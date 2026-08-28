#!/usr/bin/env node
/**
 * IT Glue MCP Server
 *
 * This MCP server provides tools for interacting with IT Glue API.
 * It accepts credentials via HTTP headers from the MCP Gateway.
 *
 * The MCP server factory and IT Glue client live in `mcp-server.ts` (which is
 * side-effect free and shared with the Cloudflare Workers entrypoint in
 * `worker.ts`). This file owns the Node-only transports (stdio + Node HTTP).
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  createMcpServer,
  type GatewayCredentials,
  type ITGlueRegion,
} from "./mcp-server.js";
import { runWithServerRef, bindServerRef } from "./utils/server-ref.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || "";

// Re-export the shared factory + IT Glue client/helpers so existing consumers
// (and tests) that import from the package entry keep working after the
// side-effect-free factory was extracted into `mcp-server.ts`.
export {
  createMcpServer,
  createClient,
  cleanCredential,
  getCredentialsFromEnv,
  sanitizeCredentials,
  ITGlueClient,
  buildFolderPickerOptions,
  buildUserMetricsDateFilter,
  USER_METRIC_SORT_FIELDS,
  createDocumentWithContent,
  documentBodyOmittedNote,
  folderedDocumentsIncludedNote,
  listDocumentFoldersViaApiKey,
  parseFolderReference,
  requestDocumentsWithFolderDefault,
  rootLevelDocumentsNote,
  stripDocumentBodies,
  stripPasswordValues,
} from "./mcp-server.js";
export type {
  DocumentSearchAttempt,
  GatewayCredentials,
  ITGlueRegion,
} from "./mcp-server.js";

/**
 * Start with stdio transport (default for local/CLI usage)
 */
async function startStdioTransport(): Promise<void> {
  const server = createMcpServer();
  // stdio is single-session (one process = one caller), so there is no
  // concurrent tenant to isolate from — bind once for the process
  // lifetime rather than per-request. See utils/server-ref.ts.
  bindServerRef(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("IT Glue MCP server running on stdio");
}

/**
 * Start with HTTP Streamable transport (for Docker/cloud deployment)
 * Supports both env-based and gateway (header-based) credential modes
 */
async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint - no auth required
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          transport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    // MCP endpoint — stateless: fresh server + transport per request
    if (url.pathname === "/mcp") {
      if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
          })
        );
        return;
      }

      // Only POST is supported in stateless mode
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        }));
        return;
      }

      // In gateway mode, extract credentials from headers; otherwise undefined (env fallback)
      let gatewayCredentials: GatewayCredentials | undefined;
      if (isGatewayMode) {
        const headers = req.headers as Record<string, string | string[] | undefined>;
        const apiKey =
          (headers["x-itglue-api-key"] as string) ||
          (headers["x-api-key"] as string);
        const jwt = (headers["x-itglue-jwt"] as string) || undefined;

        if (!apiKey && !jwt) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing credentials",
              message: "Gateway mode requires X-ITGlue-API-Key or X-ITGlue-JWT header",
              required: ["X-ITGlue-API-Key OR X-ITGlue-JWT"],
            })
          );
          return;
        }

        const baseUrl = headers["x-itglue-base-url"] as string | undefined;
        const region = headers["x-itglue-region"] as string | undefined;

        gatewayCredentials = {
          apiKey,
          jwt,
          region: (region || "us") as ITGlueRegion,
          baseUrl: baseUrl || undefined,
        };
      }

      // Stateless: create fresh server + transport for each request
      const server = createMcpServer(gatewayCredentials);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      res.on("close", () => {
        transport.close();
        server.close();
      });

      // Bind this request's server into the per-request async context
      // (not a module-level global) so elicitation helpers resolve *this*
      // server/transport even after await gaps, and never a concurrent
      // request's — see utils/server-ref.ts. The whole connect/then/catch
      // chain must stay inside this callback so the bound context survives
      // every await gap between here and any later getServerRef() call.
      runWithServerRef(server, () => {
        server.connect(transport as unknown as Transport).then(() => {
          transport.handleRequest(req, res);
        }).catch((err) => {
          console.error("MCP transport error:", err);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            }));
          }
        });
      });

      return;
    }

    // 404 for everything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(`IT Glue MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("Shutting down IT Glue MCP server...");
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Start the server
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

// Only bootstrap the server when run as a process, not when imported for tests.
if (process.env.NODE_ENV !== "test") {
  main().catch(console.error);
}
