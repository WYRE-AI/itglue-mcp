/**
 * Comprehensive tests for IT Glue MCP Server
 *
 * Tests cover:
 * - Utility functions (kebabToCamel, camelToKebab, etc.)
 * - ITGlueClient class
 * - Tool listing
 * - All tool handlers with mocked fetch
 * - Error handling
 * - Credential validation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock fetch globally before any imports
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Importing from ../index pulls in the production helpers. The module guards
// its main() bootstrap on NODE_ENV=test so this import does not start an MCP
// server during tests.
import {
  buildUserMetricsDateFilter,
  buildFolderPickerOptions,
  cleanCredential,
  createClient,
  createDocumentWithContent,
  createMcpServer,
  folderedDocumentsIncludedNote,
  getCredentialsFromEnv,
  ITGlueClient,
  listDocumentFoldersViaApiKey,
  parseFolderReference,
  requestDocumentsWithFolderDefault,
  rootLevelDocumentsNote,
  stripDocumentBodies,
  stripPasswordValues,
} from "../index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Store original env vars
const originalEnv = { ...process.env };

// Type definitions for JSON:API responses
interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
}

interface JsonApiMeta {
  "current-page"?: number;
  "next-page"?: number | null;
  "prev-page"?: number | null;
  "total-pages"?: number;
  "total-count"?: number;
}

interface JsonApiResponse {
  data: JsonApiResource | JsonApiResource[];
  meta?: JsonApiMeta;
  errors?: Array<{ title?: string; detail?: string; status?: string }>;
}

// Helper to create a mock JSON:API response
function createJsonApiResponse(
  data: JsonApiResource[],
  meta?: JsonApiMeta
): JsonApiResponse {
  return {
    data,
    meta: meta || {
      "current-page": 1,
      "next-page": null,
      "prev-page": null,
      "total-pages": 1,
      "total-count": data.length,
    },
  };
}

// Helper to create a successful fetch response
function createMockResponse(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

// Helper to create an error fetch response
function createErrorResponse(status: number, body: string) {
  return Promise.resolve({
    ok: false,
    status,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(body),
  });
}

describe("Utility Functions", () => {
  describe("kebabToCamel conversion", () => {
    it("should convert kebab-case to camelCase", () => {
      // Test the conversion logic used in the server
      const kebabToCamel = (str: string): string => {
        return str.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      };

      expect(kebabToCamel("organization-type-id")).toBe("organizationTypeId");
      expect(kebabToCamel("created-at")).toBe("createdAt");
      expect(kebabToCamel("short-name")).toBe("shortName");
      expect(kebabToCamel("name")).toBe("name"); // No change for single word
    });
  });

  describe("camelToKebab conversion", () => {
    it("should convert camelCase to kebab-case", () => {
      // Test the conversion logic used in the server
      const camelToKebab = (str: string): string => {
        return str.replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`);
      };

      expect(camelToKebab("organizationTypeId")).toBe("organization-type-id");
      expect(camelToKebab("createdAt")).toBe("created-at");
      expect(camelToKebab("shortName")).toBe("short-name");
      expect(camelToKebab("name")).toBe("name"); // No change for single word
    });
  });

  describe("convertKeysToCamel", () => {
    it("should recursively convert object keys from kebab to camel", () => {
      const convertKeysToCamel = (obj: Record<string, unknown>): Record<string, unknown> => {
        const kebabToCamel = (str: string): string => {
          return str.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
        };

        const result: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(obj)) {
          const camelKey = kebabToCamel(key);
          if (value && typeof value === "object" && !Array.isArray(value)) {
            result[camelKey] = convertKeysToCamel(value as Record<string, unknown>);
          } else {
            result[camelKey] = value;
          }
        }
        return result;
      };

      const input = {
        "organization-type-id": 1,
        "created-at": "2024-01-01",
        nested: {
          "inner-key": "value",
        },
      };

      const result = convertKeysToCamel(input);

      expect(result.organizationTypeId).toBe(1);
      expect(result.createdAt).toBe("2024-01-01");
      expect((result.nested as Record<string, unknown>).innerKey).toBe("value");
    });
  });
});

describe("ITGlueClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ITGLUE_API_KEY = "test-api-key";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("Region Configuration", () => {
    it("should use US region by default", () => {
      delete process.env.ITGLUE_REGION;
      const region = process.env.ITGLUE_REGION || "us";
      expect(region).toBe("us");
    });

    it("should support EU region", () => {
      process.env.ITGLUE_REGION = "eu";
      expect(process.env.ITGLUE_REGION).toBe("eu");
    });

    it("should support AU region", () => {
      process.env.ITGLUE_REGION = "au";
      expect(process.env.ITGLUE_REGION).toBe("au");
    });

    it("should resolve the US base URL for region 'us'", async () => {
      mockFetch.mockImplementation(() => createMockResponse(createJsonApiResponse([])));
      const client = new ITGlueClient({ apiKey: "test-api-key", region: "us" });
      await client.request("/organizations");
      expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/api\.itglue\.com\/organizations/);
    });

    it("should resolve the EU base URL for region 'eu'", async () => {
      mockFetch.mockImplementation(() => createMockResponse(createJsonApiResponse([])));
      const client = new ITGlueClient({ apiKey: "test-api-key", region: "eu" });
      await client.request("/organizations");
      expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/api\.eu\.itglue\.com\/organizations/);
    });

    it("should throw a clear error for an unknown region instead of producing an 'undefined' URL", () => {
      // Reproduces issue #40: ITGLUE_REGION set to an account subdomain (not us/eu/au)
      // previously yielded baseUrl=undefined and a "Failed to parse URL from undefined/..." error.
      expect(
        () => new ITGlueClient({ apiKey: "test-api-key", region: "our-itg-subdomain" as never })
      ).toThrowError(/Invalid.*region/i);
    });

    it("should still honor an explicit baseUrl even when region is unknown", async () => {
      mockFetch.mockImplementation(() => createMockResponse(createJsonApiResponse([])));
      const client = new ITGlueClient({
        apiKey: "test-api-key",
        region: "our-itg-subdomain" as never,
        baseUrl: "https://api.itglue.example",
      });
      await client.request("/organizations");
      expect(mockFetch.mock.calls[0][0]).toMatch(/^https:\/\/api\.itglue\.example\/organizations/);
    });
  });

  describe("API Request Building", () => {
    it("should build correct query string with filters", () => {
      const buildQueryString = (params: Record<string, unknown>): string => {
        const searchParams = new URLSearchParams();

        for (const [key, value] of Object.entries(params)) {
          if (value === undefined || value === null) continue;

          if (key === "filter" && typeof value === "object") {
            for (const [filterKey, filterValue] of Object.entries(value as Record<string, unknown>)) {
              if (filterValue !== undefined && filterValue !== null) {
                searchParams.append(`filter[${filterKey}]`, String(filterValue));
              }
            }
          } else if (key === "page" && typeof value === "object") {
            const pageObj = value as { size?: number; number?: number };
            if (pageObj.size) searchParams.append("page[size]", String(pageObj.size));
            if (pageObj.number) searchParams.append("page[number]", String(pageObj.number));
          } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
            searchParams.append(key, String(value));
          }
        }

        const queryString = searchParams.toString();
        return queryString ? `?${queryString}` : "";
      };

      const params = {
        filter: { name: "test" },
        page: { size: 50, number: 1 },
        sort: "-name",
      };

      const queryString = buildQueryString(params);
      expect(queryString).toContain("filter%5Bname%5D=test");
      expect(queryString).toContain("page%5Bsize%5D=50");
      expect(queryString).toContain("page%5Bnumber%5D=1");
      expect(queryString).toContain("sort=-name");
    });

    it("should return empty string for no params", () => {
      const params = {};
      const queryString = Object.keys(params).length === 0 ? "" : "?...";
      expect(queryString).toBe("");
    });
  });

  describe("Request Headers", () => {
    // Asserts on what ITGlueClient.authHeaders() actually put on the wire.
    // The previous version of this test hand-built a headers object, handed it
    // to the fetch mock itself, and asserted the mock had received it — it
    // never touched the client and could not fail.
    it("sends the API key and the JSON:API content negotiation headers", async () => {
      mockFetch.mockImplementation(() =>
        createMockResponse(createJsonApiResponse([]))
      );

      const client = new ITGlueClient({ apiKey: "test-api-key", region: "us" });
      await client.request("/organizations");

      const headers = (mockFetch.mock.calls[0][1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-api-key");
      expect(headers["Content-Type"]).toBe("application/vnd.api+json");
      expect(headers["Accept"]).toBe("application/vnd.api+json");
    });
  });

  describe("Error Handling", () => {
    it("turns a non-OK HTTP response into a thrown error carrying the status", async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(401, "Unauthorized"));

      const client = new ITGlueClient({ apiKey: "test-api-key", region: "us" });
      await expect(client.request("/organizations")).rejects.toThrow(
        /IT Glue API error \(401\).*Unauthorized/
      );
    });

    it("throws on a 200 response that carries a JSON:API errors array", async () => {
      // IT Glue can answer 200 OK with an `errors` member; treating that as a
      // successful empty result would report "no such organization" for what is
      // really a server-side failure.
      const errorBody: JsonApiResponse = {
        data: [],
        errors: [
          { title: "Not Found", detail: "Organization not found", status: "404" },
        ],
      };
      mockFetch.mockResolvedValueOnce(createMockResponse(errorBody));

      const client = new ITGlueClient({ apiKey: "test-api-key", region: "us" });
      await expect(client.request("/organizations/999999")).rejects.toThrow(
        "IT Glue API error: Organization not found"
      );
    });

    it("propagates transport-level failures unchanged", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const client = new ITGlueClient({ apiKey: "test-api-key", region: "us" });
      await expect(client.request("/organizations")).rejects.toThrow(
        "Network error"
      );
    });
  });
});

describe("Tool Definitions", () => {
  const tools = [
    { name: "search_organizations", requiredFields: [] as string[], properties: ["name", "organization_type_id", "organization_status_id", "psa_id", "page_size", "page_number", "sort"] },
    { name: "get_organization", requiredFields: ["id"], properties: ["id"] },
    { name: "search_configurations", requiredFields: [] as string[], properties: ["organization_id", "name", "configuration_type_id", "configuration_status_id", "serial_number", "rmm_id", "psa_id", "page_size", "page_number", "sort"] },
    { name: "get_configuration", requiredFields: ["id"], properties: ["id"] },
    { name: "search_locations", requiredFields: [] as string[], properties: ["organization_id", "name", "city", "region_id", "country_id", "psa_id", "page_size", "page_number", "sort"] },
    { name: "get_location", requiredFields: ["id"], properties: ["id"] },
    { name: "create_location", requiredFields: ["organization_id", "name"], properties: ["organization_id", "name", "country_id", "region_id", "address_1", "address_2", "city", "postal_code", "phone", "fax", "notes", "primary"] },
    { name: "update_location", requiredFields: ["organization_id", "id"], properties: ["organization_id", "id", "name", "country_id", "region_id", "address_1", "address_2", "city", "postal_code", "phone", "fax", "notes", "primary"] },
    { name: "search_passwords", requiredFields: [] as string[], properties: ["organization_id", "name", "password_category_id", "url", "username", "page_size", "page_number", "sort"] },
    { name: "get_password", requiredFields: ["id"], properties: ["id", "show_password"] },
    { name: "search_documents", requiredFields: ["organization_id"] as string[], properties: ["organization_id", "name", "page_size", "page_number", "sort"] },
    { name: "get_document", requiredFields: ["organization_id", "id"], properties: ["organization_id", "id"] },
    { name: "list_document_folders", requiredFields: ["organization_id"], properties: ["organization_id", "name", "page_size", "page_number"] },
    { name: "create_document", requiredFields: ["organization_id", "name"], properties: ["organization_id", "name", "content"] },
    { name: "list_document_sections", requiredFields: ["document_id"], properties: ["document_id"] },
    { name: "create_document_section", requiredFields: ["document_id", "section_type", "content"], properties: ["document_id", "section_type", "content"] },
    { name: "update_document_section", requiredFields: ["document_id", "section_id", "content"], properties: ["document_id", "section_id", "content"] },
    { name: "delete_document_section", requiredFields: ["document_id", "section_id"], properties: ["document_id", "section_id"] },
    { name: "create_document_image", requiredFields: ["document_id", "file_name", "content"], properties: ["document_id", "file_name", "content"] },
    { name: "create_attachment", requiredFields: ["resource_type", "resource_id", "file_name", "content"], properties: ["resource_type", "resource_id", "file_name", "content"] },
    { name: "list_attachments", requiredFields: ["resource_type", "resource_id"], properties: ["resource_type", "resource_id"] },
    { name: "publish_document", requiredFields: ["document_id"], properties: ["document_id"] },
    { name: "archive_document", requiredFields: ["document_id"], properties: ["document_id"] },
    { name: "unarchive_document", requiredFields: ["document_id"], properties: ["document_id"] },
    { name: "search_flexible_assets", requiredFields: ["flexible_asset_type_id"], properties: ["flexible_asset_type_id", "organization_id", "name", "page_size", "page_number", "sort"] },
    { name: "list_flexible_asset_types", requiredFields: [], properties: ["organization_id"] },
    { name: "search_user_metrics", requiredFields: [] as string[], properties: ["user_id", "organization_id", "resource_type", "start_date", "end_date", "sort", "page_size", "page_number"] },
    { name: "itglue_health_check", requiredFields: [] as string[], properties: [] as string[] },
  ];

  it.each(tools)("should define $name tool correctly", ({ name, requiredFields, properties }) => {
    expect(name).toBeTruthy();
    expect(Array.isArray(requiredFields)).toBe(true);
    expect(Array.isArray(properties)).toBe(true);

    // Verify required fields are subset of properties
    requiredFields.forEach((field) => {
      expect(properties).toContain(field);
    });
  });

  it("should have 25 tools total", () => {
    expect(tools.length).toBe(28);
  });
});

describe("Credential Validation", () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should accept ITGLUE_API_KEY environment variable", () => {
    process.env.ITGLUE_API_KEY = "my-api-key";
    delete process.env.X_API_KEY;

    const apiKey = process.env.ITGLUE_API_KEY || process.env.X_API_KEY;
    expect(apiKey).toBe("my-api-key");
  });

  it("should accept X_API_KEY as fallback", () => {
    delete process.env.ITGLUE_API_KEY;
    process.env.X_API_KEY = "fallback-api-key";

    const apiKey = process.env.ITGLUE_API_KEY || process.env.X_API_KEY;
    expect(apiKey).toBe("fallback-api-key");
  });

  it("should prefer ITGLUE_API_KEY over X_API_KEY", () => {
    process.env.ITGLUE_API_KEY = "primary-key";
    process.env.X_API_KEY = "fallback-key";

    const apiKey = process.env.ITGLUE_API_KEY || process.env.X_API_KEY;
    expect(apiKey).toBe("primary-key");
  });

  it("should return undefined when no API key is provided", () => {
    delete process.env.ITGLUE_API_KEY;
    delete process.env.X_API_KEY;

    const apiKey = process.env.ITGLUE_API_KEY || process.env.X_API_KEY;
    expect(apiKey).toBeUndefined();
  });

  it("should default to US region when ITGLUE_REGION is not set", () => {
    delete process.env.ITGLUE_REGION;

    const region = process.env.ITGLUE_REGION || "us";
    expect(region).toBe("us");
  });

  it("should use specified region from ITGLUE_REGION", () => {
    process.env.ITGLUE_REGION = "eu";

    const region = process.env.ITGLUE_REGION || "us";
    expect(region).toBe("eu");
  });
});

// Regression tests for issue #73: on v1.14.1 the desktop (MCPB) install 401'd
// every request. The manifest maps ITGLUE_JWT/ITGLUE_REGION to ${user_config.*};
// when the optional itglue_jwt field is left blank the host injects the literal,
// unresolved string "${user_config.itglue_jwt}". The server read that as a JWT
// and — because a JWT overrides the API key — sent
// `Authorization: Bearer ${user_config.itglue_jwt}` on every call, so a valid
// API key never got a chance. Credentials must be sanitised at ingress.
describe("issue #73: unresolved MCPB config placeholders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("cleanCredential drops empty, whitespace, and ${...} placeholder values", () => {
    expect(cleanCredential(undefined)).toBeUndefined();
    expect(cleanCredential("")).toBeUndefined();
    expect(cleanCredential("   ")).toBeUndefined();
    expect(cleanCredential("${user_config.itglue_jwt}")).toBeUndefined();
    expect(cleanCredential("  ${user_config.itglue_jwt}  ")).toBeUndefined();
  });

  it("cleanCredential preserves and trims real credentials", () => {
    expect(cleanCredential("eyJ0eXAiOiJKV1Qi.real.jwt")).toBe("eyJ0eXAiOiJKV1Qi.real.jwt");
    expect(cleanCredential("  real-api-key  ")).toBe("real-api-key");
  });

  it("getCredentialsFromEnv ignores a placeholder ITGLUE_JWT but keeps the API key", () => {
    process.env.ITGLUE_API_KEY = "real-api-key";
    process.env.ITGLUE_JWT = "${user_config.itglue_jwt}";

    const creds = getCredentialsFromEnv();

    expect(creds.apiKey).toBe("real-api-key");
    expect(creds.jwt).toBeUndefined();
  });

  it("falls back to region 'us' when ITGLUE_REGION is an unresolved placeholder", () => {
    process.env.ITGLUE_API_KEY = "real-api-key";
    process.env.ITGLUE_REGION = "${user_config.itglue_region}";

    expect(getCredentialsFromEnv().region).toBe("us");
  });

  it("authenticates with the API key, not a bogus Bearer placeholder (the 401 repro)", async () => {
    process.env.ITGLUE_API_KEY = "real-api-key";
    process.env.ITGLUE_JWT = "${user_config.itglue_jwt}";

    let captured: Record<string, string> = {};
    mockFetch.mockImplementation((_url: string, options: RequestInit) => {
      captured = options.headers as Record<string, string>;
      return createMockResponse(createJsonApiResponse([]));
    });

    const client = createClient(getCredentialsFromEnv());
    await client.request("/organizations", {});

    expect(captured["x-api-key"]).toBe("real-api-key");
    expect(captured["Authorization"]).toBeUndefined();
  });
});

describe("Tool Handler Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.ITGLUE_API_KEY = "test-api-key";
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // search_organizations, get_organization, search_configurations,
  // get_configuration and search_documents used to be "tested" here by calling
  // the fetch mock directly and asserting on the payload the mock had just been
  // handed — the handlers never ran. Real round-trip coverage now lives in
  // "Core tools (round-trip)" below (and, for search_documents, in
  // "Document folder access (API-key-first, round-trip)").

  // Regression tests for wyre-technology/msp-claude-plugins#134: an org-wide
  // search_documents returns only ROOT-LEVEL documents (IT Glue API limitation),
  // so the model must be told the listing is partial or it reports the truncated
  // count as the org's total ("this org has 1 document" for an org with 1,100+).
  // Since issue #55 this note is only emitted when the folder-inclusive filter
  // forms were rejected and the search degraded to the legacy root-only call.
  describe("rootLevelDocumentsNote", () => {
    it("returns null when a folder filter scopes the search (result is complete)", () => {
      expect(
        rootLevelDocumentsNote({ folderFiltered: true, haveJwt: false })
      ).toBeNull();
      expect(
        rootLevelDocumentsNote({ folderFiltered: true, haveJwt: true })
      ).toBeNull();
    });

    it("warns that the listing is root-level-only for an unscoped search", () => {
      const note = rootLevelDocumentsNote({ folderFiltered: false, haveJwt: true });
      expect(note).toContain("ROOT-LEVEL");
      expect(note).toContain("meta.total-count");
      expect(note).toContain("list_document_folders");
    });

    it("frames the JWT as an optional fallback (not a requirement) for API-key-only callers", () => {
      const note = rootLevelDocumentsNote({ folderFiltered: false, haveJwt: false });
      expect(note).toContain("ITGLUE_JWT");
      expect(note).toContain("fallback");
      expect(note).not.toMatch(/requires a JWT/i);
    });
  });

  describe("folderedDocumentsIncludedNote", () => {
    it("tells the model foldered documents are included and how to read folder membership", () => {
      const note = folderedDocumentsIncludedNote();
      expect(note).toContain("includes documents inside folders");
      expect(note).toContain("documentFolderId");
    });
  });

  // Issue #55 follow-up: IT Glue's documents LIST endpoint inlines every
  // document's full sectioned body under `content`, dominating the payload and
  // making foldered orgs exceed the MCP client's response limit. search_documents
  // must return metadata only.
  describe("stripDocumentBodies", () => {
    it("removes the content array while preserving all other document fields", () => {
      const stripped = stripDocumentBodies([
        {
          id: "1",
          name: "Doc",
          documentFolderId: 42,
          content: [{ id: 9, resource: { content: "<p>body</p>" } }],
        },
      ]);
      expect(stripped).toEqual([{ id: "1", name: "Doc", documentFolderId: 42 }]);
    });

    it("leaves documents without a content field untouched", () => {
      const docs = [{ id: "2", name: "Root Doc", documentFolderId: null }];
      expect(stripDocumentBodies(docs)).toEqual(docs);
    });
  });

  describe("stripPasswordValues", () => {
    it("removes the secret while preserving every other field", () => {
      const stripped = stripPasswordValues([
        { id: "1", name: "VPN Admin", username: "admin", password: "hunter2" },
      ]);
      expect(stripped).toEqual([
        { id: "1", name: "VPN Admin", username: "admin" },
      ]);
    });

    it("leaves records without a password field untouched", () => {
      const pws = [{ id: "2", name: "No Secret", username: "svc" }];
      expect(stripPasswordValues(pws)).toEqual(pws);
    });
  });

  // Issue #55: search_documents defaults to a folder-INCLUSIVE listing
  // (filter[document_folder_id]=null returns ALL documents), degrading through
  // the [ne] filter form down to the legacy root-only call when the tenant's
  // API rejects the filter.
  describe("requestDocumentsWithFolderDefault", () => {
    function newClient(): ITGlueClient {
      return new ITGlueClient({ apiKey: "test-api-key", region: "us" });
    }

    function decodedUrl(callIndex: number): string {
      return decodeURIComponent(mockFetch.mock.calls[callIndex][0] as string);
    }

    it("sends filter[document_folder_id]=null on the first attempt", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createJsonApiResponse([])));

      const { attempt } = await requestDocumentsWithFolderDefault(newClient(), 123, {
        page: { size: 50, number: 1 },
      });

      expect(attempt).toBe("null-filter");
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(decodedUrl(0)).toContain("/organizations/123/relationships/documents");
      expect(decodedUrl(0)).toContain("filter[document_folder_id]=null");
    });

    it("preserves caller filters (e.g. name) alongside the folder default", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse(createJsonApiResponse([])));

      await requestDocumentsWithFolderDefault(newClient(), 123, {
        filter: { name: "Runbook" },
        page: { size: 50, number: 1 },
      });

      expect(decodedUrl(0)).toContain("filter[name]=Runbook");
      expect(decodedUrl(0)).toContain("filter[document_folder_id]=null");
    });

    it("retries with filter[document_folder_id][ne]= when the null form is rejected (400)", async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(400, "bad filter"))
        .mockResolvedValueOnce(createMockResponse(createJsonApiResponse([])));

      const { attempt } = await requestDocumentsWithFolderDefault(newClient(), 123, {
        page: { size: 50, number: 1 },
      });

      expect(attempt).toBe("ne-filter");
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(decodedUrl(1)).toContain("filter[document_folder_id][ne]=");
    });

    it("falls back to the unfiltered (root-only) call when both filter forms are rejected", async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(400, "bad filter"))
        .mockResolvedValueOnce(createErrorResponse(422, "unprocessable"))
        .mockResolvedValueOnce(createMockResponse(createJsonApiResponse([])));

      const { attempt } = await requestDocumentsWithFolderDefault(newClient(), 123, {
        page: { size: 50, number: 1 },
      });

      expect(attempt).toBe("unfiltered");
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(decodedUrl(2)).not.toContain("document_folder_id");
    });

    it("propagates non-filter errors (404, 500) without degrading", async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(404, "Not Found"));

      await expect(
        requestDocumentsWithFolderDefault(newClient(), 123, {})
      ).rejects.toThrow(/404/);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  // Issue #55: folder enumeration is API-key-first. IT Glue's public API now
  // documents a Document Folders resource (rolling out across tenants), so the
  // JWT becomes a fallback rather than a requirement.
  describe("listDocumentFoldersViaApiKey", () => {
    function newClient(): ITGlueClient {
      return new ITGlueClient({ apiKey: "test-api-key", region: "us" });
    }

    it("returns folders from the organization relationship path", async () => {
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
          ])
        )
      );

      const result = await listDocumentFoldersViaApiKey(newClient(), 123, {});

      expect(result).not.toBeNull();
      expect((result!.data[0] as { name: string }).name).toBe("Runbooks");
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/organizations/123/relationships/document_folders"
      );
    });

    it("tries the top-level /document_folders form when the relationship path 404s", async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(404, "Not Found"))
        .mockResolvedValueOnce(
          createMockResponse(
            createJsonApiResponse([
              { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
            ])
          )
        );

      const result = await listDocumentFoldersViaApiKey(newClient(), 123, {});

      expect(result).not.toBeNull();
      const secondUrl = decodeURIComponent(mockFetch.mock.calls[1][0] as string);
      expect(secondUrl).toContain("/document_folders?");
      expect(secondUrl).toContain("filter[organization_id]=123");
    });

    it("returns null (JWT-fallback signal) when the API key is rejected with 403", async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(403, "Forbidden"));

      const result = await listDocumentFoldersViaApiKey(newClient(), 123, {});

      expect(result).toBeNull();
      // 403 means the key is rejected outright — no point probing the top-level path.
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("returns null when both paths 404 (resource not exposed on this tenant)", async () => {
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(404, "Not Found"))
        .mockResolvedValueOnce(createErrorResponse(404, "Not Found"));

      const result = await listDocumentFoldersViaApiKey(newClient(), 123, {});

      expect(result).toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("propagates unexpected errors (500) instead of silently falling back", async () => {
      mockFetch.mockResolvedValueOnce(createErrorResponse(500, "boom"));

      await expect(listDocumentFoldersViaApiKey(newClient(), 123, {})).rejects.toThrow(/500/);
    });
  });

  // Regression tests for issue #7: document creation must persist content.
  // IT Glue's Documents API ignores a top-level `content` attribute on POST —
  // documents are section-structured, so the body only materialises when a
  // follow-up document_section is POSTed. The helper below orchestrates that
  // two-step flow; these tests exercise it directly against a mocked fetch so
  // the assertions cover the real production code path (not a re-construction
  // of it).
  describe("createDocumentWithContent", () => {
    function newClient(): ITGlueClient {
      return new ITGlueClient({ apiKey: "test-api-key", region: "us" });
    }

    it("POSTs only the document when content is omitted", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({
        data: { id: "789", type: "documents", attributes: { name: "Doc" } },
      }));

      await createDocumentWithContent(newClient(), {
        organization_id: 1765329,
        name: "Doc",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/organizations/1765329/relationships/documents"
      );
    });

    it("POSTs document then section when content is provided", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse({
          data: { id: "23350960", type: "documents", attributes: { name: "Doc" } },
        }))
        .mockResolvedValueOnce(createMockResponse({
          data: { id: "1001", type: "document-sections", attributes: {} },
        }));

      await createDocumentWithContent(newClient(), {
        organization_id: 1765329,
        name: "Doc",
        content: "<h1>Hello</h1><p>World</p>",
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[0][0]).toContain(
        "/organizations/1765329/relationships/documents"
      );
      expect(mockFetch.mock.calls[1][0]).toContain(
        "/documents/23350960/relationships/sections"
      );

      const sectionBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(sectionBody.data.type).toBe("document-sections");
      // IT Glue stores the section type in `resource_type`, not `section-type`.
      // Verified live 2026-04-23: `section-type` is ignored on write and a
      // `relationships.resource` binding triggers a 400.
      expect(sectionBody.data.attributes.resource_type).toBe("Document::Text");
      expect(sectionBody.data.attributes.content).toBe("<h1>Hello</h1><p>World</p>");
      expect(sectionBody.data.attributes).not.toHaveProperty("section-type");
      expect(sectionBody.data).not.toHaveProperty("relationships");
    });

    it("skips section POST when content is empty string", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({
        data: { id: "789", type: "documents", attributes: { name: "Doc" } },
      }));

      await createDocumentWithContent(newClient(), {
        organization_id: 1,
        name: "Doc",
        content: "",
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("includes document_folder_id on the POST attributes when provided", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({
        data: { id: "789", type: "documents", attributes: { name: "Doc" } },
      }));

      await createDocumentWithContent(newClient(), {
        organization_id: 1765329,
        name: "Doc",
        document_folder_id: 42,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.attributes.document_folder_id).toBe(42);
      expect(body.data.attributes.name).toBe("Doc");
    });

    it("accepts string folder ids and passes them through unchanged", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({
        data: { id: "789", type: "documents", attributes: { name: "Doc" } },
      }));

      await createDocumentWithContent(newClient(), {
        organization_id: 1765329,
        name: "Doc",
        document_folder_id: "42",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.attributes.document_folder_id).toBe("42");
    });

    it("omits document_folder_id from attributes when not provided", async () => {
      mockFetch.mockResolvedValueOnce(createMockResponse({
        data: { id: "789", type: "documents", attributes: { name: "Doc" } },
      }));

      await createDocumentWithContent(newClient(), {
        organization_id: 1765329,
        name: "Doc",
      });

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.data.attributes).not.toHaveProperty("document_folder_id");
    });

    it("returns the document (not the section) as the caller-visible result", async () => {
      mockFetch
        .mockResolvedValueOnce(createMockResponse({
          data: { id: "23350960", type: "documents", attributes: { name: "Doc" } },
        }))
        .mockResolvedValueOnce(createMockResponse({
          data: { id: "1001", type: "document-sections", attributes: {} },
        }));

      const result = await createDocumentWithContent(newClient(), {
        organization_id: 1,
        name: "Doc",
        content: "<p>x</p>",
      });

      expect((result as { id: string; type: string }).id).toBe("23350960");
      expect((result as { id: string; type: string }).type).toBe("documents");
    });
  });

  describe("ITGlueClient auth dispatch", () => {
    it("throws when neither apiKey nor jwt is provided", () => {
      expect(() => new ITGlueClient({ region: "us" } as never)).toThrow(
        /apiKey or a jwt/i
      );
    });

    it("sends Authorization: Bearer when a JWT is configured", async () => {
      let captured: Record<string, string> = {};
      mockFetch.mockImplementation((_url: string, options: RequestInit) => {
        captured = options.headers as Record<string, string>;
        return createMockResponse(createJsonApiResponse([]));
      });

      const client = new ITGlueClient({ jwt: "test-jwt", region: "us" });
      await client.request("/organizations", {});

      expect(captured["Authorization"]).toBe("Bearer test-jwt");
      expect(captured["x-api-key"]).toBeUndefined();
    });

    it("sends x-api-key when only an apiKey is configured", async () => {
      let captured: Record<string, string> = {};
      mockFetch.mockImplementation((_url: string, options: RequestInit) => {
        captured = options.headers as Record<string, string>;
        return createMockResponse(createJsonApiResponse([]));
      });

      const client = new ITGlueClient({ apiKey: "test-key", region: "us" });
      await client.request("/organizations", {});

      expect(captured["x-api-key"]).toBe("test-key");
      expect(captured["Authorization"]).toBeUndefined();
    });

    it("prefers JWT over apiKey when both are configured (JWT carries broader scope)", async () => {
      let captured: Record<string, string> = {};
      mockFetch.mockImplementation((_url: string, options: RequestInit) => {
        captured = options.headers as Record<string, string>;
        return createMockResponse(createJsonApiResponse([]));
      });

      const client = new ITGlueClient({
        apiKey: "test-key",
        jwt: "test-jwt",
        region: "us",
      });
      await client.request("/organizations", {});

      expect(captured["Authorization"]).toBe("Bearer test-jwt");
      expect(captured["x-api-key"]).toBeUndefined();
    });

    it("uses JWT auth on POST as well as GET", async () => {
      let captured: Record<string, string> = {};
      mockFetch.mockImplementation((_url: string, options: RequestInit) => {
        captured = options.headers as Record<string, string>;
        return createMockResponse({
          data: { id: "1", type: "documents", attributes: { name: "d" } },
        });
      });

      const client = new ITGlueClient({ jwt: "test-jwt", region: "us" });
      await client.post("/organizations/1/relationships/documents", {
        data: { type: "documents", attributes: { name: "d" } },
      });

      expect(captured["Authorization"]).toBe("Bearer test-jwt");
    });
  });

  describe("buildFolderPickerOptions", () => {
    it("always prepends a __root__ sentinel even when the folder list is empty", () => {
      const options = buildFolderPickerOptions([]);
      expect(options).toEqual([
        { value: "__root__", label: "(Root — no folder)" },
      ]);
    });

    it("builds breadcrumb labels for nested folders using parent-id (kebab-case)", () => {
      const options = buildFolderPickerOptions([
        { id: "1", attributes: { name: "Networking" } },
        { id: "2", attributes: { name: "Firewalls", "parent-id": "1" } },
        { id: "3", attributes: { name: "Edge", "parent-id": "2" } },
      ]);
      expect(options[0]).toEqual({ value: "__root__", label: "(Root — no folder)" });
      const byValue = Object.fromEntries(options.map((o) => [o.value, o.label]));
      expect(byValue["1"]).toBe("Networking");
      expect(byValue["2"]).toBe("Networking / Firewalls");
      expect(byValue["3"]).toBe("Networking / Firewalls / Edge");
    });

    it("also accepts snake_case parent_id", () => {
      const options = buildFolderPickerOptions([
        { id: "1", attributes: { name: "Top" } },
        { id: "2", attributes: { name: "Child", parent_id: "1" } },
      ]);
      const byValue = Object.fromEntries(options.map((o) => [o.value, o.label]));
      expect(byValue["2"]).toBe("Top / Child");
    });

    it("disambiguates duplicate folder names under different parents", () => {
      const options = buildFolderPickerOptions([
        { id: "1", attributes: { name: "Networking" } },
        { id: "2", attributes: { name: "Servers" } },
        { id: "3", attributes: { name: "Firewalls", "parent-id": "1" } },
        { id: "4", attributes: { name: "Firewalls", "parent-id": "2" } },
      ]);
      const labels = options.map((o) => o.label);
      expect(labels).toContain("Networking / Firewalls");
      expect(labels).toContain("Servers / Firewalls");
    });

    it("is cycle-safe (parent chain looping back terminates)", () => {
      const options = buildFolderPickerOptions([
        { id: "A", attributes: { name: "A", "parent-id": "B" } },
        { id: "B", attributes: { name: "B", "parent-id": "A" } },
      ]);
      const byValue = Object.fromEntries(options.map((o) => [o.value, o.label]));
      expect(byValue["A"]).toBe("B / A");
      expect(byValue["B"]).toBe("A / B");
    });

    it("treats unknown parent ids as orphans (own-name label)", () => {
      const options = buildFolderPickerOptions([
        { id: "1", attributes: { name: "Stray", "parent-id": "999" } },
      ]);
      expect(options.find((o) => o.value === "1")?.label).toBe("Stray");
    });
  });

  describe("parseFolderReference", () => {
    it("returns root for null, undefined, empty, and whitespace input", () => {
      expect(parseFolderReference(null)).toEqual({ kind: "root" });
      expect(parseFolderReference(undefined)).toEqual({ kind: "root" });
      expect(parseFolderReference("")).toEqual({ kind: "root" });
      expect(parseFolderReference("   \n  ")).toEqual({ kind: "root" });
    });

    it("returns a folder reference for a bare numeric id (trimmed)", () => {
      expect(parseFolderReference("6926612")).toEqual({ kind: "folder", folderId: 6926612 });
      expect(parseFolderReference("  6926612  ")).toEqual({ kind: "folder", folderId: 6926612 });
    });

    it("extracts the folder id from an IT Glue folder URL", () => {
      const url = "https://wyretechnology.itglue.com/8250506/documents/folder/6926612/";
      expect(parseFolderReference(url)).toEqual({ kind: "folder", folderId: 6926612 });
    });

    it("handles a folder URL with no trailing slash", () => {
      const url = "https://wyretechnology.itglue.com/8250506/documents/folder/6926612";
      expect(parseFolderReference(url)).toEqual({ kind: "folder", folderId: 6926612 });
    });

    it("extracts the doc id from a `/docs/<id>` URL (resource-url shape)", () => {
      const url = "https://wyretechnology.itglue.com/8250506/docs/22884804";
      expect(parseFolderReference(url)).toEqual({ kind: "doc", docId: 22884804 });
    });

    it("extracts the doc id from a `DOC-<org>-<id>` URL (UI shape)", () => {
      const url = "https://wyretechnology.itglue.com/DOC-8250506-22884804";
      expect(parseFolderReference(url)).toEqual({ kind: "doc", docId: 22884804 });
    });

    it("prefers the more specific folder pattern when both could match", () => {
      // A folder URL is unambiguous — the doc pattern should not steal from it.
      const url = "https://x/8250506/documents/folder/6926612/";
      expect(parseFolderReference(url)).toEqual({ kind: "folder", folderId: 6926612 });
    });

    it("flags unparseable input as invalid (preserves the original for the error message)", () => {
      expect(parseFolderReference("not a url or id")).toEqual({
        kind: "invalid",
        input: "not a url or id",
      });
      expect(parseFolderReference("https://example.com/somewhere/else")).toEqual({
        kind: "invalid",
        input: "https://example.com/somewhere/else",
      });
    });
  });

  // The document-section, publish/archive, flexible-asset and health-check
  // tools were also only ever exercised against the fetch mock directly. Their
  // real round-trip coverage lives in "Document section tools (round-trip)" and
  // "Core tools (round-trip)" below.
});

describe("Unknown Tool Handling", () => {
  // Previously this asserted `knownTools.length === 9` against a list literal
  // the test itself wrote — while the server registered 25 tools. It tracked
  // the test's own copy of reality, not the server's.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function connectClient(): Promise<Client> {
    const server = createMcpServer({ apiKey: "test-api-key" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "unknown-tool-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  it("returns an error result for a tool the server does not implement", async () => {
    const client = await connectClient();
    const result = (await client.callTool({
      name: "nonexistent_tool",
      arguments: {},
    })) as { isError?: boolean; content?: Array<{ text?: string }> };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toContain("Unknown tool: nonexistent_tool");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("advertises exactly the tools it can dispatch", async () => {
    const client = await connectClient();
    const { tools } = await client.listTools();

    expect(tools.length).toBe(28);
    // Every advertised tool must reach a real branch — not the Unknown-tool
    // default — so a rename in the ListTools block can't drift from the switch.
    for (const tool of tools) {
      const result = (await client.callTool({
        name: tool.name,
        arguments: {},
      })) as { content?: Array<{ text?: string }> };
      expect(result.content?.[0]?.text ?? "").not.toContain("Unknown tool:");
    }
  });
});

describe("JSON:API Deserialization", () => {
  it("should deserialize resource with id and type", () => {
    const resource: JsonApiResource = { id: "123", type: "organizations" };

    const result = {
      id: resource.id,
      type: resource.type,
    };

    expect(result.id).toBe("123");
    expect(result.type).toBe("organizations");
  });

  it("should deserialize resource attributes with camelCase conversion", () => {
    const resource: JsonApiResource = {
      id: "123",
      type: "organizations",
      attributes: {
        name: "Test Org",
        "short-name": "TEST",
        "organization-type-id": 1,
        "created-at": "2024-01-01T00:00:00Z",
      },
    };

    // Simulate deserialization
    const kebabToCamel = (str: string): string => {
      return str.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    };

    const deserialized: Record<string, unknown> = {
      id: resource.id,
      type: resource.type,
    };

    for (const [key, value] of Object.entries(resource.attributes || {})) {
      deserialized[kebabToCamel(key)] = value;
    }

    expect(deserialized.id).toBe("123");
    expect(deserialized.name).toBe("Test Org");
    expect(deserialized.shortName).toBe("TEST");
    expect(deserialized.organizationTypeId).toBe(1);
    expect(deserialized.createdAt).toBe("2024-01-01T00:00:00Z");
  });

  it("should handle empty attributes", () => {
    const resource: JsonApiResource = { id: "123", type: "organizations" };

    const result = {
      id: resource.id,
      type: resource.type,
    };

    expect(result.id).toBe("123");
    expect(Object.keys(result).length).toBe(2);
  });

  it("should handle nested objects in attributes", () => {
    const resource: JsonApiResource = {
      id: "123",
      type: "flexible-assets",
      attributes: {
        name: "Test Asset",
        traits: {
          "ip-address": "10.0.0.1",
          "subnet-mask": "255.255.255.0",
        },
      },
    };

    const traits = resource.attributes?.traits as Record<string, string>;
    expect(traits["ip-address"]).toBe("10.0.0.1");
    expect(traits["subnet-mask"]).toBe("255.255.255.0");
  });

  it("should handle array data responses", () => {
    const response = createJsonApiResponse([
      { id: "1", type: "organizations", attributes: { name: "Org 1" } },
      { id: "2", type: "organizations", attributes: { name: "Org 2" } },
    ]);

    expect(Array.isArray(response.data)).toBe(true);
    expect((response.data as JsonApiResource[]).length).toBe(2);
  });

  it("should handle single resource data responses", () => {
    const response: JsonApiResponse = {
      data: { id: "1", type: "organizations", attributes: { name: "Org 1" } },
    };

    expect(Array.isArray(response.data)).toBe(false);
    expect((response.data as JsonApiResource).id).toBe("1");
  });
});

describe("Pagination Metadata", () => {
  it("should parse pagination metadata correctly", () => {
    const meta: JsonApiMeta = {
      "current-page": 2,
      "next-page": 3,
      "prev-page": 1,
      "total-pages": 10,
      "total-count": 500,
    };

    const parsed = {
      currentPage: meta["current-page"],
      nextPage: meta["next-page"],
      prevPage: meta["prev-page"],
      totalPages: meta["total-pages"],
      totalCount: meta["total-count"],
    };

    expect(parsed.currentPage).toBe(2);
    expect(parsed.nextPage).toBe(3);
    expect(parsed.prevPage).toBe(1);
    expect(parsed.totalPages).toBe(10);
    expect(parsed.totalCount).toBe(500);
  });

  it("should handle missing pagination metadata with defaults", () => {
    const meta: JsonApiMeta = {};

    const parsed = {
      currentPage: meta["current-page"] || 1,
      nextPage: meta["next-page"] ?? null,
      prevPage: meta["prev-page"] ?? null,
      totalPages: meta["total-pages"] || 1,
      totalCount: meta["total-count"] || 0,
    };

    expect(parsed.currentPage).toBe(1);
    expect(parsed.nextPage).toBeNull();
    expect(parsed.prevPage).toBeNull();
    expect(parsed.totalPages).toBe(1);
    expect(parsed.totalCount).toBe(0);
  });

  it("should handle null next/prev page values", () => {
    const meta: JsonApiMeta = {
      "current-page": 1,
      "next-page": 2,
      "prev-page": null,
      "total-pages": 5,
      "total-count": 100,
    };

    expect(meta["prev-page"]).toBeNull();
    expect(meta["next-page"]).toBe(2);
  });

  it("should handle last page pagination", () => {
    const meta: JsonApiMeta = {
      "current-page": 5,
      "next-page": null,
      "prev-page": 4,
      "total-pages": 5,
      "total-count": 100,
    };

    expect(meta["current-page"]).toBe(meta["total-pages"]);
    expect(meta["next-page"]).toBeNull();
  });
});

describe("Filter Parameter Building", () => {
  it("should convert camelCase filter keys to kebab-case", () => {
    const camelToKebab = (str: string): string => {
      return str.replace(/[A-Z]/g, (letter: string) => `-${letter.toLowerCase()}`);
    };

    const filter: Record<string, number> = {
      organizationId: 123,
      configurationTypeId: 456,
    };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter)) {
      result[camelToKebab(key)] = String(value);
    }

    expect(result["organization-id"]).toBe("123");
    expect(result["configuration-type-id"]).toBe("456");
  });

  it("should skip undefined and null values", () => {
    const filter: Record<string, unknown> = {
      name: "test",
      organizationId: undefined,
      status: null,
    };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter)) {
      if (value !== undefined && value !== null) {
        result[key] = String(value);
      }
    }

    expect(Object.keys(result).length).toBe(1);
    expect(result.name).toBe("test");
  });

  it("should handle boolean values", () => {
    const filter: Record<string, boolean> = {
      active: true,
      archived: false,
    };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter)) {
      result[key] = String(value);
    }

    expect(result.active).toBe("true");
    expect(result.archived).toBe("false");
  });

  it("should handle numeric values", () => {
    const filter: Record<string, number> = {
      organizationId: 123,
      limit: 50,
    };

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(filter)) {
      result[key] = String(value);
    }

    expect(result.organizationId).toBe("123");
    expect(result.limit).toBe("50");
  });
});

describe("Region URL Mapping", () => {
  const REGION_URLS: Record<string, string> = {
    us: "https://api.itglue.com",
    eu: "https://api.eu.itglue.com",
    au: "https://api.au.itglue.com",
  };

  it("should map US region to correct URL", () => {
    expect(REGION_URLS.us).toBe("https://api.itglue.com");
  });

  it("should map EU region to correct URL", () => {
    expect(REGION_URLS.eu).toBe("https://api.eu.itglue.com");
  });

  it("should map AU region to correct URL", () => {
    expect(REGION_URLS.au).toBe("https://api.au.itglue.com");
  });

  it("should have exactly 3 regions", () => {
    expect(Object.keys(REGION_URLS).length).toBe(3);
  });
});

describe("Error Response Handling", () => {
  it("should format HTTP error with status code", () => {
    const status = 401;
    const body = "Unauthorized";

    const errorMessage = `IT Glue API error (${status}): ${body}`;

    expect(errorMessage).toBe("IT Glue API error (401): Unauthorized");
  });

  it("should format JSON:API errors", () => {
    const errors: Array<{ title: string; detail: string }> = [
      { title: "Validation Error", detail: "Name is required" },
      { title: "Validation Error", detail: "Email is invalid" },
    ];

    const errorMessages = errors.map((e) => e.detail || e.title).join(", ");

    expect(errorMessages).toBe("Name is required, Email is invalid");
  });

  it("should handle errors without detail", () => {
    const errors: Array<{ title: string; detail?: string }> = [{ title: "Internal Server Error" }];

    const errorMessages = errors.map((e) => e.detail || e.title).join(", ");

    expect(errorMessages).toBe("Internal Server Error");
  });

  it("should handle empty errors array", () => {
    const errors: Array<{ title?: string; detail?: string }> = [];

    const errorMessages = errors.map((e) => e.detail || e.title).join(", ");

    expect(errorMessages).toBe("");
  });

  it("should handle generic Error objects", () => {
    const error = new Error("Network timeout");

    const errorMessage = error instanceof Error ? error.message : String(error);

    expect(errorMessage).toBe("Network timeout");
  });

  it("should handle non-Error throws", () => {
    const error: unknown = "Something went wrong";

    const errorMessage = error instanceof Error ? error.message : String(error);

    expect(errorMessage).toBe("Something went wrong");
  });
});

describe("Query String Building", () => {
  it("should build empty query string for no params", () => {
    const params = {};
    const queryString = Object.keys(params).length === 0 ? "" : "?...";

    expect(queryString).toBe("");
  });

  it("should build filter query params", () => {
    const searchParams = new URLSearchParams();
    const filter: Record<string, string> = { name: "test" };

    for (const [key, value] of Object.entries(filter)) {
      searchParams.append(`filter[${key}]`, value);
    }

    expect(searchParams.toString()).toBe("filter%5Bname%5D=test");
  });

  it("should build pagination query params", () => {
    const searchParams = new URLSearchParams();
    const page: { size: number; number: number } = { size: 50, number: 2 };

    if (page.size) searchParams.append("page[size]", String(page.size));
    if (page.number) searchParams.append("page[number]", String(page.number));

    const query = searchParams.toString();
    expect(query).toContain("page%5Bsize%5D=50");
    expect(query).toContain("page%5Bnumber%5D=2");
  });

  it("should handle sort parameter", () => {
    const searchParams = new URLSearchParams();
    const sort = "-name";

    searchParams.append("sort", sort);

    expect(searchParams.toString()).toBe("sort=-name");
  });

  it("should combine multiple parameter types", () => {
    const searchParams = new URLSearchParams();

    searchParams.append("filter[name]", "test");
    searchParams.append("page[size]", "50");
    searchParams.append("page[number]", "1");
    searchParams.append("sort", "-name");

    const query = searchParams.toString();
    expect(query).toContain("filter%5Bname%5D=test");
    expect(query).toContain("page%5Bsize%5D=50");
    expect(query).toContain("page%5Bnumber%5D=1");
    expect(query).toContain("sort=-name");
  });
});

describe("MCP Response Format", () => {
  it("should format successful response with text content", () => {
    const data = { id: "123", name: "Test" };

    const response = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(data, null, 2),
        },
      ],
    };

    expect(response.content.length).toBe(1);
    expect(response.content[0].type).toBe("text");
    expect(JSON.parse(response.content[0].text)).toEqual(data);
  });

  it("should format error response with isError flag", () => {
    const response = {
      content: [
        {
          type: "text" as const,
          text: "Error: Organization ID is required",
        },
      ],
      isError: true,
    };

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("Error:");
  });

  it("should format no credentials error", () => {
    const response = {
      content: [
        {
          type: "text" as const,
          text: "Error: No API credentials provided. Please configure your IT Glue API key via the ITGLUE_API_KEY or X_API_KEY environment variable.",
        },
      ],
      isError: true,
    };

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("ITGLUE_API_KEY");
    expect(response.content[0].text).toContain("X_API_KEY");
  });

  it("should format unknown tool error", () => {
    const toolName = "nonexistent_tool";
    const response = {
      content: [
        {
          type: "text" as const,
          text: `Unknown tool: ${toolName}`,
        },
      ],
      isError: true,
    };

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toBe("Unknown tool: nonexistent_tool");
  });
});

describe("Health Check Response Format", () => {
  it("should format health check success response", () => {
    const healthResponse = {
      status: "ok",
      message: "IT Glue API is reachable",
      region: "us",
      organizationTypesFound: 5,
    };

    const response = {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(healthResponse, null, 2),
        },
      ],
    };

    const parsed = JSON.parse(response.content[0].text);
    expect(parsed.status).toBe("ok");
    expect(parsed.region).toBe("us");
    expect(parsed.organizationTypesFound).toBe(5);
  });
});

// Exercises the REAL MCP server end-to-end (ListTools + CallTool) over an
// in-memory transport pair, so these tests cover the actual tool-handler
// dispatch — not a re-implemented mock. fetch stays mocked underneath.
describe("Locations tools (round-trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function connectLocationsClient(): Promise<Client> {
    const server = createMcpServer({ apiKey: "test-api-key" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "locations-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function firstText(result: unknown): string {
    const r = result as { content?: Array<{ text?: string }> };
    return r.content?.[0]?.text ?? "";
  }

  function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
  }

  it("registers all four locations tools", async () => {
    const client = await connectLocationsClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "search_locations",
        "get_location",
        "create_location",
        "update_location",
      ])
    );
  });

  it("exposes 25 tools total", async () => {
    const client = await connectLocationsClient();
    const { tools } = await client.listTools();
    expect(tools.length).toBe(28);
  });

  it("search_locations queries /locations filtered by organization and city", async () => {
    const client = await connectLocationsClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(
        createJsonApiResponse([
          {
            id: "5",
            type: "locations",
            attributes: {
              name: "Primary Address",
              phone: "423-555-0100",
              city: "Chattanooga",
              primary: true,
            },
          },
        ])
      )
    );

    const result = await client.callTool({
      name: "search_locations",
      arguments: { organization_id: 8637099, city: "Chattanooga" },
    });

    // Decode first: buildQueryString uses URLSearchParams, which percent-encodes
    // the JSON:API filter brackets (filter%5Borganization-id%5D=...).
    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("/locations?");
    expect(url).toContain("filter[organization-id]=8637099");
    expect(url).toContain("filter[city]=Chattanooga");
    expect(firstText(result)).toContain("423-555-0100");
  });

  it("get_location fetches a single location by id", async () => {
    const client = await connectLocationsClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        data: {
          id: "5",
          type: "locations",
          attributes: { name: "HQ", phone: "423-555-0100" },
        },
      })
    );

    const result = await client.callTool({
      name: "get_location",
      arguments: { id: 5 },
    });

    expect(mockFetch.mock.calls[0][0]).toBe(
      "https://api.itglue.com/locations/5"
    );
    expect(firstText(result)).toContain("423-555-0100");
  });

  it("get_location returns an error when id is missing", async () => {
    const client = await connectLocationsClient();
    const result = await client.callTool({
      name: "get_location",
      arguments: {},
    });
    expect(isError(result)).toBe(true);
    expect(firstText(result).toLowerCase()).toContain("id is required");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("create_location posts attributes to the org locations relationship", async () => {
    const client = await connectLocationsClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        data: {
          id: "5",
          type: "locations",
          attributes: { name: "HQ", phone: "423-555-0100" },
        },
        meta: {},
      })
    );

    const result = await client.callTool({
      name: "create_location",
      arguments: {
        organization_id: 123,
        name: "HQ",
        phone: "423-555-0100",
        country_id: 1,
      },
    });

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.itglue.com/organizations/123/relationships/locations"
    );
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body as string)).toEqual({
      data: {
        type: "locations",
        attributes: { name: "HQ", phone: "423-555-0100", country_id: 1 },
      },
    });
    expect(firstText(result)).toContain("HQ");
  });

  it("create_location requires organization_id and name", async () => {
    const client = await connectLocationsClient();
    const result = await client.callTool({
      name: "create_location",
      arguments: { name: "HQ" },
    });
    expect(isError(result)).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("update_location patches only the supplied fields", async () => {
    const client = await connectLocationsClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        data: {
          id: "5",
          type: "locations",
          attributes: { phone: "423-555-9999" },
        },
        meta: {},
      })
    );

    const result = await client.callTool({
      name: "update_location",
      arguments: { organization_id: 123, id: 5, phone: "423-555-9999" },
    });

    const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://api.itglue.com/organizations/123/relationships/locations/5"
    );
    expect(options.method).toBe("PATCH");
    expect(JSON.parse(options.body as string)).toEqual({
      data: {
        type: "locations",
        attributes: { phone: "423-555-9999" },
      },
    });
    expect(firstText(result)).toContain("423-555-9999");
  });

  it("update_location requires at least one field to change", async () => {
    const client = await connectLocationsClient();
    const result = await client.callTool({
      name: "update_location",
      arguments: { organization_id: 123, id: 5 },
    });
    expect(isError(result)).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // unscopedSearchNote() is wired into search_locations as well as
  // search_passwords and search_configurations: when elicitation cannot reach
  // the client the handler drops org scoping, and "the Chattanooga office for
  // Acme" quietly becomes "every Chattanooga office in the account".
  it("flags an account-wide search when no organization_id was given", async () => {
    const client = await connectLocationsClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(
        createJsonApiResponse([
          { id: "5", type: "locations", attributes: { name: "Primary Address" } },
        ])
      )
    );

    const result = await client.callTool({
      name: "search_locations",
      arguments: { city: "Chattanooga" },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).not.toContain("filter[organization-id]");
    const text = firstText(result);
    expect(text).toContain("ALL organizations");
    expect(text.toLowerCase()).toContain("organization_id");
  });

  it("does not flag an organization-scoped search", async () => {
    const client = await connectLocationsClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(createJsonApiResponse([]))
    );

    const result = await client.callTool({
      name: "search_locations",
      arguments: { organization_id: 8637099 },
    });

    expect(firstText(result)).not.toContain("ALL organizations");
  });

  // See the equivalent search_configurations test: the warning must track the
  // filter that was actually sent, not the raw argument.
  it("flags the search when a falsy organization_id drops the filter", async () => {
    const client = await connectLocationsClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(createJsonApiResponse([]))
    );

    const result = await client.callTool({
      name: "search_locations",
      arguments: { organization_id: 0 },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).not.toContain("filter[organization-id]");
    expect(firstText(result)).toContain("ALL organizations");
  });
});

// Exercises the REAL password handlers (CallTool) over an in-memory transport
// pair. The previous "password" tests in this file mocked fetch and then called
// fetch directly, asserting on the mock's own payload — the search_passwords /
// get_password handlers were never executed, so the whole surface was
// effectively untested. fetch stays mocked underneath.
describe("Password tools (round-trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function connectPasswordClient(): Promise<Client> {
    const server = createMcpServer({ apiKey: "test-api-key" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "passwords-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function firstText(result: unknown): string {
    const r = result as { content?: Array<{ text?: string }> };
    return r.content?.[0]?.text ?? "";
  }

  function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
  }

  it("search_passwords scopes to the organization and forces show_password=false", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(
        createJsonApiResponse([
          {
            id: "1",
            type: "passwords",
            attributes: { name: "VPN Admin", username: "admin" },
          },
        ])
      )
    );

    const result = await client.callTool({
      name: "search_passwords",
      arguments: { organization_id: 8637099 },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("/passwords?");
    expect(url).toContain("filter[organization-id]=8637099");
    // Security: a list call must never ask IT Glue for secret material.
    expect(url).toContain("show_password=false");
    expect(firstText(result)).toContain("VPN Admin");
  });

  it("search_passwords never returns a password value even if the API sends one", async () => {
    // The fixture deliberately DOES carry a secret: show_password=false is a
    // request to IT Glue, not a guarantee, so the list tool has to redact on the
    // way out too. An earlier version of this test used a secret-free fixture
    // and therefore passed against a handler that had no redaction at all.
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(
        createJsonApiResponse([
          {
            id: "1",
            type: "passwords",
            attributes: {
              name: "VPN Admin",
              username: "admin",
              password: "hunter2",
            },
          },
        ])
      )
    );

    const result = await client.callTool({
      name: "search_passwords",
      arguments: { organization_id: 8637099 },
    });

    const text = firstText(result);
    expect(text).not.toContain("hunter2");
    // the rest of the record still comes through
    expect(text).toContain("VPN Admin");
    expect(text).toContain("admin");
  });

  it("get_password still returns the secret — redaction is list-only", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        data: {
          id: "55555",
          type: "passwords",
          attributes: { name: "Server Root", password: "hunter2" },
        },
      })
    );

    const result = await client.callTool({
      name: "get_password",
      arguments: { id: "55555" },
    });

    expect(firstText(result)).toContain("hunter2");
  });

  it("search_passwords passes name, username and category filters through", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(createJsonApiResponse([]))
    );

    await client.callTool({
      name: "search_passwords",
      arguments: {
        organization_id: 8637099,
        name: "VPN",
        username: "admin",
        password_category_id: 5,
      },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("filter[name]=VPN");
    expect(url).toContain("filter[username]=admin");
    expect(url).toContain("filter[password-category-id]=5");
  });

  it("get_password requests the secret value by default", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        data: {
          id: "55555",
          type: "passwords",
          attributes: { name: "Server Root", username: "root", password: "hunter2" },
        },
      })
    );

    const result = await client.callTool({
      name: "get_password",
      arguments: { id: "55555" },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("/passwords/55555");
    expect(url).toContain("show_password=true");
    expect(firstText(result)).toContain("hunter2");
  });

  it("get_password honours show_password=false", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse({
        data: {
          id: "55555",
          type: "passwords",
          attributes: { name: "Server Root", username: "root" },
        },
      })
    );

    await client.callTool({
      name: "get_password",
      arguments: { id: "55555", show_password: false },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("show_password=false");
  });

  it("get_password returns an error when id is missing", async () => {
    const client = await connectPasswordClient();
    const result = await client.callTool({
      name: "get_password",
      arguments: {},
    });
    expect(isError(result)).toBe(true);
    expect(firstText(result).toLowerCase()).toContain("id is required");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("flags an account-wide search when no organization_id was given and the client cannot be asked", async () => {
    // Through a gateway that does not proxy elicitation, elicitText() returns
    // null and the handler silently drops org scoping — a caller asking for
    // "the VPN password for Acme" gets an arbitrary slice of every org's
    // passwords and concludes the entry does not exist. The result must say so.
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(
        createJsonApiResponse([
          { id: "1", type: "passwords", attributes: { name: "VPN Admin" } },
        ])
      )
    );

    const result = await client.callTool({
      name: "search_passwords",
      arguments: { name: "VPN" },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).not.toContain("filter[organization-id]");
    const text = firstText(result);
    expect(text).toContain("ALL organizations");
    // and must not let the caller read an unscoped miss as "does not exist"
    expect(text.toLowerCase()).toContain("organization_id");
  });

  it("does not flag an organization-scoped search", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(createJsonApiResponse([]))
    );

    const result = await client.callTool({
      name: "search_passwords",
      arguments: { organization_id: 8637099 },
    });

    expect(firstText(result)).not.toContain("ALL organizations");
  });

  // See the equivalent search_configurations test: the warning must track the
  // filter that was actually sent, not the raw argument.
  it("flags the search when a falsy organization_id drops the filter", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(createJsonApiResponse([]))
    );

    const result = await client.callTool({
      name: "search_passwords",
      arguments: { organization_id: 0 },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).not.toContain("filter[organization-id]");
    expect(firstText(result)).toContain("ALL organizations");
  });

  it("surfaces an IT Glue 404 rather than reporting an empty result", async () => {
    const client = await connectPasswordClient();
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => '{"errors":[{"status":404,"title":"Not Found"}]}',
    } as Response);

    const result = await client.callTool({
      name: "get_password",
      arguments: { id: "does-not-exist" },
    });

    expect(isError(result)).toBe(true);
    expect(firstText(result)).toContain("404");
  });
});

// Round-trip coverage for the organization, configuration, flexible-asset and
// health-check tools. These handlers previously had no test that executed them
// at all: the suite called the fetch mock directly and asserted on the payload
// it had just supplied, so the tools could have been deleted outright and the
// suite would still have been green.
describe("Core tools (round-trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function connectCoreClient(): Promise<Client> {
    const server = createMcpServer({ apiKey: "test-api-key" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "core-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function firstText(result: unknown): string {
    const r = result as { content?: Array<{ text?: string }> };
    return r.content?.[0]?.text ?? "";
  }

  function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
  }

  function decodedUrl(callIndex = 0): string {
    return decodeURIComponent(mockFetch.mock.calls[callIndex][0] as string);
  }

  describe("search_organizations", () => {
    it("pages the unfiltered listing and returns the organizations", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            { id: "1", type: "organizations", attributes: { name: "Acme Corp" } },
            { id: "2", type: "organizations", attributes: { name: "Beta Inc" } },
          ])
        )
      );

      const result = await client.callTool({
        name: "search_organizations",
        arguments: {},
      });

      const url = decodedUrl();
      expect(url).toContain("/organizations?");
      expect(url).toContain("page[size]=50");
      expect(url).toContain("page[number]=1");
      expect(firstText(result)).toContain("Acme Corp");
    });

    it("passes the name filter through as filter[name]", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      await client.callTool({
        name: "search_organizations",
        arguments: { name: "Acme" },
      });

      expect(decodedUrl()).toContain("filter[name]=Acme");
    });

    it("kebab-cases the type/status filters and forwards sort and pagination", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      await client.callTool({
        name: "search_organizations",
        arguments: {
          organization_type_id: 7,
          organization_status_id: 9,
          sort: "-name",
          page_size: 25,
          page_number: 2,
        },
      });

      const url = decodedUrl();
      expect(url).toContain("filter[organization-type-id]=7");
      expect(url).toContain("filter[organization-status-id]=9");
      expect(url).toContain("sort=-name");
      expect(url).toContain("page[size]=25");
      expect(url).toContain("page[number]=2");
    });

    it("sends the API key and JSON:API headers on the handler's own request", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      await client.callTool({
        name: "search_organizations",
        arguments: { name: "Acme" },
      });

      const headers = (mockFetch.mock.calls[0][1] as RequestInit)
        .headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-api-key");
      expect(headers["Content-Type"]).toBe("application/vnd.api+json");
      expect(headers["Accept"]).toBe("application/vnd.api+json");
    });
  });

  describe("get_organization", () => {
    it("fetches a single organization by id", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: {
            id: "12345",
            type: "organizations",
            attributes: { name: "Acme Corp", "short-name": "ACME" },
          },
        })
      );

      const result = await client.callTool({
        name: "get_organization",
        arguments: { id: 12345 },
      });

      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://api.itglue.com/organizations/12345"
      );
      expect(firstText(result)).toContain("Acme Corp");
    });

    it("returns an error without calling the API when id is missing", async () => {
      const client = await connectCoreClient();
      const result = await client.callTool({
        name: "get_organization",
        arguments: {},
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("Organization ID is required");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("surfaces an IT Glue 404 as an error result", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(createErrorResponse(404, "Not Found"));

      const result = await client.callTool({
        name: "get_organization",
        arguments: { id: 999999 },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("404");
    });
  });

  describe("search_configurations", () => {
    it("scopes to the organization and returns the configurations", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            {
              id: "1",
              type: "configurations",
              attributes: { name: "Server-01", "serial-number": "SN12345" },
            },
          ])
        )
      );

      const result = await client.callTool({
        name: "search_configurations",
        arguments: { organization_id: 123 },
      });

      const url = decodedUrl();
      expect(url).toContain("/configurations?");
      expect(url).toContain("filter[organization-id]=123");
      expect(firstText(result)).toContain("SN12345");
    });

    it("kebab-cases every configuration filter it accepts", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      await client.callTool({
        name: "search_configurations",
        arguments: {
          organization_id: 1,
          name: "Laptop-01",
          configuration_type_id: 5,
          configuration_status_id: 6,
          serial_number: "ABC123",
          rmm_id: "rmm-1",
          psa_id: "psa-1",
        },
      });

      const url = decodedUrl();
      expect(url).toContain("filter[organization-id]=1");
      expect(url).toContain("filter[name]=Laptop-01");
      expect(url).toContain("filter[configuration-type-id]=5");
      expect(url).toContain("filter[configuration-status-id]=6");
      expect(url).toContain("filter[serial-number]=ABC123");
      expect(url).toContain("filter[rmm-id]=rmm-1");
      expect(url).toContain("filter[psa-id]=psa-1");
    });

    // unscopedSearchNote() is wired into search_configurations as well as
    // search_passwords: through a gateway that cannot proxy elicitation the
    // handler silently drops org scoping, and a caller asking for "the switch
    // at Acme" gets an arbitrary slice of every org's configurations.
    it("flags an account-wide search when no organization_id was given", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            { id: "1", type: "configurations", attributes: { name: "Server-01" } },
          ])
        )
      );

      const result = await client.callTool({
        name: "search_configurations",
        arguments: { name: "Server" },
      });

      expect(decodedUrl()).not.toContain("filter[organization-id]");
      const text = firstText(result);
      expect(text).toContain("ALL organizations");
      expect(text.toLowerCase()).toContain("organization_id");
    });

    it("does not flag an organization-scoped search", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      const result = await client.callTool({
        name: "search_configurations",
        arguments: { organization_id: 123 },
      });

      expect(firstText(result)).not.toContain("ALL organizations");
    });

    // The filter is applied under `if (orgId)` but the warning used to be gated
    // on `orgId === undefined`. A falsy-but-present id fell through the gap:
    // the org filter was dropped AND the warning suppressed — the exact silent
    // account-wide search the note exists to prevent.
    it("flags the search when a falsy organization_id drops the filter", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      const result = await client.callTool({
        name: "search_configurations",
        arguments: { organization_id: 0 },
      });

      expect(decodedUrl()).not.toContain("filter[organization-id]");
      expect(firstText(result)).toContain("ALL organizations");
    });
  });

  describe("get_configuration", () => {
    it("fetches a single configuration by id", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: {
            id: "99999",
            type: "configurations",
            attributes: { name: "Desktop-05", "ip-address": "192.168.1.100" },
          },
        })
      );

      const result = await client.callTool({
        name: "get_configuration",
        arguments: { id: 99999 },
      });

      expect(mockFetch.mock.calls[0][0]).toBe(
        "https://api.itglue.com/configurations/99999"
      );
      expect(firstText(result)).toContain("192.168.1.100");
    });

    it("returns an error without calling the API when id is missing", async () => {
      const client = await connectCoreClient();
      const result = await client.callTool({
        name: "get_configuration",
        arguments: {},
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("Configuration ID is required");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("list_flexible_asset_types", () => {
    it("lists the types with a 100-per-page window", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            {
              id: "5",
              type: "flexible-asset-types",
              attributes: { name: "SSL Certificate" },
            },
          ])
        )
      );

      const result = await client.callTool({
        name: "list_flexible_asset_types",
        arguments: {},
      });

      const url = decodedUrl();
      expect(url).toContain("/flexible_asset_types?");
      expect(url).toContain("page[size]=100");
      expect(url).not.toContain("filter[");
      expect(firstText(result)).toContain("SSL Certificate");
    });

    it("scopes the types to an organization when one is given", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      await client.callTool({
        name: "list_flexible_asset_types",
        arguments: { organization_id: 123 },
      });

      expect(decodedUrl()).toContain("filter[organization-id]=123");
    });
  });

  describe("search_flexible_assets", () => {
    it("refuses to search without flexible_asset_type_id", async () => {
      const client = await connectCoreClient();
      const result = await client.callTool({
        name: "search_flexible_assets",
        arguments: { organization_id: 1 },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("flexible_asset_type_id is required");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("filters by the flexible asset type id", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            {
              id: "1",
              type: "flexible-assets",
              attributes: { name: "Network Asset" },
            },
          ])
        )
      );

      const result = await client.callTool({
        name: "search_flexible_assets",
        arguments: { flexible_asset_type_id: 5 },
      });

      const url = decodedUrl();
      expect(url).toContain("/flexible_assets?");
      expect(url).toContain("filter[flexible-asset-type-id]=5");
      expect(firstText(result)).toContain("Network Asset");
    });

    it("adds the organization and name filters alongside the type", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(createJsonApiResponse([]))
      );

      await client.callTool({
        name: "search_flexible_assets",
        arguments: {
          flexible_asset_type_id: 5,
          organization_id: 123,
          name: "wildcard",
        },
      });

      const url = decodedUrl();
      expect(url).toContain("filter[flexible-asset-type-id]=5");
      expect(url).toContain("filter[organization-id]=123");
      expect(url).toContain("filter[name]=wildcard");
    });
  });

  describe("itglue_health_check", () => {
    it("probes /organization_types and reports the region and the count", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse(
            [
              {
                id: "1",
                type: "organization-types",
                attributes: { name: "Customer" },
              },
            ],
            { "total-count": 5 }
          )
        )
      );

      const result = await client.callTool({
        name: "itglue_health_check",
        arguments: {},
      });

      const url = decodedUrl();
      expect(url).toContain("/organization_types?");
      expect(url).toContain("page[size]=1");

      expect(isError(result)).toBe(false);
      const payload = JSON.parse(firstText(result));
      expect(payload).toMatchObject({
        status: "ok",
        region: "us",
        organizationTypesFound: 5,
      });
    });

    it("reports an authentication failure as an error result", async () => {
      const client = await connectCoreClient();
      mockFetch.mockResolvedValueOnce(
        createErrorResponse(401, "Invalid API Key")
      );

      const result = await client.callTool({
        name: "itglue_health_check",
        arguments: {},
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("401");
      expect(firstText(result)).toContain("Invalid API Key");
    });

    it("reports an unreachable API as an error result", async () => {
      const client = await connectCoreClient();
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const result = await client.callTool({
        name: "itglue_health_check",
        arguments: {},
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("Network error");
    });
  });
});

// Round-trip coverage for the document section / lifecycle tools. The previous
// tests here asserted on request payloads the test itself had built; one of
// them ("should include resource relationship in document section payload")
// asserted the exact opposite of what the handler does, because it was never
// run against the handler.
describe("Document section tools (round-trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function connectSectionsClient(): Promise<Client> {
    const server = createMcpServer({ apiKey: "test-api-key" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "sections-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function firstText(result: unknown): string {
    const r = result as { content?: Array<{ text?: string }> };
    return r.content?.[0]?.text ?? "";
  }

  function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
  }

  function requestOf(callIndex = 0): { url: string; init: RequestInit } {
    const [url, init] = mockFetch.mock.calls[callIndex];
    return { url: url as string, init: init as RequestInit };
  }

  function bodyOf(callIndex = 0): Record<string, unknown> {
    return JSON.parse(requestOf(callIndex).init.body as string);
  }

  describe("list_document_sections", () => {
    it("reads the document's sections relationship", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            {
              id: "1001",
              type: "document-sections",
              attributes: { content: "<h2>Overview</h2>", position: 1 },
            },
          ])
        )
      );

      const result = await client.callTool({
        name: "list_document_sections",
        arguments: { document_id: 789 },
      });

      expect(requestOf().url).toBe(
        "https://api.itglue.com/documents/789/relationships/sections"
      );
      expect(requestOf().init.method).toBe("GET");
      expect(firstText(result)).toContain("Overview");
    });

    it("returns an error without calling the API when document_id is missing", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "list_document_sections",
        arguments: {},
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("document_id is required");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("create_document_section", () => {
    // IT Glue stores the section kind in the `resource_type` ATTRIBUTE. A
    // `relationships.resource` binding is rejected with a 400 for a missing
    // `resource_type` (verified live 2026-04-23), so the payload must carry the
    // attribute and no relationships member.
    it.each([
      ["heading", "Document::Heading"],
      ["text", "Document::Text"],
    ])("maps section_type '%s' to resource_type %s", async (arg, apiValue) => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: {
            id: "1003",
            type: "document-sections",
            attributes: { content: "<p>New section.</p>" },
          },
        })
      );

      await client.callTool({
        name: "create_document_section",
        arguments: {
          document_id: 789,
          section_type: arg,
          content: "<p>New section.</p>",
        },
      });

      const { url, init } = requestOf();
      expect(url).toBe(
        "https://api.itglue.com/documents/789/relationships/sections"
      );
      expect(init.method).toBe("POST");

      const body = bodyOf() as {
        data: {
          type: string;
          attributes: Record<string, unknown>;
          relationships?: unknown;
        };
      };
      expect(body.data.type).toBe("document-sections");
      expect(body.data.attributes.resource_type).toBe(apiValue);
      expect(body.data.attributes.content).toBe("<p>New section.</p>");
      expect(body.data.relationships).toBeUndefined();
    });

    it("rejects a section_type outside heading/text before calling the API", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "create_document_section",
        arguments: {
          document_id: 789,
          section_type: "table",
          content: "<p>x</p>",
        },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("'heading' or 'text'");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("requires document_id, section_type and content", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "create_document_section",
        arguments: { document_id: 789 },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain(
        "document_id, section_type, and content are required"
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("surfaces an IT Glue 400 instead of reporting a created section", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createErrorResponse(
          400,
          JSON.stringify({
            errors: [
              {
                title: "Bad Request",
                detail: "param is missing or the value is empty: resource_type",
                status: "400",
              },
            ],
          })
        )
      );

      const result = await client.callTool({
        name: "create_document_section",
        arguments: {
          document_id: 789,
          section_type: "text",
          content: "<p>x</p>",
        },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("400");
      expect(firstText(result)).toContain("resource_type");
    });
  });

  describe("update_document_section", () => {
    it("PATCHes the section with the new content", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: {
            id: "1002",
            type: "document-sections",
            attributes: { content: "<p>Updated.</p>" },
          },
        })
      );

      const result = await client.callTool({
        name: "update_document_section",
        arguments: {
          document_id: 789,
          section_id: 1002,
          content: "<p>Updated.</p>",
        },
      });

      const { url, init } = requestOf();
      expect(url).toBe(
        "https://api.itglue.com/documents/789/relationships/sections/1002"
      );
      expect(init.method).toBe("PATCH");
      expect(bodyOf()).toEqual({
        data: {
          type: "document-sections",
          attributes: { content: "<p>Updated.</p>" },
        },
      });
      expect(firstText(result)).toContain("Updated.");
    });

    it("requires document_id, section_id and content", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "update_document_section",
        arguments: { document_id: 789, section_id: 1002 },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain(
        "document_id, section_id, and content are required"
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("create_document_image", () => {
    it("POSTs base64 content to the document's document_images relationship", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: {
            id: "5001",
            type: "document_images",
            attributes: { "file-name": "architecture.png" },
          },
        })
      );

      await client.callTool({
        name: "create_document_image",
        arguments: {
          document_id: 789,
          file_name: "architecture.png",
          content: "aGVsbG8=",
        },
      });

      const { url, init } = requestOf();
      expect(url).toBe(
        "https://api.itglue.com/documents/789/relationships/document_images"
      );
      expect(init.method).toBe("POST");

      const body = bodyOf() as {
        data: { type: string; attributes: { image: Record<string, unknown> } };
      };
      expect(body.data.type).toBe("document_images");
      expect(body.data.attributes.image.content).toBe("aGVsbG8=");
      expect(body.data.attributes.image.file_name).toBe("architecture.png");
    });

    // IT Glue stores whatever it is given, so a data: prefix left on the front
    // uploads without complaint and yields a corrupt file that only surfaces
    // when somebody opens it.
    it("strips a data: URI prefix rather than storing a corrupt file", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({ data: { id: "5002", type: "document_images" } })
      );

      await client.callTool({
        name: "create_document_image",
        arguments: {
          document_id: 789,
          file_name: "diagram.png",
          content: "data:image/png;base64,aGVsbG8=",
        },
      });

      const body = bodyOf() as {
        data: { attributes: { image: Record<string, unknown> } };
      };
      expect(body.data.attributes.image.content).toBe("aGVsbG8=");
    });

    it("requires document_id, file_name and content", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "create_document_image",
        arguments: { document_id: 789 },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("required");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("create_attachment", () => {
    it("POSTs to the resource's attachments relationship", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: { id: "6001", type: "attachments", attributes: { "file-name": "runbook.pdf" } },
        })
      );

      await client.callTool({
        name: "create_attachment",
        arguments: {
          resource_type: "configurations",
          resource_id: 4242,
          file_name: "runbook.pdf",
          content: "aGVsbG8=",
        },
      });

      const { url, init } = requestOf();
      expect(url).toBe(
        "https://api.itglue.com/configurations/4242/relationships/attachments"
      );
      expect(init.method).toBe("POST");

      const body = bodyOf() as {
        data: { type: string; attributes: { attachment: Record<string, unknown> } };
      };
      expect(body.data.type).toBe("attachments");
      expect(body.data.attributes.attachment.content).toBe("aGVsbG8=");
      expect(body.data.attributes.attachment.file_name).toBe("runbook.pdf");
    });

    it("rejects a resource_type IT Glue does not accept attachments on", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "create_attachment",
        arguments: {
          resource_type: "organizations",
          resource_id: 1,
          file_name: "x.png",
          content: "aGVsbG8=",
        },
      });

      expect(isError(result)).toBe(true);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("list_attachments", () => {
    it("GETs the resource's attachments relationship", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            { id: "6001", type: "attachments", attributes: { "file-name": "runbook.pdf" } },
          ])
        )
      );

      await client.callTool({
        name: "list_attachments",
        arguments: { resource_type: "documents", resource_id: 789 },
      });

      const { url, init } = requestOf();
      expect(url).toContain(
        "https://api.itglue.com/documents/789/relationships/attachments"
      );
      expect(init.method ?? "GET").toBe("GET");
    });
  });

  describe("delete_document_section", () => {
    it("DELETEs the section and confirms by id", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(createMockResponse(null, 204));

      const result = await client.callTool({
        name: "delete_document_section",
        arguments: { document_id: 789, section_id: 1002 },
      });

      const { url, init } = requestOf();
      expect(url).toBe(
        "https://api.itglue.com/documents/789/relationships/sections/1002"
      );
      expect(init.method).toBe("DELETE");
      expect(isError(result)).toBe(false);
      expect(firstText(result)).toContain("Section 1002 deleted successfully");
    });

    it("requires document_id and section_id", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "delete_document_section",
        arguments: { document_id: 789 },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain(
        "document_id and section_id are required"
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("publish_document", () => {
    // POST /documents/:id/publish returns 404 — the verb is load-bearing.
    it("PATCHes /documents/:id/publish", async () => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: {
            id: "789",
            type: "documents",
            attributes: { name: "My Doc", published: true },
          },
        })
      );

      const result = await client.callTool({
        name: "publish_document",
        arguments: { document_id: 789 },
      });

      const { url, init } = requestOf();
      expect(url).toBe("https://api.itglue.com/documents/789/publish");
      expect(init.method).toBe("PATCH");
      expect(firstText(result)).toContain("My Doc");
    });

    it("requires document_id", async () => {
      const client = await connectSectionsClient();
      const result = await client.callTool({
        name: "publish_document",
        arguments: {},
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("document_id is required");
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe("archive_document / unarchive_document", () => {
    // Pins the URL, verb and payload so a refactor can't silently omit
    // `archived` or invent a non-existent /archive sub-endpoint.
    it.each([
      ["archive_document", true],
      ["unarchive_document", false],
    ])("%s PATCHes /documents/:id with archived=%s", async (tool, archived) => {
      const client = await connectSectionsClient();
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: { id: "789", type: "documents", attributes: { archived } },
        })
      );

      await client.callTool({
        name: tool as string,
        arguments: { document_id: 789 },
      });

      const { url, init } = requestOf();
      expect(url).toBe("https://api.itglue.com/documents/789");
      expect(init.method).toBe("PATCH");
      expect(bodyOf()).toEqual({
        data: { type: "documents", attributes: { archived } },
      });
    });

    it.each(["archive_document", "unarchive_document"])(
      "%s requires document_id",
      async (tool) => {
        const client = await connectSectionsClient();
        const result = await client.callTool({ name: tool, arguments: {} });

        expect(isError(result)).toBe(true);
        expect(firstText(result)).toContain("document_id is required");
        expect(mockFetch).not.toHaveBeenCalled();
      }
    );
  });
});

// Issue #55 round-trip coverage: exercises the REAL MCP server (CallTool) over
// an in-memory transport pair so the API-key-first / JWT-fallback ordering in
// the actual handlers is what's under test. fetch stays mocked underneath.
describe("Document folder access (API-key-first, round-trip)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function connectClient(credentials: {
    apiKey?: string;
    jwt?: string;
  }): Promise<Client> {
    const server = createMcpServer(credentials);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "folders-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function firstText(result: unknown): string {
    const r = result as { content?: Array<{ text?: string }> };
    return r.content?.[0]?.text ?? "";
  }

  function isError(result: unknown): boolean {
    return (result as { isError?: boolean }).isError === true;
  }

  function decodedUrl(callIndex: number): string {
    return decodeURIComponent(mockFetch.mock.calls[callIndex][0] as string);
  }

  function headersOf(callIndex: number): Record<string, string> {
    return (mockFetch.mock.calls[callIndex][1] as RequestInit)
      .headers as Record<string, string>;
  }

  describe("search_documents", () => {
    it("defaults to filter[document_folder_id]=null and surfaces each doc's folder id", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            {
              id: "1",
              type: "documents",
              attributes: { name: "Foldered Doc", "document-folder-id": 42 },
            },
            {
              id: "2",
              type: "documents",
              attributes: { name: "Root Doc", "document-folder-id": null },
            },
          ])
        )
      );

      const result = await client.callTool({
        name: "search_documents",
        arguments: { organization_id: 123 },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(decodedUrl(0)).toContain("filter[document_folder_id]=null");
      const text = firstText(result);
      expect(text).toContain("includes documents inside folders");
      expect(text).not.toContain("ROOT-LEVEL");
      // Folder membership is surfaced on each returned document.
      expect(text).toContain('"documentFolderId": 42');
    });

    it("omits heavy document body content from list results (metadata only)", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      // IT Glue's documents list endpoint embeds each document's full sectioned
      // body in a `content` array. Passing that straight through makes list
      // responses enormous (a single foldered org can exceed the MCP client's
      // limit and hang with no error — issue #55). search_documents is a
      // LIST/SEARCH tool: it must return lightweight metadata, not full bodies.
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            {
              id: "1",
              type: "documents",
              attributes: {
                name: "Change Management SOP",
                "document-folder-id": 42,
                content: [
                  { id: 9, resource: { content: "<p>HEAVY_BODY_MARKER</p>" } },
                ],
              },
            },
          ])
        )
      );

      const result = await client.callTool({
        name: "search_documents",
        arguments: { organization_id: 123 },
      });

      const text = firstText(result);
      // Metadata the model needs to list/locate documents is preserved.
      expect(text).toContain("Change Management SOP");
      expect(text).toContain('"documentFolderId": 42');
      // The full body is NOT inlined — it belongs to get_document.
      expect(text).not.toContain("HEAVY_BODY_MARKER");
      expect(text).not.toContain('"content"');
    });

    it("issues a single kebab-case filter request for an explicit document_folder_id", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            {
              id: "1",
              type: "documents",
              attributes: {
                name: "Doc",
                content: [{ id: 9, resource: { content: "HEAVY_BODY_MARKER" } }],
              },
            },
          ])
        )
      );

      const result = await client.callTool({
        name: "search_documents",
        arguments: { organization_id: 123, document_folder_id: 42 },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(decodedUrl(0)).toContain("filter[document-folder-id]=42");
      expect(decodedUrl(0)).not.toContain("filter[document_folder_id]=null");
      // No folder-inclusive caveat for an explicit scope, but bodies are still
      // stripped (the per-folder listing inlines full bodies too — issue #55).
      const text = firstText(result);
      expect(text).not.toContain("includes documents inside folders");
      expect(text).toContain("document bodies are omitted");
      expect(text).not.toContain("HEAVY_BODY_MARKER");
    });

    it("degrades 400 → [ne] filter and still reports foldered docs included", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(400, "bad filter"))
        .mockResolvedValueOnce(
          createMockResponse(
            createJsonApiResponse([
              { id: "1", type: "documents", attributes: { name: "Doc" } },
            ])
          )
        );

      const result = await client.callTool({
        name: "search_documents",
        arguments: { organization_id: 123 },
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(decodedUrl(1)).toContain("filter[document_folder_id][ne]=");
      expect(firstText(result)).toContain("includes documents inside folders");
    });

    it("degrades 400 → 422 → unfiltered and keeps the root-level-only warning", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(400, "bad filter"))
        .mockResolvedValueOnce(createErrorResponse(422, "unprocessable"))
        .mockResolvedValueOnce(
          createMockResponse(
            createJsonApiResponse([
              { id: "1", type: "documents", attributes: { name: "Root Doc" } },
            ])
          )
        );

      const result = await client.callTool({
        name: "search_documents",
        arguments: { organization_id: 123 },
      });

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(decodedUrl(2)).not.toContain("document_folder_id");
      const text = firstText(result);
      expect(text).toContain("ROOT-LEVEL");
      expect(text).toContain("meta.total-count");
    });

    it("still maps a 404 to the Documents-module-missing message (no degradation)", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch.mockResolvedValueOnce(createErrorResponse(404, "Not Found"));

      const result = await client.callTool({
        name: "search_documents",
        arguments: { organization_id: 123 },
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("Documents module");
    });
  });

  // search_documents strips bodies to stay small, so the full document body MUST
  // remain reachable through get_document — that is the read path the list tool
  // points callers to. This pins it so a future change can't silently strip the
  // read path too (issue #55).
  describe("get_document (full-body read path)", () => {
    it("returns the complete document body, unstripped", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch.mockResolvedValueOnce(
        createMockResponse({
          data: {
            id: "20022034",
            type: "documents",
            attributes: {
              name: "00-1 READ ME",
              "document-folder-id": 6262993,
              content: [
                { id: 9, resource: { content: "<p>FULL_BODY_MARKER</p>" } },
              ],
            },
          },
          meta: {},
        })
      );

      const result = await client.callTool({
        name: "get_document",
        arguments: { organization_id: 8250506, id: 20022034 },
      });

      const text = firstText(result);
      // The body the list tool omits is present here in full.
      expect(text).toContain("FULL_BODY_MARKER");
      expect(text).toContain('"content"');
      expect(text).toContain("00-1 READ ME");
      // Fetched from the single-document relationship endpoint.
      expect(decodedUrl(0)).toContain(
        "/organizations/8250506/relationships/documents/20022034"
      );
    });
  });

  describe("list_document_folders", () => {
    it("succeeds with the API key alone (no JWT involved)", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
          ])
        )
      );

      const result = await client.callTool({
        name: "list_document_folders",
        arguments: { organization_id: 123 },
      });

      expect(isError(result)).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(decodedUrl(0)).toContain(
        "/organizations/123/relationships/document_folders"
      );
      expect(headersOf(0)["x-api-key"]).toBe("test-api-key");
      expect(headersOf(0)["Authorization"]).toBeUndefined();
      expect(firstText(result)).toContain("Runbooks");
    });

    it("prefers the API key even when a JWT is also configured", async () => {
      const client = await connectClient({ apiKey: "test-api-key", jwt: "test-jwt" });
      mockFetch.mockResolvedValueOnce(
        createMockResponse(
          createJsonApiResponse([
            { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
          ])
        )
      );

      const result = await client.callTool({
        name: "list_document_folders",
        arguments: { organization_id: 123 },
      });

      expect(isError(result)).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(headersOf(0)["x-api-key"]).toBe("test-api-key");
      expect(headersOf(0)["Authorization"]).toBeUndefined();
    });

    it("falls back to the top-level /document_folders path when the relationship path 404s", async () => {
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(404, "Not Found"))
        .mockResolvedValueOnce(
          createMockResponse(
            createJsonApiResponse([
              { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
            ])
          )
        );

      const result = await client.callTool({
        name: "list_document_folders",
        arguments: { organization_id: 123 },
      });

      expect(isError(result)).toBe(false);
      expect(decodedUrl(1)).toContain("/document_folders?");
      expect(decodedUrl(1)).toContain("filter[organization_id]=123");
    });

    it("falls back to the configured JWT when the API key is rejected with 403", async () => {
      const client = await connectClient({ apiKey: "test-api-key", jwt: "test-jwt" });
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(403, "Forbidden"))
        .mockResolvedValueOnce(
          createMockResponse(
            createJsonApiResponse([
              { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
            ])
          )
        );

      const result = await client.callTool({
        name: "list_document_folders",
        arguments: { organization_id: 123 },
      });

      expect(isError(result)).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(headersOf(0)["x-api-key"]).toBe("test-api-key");
      expect(headersOf(1)["Authorization"]).toBe("Bearer test-jwt");
      expect(firstText(result)).toContain("Runbooks");
    });

    it("returns an actionable error when the API key is rejected and no JWT is available", async () => {
      // The in-memory test client does not support elicitation, so the JWT
      // prompt yields nothing — the neither-credential-works path.
      const client = await connectClient({ apiKey: "test-api-key" });
      mockFetch.mockResolvedValueOnce(createErrorResponse(403, "Forbidden"));

      const result = await client.callTool({
        name: "list_document_folders",
        arguments: { organization_id: 123 },
      });

      expect(isError(result)).toBe(true);
      const text = firstText(result);
      expect(text).toContain("Document Folders");
      expect(text).toContain("ITGLUE_JWT");
      expect(text).toContain("fallback");
    });

    it("clears the cached JWT when IT Glue rejects it with 401 (existing behavior)", async () => {
      const client = await connectClient({ apiKey: "test-api-key", jwt: "stale-jwt" });
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(403, "Forbidden")) // API key
        .mockResolvedValueOnce(createErrorResponse(401, "Unauthorized")); // stale JWT

      const result = await client.callTool({
        name: "list_document_folders",
        arguments: { organization_id: 123 },
      });

      expect(isError(result)).toBe(true);
      expect(firstText(result)).toContain("expired");
    });
  });

  describe("create_document folder picker", () => {
    it("enumerates folders with the API key first", async () => {
      const client = await connectClient({ apiKey: "test-api-key", jwt: "test-jwt" });
      mockFetch
        .mockResolvedValueOnce(
          createMockResponse(
            createJsonApiResponse([
              { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
            ])
          )
        )
        // Picker elicitation is unsupported by the test client → folderId stays
        // undefined → the document is created at the root.
        .mockResolvedValueOnce(
          createMockResponse({
            data: { id: "99", type: "documents", attributes: { name: "New Doc" } },
          })
        );

      const result = await client.callTool({
        name: "create_document",
        arguments: { organization_id: 123, name: "New Doc" },
      });

      expect(isError(result)).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(2);
      // Folder enumeration used the API key, not the configured JWT.
      expect(decodedUrl(0)).toContain(
        "/organizations/123/relationships/document_folders"
      );
      expect(headersOf(0)["x-api-key"]).toBe("test-api-key");
      expect(headersOf(0)["Authorization"]).toBeUndefined();
      expect(decodedUrl(1)).toContain("/organizations/123/relationships/documents");
    });

    it("falls back to the configured JWT for folder enumeration when the API key is rejected", async () => {
      const client = await connectClient({ apiKey: "test-api-key", jwt: "test-jwt" });
      mockFetch
        .mockResolvedValueOnce(createErrorResponse(403, "Forbidden")) // API key
        .mockResolvedValueOnce(
          createMockResponse(
            createJsonApiResponse([
              { id: "10", type: "document-folders", attributes: { name: "Runbooks" } },
            ])
          )
        )
        .mockResolvedValueOnce(
          createMockResponse({
            data: { id: "99", type: "documents", attributes: { name: "New Doc" } },
          })
        );

      const result = await client.callTool({
        name: "create_document",
        arguments: { organization_id: 123, name: "New Doc" },
      });

      expect(isError(result)).toBe(false);
      expect(headersOf(0)["x-api-key"]).toBe("test-api-key");
      expect(headersOf(1)["Authorization"]).toBe("Bearer test-jwt");
    });
  });
});

describe("user metrics", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  async function connectClient(): Promise<Client> {
    const server = createMcpServer({ apiKey: "test-api-key" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "user-metrics-test", version: "1.0.0" });
    await client.connect(clientTransport);
    return client;
  }

  function textOf(result: unknown): string {
    const r = result as { content?: Array<{ text?: string }> };
    return r.content?.[0]?.text ?? "";
  }

  describe("buildUserMetricsDateFilter", () => {
    it("returns null when neither bound is given, so the filter is omitted", () => {
      expect(buildUserMetricsDateFilter(undefined, undefined)).toEqual({ value: null });
    });

    it("allows an open END, which IT Glue accepts", () => {
      // Verified live 2026-08-06: "2026-08-01,*" → 200.
      expect(buildUserMetricsDateFilter("2026-01-01", undefined)).toEqual({
        value: "2026-01-01,*",
      });
    });

    it("refuses an open START, which IT Glue rejects outright", () => {
      // Verified live 2026-08-06: "*,2026-08-07" → 422 "cannot start with a
      // wildcard". An end_date alone is a guaranteed error, not a narrowing.
      const result = buildUserMetricsDateFilter(undefined, "2026-01-07");
      expect((result as { error: string }).error).toContain("requires a start_date");
    });

    it("accepts a 7-day end-to-start difference (8 calendar days)", () => {
      // Verified live 2026-08-06: 2026-08-01,2026-08-08 → 200. The server
      // compares the difference, not the inclusive count, so this is legal.
      expect(buildUserMetricsDateFilter("2026-01-01", "2026-01-08")).toEqual({
        value: "2026-01-01,2026-01-08",
      });
    });

    it("rejects an 8-day difference, matching the live 422 boundary", () => {
      // Verified live 2026-08-06: 2026-08-01,2026-08-09 → 422.
      const result = buildUserMetricsDateFilter("2026-01-01", "2026-01-09");
      expect(result).toHaveProperty("error");
      expect((result as { error: string }).error).toContain("8 days");
      expect((result as { error: string }).error).toContain("at most 7");
      // Names the widest legal end for this start, so the caller can retry.
      expect((result as { error: string }).error).toContain("2026-01-08");
    });

    it("rejects an inverted range", () => {
      const result = buildUserMetricsDateFilter("2026-01-07", "2026-01-01");
      expect((result as { error: string }).error).toContain("before start_date");
    });

    it("rejects a non-ISO date rather than forwarding it", () => {
      const result = buildUserMetricsDateFilter("01/01/2026", undefined);
      expect((result as { error: string }).error).toContain("YYYY-MM-DD");
    });
  });

  it("queries /user_metrics with kebab-case filters and a composed date range", async () => {
    const client = await connectClient();
    mockFetch.mockResolvedValueOnce(
      createMockResponse(
        createJsonApiResponse([
          {
            id: "1",
            type: "user_metrics",
            attributes: {
              "user-id": 42,
              "organization-id": 8637099,
              "resource-type": "Configuration",
              created: 3,
              viewed: 17,
              edited: 2,
              deleted: 0,
              date: "2026-01-02",
            },
          },
        ])
      )
    );

    const result = await client.callTool({
      name: "search_user_metrics",
      arguments: {
        user_id: 42,
        organization_id: 8637099,
        resource_type: "Configuration",
        start_date: "2026-01-01",
        end_date: "2026-01-08",
      },
    });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("/user_metrics?");
    expect(url).toContain("filter[user-id]=42");
    expect(url).toContain("filter[organization-id]=8637099");
    expect(url).toContain("filter[resource-type]=Configuration");
    expect(url).toContain("filter[date]=2026-01-01,2026-01-08");
    expect(textOf(result)).toContain("Configuration");
  });

  it("omits filter[date] entirely when no dates are supplied", async () => {
    const client = await connectClient();
    mockFetch.mockResolvedValueOnce(createMockResponse(createJsonApiResponse([])));

    await client.callTool({ name: "search_user_metrics", arguments: { user_id: 42 } });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("filter[user-id]=42");
    expect(url).not.toContain("filter[date]");
  });

  it("rejects an over-long range without calling the API", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "search_user_metrics",
      arguments: { start_date: "2026-01-01", end_date: "2026-02-01" },
    });

    // The point of the client-side cap: no wasted call, and an actionable
    // message instead of IT Glue's generic 4xx.
    expect(mockFetch).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("at most 7");
  });

  it("rejects an unsupported sort field without calling the API", async () => {
    const client = await connectClient();

    const result = await client.callTool({
      name: "search_user_metrics",
      arguments: { sort: "-organization_id" },
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain("sort must be one of");
  });

  it("accepts a descending sort on a supported field", async () => {
    const client = await connectClient();
    mockFetch.mockResolvedValueOnce(createMockResponse(createJsonApiResponse([])));

    await client.callTool({ name: "search_user_metrics", arguments: { sort: "-date" } });

    const url = decodeURIComponent(mockFetch.mock.calls[0][0] as string);
    expect(url).toContain("sort=-date");
  });
});
