/**
 * Side-effect-free MCP server factory for IT Glue.
 *
 * Importing this module never starts a transport, so it can be reused by every
 * entrypoint:
 * - `index.ts`  — stdio + Node HTTP transport
 * - `worker.ts` — Cloudflare Workers (Web Standard) transport
 *
 * IT Glue is called directly over the global `fetch` API (no vendor SDK), so
 * this module runs natively on the Workers runtime.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { elicitSelection, elicitText } from "./utils/elicitation.js";
import { registerPromptHandlers } from "./prompts.js";
import { registerResourceHandlers } from "./resources.js";
import { buildDocumentCard, DOCUMENT_CARD_META } from "./card.builder.js";


// IT Glue region configuration
export type ITGlueRegion = "us" | "eu" | "au";

const REGION_URLS: Record<ITGlueRegion, string> = {
  us: "https://api.itglue.com",
  eu: "https://api.eu.itglue.com",
  au: "https://api.au.itglue.com",
};

// JSON:API types
interface JsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data: unknown }>;
}

interface JsonApiResponse {
  data: JsonApiResource | JsonApiResource[];
  meta?: {
    "current-page"?: number;
    "next-page"?: number | null;
    "prev-page"?: number | null;
    "total-pages"?: number;
    "total-count"?: number;
  };
  included?: JsonApiResource[];
  errors?: Array<{
    title?: string;
    detail?: string;
    status?: string;
  }>;
}

interface PaginationMeta {
  currentPage: number;
  nextPage: number | null;
  prevPage: number | null;
  totalPages: number;
  totalCount: number;
}

// Utility functions for JSON:API
function kebabToCamel(str: string): string {
  return str.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Sort fields /user_metrics accepts, per the IT Glue developer docs. */
export const USER_METRIC_SORT_FIELDS = [
  "id",
  "created",
  "viewed",
  "edited",
  "deleted",
  "date",
] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Maximum end-minus-start difference IT Glue accepts on `filter[date]`.
 *
 * Verified live 2026-08-06 against api.itglue.com by bisection:
 *   2026-08-01,2026-08-08  (diff 7) → 200
 *   2026-08-01,2026-08-09  (diff 8) → 422
 * So the server compares the *difference*, not the inclusive day count — a
 * range spanning 8 calendar days is legal. The docs' phrase "longer than a
 * week" is the difference, and reading it as an inclusive count (7 days) is
 * off by one in the direction that rejects valid queries.
 */
const USER_METRICS_MAX_RANGE_DIFF_DAYS = 7;

/**
 * Build the `filter[date]` value for /user_metrics, or return an error string.
 *
 * IT Glue expects `start,end` with `*` for an open boundary. Two rules are
 * enforced here rather than left to the API, both verified live 2026-08-06:
 *
 *  1. **Range cap.** A difference over 7 days returns 422 with the title
 *     "date range filter cannot be longer than a week, and cannot start with
 *     a wildcard" — one message for two distinct faults, so it cannot tell a
 *     caller which one they hit. We say which.
 *
 *  2. **No open start.** `*,2026-08-07` is rejected outright (422); only the
 *     END may be a wildcard. `2026-08-01,*` and the degenerate `*,*` both
 *     return 200. So an `end_date` without a `start_date` is not a narrower
 *     query — it is a guaranteed error, and we refuse it before the call.
 *
 * Returns null when neither bound is supplied, so the caller omits the filter
 * and lets IT Glue apply its own default window.
 */
export function buildUserMetricsDateFilter(
  startDate?: string,
  endDate?: string
): { value: string | null } | { error: string } {
  for (const [label, value] of [
    ["start_date", startDate],
    ["end_date", endDate],
  ] as const) {
    if (value !== undefined && !ISO_DATE.test(value)) {
      return { error: `${label} must be in YYYY-MM-DD format (got "${value}")` };
    }
  }

  if (!startDate && !endDate) return { value: null };

  if (!startDate && endDate) {
    return {
      error:
        `end_date requires a start_date. IT Glue rejects a date filter that begins with a ` +
        `wildcard ("*,${endDate}" → 422), so an open start is not a valid narrowing — ` +
        `supply start_date, or omit both to use the default window.`,
    };
  }

  if (startDate && endDate) {
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      return { error: "start_date and end_date must be valid calendar dates" };
    }
    if (end < start) {
      return { error: `end_date (${endDate}) is before start_date (${startDate})` };
    }
    const diffDays = Math.round((end - start) / 86_400_000);
    if (diffDays > USER_METRICS_MAX_RANGE_DIFF_DAYS) {
      return {
        error:
          `Date range spans ${diffDays} days end-to-start; IT Glue allows at most ` +
          `${USER_METRICS_MAX_RANGE_DIFF_DAYS} (so ${startDate} through ` +
          `${new Date(start + USER_METRICS_MAX_RANGE_DIFF_DAYS * 86_400_000).toISOString().slice(0, 10)} ` +
          `is the widest window from this start). Narrow the range and page through it.`,
      };
    }
  }

  return { value: `${startDate},${endDate ?? "*"}` };
}

function convertKeysToCamel(obj: Record<string, unknown>): Record<string, unknown> {
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
}

function deserializeResource(resource: JsonApiResource): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: resource.id,
    type: resource.type,
  };
  if (resource.attributes) {
    Object.assign(result, convertKeysToCamel(resource.attributes));
  }
  return result;
}

function buildFilterParams(filter: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null) continue;
    const kebabKey = camelToKebab(key);
    if (typeof value === "object" && !Array.isArray(value)) {
      // JSON:API filter operator form, e.g. { ne: "" } → filter[key][ne]=
      for (const [op, opValue] of Object.entries(value as Record<string, unknown>)) {
        result[`${kebabKey}][${op}`] = String(opValue ?? "");
      }
    } else {
      result[kebabKey] = String(value);
    }
  }
  return result;
}

/**
 * Extract the HTTP status from an ITGlueClient error message
 * ("IT Glue API error (404): ..."), or null for non-HTTP errors.
 */
function apiErrorStatus(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/IT Glue API error \((\d{3})\)/);
  return match ? Number(match[1]) : null;
}

/**
 * Record types that IT Glue accepts attachments on, as the plural path segment
 * used by `/:resource_type/:resource_id/relationships/attachments`.
 *
 * Kept as an explicit list rather than a free-text string so a wrong path is
 * rejected by the schema instead of returning a 404 from the API.
 */
export const ATTACHABLE_RESOURCE_TYPES = [
  "checklists",
  "checklist_templates",
  "configurations",
  "contacts",
  "documents",
  "domains",
  "flexible_assets",
  "locations",
  "passwords",
  "ssl_certificates",
  "tickets",
] as const;

/**
 * Rejects a base64 payload that still carries its data: URI prefix.
 *
 * IT Glue stores whatever it is given, so a prefixed string uploads "cleanly"
 * and produces a corrupt file that only shows up when someone opens it. Cheaper
 * to refuse it here than to debug a broken image later.
 */
function stripDataUriPrefix(content: string): string {
  const match = content.match(/^data:[^;,]*;base64,(.*)$/s);
  return match ? match[1] : content;
}

// Simple IT Glue client
export class ITGlueClient {
  private readonly apiKey?: string;
  private readonly jwt?: string;
  private readonly baseUrl: string;

  constructor(config: {
    apiKey?: string;
    jwt?: string;
    region?: ITGlueRegion;
    baseUrl?: string;
  }) {
    if (!config.apiKey && !config.jwt) {
      throw new Error("ITGlueClient requires either an apiKey or a jwt");
    }
    this.apiKey = config.apiKey;
    this.jwt = config.jwt;

    if (config.baseUrl) {
      this.baseUrl = config.baseUrl;
    } else {
      const region = config.region || "us";
      // REGION_URLS is keyed by ITGlueRegion, but callers reach this via an
      // `as ITGlueRegion` cast on ITGLUE_REGION / X-ITGlue-Region, so the value
      // can be any string at runtime. Validate explicitly: an unknown region
      // used to yield baseUrl=undefined and a "Failed to parse URL from
      // undefined/..." error downstream (issue #40).
      const regionUrl = (REGION_URLS as Record<string, string>)[region];
      if (!regionUrl) {
        throw new Error(
          `Invalid IT Glue region "${region}". Valid regions are: ${Object.keys(REGION_URLS).join(", ")}. ` +
            `ITGLUE_REGION is the IT Glue API region, not your account subdomain. ` +
            `To target a custom API endpoint, set ITGLUE_BASE_URL instead.`
        );
      }
      this.baseUrl = regionUrl;
    }
  }

  /**
   * Build the auth header for outbound requests. JWT (when present) wins over
   * API key because it carries strictly broader scope on the IT Glue API.
   */
  private authHeaders(): Record<string, string> {
    if (this.jwt) return { Authorization: `Bearer ${this.jwt}` };
    return { "x-api-key": this.apiKey as string };
  }

  private buildQueryString(params: Record<string, unknown>): string {
    const searchParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null) continue;

      if (key === "filter" && typeof value === "object") {
        const filterParams = buildFilterParams(value as Record<string, unknown>);
        for (const [filterKey, filterValue] of Object.entries(filterParams)) {
          searchParams.append(`filter[${filterKey}]`, filterValue);
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
  }

  async request<T>(
    path: string,
    params: Record<string, unknown> = {}
  ): Promise<{ data: T[]; meta: PaginationMeta }> {
    const url = `${this.baseUrl}${path}${this.buildQueryString(params)}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`IT Glue API error (${response.status}): ${errorBody}`);
    }

    const json = (await response.json()) as JsonApiResponse;

    if (json.errors && json.errors.length > 0) {
      const errorMessages = json.errors.map((e) => e.detail || e.title).join(", ");
      throw new Error(`IT Glue API error: ${errorMessages}`);
    }

    const data = Array.isArray(json.data)
      ? json.data.map(deserializeResource)
      : [deserializeResource(json.data)];

    const meta: PaginationMeta = {
      currentPage: json.meta?.["current-page"] || 1,
      nextPage: json.meta?.["next-page"] || null,
      prevPage: json.meta?.["prev-page"] || null,
      totalPages: json.meta?.["total-pages"] || 1,
      totalCount: json.meta?.["total-count"] || data.length,
    };

    return { data: data as T[], meta };
  }

  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const result = await this.request<T>(path, params);
    return result.data[0];
  }

  async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`IT Glue API error (${response.status}): ${errorBody}`);
    }

    const json = (await response.json()) as JsonApiResponse;

    if (json.errors && json.errors.length > 0) {
      const errorMessages = json.errors.map((e) => e.detail || e.title).join(", ");
      throw new Error(`IT Glue API error: ${errorMessages}`);
    }

    const resource = Array.isArray(json.data) ? json.data[0] : json.data;
    return deserializeResource(resource) as T;
  }

  async patch<T>(path: string, body: Record<string, unknown> = {}): Promise<T> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/vnd.api+json",
        Accept: "application/vnd.api+json",
      },
      body: Object.keys(body).length > 0 ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`IT Glue API error (${response.status}): ${errorBody}`);
    }

    const json = (await response.json()) as JsonApiResponse;

    if (json.errors && json.errors.length > 0) {
      const errorMessages = json.errors.map((e) => e.detail || e.title).join(", ");
      throw new Error(`IT Glue API error: ${errorMessages}`);
    }

    const resource = Array.isArray(json.data) ? json.data[0] : json.data;
    return deserializeResource(resource) as T;
  }

  async delete(path: string): Promise<void> {
    const url = `${this.baseUrl}${path}`;

    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        ...this.authHeaders(),
        Accept: "application/vnd.api+json",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`IT Glue API error (${response.status}): ${errorBody}`);
    }
  }
}

/**
 * Create a document *with* its body content.
 *
 * IT Glue's Documents API accepts but does not persist a top-level `content`
 * attribute on POST — documents are section-structured, so a document's body
 * only exists once a child `document-sections` resource has been created.
 * This helper performs the full flow: POST the document, then (if content was
 * supplied) POST a `Document::Text` section against it.
 *
 * Payload shape verified live against IT Glue's API: the section-type lives
 * in the `resource_type` attribute (values `Document::Text` or
 * `Document::Heading`). The `section-type` field is accepted but ignored; a
 * `relationships.resource` binding causes HTTP 400
 * `"param is missing or the value is empty: resource_type"`.
 *
 * Returns the deserialized document resource (not the section) so the caller
 * sees the same shape as a simple POST.
 */
export async function createDocumentWithContent(
  client: ITGlueClient,
  args: {
    organization_id: number | string;
    name: string;
    content?: string;
    document_folder_id?: number | string;
  }
): Promise<Record<string, unknown>> {
  const attributes: Record<string, unknown> = { name: args.name };
  if (args.document_folder_id !== undefined && args.document_folder_id !== null) {
    // Verified live 2026-05-12: IT Glue accepts both snake_case
    // `document_folder_id` and kebab-case `document-folder-id` on write
    // (both reach the same validation path; 99999999 → 422 "must exist in
    // the same organization"). We use snake_case to match the precedent set
    // by `resource_type` on document-sections.
    attributes.document_folder_id = args.document_folder_id;
  }

  const newDoc = await client.post<Record<string, unknown>>(
    `/organizations/${args.organization_id}/relationships/documents`,
    {
      data: {
        type: "documents",
        attributes,
      },
    }
  );

  if (args.content !== undefined && args.content !== "") {
    const docId = String(newDoc.id);
    await client.post(`/documents/${docId}/relationships/sections`, {
      data: {
        type: "document-sections",
        attributes: {
          resource_type: "Document::Text",
          content: args.content,
        },
      },
    });
  }

  return newDoc;
}

/**
 * Parse a folder reference supplied by the user. This is the last-resort
 * folder prompt for when folder *names* cannot be enumerated — i.e. the
 * tenant's API key does not (yet) expose the Document Folders resource and no
 * JWT fallback is available (see the README). It accepts inputs the user can
 * copy out of their browser tab while looking at the folder they want:
 *
 *   - empty / whitespace → root
 *   - bare numeric id    → folder
 *   - URL containing `/documents/folder/<id>/` → folder
 *   - URL containing `/docs/<id>` or `/DOC-<org>-<id>` → doc (caller GETs
 *     the doc and reads its `document-folder-id` to resolve the folder)
 *   - anything else      → invalid
 */
export type FolderReference =
  | { kind: "root" }
  | { kind: "folder"; folderId: number }
  | { kind: "doc"; docId: number }
  | { kind: "invalid"; input: string };

/**
 * IT Glue document folder resource shape (subset used by the folder-picker
 * path). Folders are nested via `parent-id` (kebab) on the wire; the
 * helper also accepts `parent_id` defensively.
 */
export interface DocumentFolderResource {
  id: string;
  attributes?: Record<string, unknown>;
}

/**
 * Turn a flat folder list into elicitation-picker options.
 *
 * The `__root__` sentinel is pinned first so picking "no folder" stays
 * distinguishable from declining. Other entries are labelled with their full
 * breadcrumb path (so duplicate folder names under different parents stay
 * distinguishable), then locale-collated.
 *
 * Cycle-safe via a `seen` set; orphan folders (parent id pointing nowhere)
 * fall back to their own name only.
 */
export function buildFolderPickerOptions(
  folders: DocumentFolderResource[]
): Array<{ value: string; label: string }> {
  const byId = new Map<string, DocumentFolderResource>(
    folders.map((f) => [f.id, f])
  );

  const labelFor = (f: DocumentFolderResource): string => {
    const parts: string[] = [];
    let cur: DocumentFolderResource | undefined = f;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      const attrs: Record<string, unknown> = cur.attributes ?? {};
      parts.unshift(String(attrs.name ?? `folder ${cur.id}`));
      const parentId = attrs["parent-id"] ?? attrs.parent_id;
      cur = parentId != null ? byId.get(String(parentId)) : undefined;
    }
    return parts.join(" / ");
  };

  return [
    { value: "__root__", label: "(Root — no folder)" },
    ...folders
      .map((f) => ({ value: String(f.id), label: labelFor(f) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
}

export function parseFolderReference(input: string | null | undefined): FolderReference {
  if (input == null) return { kind: "root" };
  const trimmed = input.trim();
  if (trimmed === "") return { kind: "root" };

  if (/^\d+$/.test(trimmed)) {
    return { kind: "folder", folderId: Number(trimmed) };
  }

  const folderMatch = trimmed.match(/\/documents\/folder\/(\d+)/);
  if (folderMatch) return { kind: "folder", folderId: Number(folderMatch[1]) };

  const docMatch =
    trimmed.match(/\/docs\/(\d+)/) ??
    trimmed.match(/\/DOC-\d+-(\d+)/i);
  if (docMatch) return { kind: "doc", docId: Number(docMatch[1]) };

  return { kind: "invalid", input: trimmed };
}

/**
 * Advisory note for `search_documents` results.
 *
 * IT Glue's `/organizations/:id/relationships/documents` endpoint returns only
 * ROOT-LEVEL documents unless a `filter[document_folder_id]` is supplied. The
 * handler defaults to `filter[document_folder_id]=null` (which — despite the
 * name — returns ALL documents including foldered ones) so this note is only
 * emitted when the tenant's API rejected both folder-inclusive filter forms
 * and the search degraded to the legacy root-only listing. Without the caveat
 * the model reports that truncated count as authoritative ("this org has 1
 * document" for an org holding thousands).
 *
 * Returns a note to prepend to the result, or null when a folder filter was
 * applied (in which case the result is complete for that folder's scope).
 */
export function rootLevelDocumentsNote(opts: {
  folderFiltered: boolean;
  haveJwt: boolean;
}): string | null {
  if (opts.folderFiltered) return null;
  return (
    "NOTE: this listing contains only ROOT-LEVEL documents. The folder-inclusive filter forms " +
    "(filter[document_folder_id]=null and its [ne] variant) were rejected by this IT Glue tenant's " +
    "API, so the search degraded to the legacy root-only listing. Documents inside folders are NOT " +
    "included here and are NOT reflected in meta.total-count — do not report this as the " +
    "organization's complete document count. To include foldered documents, call " +
    "list_document_folders, then re-run search_documents with document_folder_id for each folder." +
    (opts.haveJwt
      ? ""
      : " list_document_folders works with an API key on tenants where IT Glue exposes the " +
        "Document Folders resource; a JWT (ITGLUE_JWT) is only needed as a fallback if it does not. " +
        "See the README.")
  );
}

/**
 * Advisory note prepended to `search_documents` results when the
 * folder-inclusive listing succeeded: tells the model how to read folder
 * membership off each document instead of assuming a flat listing.
 */
export function folderedDocumentsIncludedNote(): string {
  return (
    "NOTE: this listing includes documents inside folders. Each document's documentFolderId " +
    "identifies its folder (null/absent = organization root). Use list_document_folders to " +
    "resolve folder names."
  );
}

/**
 * Drop one top-level field from every resource in a list result.
 *
 * `deserializeResource` flattens `attributes` and camelCases the keys, so the
 * fields these list tools want to withhold sit at the top level of each record.
 */
function omitResourceField(items: unknown[], field: string): unknown[] {
  return items.map((item) => {
    if (item && typeof item === "object" && field in item) {
      const { [field]: _omitted, ...rest } = item as Record<string, unknown>;
      return rest;
    }
    return item;
  });
}

/**
 * Strip each document's full body from a `search_documents` listing.
 *
 * IT Glue's documents list endpoint embeds every document's full sectioned body
 * in a `content` array. That body dominates the payload — on a heavily-foldered
 * org it is ~90% of the bytes — so passing it through makes the list response so
 * large it can exceed the MCP client's response limit and hang with no error
 * (issue #55: folder enumeration works, but viewing the documents inside chokes).
 * search_documents is a LIST/SEARCH tool, so it returns metadata only; full-body
 * retrieval stays with get_document / list_document_sections.
 *
 * Coupled to IT Glue's current field name: the body arrives as a top-level
 * `content` key. If IT Glue renames the body field or adds another heavy one,
 * revisit this.
 */
export function stripDocumentBodies(docs: unknown[]): unknown[] {
  return omitResourceField(docs, "content");
}

/**
 * Remove secret material from a `search_passwords` listing.
 *
 * `search_passwords` asks IT Glue not to send secrets (`show_password=false`),
 * but that is a request, not a guarantee: it is one query parameter away from
 * being dropped by a refactor, and a tenant or API version that ignores it would
 * spill every matched secret into the model's context in a single bulk listing.
 * Reading a secret is `get_password`'s job — one id at a time, deliberately — so
 * the list tool strips the value on the way out regardless of what came back.
 */
export function stripPasswordValues(passwords: unknown[]): unknown[] {
  return omitResourceField(passwords, "password");
}

/** Advisory that document bodies are omitted from `search_documents` results. */
export function documentBodyOmittedNote(): string {
  return (
    "NOTE: document bodies are omitted from these results to keep the listing small — each " +
    "item is metadata only. Call get_document (or list_document_sections) to read a specific " +
    "document's content."
  );
}

/**
 * Warning attached to a `search_*` result that ran WITHOUT an organization
 * filter.
 *
 * These tools try to scope themselves by eliciting an organization name when
 * `organization_id` is omitted. That can fail to produce a scope in several
 * ways: elicitation is unavailable on any client that doesn't support it
 * — notably through the MCP gateway, which does not proxy server-initiated
 * requests — the user can decline, and the name they give can match no
 * organization at all. Every one of those paths silently widened the search to
 * the whole account. A caller that asked for "the VPN password for Acme" then
 * received an arbitrary page drawn from every organization and reasonably
 * concluded the entry did not exist.
 *
 * The query still runs (organization_id is genuinely optional — an account-wide
 * search is a legitimate request). What changes is that the result now says
 * which search actually happened, so an unscoped miss can't be read as proof of
 * absence. The wording deliberately does not blame a particular cause: the
 * handler can't tell "could not ask" from "asked, and nothing matched", and
 * naming the wrong one sends the reader after the wrong fix.
 */
export function unscopedSearchNote(
  resource: string,
  meta: PaginationMeta
): string {
  return (
    `NOTE: this search was NOT scoped to an organization — no organization_id was ` +
    `supplied and one could not be determined, ` +
    `so it searched ${resource} across ALL organizations — returning page ${meta.currentPage} ` +
    `of ${meta.totalPages} (${meta.totalCount} matching entries account-wide). ` +
    `An empty or unexpected result here does NOT mean the entry is absent. ` +
    `To scope the search, call search_organizations to find the organization's id, ` +
    `then re-run this tool with organization_id set.`
  );
}

/**
 * The unscoped-search warning, emitted only when no organization filter
 * actually went out on the wire.
 *
 * Deliberately keyed off the built filter rather than the caller's raw
 * `organization_id`. The handlers apply the filter under `if (orgId)` but the
 * warning used to be gated on `orgId === undefined`, so a falsy-but-present id
 * (`0`, or the `NaN` from `Number(<non-numeric id>)` after an elicited lookup)
 * fell through the gap: the scope was dropped AND the warning suppressed. One
 * helper reading the filter keeps the two from drifting apart again.
 */
function unscopedSearchNoteFor(
  resource: string,
  filter: Record<string, unknown>,
  meta: PaginationMeta
): string {
  return filter.organizationId === undefined
    ? unscopedSearchNote(resource, meta)
    : "";
}

/** Which filter form ultimately produced a `search_documents` listing. */
export type DocumentSearchAttempt = "null-filter" | "ne-filter" | "unfiltered";

/**
 * Fetch an organization's documents, defaulting to a folder-INCLUSIVE listing.
 *
 * IT Glue's documents relationship endpoint returns only root-level documents
 * unless `filter[document_folder_id]` is supplied. Passing the literal value
 * `null` returns ALL documents (foldered ones included); the
 * `filter[document_folder_id][ne]=` form is a community-verified alternative.
 * Layered degradation, so tenants whose API rejects either form still work:
 *
 *   1. `filter[document_folder_id]=null`   → all documents
 *   2. `filter[document_folder_id][ne]=`   → all documents (alternate form)
 *   3. unfiltered                          → root-level only (legacy)
 *
 * Only a 400/422 (filter rejected) triggers the next layer — anything else
 * (401/404/5xx) propagates to the caller unchanged.
 */
export async function requestDocumentsWithFolderDefault(
  client: ITGlueClient,
  organizationId: number | string,
  params: Record<string, unknown>
): Promise<{
  result: { data: unknown[]; meta: PaginationMeta };
  attempt: DocumentSearchAttempt;
}> {
  const path = `/organizations/${organizationId}/relationships/documents`;
  const withFolderFilter = (folderFilter: Record<string, unknown>) => ({
    ...params,
    filter: { ...((params.filter as Record<string, unknown>) ?? {}), ...folderFilter },
  });
  const filterRejected = (err: unknown) => {
    const status = apiErrorStatus(err);
    return status === 400 || status === 422;
  };

  try {
    const result = await client.request(path, withFolderFilter({ document_folder_id: "null" }));
    return { result, attempt: "null-filter" };
  } catch (err) {
    if (!filterRejected(err)) throw err;
  }

  try {
    const result = await client.request(path, withFolderFilter({ document_folder_id: { ne: "" } }));
    return { result, attempt: "ne-filter" };
  } catch (err) {
    if (!filterRejected(err)) throw err;
  }

  const result = await client.request(path, params);
  return { result, attempt: "unfiltered" };
}

/**
 * Enumerate an organization's document folders using API-key auth.
 *
 * IT Glue's public API now documents a Document Folders resource, but the
 * rollout across tenants (2026) means a given tenant may expose it at the
 * organization relationship path, at the top level, or not at all. Tries the
 * relationship path first, then `/document_folders?filter[organization_id]=`
 * if that 404s.
 *
 * Returns the folder listing on success, or null when the API key was
 * rejected (401/403) or the resource is not exposed (404) — the caller should
 * fall back to JWT auth. Any other error propagates unchanged.
 */
export async function listDocumentFoldersViaApiKey(
  client: ITGlueClient,
  organizationId: number | string,
  params: Record<string, unknown>
): Promise<{ data: unknown[]; meta: PaginationMeta } | null> {
  const apiKeyBlocked = (err: unknown) => {
    const status = apiErrorStatus(err);
    return status === 401 || status === 403 || status === 404;
  };

  try {
    return await client.request(
      `/organizations/${organizationId}/relationships/document_folders`,
      params
    );
  } catch (err) {
    if (!apiKeyBlocked(err)) throw err;
    if (apiErrorStatus(err) !== 404) return null;
  }

  // The relationship path 404'd — the tenant may expose the public resource
  // only at the top level.
  try {
    return await client.request("/document_folders", {
      ...params,
      filter: {
        ...((params.filter as Record<string, unknown>) ?? {}),
        organization_id: organizationId,
      },
    });
  } catch (err) {
    if (!apiKeyBlocked(err)) throw err;
    return null;
  }
}

// Credential extraction from gateway headers
export interface GatewayCredentials {
  apiKey?: string;
  jwt?: string;
  region?: ITGlueRegion;
  baseUrl?: string;
}

// An unresolved MCPB/DXT manifest placeholder, e.g. "${user_config.itglue_jwt}".
// Desktop hosts inject the config template verbatim when its optional user_config
// field is left blank, so the literal string arrives in the env var / header.
const CONFIG_PLACEHOLDER = /^\$\{.*\}$/;

/**
 * Normalise a single credential read from an env var or gateway header.
 *
 * Returns `undefined` for values that are effectively absent, so the auth layer
 * treats them as "no credential" rather than a real secret:
 *   - undefined / empty / whitespace-only
 *   - an unresolved manifest placeholder like `${user_config.itglue_jwt}`
 *
 * Root cause of issue #73: a blank optional JWT field left the literal
 * `${user_config.itglue_jwt}` in ITGLUE_JWT. Because a JWT overrides the API key
 * (see ITGlueClient.authHeaders), every request went out as
 * `Authorization: Bearer ${user_config.itglue_jwt}` and 401'd — even with a valid
 * API key configured. Stripping the placeholder here lets the API key take over.
 */
export function cleanCredential(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || CONFIG_PLACEHOLDER.test(trimmed)) return undefined;
  return trimmed;
}

// Warn at most once per field so a stray placeholder surfaces in the server log
// (a clear diagnostic for the operator) without spamming it on every tool call.
const warnedPlaceholderFields = new Set<string>();
function warnPlaceholderOnce(field: string): void {
  if (warnedPlaceholderFields.has(field)) return;
  warnedPlaceholderFields.add(field);
  console.error(
    `[itglue-mcp] Ignoring ${field}: value is an unresolved config placeholder ` +
      `(e.g. "\${user_config...}"), not a real credential. This usually means an ` +
      `optional field was left blank in your MCP client config. (issue #73)`
  );
}

/**
 * Sanitise every field of a credential set at ingress, dropping empty and
 * unresolved-placeholder values. Applied to both credential sources (env and
 * gateway headers) so a placeholder never reaches the auth layer as a secret.
 */
export function sanitizeCredentials(creds: GatewayCredentials): GatewayCredentials {
  if (creds.jwt && CONFIG_PLACEHOLDER.test(creds.jwt.trim())) {
    warnPlaceholderOnce("ITGLUE_JWT / X-ITGlue-JWT");
  }
  return {
    apiKey: cleanCredential(creds.apiKey),
    jwt: cleanCredential(creds.jwt),
    region: (cleanCredential(creds.region) ?? "us") as ITGlueRegion,
    baseUrl: cleanCredential(creds.baseUrl),
  };
}

export function getCredentialsFromEnv(): GatewayCredentials {
  return sanitizeCredentials({
    apiKey: process.env.ITGLUE_API_KEY || process.env.X_API_KEY,
    jwt: process.env.ITGLUE_JWT,
    region: (process.env.ITGLUE_REGION || "us") as ITGlueRegion,
    baseUrl: process.env.ITGLUE_BASE_URL,
  });
}

export function createClient(credentials: GatewayCredentials): ITGlueClient {
  if (!credentials.apiKey && !credentials.jwt) {
    throw new Error("No IT Glue API key or JWT provided");
  }
  return new ITGlueClient({
    apiKey: credentials.apiKey,
    jwt: credentials.jwt,
    region: credentials.region || "us",
    baseUrl: credentials.baseUrl,
  });
}

/**
 * Create a fresh MCP Server with all tool handlers registered.
 * Called per-request in HTTP (stateless) mode so each initialize gets a clean server.
 *
 * The returned server is NOT registered as "the" server anywhere here —
 * callers are responsible for binding it into the per-request `server-ref`
 * AsyncLocalStorage context (via `runWithServerRef` / `bindServerRef`) so
 * elicitation helpers resolve the right server even after await gaps. See
 * `utils/server-ref.ts` for why this matters.
 */
export function createMcpServer(credentialOverrides?: GatewayCredentials): Server {
  const server = new Server(
    {
      name: "itglue-mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    }
  );

  // Register prompt handlers
  registerPromptHandlers(server);

  // Register resource handlers (MCP Apps document card, SEP-1865)
  registerResourceHandlers(server);

  server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      // Organizations
      {
        name: "search_organizations",
        description: "Search for organizations in IT Glue with optional filtering",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Filter by organization name (partial match)",
            },
            organization_type_id: {
              type: "number",
              description: "Filter by organization type ID",
            },
            organization_status_id: {
              type: "number",
              description: "Filter by organization status ID",
            },
            psa_id: {
              type: "string",
              description: "Filter by PSA integration ID",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number to retrieve (default 1)",
            },
            sort: {
              type: "string",
              description: "Sort field (prefix with - for descending, e.g., '-name')",
            },
          },
          required: [],
        },
      },
      {
        name: "get_organization",
        description: "Get a specific organization by ID from IT Glue",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The organization ID",
            },
          },
          required: ["id"],
        },
      },
      // Configurations
      {
        name: "search_configurations",
        description: "Search for configurations (devices/assets) in IT Glue",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Filter by organization ID",
            },
            name: {
              type: "string",
              description: "Filter by configuration name (partial match)",
            },
            configuration_type_id: {
              type: "number",
              description: "Filter by configuration type ID",
            },
            configuration_status_id: {
              type: "number",
              description: "Filter by configuration status ID",
            },
            serial_number: {
              type: "string",
              description: "Filter by serial number",
            },
            rmm_id: {
              type: "string",
              description: "Filter by RMM integration ID",
            },
            psa_id: {
              type: "string",
              description: "Filter by PSA integration ID",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number to retrieve (default 1)",
            },
            sort: {
              type: "string",
              description: "Sort field (prefix with - for descending)",
            },
          },
          required: [],
        },
      },
      {
        name: "get_configuration",
        description: "Get a specific configuration (device/asset) by ID from IT Glue",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The configuration ID",
            },
          },
          required: ["id"],
        },
      },
      // Locations
      {
        name: "search_locations",
        description:
          "Search for locations (physical addresses/sites) of an organization in IT Glue. " +
          "Each result includes the address fields and phone number. Locations are a built-in " +
          "IT Glue entity (not a flexible asset), so use this rather than search_flexible_assets " +
          "to look up an organization's address or phone.",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Filter by organization ID (recommended — locations are scoped to organizations)",
            },
            name: {
              type: "string",
              description: "Filter by location name (partial match)",
            },
            city: {
              type: "string",
              description: "Filter by city",
            },
            region_id: {
              type: "number",
              description: "Filter by region/state ID",
            },
            country_id: {
              type: "number",
              description: "Filter by country ID",
            },
            psa_id: {
              type: "string",
              description: "Filter by PSA integration ID",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number to retrieve (default 1)",
            },
            sort: {
              type: "string",
              description: "Sort field (prefix with - for descending, e.g., '-name')",
            },
          },
          required: [],
        },
      },
      {
        name: "get_location",
        description: "Get a specific location by ID from IT Glue, including its full address and phone number.",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The location ID",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "create_location",
        description:
          "Create a new location (physical address/site) for an organization in IT Glue. " +
          "IT Glue requires a name and typically a country_id for a location.",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Organization ID to create the location in",
            },
            name: {
              type: "string",
              description: "Location name/title",
            },
            country_id: {
              type: "number",
              description: "Country ID — IT Glue typically requires this when creating a location. Find country IDs in the IT Glue web UI.",
            },
            region_id: {
              type: "number",
              description: "Region/state ID",
            },
            address_1: {
              type: "string",
              description: "Address line 1",
            },
            address_2: {
              type: "string",
              description: "Address line 2",
            },
            city: {
              type: "string",
              description: "City",
            },
            postal_code: {
              type: "string",
              description: "Postal/ZIP code",
            },
            phone: {
              type: "string",
              description: "Phone number",
            },
            fax: {
              type: "string",
              description: "Fax number",
            },
            notes: {
              type: "string",
              description: "Free-text notes",
            },
            primary: {
              type: "boolean",
              description: "Whether this is the organization's primary location",
            },
          },
          required: ["organization_id", "name"],
        },
      },
      {
        name: "update_location",
        description: "Update an existing location in IT Glue. Only the fields you supply are changed.",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Organization ID that owns the location",
            },
            id: {
              type: "string",
              description: "The location ID to update",
            },
            name: {
              type: "string",
              description: "Location name/title",
            },
            country_id: {
              type: "number",
              description: "Country ID",
            },
            region_id: {
              type: "number",
              description: "Region/state ID",
            },
            address_1: {
              type: "string",
              description: "Address line 1",
            },
            address_2: {
              type: "string",
              description: "Address line 2",
            },
            city: {
              type: "string",
              description: "City",
            },
            postal_code: {
              type: "string",
              description: "Postal/ZIP code",
            },
            phone: {
              type: "string",
              description: "Phone number",
            },
            fax: {
              type: "string",
              description: "Fax number",
            },
            notes: {
              type: "string",
              description: "Free-text notes",
            },
            primary: {
              type: "boolean",
              description: "Whether this is the organization's primary location",
            },
          },
          required: ["organization_id", "id"],
        },
      },
      // Passwords
      {
        name: "search_passwords",
        description: "Search for password entries in IT Glue (returns metadata only, not actual passwords)",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Filter by organization ID",
            },
            name: {
              type: "string",
              description: "Filter by password entry name (partial match)",
            },
            password_category_id: {
              type: "number",
              description: "Filter by password category ID",
            },
            url: {
              type: "string",
              description: "Filter by URL",
            },
            username: {
              type: "string",
              description: "Filter by username",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number to retrieve (default 1)",
            },
            sort: {
              type: "string",
              description: "Sort field (prefix with - for descending)",
            },
          },
          required: [],
        },
      },
      {
        name: "get_password",
        description: "Get a specific password entry by ID from IT Glue (includes the actual password value)",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "string",
              description: "The password entry ID",
            },
            show_password: {
              type: "boolean",
              description: "Whether to include the actual password value (default true)",
            },
          },
          required: ["id"],
        },
      },
      // Documents
      {
        name: "search_documents",
        description: "Search for documents in IT Glue (scoped to an organization). Returns document metadata only (name, folder, URL, timestamps) — not the document body. Use get_document or list_document_sections to read a specific document's content.",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Organization ID (required — documents are scoped to organizations)",
            },
            name: {
              type: "string",
              description: "Filter by document name (partial match)",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number to retrieve (default 1)",
            },
            sort: {
              type: "string",
              description: "Sort field (prefix with - for descending)",
            },
            document_folder_id: {
              type: "number",
              description: "Filter by document folder ID to search within a specific folder",
            },
          },
          required: ["organization_id"],
        },
      },
      {
        name: "get_document",
        description: "Get a specific document by ID from IT Glue",
        _meta: DOCUMENT_CARD_META,
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Organization ID that owns the document",
            },
            id: {
              type: "string",
              description: "The document ID",
            },
          },
          required: ["organization_id", "id"],
        },
      },
      {
        name: "list_document_folders",
        description: "List document folders for an organization in IT Glue, returning their names and IDs. Works with your API key on tenants where IT Glue exposes the Document Folders resource (rolling out across tenants in 2026). If the API key is rejected, a JWT is used as a fallback (configure via ITGLUE_JWT env var or X-ITGlue-JWT header, or paste one when prompted).",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Organization ID to list folders for",
            },
            name: {
              type: "string",
              description: "Optional name filter (partial match)",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number to retrieve (default 1)",
            },
          },
          required: ["organization_id"],
        },
      },
      {
        name: "create_document",
        description: "Create a new document in IT Glue for an organization. If neither document_folder_id nor skip_folder_prompt is supplied, the user is prompted to pick a folder. Folder enumeration for the name-based picker tries the API key first (works on tenants where IT Glue exposes the Document Folders resource), then a configured JWT; if neither can list folders, the prompt accepts a folder URL, a sibling-document URL, or a numeric folder ID. Pass skip_folder_prompt=true to always create at the organization root without prompting.",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Organization ID to create the document in",
            },
            name: {
              type: "string",
              description: "Document name/title",
            },
            content: {
              type: "string",
              description: "Document content (HTML supported)",
            },
            document_folder_id: {
              type: "number",
              description: "Optional folder ID to place the document in. Find folder IDs in the IT Glue web URL (e.g. `/documents/folder/12345/`) or by inspecting `document-folder-id` on an existing document in that folder.",
            },
            skip_folder_prompt: {
              type: "boolean",
              description: "If true, skip the interactive folder picker and create the document at the organization root.",
            },
          },
          required: ["organization_id", "name"],
        },
      },
      // Document Sections
      {
        name: "list_document_sections",
        description: "List all sections of an IT Glue document in order. Use this to read document content before editing.",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID",
            },
          },
          required: ["document_id"],
        },
      },
      {
        name: "create_document_section",
        description: "Add a new section to an IT Glue document. Section types: 'heading' (Document::Heading) or 'text' (Document::Text). Call publish_document after editing.",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID",
            },
            section_type: {
              type: "string",
              enum: ["heading", "text"],
              description: "Section type: 'heading' for Document::Heading, 'text' for Document::Text",
            },
            content: {
              type: "string",
              description: "HTML content for the section",
            },
          },
          required: ["document_id", "section_type", "content"],
        },
      },
      {
        name: "update_document_section",
        description: "Update the content of an existing IT Glue document section. Use list_document_sections to get section IDs. Call publish_document after editing.",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID",
            },
            section_id: {
              type: "number",
              description: "The section ID (from list_document_sections)",
            },
            content: {
              type: "string",
              description: "New HTML content for the section",
            },
          },
          required: ["document_id", "section_id", "content"],
        },
      },
      {
        name: "delete_document_section",
        description:
          "⚠ DESTRUCTIVE — IRREVERSIBLE. Permanently deletes a section from an IT Glue document. " +
          "This action cannot be undone. Call publish_document after editing. " +
          "Confirm with the user before invoking.",
        annotations: {
          title: "Delete document section (irreversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID",
            },
            section_id: {
              type: "number",
              description: "The section ID to delete (from list_document_sections)",
            },
          },
          required: ["document_id", "section_id"],
        },
      },
      {
        name: "create_document_image",
        description:
          "Upload an image into an IT Glue document so it can be shown inline in the document body. " +
          "Pass the file as base64 with no data: prefix. IT Glue's HTML sanitiser strips inline <svg> and " +
          "rejects data: URIs in <img src>, so uploading the image first is the only way to get a picture " +
          "into a document body. Call publish_document after editing sections to reference it.",
        annotations: {
          title: "Upload document image",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID to upload the image into",
            },
            file_name: {
              type: "string",
              description: "File name including extension, e.g. 'architecture.png'",
            },
            content: {
              type: "string",
              description:
                "Base64-encoded file contents. Raw base64 only - strip any 'data:image/png;base64,' prefix first.",
            },
          },
          required: ["document_id", "file_name", "content"],
        },
      },
      {
        name: "create_attachment",
        description:
          "Attach a file to an IT Glue record. Unlike create_document_image this adds a downloadable " +
          "attachment rather than an image in the document body. Pass the file as base64 with no data: prefix.",
        annotations: {
          title: "Create attachment",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            resource_type: {
              type: "string",
              enum: ATTACHABLE_RESOURCE_TYPES,
              description: "The kind of record to attach the file to",
            },
            resource_id: {
              type: "number",
              description: "ID of the record to attach the file to",
            },
            file_name: {
              type: "string",
              description: "File name including extension, e.g. 'network-diagram.png'",
            },
            content: {
              type: "string",
              description:
                "Base64-encoded file contents. Raw base64 only - strip any 'data:...;base64,' prefix first.",
            },
          },
          required: ["resource_type", "resource_id", "file_name", "content"],
        },
      },
      {
        name: "list_attachments",
        description: "List the files attached to an IT Glue record, with their download URLs.",
        inputSchema: {
          type: "object",
          properties: {
            resource_type: {
              type: "string",
              enum: ATTACHABLE_RESOURCE_TYPES,
              description: "The kind of record to list attachments for",
            },
            resource_id: {
              type: "number",
              description: "ID of the record to list attachments for",
            },
          },
          required: ["resource_type", "resource_id"],
        },
      },
      {
        name: "publish_document",
        description: "Publish an IT Glue document to make section changes visible. Always call this after creating, updating, or deleting sections.",
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID to publish",
            },
          },
          required: ["document_id"],
        },
      },
      {
        name: "archive_document",
        description:
          "⚠ HIGH-IMPACT. Archives an IT Glue document (soft delete — hides it from normal views " +
          "but keeps it recoverable). Use unarchive_document to restore. " +
          "Confirm with the user before invoking.",
        annotations: {
          title: "Archive document (reversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID to archive",
            },
          },
          required: ["document_id"],
        },
      },
      {
        name: "unarchive_document",
        description:
          "⚠ HIGH-IMPACT. Restores a previously archived IT Glue document so it appears in " +
          "normal views again. This makes the document visible to all users. " +
          "Confirm with the user before invoking.",
        annotations: {
          title: "Unarchive document (reversible)",
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            document_id: {
              type: "number",
              description: "The document ID to unarchive",
            },
          },
          required: ["document_id"],
        },
      },
      // Flexible Assets
      {
        name: "list_flexible_asset_types",
        description: "List all flexible asset types defined in IT Glue. Call this first to discover type IDs before using search_flexible_assets.",
        inputSchema: {
          type: "object",
          properties: {
            organization_id: {
              type: "number",
              description: "Filter by organization ID (optional — returns global types if omitted)",
            },
          },
          required: [],
        },
      },
      {
        name: "search_flexible_assets",
        description: "Search for flexible assets in IT Glue (requires flexible_asset_type_id filter)",
        inputSchema: {
          type: "object",
          properties: {
            flexible_asset_type_id: {
              type: "number",
              description: "Required: The flexible asset type ID to search within",
            },
            organization_id: {
              type: "number",
              description: "Filter by organization ID",
            },
            name: {
              type: "string",
              description: "Filter by flexible asset name (partial match)",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number to retrieve (default 1)",
            },
            sort: {
              type: "string",
              description: "Sort field (prefix with - for descending)",
            },
          },
          required: ["flexible_asset_type_id"],
        },
      },
      // User metrics
      {
        name: "search_user_metrics",
        description:
          "Search IT Glue user activity metrics — per-user, per-organization, per-resource-type " +
          "counts of created/viewed/edited/deleted actions, bucketed by date. This is the raw data " +
          "behind IT Glue's user reputation scores. The date range may span at most 7 days " +
          "end-to-start; end_date requires a start_date (IT Glue rejects an open start).",
        inputSchema: {
          type: "object",
          properties: {
            user_id: {
              type: "number",
              description: "Filter by IT Glue user ID",
            },
            organization_id: {
              type: "number",
              description: "Filter by organization ID",
            },
            resource_type: {
              type: "string",
              description:
                "Filter by resource type the activity was against (e.g. Configuration, Password, Document, FlexibleAsset)",
            },
            start_date: {
              type: "string",
              description:
                "Start of the UTC date range, YYYY-MM-DD. Omit for an open start. The range may not exceed 7 days.",
            },
            end_date: {
              type: "string",
              description:
                "End of the UTC date range, YYYY-MM-DD. Omit for an open end. The range may not exceed 7 days.",
            },
            sort: {
              type: "string",
              description:
                "Sort field: id, created, viewed, edited, deleted, or date. Prefix with - for descending.",
            },
            page_size: {
              type: "number",
              description: "Number of results per page (max 1000, default 50)",
            },
            page_number: {
              type: "number",
              description: "Page number (default 1)",
            },
          },
        },
      },
      // Health check
      {
        name: "itglue_health_check",
        description: "Check connectivity to IT Glue API by fetching organization types",
        inputSchema: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ],
  };
});

// Session-level JWT slot. Initialised from credentials and mutated by the
// elicitJwt path so a single paste covers the rest of the session (JWTs are
// 2h-TTL). Per-server-instance; in stateless HTTP gateway mode each request
// gets a fresh server, so this is effectively scoped to one request there.
let sessionJwt: string | undefined;

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const credentials = credentialOverrides
    ? sanitizeCredentials(credentialOverrides)
    : getCredentialsFromEnv();

  // Seed the session JWT slot from credentials on first call (avoids
  // recomputing every tool invocation).
  if (sessionJwt === undefined && credentials.jwt) {
    sessionJwt = credentials.jwt;
  }

  if (!credentials.apiKey && !sessionJwt) {
    return {
      content: [
        {
          type: "text",
          text: "Error: No API credentials provided. Please configure your IT Glue API key (ITGLUE_API_KEY env var or X-ITGlue-API-Key header) or a JWT (ITGLUE_JWT env var or X-ITGlue-JWT header).",
        },
      ],
      isError: true,
    };
  }

  // Effective credentials for this call — JWT, when present, overrides
  // because it carries strictly broader scope on the IT Glue API.
  const effectiveCredentials: GatewayCredentials = {
    ...credentials,
    jwt: sessionJwt ?? credentials.jwt,
  };

  /**
   * Ensure the session has a JWT, eliciting one from the user if needed.
   * Returns the JWT or null if the client doesn't support elicitation /
   * the user declined. Caches successful elicitation in `sessionJwt` so
   * subsequent JWT-only tools don't re-prompt.
   */
  const ensureJwt = async (reason: string): Promise<string | null> => {
    if (sessionJwt) return sessionJwt;
    const elicited = await elicitText(
      `${reason} Your API key could not access this resource (your IT Glue tenant may not expose Document Folders to API keys yet — the rollout runs through 2026), so a JWT is needed as a fallback. Paste your IT Glue JWT — find it in browser DevTools → Network → any request to itg-api-*.itglue.com → Authorization: Bearer <token>. JWT expires in ~2h; you'll be re-prompted on expiry. NOTE: this token will appear in your conversation transcript.`,
      "jwt",
      "IT Glue JWT (e.g. eyJ0eXAiOiJKV1Qi...)"
    );
    if (!elicited || elicited.trim() === "") return null;
    sessionJwt = elicited.trim();
    return sessionJwt;
  };

  /**
   * Build a JWT-authenticated client for tools that need the elevated scope.
   * Returns null when no JWT is available and elicitation didn't yield one.
   */
  const getJwtClient = async (reason: string): Promise<ITGlueClient | null> => {
    const jwt = await ensureJwt(reason);
    if (!jwt) return null;
    return createClient({ ...effectiveCredentials, apiKey: undefined, jwt });
  };

  try {
    const client = createClient(effectiveCredentials);

    switch (name) {
      // Organizations
      case "search_organizations": {
        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {};

        // If no search term provided, elicit one from the user
        let orgName = args?.name as string | undefined;
        if (!orgName && !args?.organization_type_id && !args?.organization_status_id && !args?.psa_id) {
          const elicited = await elicitText(
            "Which organization are you looking for?",
            "name",
            "Enter an organization name to search for, or leave blank to list all"
          );
          if (elicited) {
            orgName = elicited;
          }
        }

        if (orgName) filter.name = orgName;
        if (args?.organization_type_id) filter.organizationTypeId = args.organization_type_id;
        if (args?.organization_status_id) filter.organizationStatusId = args.organization_status_id;
        if (args?.psa_id) filter.psaId = args.psa_id;

        if (Object.keys(filter).length > 0) params.filter = filter;
        if (args?.sort) params.sort = args.sort;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };

        const result = await client.request("/organizations", params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "get_organization": {
        if (!args?.id) {
          return {
            content: [{ type: "text", text: "Error: Organization ID is required" }],
            isError: true,
          };
        }
        const org = await client.get(`/organizations/${args.id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(org, null, 2),
            },
          ],
        };
      }

      // Configurations
      case "search_configurations": {
        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {};

        let configOrgId = args?.organization_id as number | undefined;

        // If no organization_id, elicit an organization name search to find it
        if (!configOrgId) {
          const orgSearch = await elicitText(
            "Configurations are easier to find when scoped to an organization. Which organization?",
            "organization",
            "Enter an organization name to search for"
          );
          if (orgSearch) {
            // Search for the organization to get its ID
            const orgResult = await client.request("/organizations", {
              filter: { name: orgSearch },
              page: { size: 5, number: 1 },
            });
            const orgs = orgResult.data as Array<Record<string, unknown>>;
            if (orgs.length === 1) {
              configOrgId = Number(orgs[0].id);
            } else if (orgs.length > 1) {
              // Return the org list so the LLM can ask the user to pick
              return {
                content: [
                  {
                    type: "text",
                    text: `Multiple organizations match "${orgSearch}". Please re-run with a specific organization_id:\n\n${JSON.stringify(orgs.map((o) => ({ id: o.id, name: o.name })), null, 2)}`,
                  },
                ],
              };
            }
          }
        }

        if (configOrgId) filter.organizationId = configOrgId;
        if (args?.name) filter.name = args.name;
        if (args?.configuration_type_id) filter.configurationTypeId = args.configuration_type_id;
        if (args?.configuration_status_id) filter.configurationStatusId = args.configuration_status_id;
        if (args?.serial_number) filter.serialNumber = args.serial_number;
        if (args?.rmm_id) filter.rmmId = args.rmm_id;
        if (args?.psa_id) filter.psaId = args.psa_id;

        if (Object.keys(filter).length > 0) params.filter = filter;
        if (args?.sort) params.sort = args.sort;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };

        const result = await client.request("/configurations", params);
        const configText = [
          unscopedSearchNoteFor("configurations", filter, result.meta),
          JSON.stringify(result, null, 2),
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [{ type: "text", text: configText }],
        };
      }

      case "get_configuration": {
        if (!args?.id) {
          return {
            content: [{ type: "text", text: "Error: Configuration ID is required" }],
            isError: true,
          };
        }
        const config = await client.get(`/configurations/${args.id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(config, null, 2),
            },
          ],
        };
      }

      // Locations
      case "search_locations": {
        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {};

        let locOrgId = args?.organization_id as number | undefined;

        // If no organization_id, elicit an organization name search to find it
        // (mirrors search_configurations / search_passwords).
        if (!locOrgId) {
          const orgSearch = await elicitText(
            "Locations are easier to find when scoped to an organization. Which organization?",
            "organization",
            "Enter an organization name to search for"
          );
          if (orgSearch) {
            const orgResult = await client.request("/organizations", {
              filter: { name: orgSearch },
              page: { size: 5, number: 1 },
            });
            const orgs = orgResult.data as Array<Record<string, unknown>>;
            if (orgs.length === 1) {
              locOrgId = Number(orgs[0].id);
            } else if (orgs.length > 1) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Multiple organizations match "${orgSearch}". Please re-run with a specific organization_id:\n\n${JSON.stringify(orgs.map((o) => ({ id: o.id, name: o.name })), null, 2)}`,
                  },
                ],
              };
            }
          }
        }

        if (locOrgId) filter.organizationId = locOrgId;
        if (args?.name) filter.name = args.name;
        if (args?.city) filter.city = args.city;
        if (args?.region_id) filter.regionId = args.region_id;
        if (args?.country_id) filter.countryId = args.country_id;
        if (args?.psa_id) filter.psaId = args.psa_id;

        if (Object.keys(filter).length > 0) params.filter = filter;
        if (args?.sort) params.sort = args.sort;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };

        const result = await client.request("/locations", params);
        const locText = [
          unscopedSearchNoteFor("locations", filter, result.meta),
          JSON.stringify(result, null, 2),
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [{ type: "text", text: locText }],
        };
      }

      case "get_location": {
        if (!args?.id) {
          return {
            content: [{ type: "text", text: "Error: Location ID is required" }],
            isError: true,
          };
        }
        const location = await client.get(`/locations/${args.id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(location, null, 2),
            },
          ],
        };
      }

      case "create_location": {
        if (!args?.organization_id || !args?.name) {
          return {
            content: [{ type: "text", text: "Error: organization_id and name are required" }],
            isError: true,
          };
        }
        // IT Glue accepts snake_case attribute keys on write (same precedent as
        // document creation). The organization is supplied via the relationship
        // path, so it is not repeated in attributes.
        const argv = args as Record<string, unknown>;
        const attributes: Record<string, unknown> = { name: argv.name };
        const writableFields = [
          "country_id", "region_id", "address_1", "address_2",
          "city", "postal_code", "phone", "fax", "notes", "primary",
        ];
        for (const field of writableFields) {
          const value = argv[field];
          if (value !== undefined && value !== null) attributes[field] = value;
        }
        const newLocation = await client.post(
          `/organizations/${args.organization_id}/relationships/locations`,
          { data: { type: "locations", attributes } }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(newLocation, null, 2) }],
        };
      }

      case "update_location": {
        if (!args?.organization_id || !args?.id) {
          return {
            content: [{ type: "text", text: "Error: organization_id and id are required" }],
            isError: true,
          };
        }
        const argv = args as Record<string, unknown>;
        const attributes: Record<string, unknown> = {};
        const writableFields = [
          "name", "country_id", "region_id", "address_1", "address_2",
          "city", "postal_code", "phone", "fax", "notes", "primary",
        ];
        for (const field of writableFields) {
          const value = argv[field];
          if (value !== undefined && value !== null) attributes[field] = value;
        }
        if (Object.keys(attributes).length === 0) {
          return {
            content: [{ type: "text", text: "Error: provide at least one field to update (e.g. phone, address_1, city)" }],
            isError: true,
          };
        }
        const updatedLocation = await client.patch(
          `/organizations/${args.organization_id}/relationships/locations/${args.id}`,
          { data: { type: "locations", attributes } }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(updatedLocation, null, 2) }],
        };
      }

      // Passwords
      case "search_passwords": {
        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {};

        let pwOrgId = args?.organization_id as number | undefined;

        // If no organization_id, elicit an organization name search to find it
        if (!pwOrgId) {
          const orgSearch = await elicitText(
            "Passwords are easier to find when scoped to an organization. Which organization?",
            "organization",
            "Enter an organization name to search for"
          );
          if (orgSearch) {
            // Search for the organization to get its ID
            const orgResult = await client.request("/organizations", {
              filter: { name: orgSearch },
              page: { size: 5, number: 1 },
            });
            const orgs = orgResult.data as Array<Record<string, unknown>>;
            if (orgs.length === 1) {
              pwOrgId = Number(orgs[0].id);
            } else if (orgs.length > 1) {
              // Return the org list so the LLM can ask the user to pick
              return {
                content: [
                  {
                    type: "text",
                    text: `Multiple organizations match "${orgSearch}". Please re-run with a specific organization_id:\n\n${JSON.stringify(orgs.map((o) => ({ id: o.id, name: o.name })), null, 2)}`,
                  },
                ],
              };
            }
          }
        }

        if (pwOrgId) filter.organizationId = pwOrgId;
        if (args?.name) filter.name = args.name;
        if (args?.password_category_id) filter.passwordCategoryId = args.password_category_id;
        if (args?.url) filter.url = args.url;
        if (args?.username) filter.username = args.username;

        if (Object.keys(filter).length > 0) params.filter = filter;
        if (args?.sort) params.sort = args.sort;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };
        // Don't show passwords in search results for security
        params.show_password = false;

        const result = await client.request("/passwords", params);
        const redacted = {
          ...result,
          data: stripPasswordValues(result.data as unknown[]),
        };
        const pwText = [
          unscopedSearchNoteFor("passwords", filter, result.meta),
          JSON.stringify(redacted, null, 2),
        ]
          .filter(Boolean)
          .join("\n\n");
        return {
          content: [{ type: "text", text: pwText }],
        };
      }

      case "get_password": {
        if (!args?.id) {
          return {
            content: [{ type: "text", text: "Error: Password ID is required" }],
            isError: true,
          };
        }
        const showPassword = args?.show_password !== false;
        const password = await client.get(`/passwords/${args.id}`, {
          show_password: showPassword,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(password, null, 2),
            },
          ],
        };
      }

      // Documents
      case "search_documents": {
        if (!args?.organization_id) {
          return {
            content: [{ type: "text", text: "Error: organization_id is required for search_documents" }],
            isError: true,
          };
        }

        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {};

        if (args?.name) filter.name = args.name;
        if (args?.document_folder_id) filter.documentFolderId = args.document_folder_id;

        if (Object.keys(filter).length > 0) params.filter = filter;
        if (args?.sort) params.sort = args.sort;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };

        try {
          let result: { data: unknown[]; meta: PaginationMeta };
          let note: string | null;

          if (args?.document_folder_id) {
            // Explicit folder scope — single request, result is complete for
            // that folder, no caveat needed.
            result = await client.request(
              `/organizations/${args.organization_id}/relationships/documents`,
              params
            );
            note = null;
          } else {
            // No folder scope — default to the folder-INCLUSIVE listing, with
            // layered degradation down to the legacy root-only call.
            const attempted = await requestDocumentsWithFolderDefault(
              client,
              args.organization_id as number | string,
              params
            );
            result = attempted.result;
            note =
              attempted.attempt === "unfiltered"
                ? rootLevelDocumentsNote({
                    folderFiltered: false,
                    haveJwt: Boolean(sessionJwt ?? credentials.jwt),
                  })
                : folderedDocumentsIncludedNote();
          }

          // Drop each document's full body — search_documents is a list tool,
          // and IT Glue's list endpoint inlines the entire sectioned body per
          // document, which can balloon the response past the client's limit
          // (issue #55). Bodies stay available via get_document.
          const trimmed = { ...result, data: stripDocumentBodies(result.data) };
          const text = [documentBodyOmittedNote(), note, JSON.stringify(trimmed, null, 2)]
            .filter(Boolean)
            .join("\n\n");
          return {
            content: [{ type: "text", text }],
          };
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("404")) {
            return {
              content: [{
                type: "text",
                text: `No documents found for organization ${args.organization_id}. The organization may not have the IT Glue Documents module enabled, or may not have any documents yet. Consider using search_flexible_assets instead, which stores documentation as structured data.`,
              }],
              isError: true,
            };
          }
          throw err;
        }
      }

      case "get_document": {
        if (!args?.organization_id || !args?.id) {
          return {
            content: [{ type: "text", text: "Error: organization_id and id are required" }],
            isError: true,
          };
        }
        const doc = await client.get<Record<string, unknown>>(
          `/organizations/${args.organization_id}/relationships/documents/${args.id}`
        );
        const payload: Record<string, unknown> = { ...doc };

        // MCP Apps: attach the normalized card payload the ui:// document
        // card renders from. Best-effort — a null card just means no UI
        // surface, and the model-visible payload is otherwise unchanged.
        const card = await buildDocumentCard(payload, client);
        if (card) payload._card = card;

        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      }

      case "list_document_folders": {
        if (!args?.organization_id) {
          return {
            content: [{ type: "text", text: "Error: organization_id is required" }],
            isError: true,
          };
        }
        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {};
        if (args?.name) filter.name = args.name;
        if (Object.keys(filter).length > 0) params.filter = filter;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };

        // API-key first: IT Glue is rolling out a public Document Folders
        // resource, so most tenants no longer need a JWT here. Fall back to
        // JWT auth only when the API key is rejected (401/403/404).
        if (effectiveCredentials.apiKey) {
          const apiKeyClient = createClient({ ...effectiveCredentials, jwt: undefined });
          const apiKeyResult = await listDocumentFoldersViaApiKey(
            apiKeyClient,
            args.organization_id as number | string,
            params
          );
          if (apiKeyResult) {
            return {
              content: [{ type: "text", text: JSON.stringify(apiKeyResult, null, 2) }],
            };
          }
        }

        const jwtClient = await getJwtClient("Listing IT Glue document folders.");
        if (!jwtClient) {
          return {
            content: [{
              type: "text",
              text: "Could not list document folders. API-key access requires your IT Glue tenant's API to expose the Document Folders resource (IT Glue is rolling this out across tenants in 2026; yours does not appear to have it yet), and no JWT was available as a fallback. Configure ITGLUE_JWT (env) or X-ITGlue-JWT (header), or paste one when prompted. See README for how to retrieve a JWT from your browser.",
            }],
            isError: true,
          };
        }
        try {
          const result = await jwtClient.request(
            `/organizations/${args.organization_id}/relationships/document_folders`,
            params
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("401")) {
            sessionJwt = undefined;
            return {
              content: [{
                type: "text",
                text: "IT Glue rejected the JWT (likely expired — they last ~2h). The cached JWT has been cleared; re-run this tool to be prompted for a fresh one.",
              }],
              isError: true,
            };
          }
          throw err;
        }
      }

      case "create_document": {
        if (!args?.organization_id || !args?.name) {
          return {
            content: [{ type: "text", text: "Error: organization_id and name are required" }],
            isError: true,
          };
        }

        let folderId = args.document_folder_id as number | string | undefined;
        const skipPrompt = args.skip_folder_prompt === true;

        if (folderId === undefined && !skipPrompt) {
          // Enumerate folders for the name-based picker: API key first (IT
          // Glue is rolling out a public Document Folders resource), then a
          // JWT the caller has already configured. If neither can list
          // folders, fall back to the URL/ID parser as the last resort.
          const pickerParams = { page: { size: 1000, number: 1 } };
          let folders: DocumentFolderResource[] | null = null;

          if (effectiveCredentials.apiKey) {
            const apiKeyClient = createClient({ ...effectiveCredentials, jwt: undefined });
            const apiKeyResult = await listDocumentFoldersViaApiKey(
              apiKeyClient,
              args.organization_id as number | string,
              pickerParams
            );
            if (apiKeyResult) {
              folders = apiKeyResult.data as DocumentFolderResource[];
            }
          }

          if (folders === null && Boolean(sessionJwt ?? credentials.jwt)) {
            const jwtClient = await getJwtClient("Listing folders to pick from.");
            if (jwtClient) {
              try {
                const foldersResp = await jwtClient.request(
                  `/organizations/${args.organization_id}/relationships/document_folders`,
                  pickerParams
                ) as { data?: DocumentFolderResource[] };
                folders = foldersResp?.data ?? [];
              } catch (err) {
                // 401 invalidates the cached JWT and falls through to the URL
                // parser; any other error propagates because something is
                // genuinely wrong.
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes("401")) {
                  sessionJwt = undefined;
                } else {
                  throw err;
                }
              }
            }
          }

          let pickerUsed = false;
          if (folders && folders.length > 0) {
            pickerUsed = true;
            const choice = await elicitSelection(
              `Which folder should "${args.name}" go in?`,
              "folder",
              buildFolderPickerOptions(folders)
            );
            if (choice && choice !== "__root__") {
              folderId = choice;
            }
            // null choice (declined/unsupported) or "__root__" → folderId stays undefined.
          }

          if (!pickerUsed) {
            const elicited = await elicitText(
              `Where should "${args.name}" go? Paste one of:\n  • a folder URL (e.g. https://…/documents/folder/12345/)\n  • a sibling document's URL (e.g. https://…/docs/67890)\n  • a folder ID number\nLeave blank to create at the organization root.`,
              "folder",
              "IT Glue folder URL, sibling-document URL, or numeric folder ID"
            );
            const ref = parseFolderReference(elicited);
            if (ref.kind === "invalid") {
              return {
                content: [{
                  type: "text",
                  text: `Could not parse folder reference "${ref.input}". Expected a folder URL, a document URL, a numeric folder ID, or an empty value for root.`,
                }],
                isError: true,
              };
            }
            let siblingAtRoot = false;
            if (ref.kind === "folder") {
              folderId = ref.folderId;
            } else if (ref.kind === "doc") {
              const sibling = await client.get<Record<string, unknown>>(
                `/organizations/${args.organization_id}/relationships/documents/${ref.docId}`
              );
              const siblingFolder = sibling.documentFolderId ?? sibling["document-folder-id"];
              if (siblingFolder != null) {
                folderId = siblingFolder as number | string;
              } else {
                // The user pasted a sibling URL expecting placement; surface
                // that the sibling itself is at root so "created at root"
                // isn't a surprise.
                siblingAtRoot = true;
              }
            }
            // ref.kind === "root" (elicit blank/null/unsupported): fall through with folderId undefined.

            if (siblingAtRoot) {
              const newDoc = await createDocumentWithContent(client, {
                organization_id: args.organization_id as number | string,
                name: args.name as string,
                content: args.content as string | undefined,
                document_folder_id: folderId,
              });
              return {
                content: [
                  {
                    type: "text",
                    text: `Note: the sibling document you referenced lives at the organization root, so the new document was also created at the root.\n\n${JSON.stringify(newDoc, null, 2)}`,
                  },
                ],
              };
            }
          }
        }

        const newDoc = await createDocumentWithContent(client, {
          organization_id: args.organization_id as number | string,
          name: args.name as string,
          content: args.content as string | undefined,
          document_folder_id: folderId,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(newDoc, null, 2) }],
        };
      }

      // Document Sections
      case "list_document_sections": {
        if (!args?.document_id) {
          return {
            content: [{ type: "text", text: "Error: document_id is required" }],
            isError: true,
          };
        }
        const result = await client.request(
          `/documents/${args.document_id}/relationships/sections`,
          {}
        );
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      case "create_document_section": {
        if (!args?.document_id || !args?.section_type || !args?.content) {
          return {
            content: [{ type: "text", text: "Error: document_id, section_type, and content are required" }],
            isError: true,
          };
        }
        // IT Glue's API stores the section-type value in the `resource_type`
        // attribute (values `Document::Text` / `Document::Heading`). The
        // `section-type` field is accepted but ignored, and passing a
        // `relationships.resource` binding triggers a 400 for missing
        // `resource_type`. Verified live 2026-04-23.
        const sectionTypeMap: Record<string, string> = {
          heading: "Document::Heading",
          text: "Document::Text",
        };
        const apiSectionType = sectionTypeMap[args.section_type as string];
        if (!apiSectionType) {
          return {
            content: [{ type: "text", text: "Error: section_type must be 'heading' or 'text'" }],
            isError: true,
          };
        }
        const newSection = await client.post(
          `/documents/${args.document_id}/relationships/sections`,
          {
            data: {
              type: "document-sections",
              attributes: {
                resource_type: apiSectionType,
                content: args.content,
              },
            },
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(newSection, null, 2) }],
        };
      }

      case "update_document_section": {
        if (!args?.document_id || !args?.section_id || !args?.content) {
          return {
            content: [{ type: "text", text: "Error: document_id, section_id, and content are required" }],
            isError: true,
          };
        }
        const updatedSection = await client.patch(
          `/documents/${args.document_id}/relationships/sections/${args.section_id}`,
          {
            data: {
              type: "document-sections",
              attributes: {
                content: args.content,
              },
            },
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(updatedSection, null, 2) }],
        };
      }

      case "delete_document_section": {
        if (!args?.document_id || !args?.section_id) {
          return {
            content: [{ type: "text", text: "Error: document_id and section_id are required" }],
            isError: true,
          };
        }
        await client.delete(
          `/documents/${args.document_id}/relationships/sections/${args.section_id}`
        );
        return {
          content: [{ type: "text", text: `Section ${args.section_id} deleted successfully` }],
        };
      }

      case "create_document_image": {
        if (!args?.document_id || !args?.file_name || !args?.content) {
          return {
            content: [{ type: "text", text: "Error: document_id, file_name, and content are required" }],
            isError: true,
          };
        }
        const image = await client.post(
          `/documents/${args.document_id}/relationships/document_images`,
          {
            data: {
              type: "document_images",
              attributes: {
                image: {
                  content: stripDataUriPrefix(args.content as string),
                  file_name: args.file_name,
                },
              },
            },
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(image, null, 2) }],
        };
      }

      case "create_attachment": {
        if (!args?.resource_type || !args?.resource_id || !args?.file_name || !args?.content) {
          return {
            content: [
              {
                type: "text",
                text: "Error: resource_type, resource_id, file_name, and content are required",
              },
            ],
            isError: true,
          };
        }
        if (!ATTACHABLE_RESOURCE_TYPES.includes(args.resource_type as typeof ATTACHABLE_RESOURCE_TYPES[number])) {
          return {
            content: [
              {
                type: "text",
                text: `Error: resource_type must be one of ${ATTACHABLE_RESOURCE_TYPES.join(", ")}`,
              },
            ],
            isError: true,
          };
        }
        const attachment = await client.post(
          `/${args.resource_type}/${args.resource_id}/relationships/attachments`,
          {
            data: {
              type: "attachments",
              attributes: {
                attachment: {
                  content: stripDataUriPrefix(args.content as string),
                  file_name: args.file_name,
                },
              },
            },
          }
        );
        return {
          content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }],
        };
      }

      case "list_attachments": {
        if (!args?.resource_type || !args?.resource_id) {
          return {
            content: [{ type: "text", text: "Error: resource_type and resource_id are required" }],
            isError: true,
          };
        }
        if (!ATTACHABLE_RESOURCE_TYPES.includes(args.resource_type as typeof ATTACHABLE_RESOURCE_TYPES[number])) {
          return {
            content: [
              {
                type: "text",
                text: `Error: resource_type must be one of ${ATTACHABLE_RESOURCE_TYPES.join(", ")}`,
              },
            ],
            isError: true,
          };
        }
        const attachments = await client.get(
          `/${args.resource_type}/${args.resource_id}/relationships/attachments`
        );
        return {
          content: [{ type: "text", text: JSON.stringify(attachments, null, 2) }],
        };
      }

      case "publish_document": {
        if (!args?.document_id) {
          return {
            content: [{ type: "text", text: "Error: document_id is required" }],
            isError: true,
          };
        }
        // Publish uses PATCH — POST returns 404
        const published = await client.patch(`/documents/${args.document_id}/publish`);
        return {
          content: [{ type: "text", text: JSON.stringify(published, null, 2) }],
        };
      }

      case "archive_document":
      case "unarchive_document": {
        if (!args?.document_id) {
          return {
            content: [{ type: "text", text: "Error: document_id is required" }],
            isError: true,
          };
        }
        // IT Glue toggles archive state via PATCH /documents/:id with the
        // standard JSON:API document resource shape. There is no dedicated
        // /archive sub-endpoint — only the `archived` boolean attribute.
        const archived = name === "archive_document";
        const result = await client.patch(`/documents/${args.document_id}`, {
          data: {
            type: "documents",
            attributes: { archived },
          },
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      }

      // Flexible Assets
      case "list_flexible_asset_types": {
        const params: Record<string, unknown> = {};
        if (args?.organization_id) {
          params.filter = { organizationId: args.organization_id };
        }
        params.page = { size: 100, number: 1 };

        const result = await client.request("/flexible_asset_types", params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "search_flexible_assets": {
        if (!args?.flexible_asset_type_id) {
          return {
            content: [{ type: "text", text: "Error: flexible_asset_type_id is required" }],
            isError: true,
          };
        }

        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {
          flexibleAssetTypeId: args.flexible_asset_type_id,
        };

        if (args?.organization_id) filter.organizationId = args.organization_id;
        if (args?.name) filter.name = args.name;

        params.filter = filter;
        if (args?.sort) params.sort = args.sort;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };

        const result = await client.request("/flexible_assets", params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "search_user_metrics": {
        const dateFilter = buildUserMetricsDateFilter(
          args?.start_date as string | undefined,
          args?.end_date as string | undefined
        );
        if ("error" in dateFilter) {
          return {
            content: [{ type: "text", text: `Error: ${dateFilter.error}` }],
            isError: true,
          };
        }

        if (args?.sort) {
          const field = String(args.sort).replace(/^-/, "");
          if (!(USER_METRIC_SORT_FIELDS as readonly string[]).includes(field)) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `Error: sort must be one of ${USER_METRIC_SORT_FIELDS.join(", ")} ` +
                    `(optionally prefixed with - for descending); got "${args.sort}"`,
                },
              ],
              isError: true,
            };
          }
        }

        const params: Record<string, unknown> = {};
        const filter: Record<string, unknown> = {};

        if (args?.user_id) filter.userId = args.user_id;
        if (args?.organization_id) filter.organizationId = args.organization_id;
        if (args?.resource_type) filter.resourceType = args.resource_type;
        if (dateFilter.value !== null) filter.date = dateFilter.value;

        if (Object.keys(filter).length > 0) params.filter = filter;
        if (args?.sort) params.sort = args.sort;
        params.page = {
          size: (args?.page_size as number) || 50,
          number: (args?.page_number as number) || 1,
        };

        const result = await client.request("/user_metrics", params);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // Health check
      case "itglue_health_check": {
        const result = await client.request("/organization_types", { page: { size: 1 } });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "ok",
                  message: "IT Glue API is reachable",
                  region: credentials.region,
                  organizationTypesFound: result.meta.totalCount,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${errorMessage}`,
        },
      ],
      isError: true,
    };
  }
});

  return server;
}
