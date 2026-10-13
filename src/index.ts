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
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is set to a real
 * secret. Known placeholders are rejected. MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning, does not
 * enforce X-Gateway-S2S, and binds 127.0.0.1. A non-loopback MCP_HTTP_HOST
 * is refused in that mode. A configured secret honors MCP_HTTP_HOST; when
 * that variable is unset the process keeps the historical 0.0.0.0 bind.
 * Gateway mode never falls back to ITGLUE_* env credentials.
 * /health and /healthz stay unauthenticated and do not read credentials.
 * stdio does not use S2S auth.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  cleanCredential,
  createMcpServer,
  type GatewayCredentials,
  type ITGlueRegion,
} from "./mcp-server.js";
import { runWithServerRef, bindServerRef } from "./utils/server-ref.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

/**
 * Public example values. A copied placeholder must not verify as a real secret.
 * Compared case-insensitively after trim.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const S2S_UNAUTHORIZED = {
  error:
    "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
};

function refuseStart(message: string): never {
  console.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 * The secret value is never written to logs.
 */
function resolveS2sSecret(env: NodeJS.ProcessEnv = process.env): { secret: string; insecureDev: boolean } {
  const raw = (env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (env.MCP_ALLOW_INSECURE_DEV === "1") {
    return { secret: "", insecureDev: true };
  }
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1. A non-loopback MCP_HTTP_HOST refuses to
 * start and is logged. A real secret honors MCP_HTTP_HOST; unset stays
 * 0.0.0.0 so existing container deploys keep their bind.
 */
function resolveBindHost(insecureDev: boolean, env: NodeJS.ProcessEnv = process.env): string {
  const configured = (env.MCP_HTTP_HOST ?? "").trim();
  if (!insecureDev) {
    return configured || "0.0.0.0";
  }
  if (configured === "" || isLoopbackBindHost(configured)) {
    return LOOPBACK_HOST;
  }
  refuseStart(
    `Refusing to start HTTP transport: MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET ` +
      `only listens on ${LOOPBACK_HOST}. MCP_HTTP_HOST=${configured} is not loopback. ` +
      `Unset MCP_HTTP_HOST or set it to ${LOOPBACK_HOST}.`,
  );
}

// Re-export the shared factory + IT Glue client/helpers so existing consumers
// (and tests) that import from the package entry keep working after the
// side-effect-free factory was extracted into `mcp-server.ts`.
export {
  createMcpServer,
  createClient,
  cleanCredential,
  clampPageSize,
  MAX_PAGE_SIZE,
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
  nameFallbackNote,
  parseFolderReference,
  requestDocumentsWithFolderDefault,
  rootLevelDocumentsNote,
  searchByNameWithFallback,
  stripDocumentBodies,
  stripPasswordValues,
} from "./mcp-server.js";
export type {
  DocumentSearchAttempt,
  GatewayCredentials,
  ITGlueRegion,
  NameFallbackResult,
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
 * Start with HTTP Streamable transport (for Docker/cloud deployment).
 * Supports both env-based and gateway (header-based) credential modes.
 *
 * Returns the listening server so tests can close it. Signal handlers are
 * installed by `main`, not here.
 */
export async function startHttpTransport(): Promise<HttpServer> {
  const { secret: s2sSecret, insecureDev } = resolveS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveBindHost(insecureDev);
  if (insecureDev) {
    // Logged only after the loopback bind is accepted, so a refused
    // non-loopback host does not claim the server is starting.
    console.error(INSECURE_DEV_WARNING);
  }
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoints — shallow, unauthenticated liveness. Must not read
    // vendor credentials: gateway mode has none at process start, and a
    // credential-gated probe would 503 forever.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
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
      // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1;
      // startup refuses otherwise. A configured secret is always enforced,
      // before any credential extraction.
      if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify(S2S_UNAUTHORIZED));
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

      // In gateway mode, extract credentials from headers. Never fall back
      // to ITGLUE_* in the process environment — that is not request-scoped.
      let gatewayCredentials: GatewayCredentials | undefined;
      if (isGatewayMode) {
        const headers = req.headers;
        const apiKey = cleanCredential(
          headerValue(headers["x-itglue-api-key"]) ?? headerValue(headers["x-api-key"])
        );
        const jwt = cleanCredential(headerValue(headers["x-itglue-jwt"]));

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

        const baseUrl = headerValue(headers["x-itglue-base-url"]);
        const region = headerValue(headers["x-itglue-region"]);

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
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health", "/healthz"] }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      console.error(`IT Glue MCP server listening on http://${host}:${port}/mcp`);
      console.error(`Health check available at http://${host}:${port}/health`);
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env (environment variables)"}`
      );
      resolve();
    });
  });

  return httpServer;
}

// Start the server
async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";

  if (transportType === "http") {
    const httpServer = await startHttpTransport();
    const shutdown = async () => {
      console.error("Shutting down IT Glue MCP server...");
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  } else {
    await startStdioTransport();
  }
}

// Only bootstrap the server when run as a process, not when imported for tests.
if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
