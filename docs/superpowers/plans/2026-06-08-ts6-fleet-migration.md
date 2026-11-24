# TypeScript 6 Fleet-Migration Capability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and validate a reusable capability to migrate the WYRE MCP fleet to TypeScript 6 — two green canaries, an idempotent codemod, a `ts6-fleet-migration` skill, a Taskmaster tracker, and TS6-ready scaffolding skills — without fanning out to all repos yet.

**Architecture:** The fix is `compilerOptions.types: ["node"]` + `typescript@^6` per repo (spike-confirmed). A dependency-free Node codemod applies it dialect-agnostically. Two canaries (`itglue-mcp` = NodeNext+lib dialect with `worker.ts`; `huntress-mcp` = bundler dialect) prove it. The capability is then frozen into a skill + tracker, and the scaffolding skills are updated so new repos are born TS6-ready.

**Tech Stack:** Node 20+, TypeScript 6, npm, gh CLI, Taskmaster MCP, skill-creator skill.

**Spec:** `docs/superpowers/specs/2026-06-08-ts6-fleet-migration-design.md`

---

## File Structure

- Create: `~/.claude/skills/ts6-fleet-migration/codemod.mjs` — the idempotent codemod (durable home: the skill).
- Create: `~/.claude/skills/ts6-fleet-migration/SKILL.md` — runbook: codemod usage, subagent dispatch pattern, verify checklist, dialect notes, in-scope/out-of-scope list.
- Modify (canary 1, branch `chore/ts6-migration`): `itglue-mcp/tsconfig.json`, `itglue-mcp/package.json`, `itglue-mcp/.github/dependabot.yml`.
- Modify (canary 2, its own branch/worktree): `huntress-mcp/tsconfig.json`, `huntress-mcp/package.json`.
- Modify (scaffolding): `~/.claude/skills/mcp-vendor-scaffolding/SKILL.md`, `~/.claude/skills/mcp-server-fleet-ci-template/SKILL.md`.
- Taskmaster: tracker tasks under this project root.

---

## Task 1: Write the codemod

**Files:**
- Create: `~/.claude/skills/ts6-fleet-migration/codemod.mjs`

- [ ] **Step 1: Create the skill directory**

Run:
```bash
mkdir -p ~/.claude/skills/ts6-fleet-migration
```

- [ ] **Step 2: Write the codemod script**

Create `~/.claude/skills/ts6-fleet-migration/codemod.mjs`:
```js
#!/usr/bin/env node
// ts6-codemod — make a WYRE MCP repo TypeScript 6-ready.
// Idempotent + dialect-aware. Run from a repo root: node codemod.mjs [--dry-run]
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const dry = process.argv.includes("--dry-run");
const TS_VERSION = "^6.0.3";

function patchTsconfig(path) {
  if (!existsSync(path)) return { path, changed: false, reason: "missing" };
  let json;
  try { json = JSON.parse(readFileSync(path, "utf8")); }
  catch { return { path, changed: false, reason: "UNPARSEABLE (JSONC/comments?) — hand-edit" }; }
  json.compilerOptions = json.compilerOptions || {};
  const t = json.compilerOptions.types;
  if (Array.isArray(t) && t.includes("node")) return { path, changed: false, reason: "already has node" };
  json.compilerOptions.types = Array.isArray(t) ? [...new Set([...t, "node"])] : ["node"];
  if (!dry) writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return { path, changed: true };
}

function patchPackageJson(path) {
  const json = JSON.parse(readFileSync(path, "utf8"));
  const dd = json.devDependencies || {};
  const dep = json.dependencies || {};
  let changed = false;
  if ("typescript" in dd && dd.typescript !== TS_VERSION) { dd.typescript = TS_VERSION; changed = true; }
  else if ("typescript" in dep && dep.typescript !== TS_VERSION) { dep.typescript = TS_VERSION; changed = true; }
  else if (!("typescript" in dd) && !("typescript" in dep)) return { path, changed: false, reason: "no typescript dep" };
  if (changed && !dry) writeFileSync(path, JSON.stringify(json, null, 2) + "\n");
  return { path, changed, reason: changed ? `typescript -> ${TS_VERSION}` : "already at target" };
}

console.log(dry ? "[dry-run]" : "[apply]");
console.log("tsconfig:", patchTsconfig("tsconfig.json"));
console.log("package:", patchPackageJson("package.json"));
console.log("Next: npm install && npm run build && npm test && npm run lint && npm run typecheck");
```

- [ ] **Step 3: Self-test the codemod against a fixture (dry-run, both dialects)**

Run:
```bash
cd /tmp && rm -rf ts6fix && mkdir -p ts6fix/A ts6fix/B
# Dialect A (has lib, no types)
printf '{\n  "compilerOptions": { "target": "ES2022", "lib": ["ES2022"] }\n}\n' > ts6fix/A/tsconfig.json
printf '{\n  "devDependencies": { "typescript": "^5.9.3" }\n}\n' > ts6fix/A/package.json
# Dialect B (bundler, no lib, no types)
printf '{\n  "compilerOptions": { "module": "ESNext", "moduleResolution": "bundler" }\n}\n' > ts6fix/B/tsconfig.json
printf '{\n  "devDependencies": { "typescript": "^5.5.0" }\n}\n' > ts6fix/B/package.json
(cd ts6fix/A && node ~/.claude/skills/ts6-fleet-migration/codemod.mjs && cat tsconfig.json package.json)
(cd ts6fix/B && node ~/.claude/skills/ts6-fleet-migration/codemod.mjs && cat tsconfig.json package.json)
```
Expected: both `tsconfig.json` files now contain `"types": ["node"]` (A keeps its `lib`; B gains `types` with no `lib`), both `package.json` show `typescript: "^6.0.3"`. Re-running prints `already has node` / `already at target` (idempotent).

- [ ] **Step 4: Commit the codemod** (only if `~/.claude/skills` is a git repo; otherwise skip with a note)

Run:
```bash
cd ~/.claude/skills && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  && git add ts6-fleet-migration/codemod.mjs && git commit -m "feat(ts6): add fleet TS6 codemod" \
  || echo "skills dir not a git repo — codemod saved, no commit"
```

---

## Task 2: Canary 1 — itglue-mcp (Dialect A, has worker.ts)

**Files:**
- Modify: `tsconfig.json`, `package.json`, `.github/dependabot.yml`
- Branch: `chore/ts6-migration` (already checked out in this worktree)

- [ ] **Step 1: Confirm the bug reproduces (baseline failure)**

Run from the itglue-mcp worktree:
```bash
npm install typescript@^6.0.3 >/dev/null 2>&1 && npm run build 2>&1 | tail -3
```
Expected: build FAILS with `Cannot find name 'process'/'fetch'/...`. (This is the regression the fix addresses.)

- [ ] **Step 2: Apply the codemod**

Run:
```bash
node ~/.claude/skills/ts6-fleet-migration/codemod.mjs
git --no-pager diff tsconfig.json package.json
```
Expected: `tsconfig.json` gains `"types": ["node"]`; `package.json` `typescript` is `^6.0.3`.

- [ ] **Step 3: Install + verify build now passes**

Run:
```bash
npm install >/dev/null 2>&1 && npm run build 2>&1 | tail -3; echo "exit: ${PIPESTATUS[0]}"
```
Expected: build succeeds, exit 0.

- [ ] **Step 4: Full verify (test + lint + typecheck)**

Run:
```bash
npm test 2>&1 | grep -E "Tests "; npm run lint >/dev/null 2>&1 && echo "lint OK" || echo "lint FAIL"; npm run typecheck >/dev/null 2>&1 && echo "typecheck OK" || echo "typecheck FAIL"
```
Expected: `Tests 146 passed`, `lint OK`, `typecheck OK`. If any *additional* TS6 type errors appear, fix them minimally here and re-run.

- [ ] **Step 5: Remove the Dependabot TS-major ignore (itglue carries it)**

Edit `.github/dependabot.yml` — delete the `ignore:` block added for `typescript` semver-major (the repo is now on TS6, so future TS updates should flow). Verify:
```bash
grep -q "version-update:semver-major" .github/dependabot.yml && echo "STILL PRESENT — remove it" || echo "ignore removed OK"
```

- [ ] **Step 6: Commit + push + PR**

Run:
```bash
git add tsconfig.json package.json package-lock.json .github/dependabot.yml
git commit -m "build(deps-dev): adopt TypeScript 6

Add compilerOptions.types: [node] so Node/web globals resolve under TS6
(TS 6.0 stopped auto-including @types/node). Bump typescript ^6.0.3 and
drop the Dependabot typescript-major ignore. Verified: build, 146 tests,
lint, typecheck. First canary of the fleet TS6 migration."
git push -u origin chore/ts6-migration
gh pr create --repo WYRE-AI/itglue-mcp --base main --head chore/ts6-migration \
  --title "build(deps-dev): adopt TypeScript 6 (canary 1)" \
  --body "First TS6 fleet-migration canary. Adds tsconfig types:[node] (restores Node/web globals dropped by TS6), bumps typescript ^6.0.3, removes the TS-major Dependabot ignore. Carries the migration spec + plan. Verified build/test/lint/typecheck locally."
```
Expected: PR created. Wait for CI green (build, tests Node 20/22, `assert`) before merge.

---

## Task 3: Canary 2 — huntress-mcp (Dialect B, bundler)

**Files:**
- Modify (in a fresh clone): `huntress-mcp/tsconfig.json`, `huntress-mcp/package.json`

- [ ] **Step 1: Clone huntress-mcp to a scratch dir**

Run:
```bash
cd /tmp && rm -rf huntress-mcp && gh repo clone WYRE-AI/huntress-mcp && cd huntress-mcp
git checkout -b chore/ts6-migration
npm ci >/dev/null 2>&1 && echo "installed"
```

- [ ] **Step 2: Confirm baseline build passes on TS5, then reproduce TS6 failure**

Run:
```bash
npm run build >/dev/null 2>&1 && echo "TS5 build OK"
npm install typescript@^6.0.3 >/dev/null 2>&1 && npm run build 2>&1 | tail -3
```
Expected: TS5 build OK; TS6 build FAILS with missing-globals errors (confirms the bundler dialect breaks the same way).

- [ ] **Step 3: Apply the codemod + verify**

Run:
```bash
node ~/.claude/skills/ts6-fleet-migration/codemod.mjs
git --no-pager diff tsconfig.json package.json
npm install >/dev/null 2>&1 && npm run build 2>&1 | tail -3; echo "build exit: ${PIPESTATUS[0]}"
npm test 2>&1 | tail -3
npm run lint >/dev/null 2>&1 && echo "lint OK" || echo "lint FAIL (check if repo has lint script)"
```
Expected: `tsconfig.json` gains `"types": ["node"]` (no `lib` added); build exit 0; tests pass. Fix any additional TS6 errors minimally. If a script (lint/typecheck) doesn't exist in this repo, note it and skip.

- [ ] **Step 4: Commit + push + PR**

Run:
```bash
git add tsconfig.json package.json package-lock.json
git commit -m "build(deps-dev): adopt TypeScript 6

Add compilerOptions.types: [node] for TS6 global resolution; bump
typescript ^6.0.3. Second canary (bundler tsconfig dialect) of the
fleet TS6 migration. Verified build + tests."
git push -u origin chore/ts6-migration
gh pr create --repo WYRE-AI/huntress-mcp --base main --head chore/ts6-migration \
  --title "build(deps-dev): adopt TypeScript 6 (canary 2, bundler dialect)" \
  --body "Second TS6 fleet-migration canary, proving the fix on the bundler tsconfig dialect. Adds types:[node], bumps typescript ^6.0.3. Verified build + tests locally."
```
Expected: PR created; wait for CI green before merge.

---

## Task 4: Author the `ts6-fleet-migration` skill

**Files:**
- Create: `~/.claude/skills/ts6-fleet-migration/SKILL.md`

- [ ] **Step 1: Invoke skill-creator**

Use the `skill-creator` skill to scaffold `ts6-fleet-migration`. Target directory `~/.claude/skills/ts6-fleet-migration/` (codemod.mjs already lives there).

- [ ] **Step 2: Write SKILL.md content**

The SKILL.md must contain, concretely (no placeholders):
- **Trigger description:** "migrate a WYRE MCP repo (or the fleet) to TypeScript 6", "TS6 fleet migration", "fan out the TS6 codemod".
- **The fix** (1 paragraph): TS6 dropped auto-`@types/node`; add `compilerOptions.types: ["node"]`; no DOM lib needed.
- **Codemod usage:** `node ~/.claude/skills/ts6-fleet-migration/codemod.mjs [--dry-run]` from a repo root; idempotent; UNPARSEABLE result = hand-edit (JSONC).
- **Per-repo verify checklist:** install → build → test → lint → typecheck; hand-fix extra TS6 errors; remove any Dependabot TS-major ignore.
- **Subagent dispatch pattern:** one repo per subagent — clone/worktree, codemod, install, verify, on green open `build(deps-dev): adopt TypeScript 6` PR + tick tracker; on failure capture error class + mark blocked.
- **In-scope list** (the ~45 TS repos) and **out-of-scope** (the 6 JS repos: datto-bcdr, datto-saas-protection, kaseya-bms, kaseya-vsa, spanning, unitrends).
- **Dialect notes:** A (NodeNext+lib) vs B (bundler, no lib/types); both fixed identically by the codemod.
- **Future fan-out:** dry-run triage across all repos first to classify green vs needs-handwork.

- [ ] **Step 3: Verify the skill is discoverable**

Run:
```bash
test -f ~/.claude/skills/ts6-fleet-migration/SKILL.md && head -5 ~/.claude/skills/ts6-fleet-migration/SKILL.md
```
Expected: SKILL.md exists with frontmatter (name + description).

---

## Task 5: Seed the Taskmaster tracker

- [ ] **Step 1: Create one tracker task per in-scope repo**

Using Taskmaster, create a parent task "TS6 fleet migration" and a subtask per in-scope repo (status pending), marking `itglue-mcp` and `huntress-mcp` done once their PRs merge. In-scope repos:

```
abnormal, action1, afkbot, alternative-payments, atera, autotask, auvik,
avanan, avanan-legacy, blackpoint, blumira, brain, cipp, connectwise-automate,
connectwise-manage, crewhu, datto-rmm, domotz, halopsa, hudu, huntress(done),
immybot, iqms, ironscales, itglue(done), kaseya-quote-manager, knowbe4, liongard,
mcp-gateway, mcpgw-cli, mimecast, ninjaone, pax8, proofpoint, qbo, rocketcyber,
rootly, salesbuildr, salesforce, sentinelone, sherweb, spamtitan, superops,
syncro, threatlocker, timezest, xero
```
(JS repos excluded: datto-bcdr, datto-saas-protection, kaseya-bms, kaseya-vsa, spanning, unitrends.)

- [ ] **Step 2: Confirm the tracker lists all repos**

Run Taskmaster `get_tasks` and verify the count of in-scope subtasks matches the list above.

---

## Task 6: Update scaffolding skills (born TS6-ready)

**Files:**
- Modify: `~/.claude/skills/mcp-vendor-scaffolding/SKILL.md`
- Modify: `~/.claude/skills/mcp-server-fleet-ci-template/SKILL.md`

- [ ] **Step 1: Bump the TS pin in the scaffolding skill**

In `~/.claude/skills/mcp-vendor-scaffolding/SKILL.md`, change the pinned `"typescript": "^5.3.0"` to `"typescript": "^6.0.3"`.

- [ ] **Step 2: Ensure the canonical tsconfig includes types:[node]**

In the same skill, locate the tsconfig template/guidance and ensure `compilerOptions` includes `"types": ["node"]`. If the skill only references `tsconfig.json` structurally without a literal body, add an explicit note: "tsconfig must include `compilerOptions.types: ["node"]` for TS6."

- [ ] **Step 3: Mirror into the fleet-ci-template skill**

In `~/.claude/skills/mcp-server-fleet-ci-template/SKILL.md`, add/adjust any TS version reference to `^6.0.3` and note the `types: ["node"]` requirement.

- [ ] **Step 4: Verify**

Run:
```bash
grep -n "typescript" ~/.claude/skills/mcp-vendor-scaffolding/SKILL.md | grep -i "6\."
grep -n "types.*node" ~/.claude/skills/mcp-vendor-scaffolding/SKILL.md || echo "ADD the types:[node] note"
```
Expected: TS pin shows 6.x; a `types: ["node"]` reference is present.

- [ ] **Step 5: Commit (if skills dir is a git repo)**

Run:
```bash
cd ~/.claude/skills && git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  && git add mcp-vendor-scaffolding/SKILL.md mcp-server-fleet-ci-template/SKILL.md ts6-fleet-migration/ \
  && git commit -m "feat(scaffolding): TS6-ready template + ts6-fleet-migration skill" \
  || echo "skills dir not a git repo — changes saved, no commit"
```

---

## Done criteria

- Both canary PRs merged and green (build, tests, `assert`).
- `~/.claude/skills/ts6-fleet-migration/` holds a self-tested codemod + SKILL.md runbook.
- Taskmaster tracker lists all in-scope repos with itglue + huntress marked done.
- Scaffolding skills pin TS6 and require `types: ["node"]`.
- No fleet-wide fan-out performed (deferred per spec).
