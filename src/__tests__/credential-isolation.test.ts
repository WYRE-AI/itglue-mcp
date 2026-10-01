/**
 * Regression test: cross-tenant credential leakage in gateway (multi-tenant
 * HTTP) mode.
 *
 * Background — the bug class this pins shut:
 *
 * An earlier shape of the HTTP entrypoint carried per-request gateway
 * credentials by *mutating `process.env`* before dispatching the request
 * (`process.env.ITGLUE_API_KEY = <header value>`), because `createMcpServer()`
 * read its credentials from the environment. `process.env` is process-global
 * and a Node HTTP server interleaves concurrent requests, so two tenants
 * racing through that global meant tenant A's in-flight tool call could read
 * tenant B's API key back out of the environment after an `await` gap — and
 * issue A's query against B's IT Glue tenant.
 *
 * The fix is structural: credentials are passed as an argument to
 * `createMcpServer(credentials)` and captured in that server instance's
 * closure, so they live on the per-request server object and never in shared
 * mutable state. See `src/index.ts` (Node HTTP) and `src/worker.ts` (Workers),
 * which both build a `GatewayCredentials` from this request's headers and hand
 * it straight to the factory.
 *
 * These tests force the hostile interleave deterministically (a manually
 * resolved gate promise, not a timing stagger) and assert BY VALUE which
 * credential went out on which request, with explicit negative cross-checks.
 *
 * Against the env-mutating implementation these fail: the environment is
 * rewritten while tenant A is parked mid-flight, so A's outbound request
 * carries the other tenant's key.
 *
 * Reported and fixed independently by @KameronTT and @DDePuy2015 in their
 * forks of itglue-mcp.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { createMcpServer } from "../index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const originalEnv = { ...process.env };

/** A promise the test resolves on demand, for a deterministic forced interleave. */
function createDeferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonApiOk(name: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        data: [{ id: "1", type: "organizations", attributes: { name } }],
        meta: {
          "current-page": 1,
          "next-page": null,
          "prev-page": null,
          "total-pages": 1,
          "total-count": 1,
        },
      }),
    text: () => Promise.resolve("{}"),
  };
}

/** Connect an in-memory MCP client to a server built with the given credentials. */
async function connect(
  credentials: Parameters<typeof createMcpServer>[0]
): Promise<Client> {
  const server = createMcpServer(credentials);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "isolation-test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** All outbound fetches, in call order, reduced to the bits that identify a tenant. */
function outboundCalls(): Array<{
  url: string;
  apiKey?: string;
  authorization?: string;
}> {
  return mockFetch.mock.calls.map((call) => {
    const headers = (call[1]?.headers ?? {}) as Record<string, string>;
    return {
      url: call[0] as string,
      apiKey: headers["x-api-key"],
      authorization: headers["Authorization"],
    };
  });
}

describe("cross-tenant credential isolation (gateway mode)", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it(
    "keeps each concurrent request on its own API key and region, even when " +
      "one tenant's whole request completes inside the other's await gap",
    async () => {
      // A third, unrelated credential sitting in the environment. The
      // env-mutating implementation resolved credentials from here, so this
      // is what tenant A would wrongly pick up.
      process.env.ITGLUE_API_KEY = "env-fallback-key";
      delete process.env.X_API_KEY;
      delete process.env.ITGLUE_JWT;

      const gate = createDeferred();
      const tenantAEnteredFetch = createDeferred();

      // Gate on call ORDER, not on the outbound URL: under the bug both
      // tenants resolve to the same credentials and therefore the same host,
      // and a URL-keyed gate would deadlock into a timeout instead of a
      // readable by-value assertion failure.
      let fetchCallIndex = 0;
      mockFetch.mockImplementation(async () => {
        const index = fetchCallIndex++;
        // Park tenant A (the first caller) mid-flight and let tenant B run to
        // completion inside that gap.
        if (index === 0) {
          tenantAEnteredFetch.resolve();
          await gate.promise;
        }
        return jsonApiOk(`org-${index}`);
      });

      const tenantA = await connect({ apiKey: "tenant-a-key", region: "us" });
      const tenantB = await connect({ apiKey: "tenant-b-key", region: "eu" });

      // A starts and parks inside fetch.
      const aCall = tenantA.callTool({
        name: "search_organizations",
        arguments: { name: "Acme" },
      });
      await tenantAEnteredFetch.promise;

      // While A is parked, the environment is rewritten under it — exactly what
      // the buggy gateway did when the next request landed — and B's request
      // runs start to finish.
      process.env.ITGLUE_API_KEY = "tenant-b-key";
      await tenantB.callTool({
        name: "search_organizations",
        arguments: { name: "Beta" },
      });

      // Only now does A resume and finish.
      gate.resolve();
      await aCall;

      const calls = outboundCalls();
      expect(calls).toHaveLength(2);

      // Call order is pinned by the gate: [0] is tenant A, [1] is tenant B.
      const [aOutbound, bOutbound] = calls;

      // Each tenant's request carried its own key...
      expect(aOutbound.apiKey).toBe("tenant-a-key");
      expect(bOutbound.apiKey).toBe("tenant-b-key");

      // ...and explicitly not the other tenant's, nor the ambient env value.
      expect(aOutbound.apiKey).not.toBe("tenant-b-key");
      expect(aOutbound.apiKey).not.toBe("env-fallback-key");
      expect(bOutbound.apiKey).not.toBe("tenant-a-key");
      expect(bOutbound.apiKey).not.toBe("env-fallback-key");

      // Region is part of the tenant boundary too: a leaked region sends one
      // customer's query to another customer's data residency endpoint.
      expect(aOutbound.url).toContain("https://api.itglue.com/");
      expect(bOutbound.url).toContain("https://api.eu.itglue.com/");
    }
  );

  it("never leaks one tenant's JWT onto another tenant's request", async () => {
    // A JWT is the higher-privilege credential (it overrides the API key in
    // `authHeaders`), so a JWT crossing tenants is the worst version of this
    // bug. The session JWT slot lives inside the `createMcpServer` closure,
    // not at module scope; this pins that.
    // Ambient credentials, so an implementation that resolves from the
    // environment still authenticates — and therefore fails these assertions
    // on the credential VALUE rather than bailing out with "no credentials".
    process.env.ITGLUE_API_KEY = "env-fallback-key";
    process.env.ITGLUE_JWT = "env-fallback-jwt";

    const gate = createDeferred();
    const jwtTenantEnteredFetch = createDeferred();

    let fetchCallIndex = 0;
    mockFetch.mockImplementation(async (url: string) => {
      if (fetchCallIndex++ === 0) {
        jwtTenantEnteredFetch.resolve();
        await gate.promise;
      }
      return jsonApiOk(String(url));
    });

    const jwtTenant = await connect({
      apiKey: "jwt-tenant-key",
      jwt: "tenant-a-secret-jwt",
      region: "us",
    });
    const apiKeyTenant = await connect({
      apiKey: "api-key-tenant-key",
      region: "us",
    });

    const jwtCall = jwtTenant.callTool({
      name: "search_organizations",
      arguments: { name: "Acme" },
    });
    await jwtTenantEnteredFetch.promise;

    // The API-key-only tenant runs entirely inside the JWT tenant's await gap.
    await apiKeyTenant.callTool({
      name: "search_organizations",
      arguments: { name: "Beta" },
    });

    gate.resolve();
    await jwtCall;

    const calls = outboundCalls();
    expect(calls).toHaveLength(2);

    const withJwt = calls.filter((c) => c.authorization !== undefined);
    const withApiKey = calls.filter((c) => c.apiKey !== undefined);

    // Exactly one request may carry the JWT: the tenant that supplied it.
    expect(withJwt).toHaveLength(1);
    expect(withJwt[0].authorization).toBe("Bearer tenant-a-secret-jwt");

    // The other request authenticated with its own API key and saw no JWT.
    expect(withApiKey).toHaveLength(1);
    expect(withApiKey[0].apiKey).toBe("api-key-tenant-key");
    expect(withApiKey[0].authorization).toBeUndefined();
  });

  it("resolves credentials per server instance, not from a shared module slot", async () => {
    process.env.ITGLUE_API_KEY = "env-fallback-key";
    mockFetch.mockImplementation(async () => jsonApiOk("ok"));

    // Build every server up front, then call them out of construction order.
    // A shared "last credentials set wins" slot would serve all three with the
    // final tenant's key.
    const tenants = ["alpha", "bravo", "charlie"];
    const clients = await Promise.all(
      tenants.map((t) => connect({ apiKey: `${t}-key`, region: "us" }))
    );

    await Promise.all(
      clients.map((c) =>
        c.callTool({ name: "search_organizations", arguments: { name: "Acme" } })
      )
    );

    const keysUsed = outboundCalls()
      .map((c) => c.apiKey)
      .sort();
    expect(keysUsed).toEqual(["alpha-key", "bravo-key", "charlie-key"]);
  });
});
