## [Unreleased]

### Security

- **Cross-tenant elicitation/confirmation misroute (gateway mode).** The
  "server reference" used by elicitation helpers (`src/utils/elicitation.ts`
  — `elicitSelection` / `elicitText` / `elicitConfirmation`) was stored in a
  module-level `let _server: Server | null` singleton in
  `src/utils/server-ref.ts`, set synchronously per request via
  `setServerRef(server)` (called from `createMcpServer()` in
  `src/mcp-server.ts`) and read back later via `getServerRef()` — including
  after `await` gaps inside async tool handlers (e.g. after awaiting an IT
  Glue API call, before sending an elicitation/confirmation prompt back
  through "the" server).
  - **Impact:** in gateway (multi-tenant HTTP) mode — `AUTH_MODE=gateway` —
    a fresh `Server` instance is created per inbound request, so two
    concurrent tenant requests could race through the shared global: tenant
    A's request sets the ref and starts awaiting async work; before A
    resumes, tenant B's request runs and overwrites the module-level ref
    with B's server/transport; when A's awaited work resolves and it reads
    the ref back to call `elicitInput`, it gets B's server — so A's
    elicitation/confirmation prompt is sent down B's connection instead of
    A's (or vice versa, depending on timing). Same shared-mutable-state
    -across-await-gaps bug class as the credential-leak fixes in
    liongard-mcp#58, ninjaone-mcp#71, and the reference fix in
    halopsa-mcp#65, but in the server/transport routing subsystem for
    elicitation, not credential/token caching.
  - **Fix:** replaced the module-level singleton with an `AsyncLocalStorage<Server>`
    context (`runWithServerRef` for per-request transports — Node HTTP,
    Workers — and `bindServerRef` for the single-session stdio transport).
    `getServerRef()` now reads from the ALS context instead of a shared
    variable, so it is correctly scoped to the request that created it and
    survives arbitrary `await` gaps without observing a concurrent
    request's server. There is no module-level mutable server/transport
    state left in `src/utils/server-ref.ts`. Call sites updated:
    `src/mcp-server.ts` (`createMcpServer` no longer calls `setServerRef`),
    `src/index.ts` (Node HTTP handler wraps the connect/then/catch chain in
    `runWithServerRef`; stdio calls `bindServerRef` once at startup),
    `src/worker.ts` (Cloudflare Workers `handleMcp` wraps the
    connect/handleRequest chain in `runWithServerRef`). Unlike
    halopsa-mcp, this repo's gateway credentials are already passed as a
    per-call function parameter (`createMcpServer(credentialOverrides)`)
    rather than a second AsyncLocalStorage context, so no separate
    credential-isolation fix was needed here — only the server reference
    was affected.
  - **Regression test:** `src/__tests__/server-ref.test.ts` forces a
    deterministic interleave (a manually-resolved "gate" promise, not a
    timing stagger) where tenant A binds its server and suspends on an
    await gap, tenant B's entire request runs to completion in the
    meantime, and only then does tenant A resume and elicit. The test
    asserts by value which tenant's mock `elicitInput` actually received
    each message. Verified to fail with the exact predicted symptom
    (`expected 'tenant-B' to be 'tenant-A'`) against a reinstated
    module-singleton implementation, and to pass against the ALS-based fix.

### Changed

- **API-key-first document folder access (JWT now an optional fallback):**
  ([#55](https://github.com/wyre-technology/itglue-mcp/issues/55),
  [msp-claude-plugins#134](https://github.com/wyre-technology/msp-claude-plugins/issues/134))
  - `search_documents` now defaults to a folder-inclusive listing when no
    `document_folder_id` is supplied: it sends
    `filter[document_folder_id]=null` (which returns ALL documents, foldered
    ones included), retries with the `filter[document_folder_id][ne]=` form if
    the tenant's API rejects that (400/422), and only then degrades to the
    legacy root-only listing — keeping the root-level-only warning for that
    case. Each returned document carries its `documentFolderId`, so folder
    membership is visible in the results. Explicit `document_folder_id`
    searches are unchanged.
  - `list_document_folders` tries the API key first (organization-relationship
    path, then the top-level `/document_folders?filter[organization_id]=` form
    if that 404s — IT Glue's public Document Folders resource is rolling out
    across tenants through 2026 and may be exposed either way). The JWT client
    is now only a fallback for tenants whose API key is rejected (401/403/404),
    with the existing 401 JWT-cache-clear behavior retained.
  - `create_document`'s name-based folder picker uses the same API-key-first,
    JWT-fallback enumeration; the URL/ID folder prompt remains the last resort.
  - Tool descriptions, error messages, and the README no longer describe the
    JWT as a requirement for folder operations — it is an optional fallback,
    only needed if your tenant's API key can't access Document Folders yet. All
    JWT plumbing (`ITGLUE_JWT`, `X-ITGlue-JWT`, runtime paste) is unchanged.
- **Publishing:** releases now publish `@wyre-technology/itglue-mcp` to the GitHub
  Packages npm registry (`npmPublish: true`; `publishConfig.registry` was already
  set to `https://npm.pkg.github.com`).

### Added

- **Interactive document card via MCP Apps (SEP-1865).** `get_document` results now
  render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other
  hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall
  of JSON. The card shows the document name, organization, folder, archive state,
  key dates, and a short plain-text preview of the document's sections. IT Glue is
  a documentation system, so the card is read-only — there is no in-card write
  round-trip. Non-App hosts are unaffected: the tool's JSON payload is unchanged
  apart from a new `_card` field.
  - The renderable tool advertises the UI via `_meta` (`ui/resourceUri`, plus the
    nested `ui.resourceUri` form) pointing at a new `ui://itglue/document-card.html`
    resource served as `text/html;profile=mcp-app`. The card HTML is a
    self-contained vite single-file bundle embedded at build time
    (`src/generated/document-card-html.ts`, committed), so it serves identically
    from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime. The server
    now declares the `resources` capability and answers `resources/list` /
    `resources/read` (`src/resources.ts`).
  - The card is neutral by default (system fonts, no vendor identity, no external
    fetches) and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env
    vars (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`,
    `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`): at serve time the
    server replaces the card's BRAND_INJECT marker with an inline, `<`-escaped
    `window.__BRAND__` script, so self-hosters can theme the card without
    rebuilding. No brand configured = HTML served unchanged.
  - The card payload builder is best-effort: a failed section fetch degrades the
    card (or drops it) without affecting the tool result. 20 new contract tests in
    `src/__tests__/mcp-apps.test.ts` pin the `_meta` advertisement, the `ui://`
    resource wire shape, the neutral-default/brand-injection behavior, and the
    card normalization.
- **Locations tools:** `search_locations`, `get_location`, `create_location`, and
  `update_location` for IT Glue's built-in Locations entity (physical
  addresses/sites). Locations carry an organization's address fields and phone
  number, which previously could not be retrieved through the server — the only
  paths were `get_organization` (no address/phone) and `search_flexible_assets`
  (custom assets only). `search_locations` mirrors `search_configurations`
  (org-scoped, with the same "search by org name" elicitation fallback) and
  filters by name, city, region, or country; the write tools accept the full
  address/phone field set. API-key scope is sufficient — no JWT required.

### Fixed

- **`search_passwords` could hand back plaintext secrets.** The handler asks IT
  Glue not to send them (`show_password=false`), but that is a request, not a
  guarantee: it sits one refactor away from being dropped, and a tenant or API
  version that ignores the flag would spill every matched secret into the
  model's context in a single bulk listing — the blast radius of a list call,
  not a lookup. The test that claimed to cover this ("never returns a password
  value even if the API sends one") used a fixture containing no password, so it
  passed against a handler that had no redaction whatsoever. `search_passwords`
  now strips the value on the way out via `stripPasswordValues()`, regardless of
  what came back; `get_password` — the deliberate, one-id-at-a-time read path —
  still returns it, and a test now pins that asymmetry.

- **The account-wide-search warning disappeared exactly when it was needed.**
  The organization filter is applied under `if (orgId)` while the warning added
  in the previous release was gated on `orgId === undefined`. A falsy-but-present
  id fell straight through the gap — `organization_id: 0`, or the `NaN` produced
  by `Number(<non-numeric id>)` after an elicited organization lookup — dropping
  the scope *and* suppressing the warning, which is precisely the silent
  account-wide search the warning exists to prevent. Both now derive from the
  filter that actually went out, through a single `unscopedSearchNoteFor()`
  helper, so the two can no longer drift apart. Regression tests cover the
  falsy-id case for all three search tools.

- **The same warning misattributed its own cause.** It stated the client "could
  not be asked" for an organization even when the user *had* been asked, *had*
  answered, and the org-name lookup had simply matched nothing — pointing the
  reader at a gateway elicitation problem that wasn't there. The handler cannot
  distinguish "could not ask" from "asked, and nothing matched", so the note now
  says what happened without guessing why.

- **A scoped search silently became an account-wide one whenever the client
  couldn't be asked for an organization.** `search_passwords`,
  `search_configurations` and `search_locations` try to narrow themselves by
  eliciting an organization name when `organization_id` is omitted. Every
  helper in `src/utils/elicitation.ts` ends in a bare `catch {}` returning
  `null`, which collapses four distinct outcomes — no server bound, client
  doesn't support elicitation, user declined, user answered — into one. On any
  client without elicitation support, and through the MCP gateway (which does
  not proxy server-initiated requests at all), the prompt is never delivered,
  the handler drops the organization filter, and the query widens to the whole
  account. A caller asking for "the VPN password for Acme" got an arbitrary
  page drawn from every organization and reasonably reported that the entry did
  not exist — indistinguishable, from the outside, from the entry genuinely
  being absent. The query still runs (`organization_id` is legitimately
  optional, and an account-wide search is a real use case), but an unscoped
  result now carries `unscopedSearchNote()`: it states that ALL organizations
  were searched, gives the page/total counts so a 50-of-4,000 slice can't be
  mistaken for the whole picture, says explicitly that an empty result is not
  proof of absence, and points at `search_organizations` +
  `organization_id` to narrow it. Separately, the swallowed failure is now
  logged to stderr with its reason, so a dropped prompt leaves a trace instead
  of being undiagnosable — it was previously invisible at every layer.

- **The password tools had no effective test coverage — the suite was green
  because the "tests" tested their own mock.** The five cases under
  `describe("search_passwords")` / `describe("get_password")` in
  `src/__tests__/index.test.ts` mocked `fetch`, then called `fetch` *directly*
  and asserted on the payload the mock had just been handed. The
  `search_passwords` / `get_password` handlers were never executed, so nothing
  about the real request — the URL, the JSON:API filter keys, the
  `show_password` flag, error propagation — was covered, and a regression in
  either handler could ship with a fully green suite. The tell: the handler
  names appeared only as `describe()` strings, never as a call. Replaced with a
  `Password tools (round-trip)` block that drives the REAL server over an
  `InMemoryTransport` pair (the idiom already used by the locations and
  document-folder suites), covering: organization scoping and the forced
  `show_password=false` on list calls, name/username/category filter
  pass-through, `show_password` defaulting to true on `get_password` and
  honouring an explicit `false`, the missing-`id` guard, and an IT Glue 404
  surfacing as an error rather than an empty result. Eleven real tests replaced
  five hollow ones and, for the first time, gave the handlers real coverage.

- **The same hollowness ran through the rest of the suite: 14 of 25 tools had
  no test that executed them.** The pattern was uniform — mock global `fetch`,
  then call `fetch` *directly* and assert on the payload the mock had just been
  handed, so the handler never ran and the test could not fail. The purest case
  was `describe("Request Headers")`, which built a headers object, passed it to
  `fetch`, and asserted the mock had captured those same values; it never
  touched `ITGlueClient.authHeaders()`. Measured before this change: 25 tools
  defined, 11 with a real `client.callTool` round-trip test, 14 with none, and
  27 hollow tests. All 25 tools now have real round-trip coverage through the
  in-memory transport idiom, and every conversion was mutation-checked —
  deliberately breaking each handler makes its new test fail. New
  `Core tools (round-trip)` covers the organization, configuration,
  flexible-asset and health-check tools; new
  `Document section tools (round-trip)` covers the section CRUD,
  `publish_document` and archive/unarchive. `Unknown Tool Handling` asserted
  `knownTools.length === 9` against a list literal the test itself wrote while
  the server registered 25, and now drives the server instead, checking that
  every advertised tool reaches a real branch rather than the unknown-tool
  default. Tests that were purely circular were deleted outright rather than
  rewritten: a test that cannot fail is worse than no test, because it buys
  false confidence.

- **One hollow test asserted the opposite of the shipped behaviour, and nothing
  caught it.** "should include resource relationship in document section
  payload" expected `create_document_section` to send a
  `relationships.resource` binding. The handler deliberately does not: IT Glue
  stores the section kind in the `resource_type` *attribute*, and a
  relationships binding is rejected with a 400 for a missing `resource_type`
  (verified live 2026-04-23, per the handler's own comment). Because the test
  only ever inspected a payload it had constructed itself, the contradiction
  between the test's claim and the code's behaviour sat there undetected. It is
  replaced by a test that pins the real payload — `resource_type` present, no
  relationships member — for both the `heading` and `text` mappings.

- **`search_documents` no longer inlines document bodies, which made foldered
  organizations hang.** ([#55](https://github.com/wyre-technology/itglue-mcp/issues/55))
  IT Glue's documents LIST endpoint embeds each document's full sectioned body
  under `content` (~90% of the payload). After the folder-inclusive default
  landed, an org-wide `search_documents` returned *every* document — each with
  its full body — so a heavily-foldered org (e.g. 1,100+ documents) produced a
  multi-megabyte response that exceeded the MCP client's limit and appeared to
  hang with no error (subfolders enumerated fine, but viewing the documents
  inside them failed). `search_documents` now strips the body from every result
  (an 84% size reduction on a representative page) and returns metadata only —
  `name`, `documentFolderId`, `resourceUrl`, timestamps, etc. Full bodies remain
  available through `get_document` and `list_document_sections`. Applies to both
  the folder-inclusive default and explicit `document_folder_id` searches.
- **GitHub Packages auth:** `.npmrc` now reads a `read:packages` token from
  `NODE_AUTH_TOKEN`, and the README install instructions document the required
  `export NODE_AUTH_TOKEN=$(gh auth token)` step so consumers can install the
  published `@wyre-technology/itglue-mcp` package (and any `@wyre-technology/*`
  packages) without a 401 from `npm.pkg.github.com`. Note: unlike the other Wyre
  MCP servers, this one has no private runtime SDK dependency, so the one-click
  deploy buttons were never affected by the build-time 401.

## [1.5.3](https://github.com/wyre-technology/itglue-mcp/compare/v1.5.2...v1.5.3) (2026-04-07)


### Bug Fixes

* **ci:** deploy :latest tag, force revision via env var bump ([22fbae2](https://github.com/wyre-technology/itglue-mcp/commit/22fbae2fe71eca8fde7cfd9944c826f6bb550189))

## [1.5.2](https://github.com/wyre-technology/itglue-mcp/compare/v1.5.1...v1.5.2) (2026-03-31)


### Bug Fixes

* **deploy:** replace node_compat with nodejs_compat for Wrangler v4 ([b9d580d](https://github.com/wyre-technology/itglue-mcp/commit/b9d580d2e2d9b0848256c0c0146e988bbb92fe95))

## [1.5.1](https://github.com/wyre-technology/itglue-mcp/compare/v1.5.0...v1.5.1) (2026-03-25)


### Bug Fixes

* **tools:** add document folder ID filter to search_documents ([747c448](https://github.com/wyre-technology/itglue-mcp/commit/747c448a027bf9d17dcb48e031a45c0122f1d035)), closes [wyre-technology/msp-claude-plugins#40](https://github.com/wyre-technology/msp-claude-plugins/issues/40)

# [1.5.0](https://github.com/wyre-technology/itglue-mcp/compare/v1.4.0...v1.5.0) (2026-03-10)


### Features

* **elicitation:** add MCP elicitation support with graceful fallback ([#2](https://github.com/wyre-technology/itglue-mcp/issues/2)) ([a134ce7](https://github.com/wyre-technology/itglue-mcp/commit/a134ce7e6c55bf7a738e14c0464f22190bfe2a24))

# [1.4.0](https://github.com/wyre-technology/itglue-mcp/compare/v1.3.0...v1.4.0) (2026-03-09)


### Features

* **tools:** add Document Sections API tools ([#1](https://github.com/wyre-technology/itglue-mcp/issues/1)) ([61c6bcf](https://github.com/wyre-technology/itglue-mcp/commit/61c6bcf14a114724b32e76185ea197f645428b3f)), closes [wyre-technology/msp-claude-plugins#34](https://github.com/wyre-technology/msp-claude-plugins/issues/34)

# [1.3.0](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.8...v1.3.0) (2026-03-05)


### Features

* **tools:** add list_flexible_asset_types tool ([c0b4831](https://github.com/wyre-technology/itglue-mcp/commit/c0b4831a2e71acf28d8712e6fc49accfecc76516))

## [1.2.8](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.7...v1.2.8) (2026-03-05)


### Bug Fixes

* **documents:** revert to correct /relationships/documents endpoint + 404 error guidance ([f4f973d](https://github.com/wyre-technology/itglue-mcp/commit/f4f973d3a87d65fcc80027c39250438003c763e4))

## [1.2.7](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.6...v1.2.7) (2026-03-05)


### Bug Fixes

* **documents:** use top-level /documents endpoint instead of /relationships path ([09b1671](https://github.com/wyre-technology/itglue-mcp/commit/09b1671297c1d1c7ebcc20b0879a2d99209c9768))

## [1.2.6](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.5...v1.2.6) (2026-03-04)


### Bug Fixes

* grant contents:write to Docker job for release asset upload ([550fdd6](https://github.com/wyre-technology/itglue-mcp/commit/550fdd6eba84a39d5dadc0647ce503a50a30dc2f))

## [1.2.5](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.4...v1.2.5) (2026-03-04)


### Bug Fixes

* strip org scope from MCPB bundle filename ([66f2479](https://github.com/wyre-technology/itglue-mcp/commit/66f2479a93066d2a015e24dc3c77a37dffd41488))

## [1.2.4](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.3...v1.2.4) (2026-03-04)


### Bug Fixes

* install dependencies before build in pack-mcpb.cjs ([5243ffb](https://github.com/wyre-technology/itglue-mcp/commit/5243ffb149d22ac1da64ff0b14e8b26115dc47ea))

## [1.2.3](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.2...v1.2.3) (2026-03-04)


### Bug Fixes

* exclude test files from TypeScript compilation ([c5765ca](https://github.com/wyre-technology/itglue-mcp/commit/c5765cadcbfadcc9be3999f7566eea6b7982e9e9))

## [1.2.2](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.1...v1.2.2) (2026-03-04)


### Bug Fixes

* correct pack-mcpb.cjs content (was corrupted in previous upload) ([889360b](https://github.com/wyre-technology/itglue-mcp/commit/889360b754b00150f4ba0cf33c0b0322d683c19b))

## [1.2.1](https://github.com/wyre-technology/itglue-mcp/compare/v1.2.0...v1.2.1) (2026-03-04)


### Bug Fixes

* remove old pack-mcpb.js (replaced by .cjs) ([20c5a85](https://github.com/wyre-technology/itglue-mcp/commit/20c5a85b9a2d6e3b3787693317cd3edc5710d378))
* rename pack-mcpb.js to .cjs for ESM compatibility ([05aff3e](https://github.com/wyre-technology/itglue-mcp/commit/05aff3ed9b6db7207943d57b4227b34cb40c0002))
* update pack:mcpb script to use .cjs extension ([cd94dff](https://github.com/wyre-technology/itglue-mcp/commit/cd94dff63a9d5f68bf82dbd2190ec7641abfd707))

# [1.2.0](https://github.com/wyre-technology/itglue-mcp/compare/v1.1.2...v1.2.0) (2026-03-04)


### Features

* **documents:** add get_document and create_document tools ([e9fab21](https://github.com/wyre-technology/itglue-mcp/commit/e9fab21500619846da44c7a59fedc92a72b411ed))

## [1.1.2](https://github.com/wyre-technology/itglue-mcp/compare/v1.1.1...v1.1.2) (2026-03-02)


### Bug Fixes

* **ci:** fix broken YAML in Discord notification step ([8764888](https://github.com/wyre-technology/itglue-mcp/commit/876488897cf293284a29d7b45f53b82bc4905b2c))
* **ci:** move Discord notification into release workflow ([679cb92](https://github.com/wyre-technology/itglue-mcp/commit/679cb9275d660bcee6140083678073148dae84ed))

## [1.1.1](https://github.com/wyre-technology/itglue-mcp/compare/v1.1.0...v1.1.1) (2026-02-23)


### Bug Fixes

* quote MCPB bundle filename to prevent shell glob expansion failure ([8047aa8](https://github.com/wyre-technology/itglue-mcp/commit/8047aa8c3e257bfdbe3d7e3cec60ea3cb666fb19))

# [1.1.0](https://github.com/wyre-technology/itglue-mcp/compare/v1.0.0...v1.1.0) (2026-02-18)


### Bug Fixes

* **ci:** deduplicate step IDs and use Node 22 for semantic-release ([ff8b086](https://github.com/wyre-technology/itglue-mcp/commit/ff8b086f7945a0194b4a0f2dc12a32e47ee420ce))
* **ci:** fix release workflow failures ([d0c4bc7](https://github.com/wyre-technology/itglue-mcp/commit/d0c4bc72b1a113b89cb4adb65bbe54ca41743dc5))
* **docker:** drop arm64 platform to fix QEMU build failures ([fd96d07](https://github.com/wyre-technology/itglue-mcp/commit/fd96d07cf79dbe5aa795a1687e06ddb68401375d))
* escape newlines in .releaserc.json message template ([741b678](https://github.com/wyre-technology/itglue-mcp/commit/741b67801d4b2020549d6afcd7580f7d96695fd0))
* use correct org-scoped endpoint for search_documents ([b1be590](https://github.com/wyre-technology/itglue-mcp/commit/b1be59043a31ed2994ff740d59e4f2b993bf67f7))
* use stateless per-request server pattern for HTTP transport ([a28d4e1](https://github.com/wyre-technology/itglue-mcp/commit/a28d4e195d47db1879f5a969d5e23fdba8fb8182))


### Features

* add HTTP transport + gateway auth mode support ([01da61f](https://github.com/wyre-technology/itglue-mcp/commit/01da61f7c55e8159224b15a35fcc3f14b701a254))
* add MCPB manifest for desktop installation ([6309e69](https://github.com/wyre-technology/itglue-mcp/commit/6309e691b3a56f447ff2a5fc3149acc6fec64a8c))
* add MCPB pack script ([d5cd1ba](https://github.com/wyre-technology/itglue-mcp/commit/d5cd1baf58af14752041e6055e0faaf926724044))
* add mcpb packaging support ([f5e7133](https://github.com/wyre-technology/itglue-mcp/commit/f5e7133b24dad56be55d308be4fda8c08cb6ca44))
* add mcpb packaging support ([bb70b62](https://github.com/wyre-technology/itglue-mcp/commit/bb70b623269ec0c5157033b8039d8362147d312a))
* add mcpb packaging support ([af26b49](https://github.com/wyre-technology/itglue-mcp/commit/af26b49335fae13091227ac148e5005828be1482))
* add mcpb packaging support ([80ee82f](https://github.com/wyre-technology/itglue-mcp/commit/80ee82fea4e75f4619c2b266f66ce98c535e23c6))
* add mcpb packaging support ([d9b36c8](https://github.com/wyre-technology/itglue-mcp/commit/d9b36c82102c98a771a359952b25de7178053f2d))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial MCP server implementation
- Tool: `search_organizations` - Search organizations with filtering
- Tool: `get_organization` - Get organization by ID
- Tool: `search_configurations` - Search configurations/devices
- Tool: `get_configuration` - Get configuration by ID
- Tool: `search_passwords` - Search password entries (metadata only)
- Tool: `get_password` - Get password with actual value
- Tool: `search_documents` - Search documents
- Tool: `search_flexible_assets` - Search flexible assets by type
- Tool: `itglue_health_check` - API connectivity check
- Docker support with multi-stage build
- GitHub Actions CI/CD pipeline
- Semantic release automation
