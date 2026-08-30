# IT Glue MCP Server

A Model Context Protocol (MCP) server that provides Claude with access to IT Glue documentation and asset management.

## One-Click Deployment

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/WYRE-AI/itglue-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WYRE-AI/itglue-mcp)

> [!NOTE]
> Unlike the other Wyre MCP servers, this one talks to the IT Glue API directly and
> has **no private `@wyre-ai/*` runtime dependency**, so the one-click build
> does not need a GitHub Packages token — the cloud builder's `npm ci` only pulls
> public packages. (A `read:packages` token is only needed to install the published
> `@wyre-ai/itglue-mcp` package itself; see [Installation](#installation).)
> The DigitalOcean target builds the full Docker image and runs the complete MCP
> server over HTTP and is the recommended path; this repo does not ship a Workers
> entrypoint (`src/worker.ts`), so prefer DigitalOcean or the prebuilt container
> image (`ghcr.io/wyre-ai/itglue-mcp`).

## Installation

This package is published to the **GitHub Packages** npm registry, which requires a
token even for public packages. Authenticate npm once, then install:

```bash
# Authenticate npm to GitHub Packages (token needs the read:packages scope)
export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages

npm install @wyre-ai/itglue-mcp
```

The repo's `.npmrc` already points the `@wyre-ai` scope at GitHub Packages and
reads the token from `NODE_AUTH_TOKEN`, so no further config is needed. The same applies
to `npx @wyre-ai/itglue-mcp`.

Or use the Docker image:

```bash
docker pull ghcr.io/wyre-ai/itglue-mcp:latest
```

## Configuration

The server accepts credentials via environment variables:

| Variable | Description | Required |
|----------|-------------|----------|
| `ITGLUE_API_KEY` | Your IT Glue API key (format: ITG.xxx) | Yes (env mode) |
| `ITGLUE_JWT` | A user-session JWT used as an optional **fallback** for document-folder operations on tenants whose API key cannot access the Document Folders resource yet. See [JWT fallback for document-folder operations](#jwt-fallback-for-document-folder-operations). | No |
| `ITGLUE_REGION` | API region: `us`, `eu`, or `au` (default: `us`) | No |
| `ITGLUE_BASE_URL` | Override the IT Glue API base URL (advanced) | No |
| `MCP_TRANSPORT` | Transport: `stdio` (local) or `http` (remote). Defaults to `stdio` when run via `npx`/`node`, and to `http` in the Docker image. | No |
| `MCP_HTTP_PORT` | Port for HTTP transport (default: `8080`) | No |
| `MCP_HTTP_HOST` | Bind address for HTTP transport (default: `0.0.0.0`) | No |
| `AUTH_MODE` | `env` (read credentials from environment) or `gateway` (read per-request credentials from HTTP headers). Default: `env`. | No |

Alternative: When `AUTH_MODE=gateway`, the MCP Gateway injects credentials per request via HTTP headers instead of environment variables. See [Remote Deployment](#remote-deployment-http-streamable).

### JWT fallback for document-folder operations

**A JWT is optional** — it is only needed if your tenant's API key can't access Document Folders yet. Every folder-related path tries your API key first:

- `search_documents` — defaults to a folder-inclusive listing (`filter[document_folder_id]=null` returns all documents, foldered ones included; each result carries its `documentFolderId`). If the tenant's API rejects that filter, the server retries the `[ne]` filter form and finally degrades to the legacy root-only listing, saying so in the result. No JWT is involved at any layer.
- `list_document_folders` — IT Glue's public (API-key) API now documents a Document Folders resource, which is rolling out across tenants through 2026. The server tries the API key first (on the organization-relationship path, then the top-level `/document_folders` path) and only falls back to a JWT if the key is rejected.
- `create_document` — the name-based folder picker uses the same API-key-first enumeration, then a configured JWT; if neither can list folders, it prompts for a folder URL / sibling-document URL / numeric folder ID as the last resort.

If you do need the JWT fallback, provide it in whichever way matches your deployment:

| Mode | How to supply the JWT |
|------|-----------------------|
| Local / env (`AUTH_MODE=env`) | Set the `ITGLUE_JWT` environment variable. |
| Remote gateway (`AUTH_MODE=gateway`) | Send the `X-ITGlue-JWT` request header. |
| Interactive clients (Claude Desktop/Code) | Leave it unset — the server prompts you to paste a JWT on first use and caches it for the session. |

> **Headless deployments (Docker, cloud):** there is no one to answer the interactive prompt, so if your tenant's API key cannot enumerate folders you must set `ITGLUE_JWT` (env mode) or send `X-ITGlue-JWT` (gateway mode) for folder enumeration to work.

**Retrieving a JWT from your browser:**

1. Sign in to IT Glue in your browser.
2. Open DevTools → **Network** tab.
3. Click any request to `itg-api-*.itglue.com`.
4. Copy the value of the `Authorization: Bearer <token>` request header — the `<token>` part is your JWT.

> **Expiry:** IT Glue JWTs are short-lived (~2 hours). A JWT placed in `ITGLUE_JWT` on a long-running container will go stale and the JWT fallback will start failing until it is refreshed. Interactive clients are simply re-prompted on expiry. API-key operations are unaffected.

## Available Tools

### Organizations

- **search_organizations** - Search for organizations with optional filtering by name, type, status, or PSA ID
- **get_organization** - Get a specific organization by ID

### Configurations (Devices/Assets)

- **search_configurations** - Search for configurations with filtering by organization, name, type, status, serial number, RMM ID, or PSA ID
- **get_configuration** - Get a specific configuration by ID

### Locations (Addresses/Sites)

- **search_locations** - Search an organization's locations (built-in address/site records), filtering by organization, name, city, region, or country. Results include the address fields and phone number.
- **get_location** - Get a specific location by ID, including its full address and phone number
- **create_location** - Create a new location for an organization (requires `name`, typically `country_id`)
- **update_location** - Update an existing location; only the fields you supply are changed

### Passwords

- **search_passwords** - Search for password entries (metadata only, no actual passwords in results)
- **get_password** - Get a specific password entry including the actual password value

### Documents

- **search_documents** - Search for documents with filtering by organization, name, or folder. Defaults to a folder-inclusive listing (each result carries its `documentFolderId`), degrading gracefully to a root-only listing on tenants whose API rejects the folder filter
- **get_document** - Get a specific document by ID, including its sectioned body. Renders as an interactive card in MCP Apps hosts — see [Interactive Document Card](#interactive-document-card-mcp-apps)
- **list_document_folders** - List an organization's document folders (names and IDs). Works with an API key on tenants where IT Glue exposes the Document Folders resource; falls back to a JWT otherwise — see [JWT fallback for document-folder operations](#jwt-fallback-for-document-folder-operations)
- **create_document_image** - Upload an image into a document so it can be shown inline in the body. Base64 in, no multipart needed. See [Images in documents](#images-in-documents)

### Attachments

- **create_attachment** - Attach a file to a checklist, checklist template, configuration, contact, document, domain, flexible asset, location, password, SSL certificate or ticket. Base64 in
- **list_attachments** - List a record's attachments, with their download URLs

### Flexible Assets

- **search_flexible_assets** - Search for flexible assets (requires flexible_asset_type_id)

### User Metrics

- **search_user_metrics** - Search user activity metrics: per-user, per-organization, per-resource-type counts of `created` / `viewed` / `edited` / `deleted` actions, bucketed by date. Filter by `user_id`, `organization_id`, `resource_type`, and a `start_date` / `end_date` range; sort by `id`, `created`, `viewed`, `edited`, `deleted`, or `date` (prefix `-` for descending).

  This is the raw data behind IT Glue's user reputation scores, so it answers "who is actually maintaining documentation" — per tech, per client, per resource type.

  **Date-range rules** (verified live against `api.itglue.com`, 2026-08-06):

  - The range may span at most **7 days end-to-start** — so `2026-08-01,2026-08-08` is accepted (8 calendar days) and `2026-08-01,2026-08-09` returns 422. The API compares the *difference*, not the inclusive day count; reading "longer than a week" as 7 inclusive days is off by one in the direction that rejects valid queries.
  - **`end_date` requires `start_date`.** IT Glue rejects a filter beginning with a wildcard (`*,2026-08-07` → 422), so an end alone is a guaranteed error rather than a narrower query. An open *end* (`2026-08-01,*`) is fine.
  - Both violations return the **same** 422 title — *"date range filter cannot be longer than a week, and cannot start with a wildcard"* — so the API cannot tell you which one you hit. The tool checks both itself and says which, without spending the call.
  - Omit both dates to let IT Glue apply its own default window.

  **Gotcha — unknown filter keys are silently ignored.** `filter[not-a-real-key]=x` returns HTTP 200 with the *full unfiltered* result set, not an error (verified live). A typo'd or misremembered filter name therefore looks like a successful, correctly-scoped query while actually returning everything. Cross-check row counts against a deliberately impossible value (`filter[resource-type]=ZZZNoSuchType` correctly returns 0 rows) if a result looks too broad.

### Utility

- **itglue_health_check** - Verify connectivity to IT Glue API

### Interactive Document Card (MCP Apps)

`get_document` renders as an interactive card in MCP Apps hosts (Claude
Desktop/web) showing the document's name, organization, folder, key dates, and a
plain-text preview of its sections; plain-JSON behavior is unchanged in other
hosts. The card is read-only — neutral by default, brandable via
`window.__BRAND__` injection or `MCP_BRAND_*` env vars (`MCP_BRAND_NAME`,
`MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`,
`MCP_BRAND_BG`, `MCP_BRAND_TEXT`) — no rebuild needed.

### Images in documents

IT Glue's HTML sanitiser is strict about how a picture gets into a document
body, and fails two of three ways (verified live against `api.itglue.com`,
2026-08-31):

| What you try | What happens |
|---|---|
| Inline `<svg>` in section HTML | **Silently stripped.** The section saves, returns 200, and the diagram is simply gone from the stored content |
| `<img src="data:image/png;base64,…">` | **Rejected with a 500**, not a validation error |
| `<img src="https://…">` | Accepted and preserved |

So the only route to an image in a document body is to upload the file first and
reference the URL IT Glue gives back — which is what `create_document_image`
does. The inline-SVG case is the one worth knowing about, because it looks like
a successful write.

```
create_document_image(document_id, file_name, content)   # content = raw base64
→ reference the returned URL from an <img src> in update_document_section
→ publish_document
```

Pass **raw base64**. If a `data:...;base64,` prefix is left on the front the
tool strips it rather than passing it through: IT Glue stores whatever it is
given, so a prefixed payload uploads "successfully" and produces a corrupt file
that only surfaces when somebody opens it.

## Usage with Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "itglue": {
      "command": "npx",
      "args": ["@wyre-ai/itglue-mcp"],
      "env": {
        "ITGLUE_API_KEY": "${ITGLUE_API_KEY}",
        "ITGLUE_REGION": "us"
      }
    }
  }
}
```

Or with Docker (local stdio):

```json
{
  "mcpServers": {
    "itglue": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "MCP_TRANSPORT=stdio",
        "-e", "ITGLUE_API_KEY",
        "ghcr.io/wyre-ai/itglue-mcp:latest"
      ],
      "env": {
        "ITGLUE_API_KEY": "${ITGLUE_API_KEY}"
      }
    }
  }
}
```

> **Note:** The Docker image defaults to HTTP transport. The `-e MCP_TRANSPORT=stdio` above is required to run it as a local stdio server for Claude Desktop/Code. For server deployments, see [Remote Deployment](#remote-deployment-http-streamable) below.

## Remote Deployment (HTTP Streamable)

For server/cloud deployments, run the server with the HTTP Streamable transport. The Docker image already defaults to `MCP_TRANSPORT=http` on port `8080`, exposing two endpoints:

- `POST /mcp` — MCP Streamable HTTP endpoint (stateless: a fresh server is created per request)
- `GET /health` — unauthenticated health check

### Env mode (single tenant)

Credentials come from environment variables. Use this when one API key serves the deployment:

```bash
docker run -d \
  --name itglue-mcp \
  -p 8080:8080 \
  -e ITGLUE_API_KEY="ITG.xxxxxxxx" \
  -e ITGLUE_REGION="us" \
  --restart unless-stopped \
  ghcr.io/wyre-ai/itglue-mcp:latest

# Verify
curl http://localhost:8080/health
# {"status":"ok","transport":"http","authMode":"env",...}
```

Clients connect to `http://<host>:8080/mcp` using the MCP Streamable HTTP transport.

### Gateway mode (multi-tenant / hosted)

When deployed behind an MCP Gateway (e.g. `mcp.wyre.ai`), set `AUTH_MODE=gateway`. Credentials are then injected per request via HTTP headers rather than environment variables:

```bash
docker run -d \
  --name itglue-mcp \
  -p 8080:8080 \
  -e AUTH_MODE=gateway \
  --restart unless-stopped \
  ghcr.io/wyre-ai/itglue-mcp:latest
```

The gateway supplies credentials on each request via these headers:

| Header | Description | Required |
|--------|-------------|----------|
| `X-ITGlue-API-Key` (or `X-API-Key`) | IT Glue API key | One of API-Key or JWT |
| `X-ITGlue-JWT` | JWT for elevated-scope operations | One of API-Key or JWT |
| `X-ITGlue-Region` | API region: `us`, `eu`, or `au` (default: `us`) | No |
| `X-ITGlue-Base-URL` | Override the IT Glue API base URL | No |

Requests missing both `X-ITGlue-API-Key` and `X-ITGlue-JWT` receive a `401`. The `/health` endpoint reports `"authMode":"gateway"` in this mode.

### Running without Docker

The same transport works from an installed/built copy by setting `MCP_TRANSPORT=http`:

```bash
MCP_TRANSPORT=http MCP_HTTP_PORT=8080 ITGLUE_API_KEY="ITG.xxxxxxxx" \
  npx @wyre-ai/itglue-mcp
```

## Example Queries

Once configured, you can ask Claude:

- "Search for organizations containing 'Acme' in IT Glue"
- "Get the configuration details for device ID 12345"
- "Find all passwords for organization ID 100"
- "Search for flexible assets of type 54321"

## Security Notes

- Password search results do not include actual password values for security
- Use `get_password` with explicit ID to retrieve password values
- Store your API key securely using environment variables or a secrets manager
- The API key should have appropriate read permissions in IT Glue

## License

Apache-2.0

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
