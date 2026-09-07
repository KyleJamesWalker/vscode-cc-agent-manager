# Session Search — Design Spec

**Date:** 2026-09-07
**Status:** Approved
**Superpower:** Search (cross-session search, file reverse lookup, saved searches, notes & tags, timeline)

## Overview

Today the panel's search box filters projects by name and path only (`media/main.js:604-610`). There is no way to answer "find the session where I was working on X". This spec adds a Search superpower built on one shared scanner:

1. **Cross-session content search** — full-text over every message in every session, with scope and metadata filters, streaming results that link to the exact message.
2. **File reverse lookup** — "which sessions touched this file", exposed as an editor/explorer context-menu command.
3. **Saved searches** — pin a query as a sidebar chip.
4. **Session notes & tags** — user-authored labels on sessions, stored outside `~/.claude`, searchable as a first-class field.
5. **Timeline** — a day-by-day activity view answering "what was I doing last Tuesday".

All five read the same scan pass. Building search without the reverse lookup would mean rewriting the scanner later, so the scanner is specified once, in Phase 1, with both consumers in mind.

The extension stays **read-only with respect to `~/.claude`**. Notes, tags, and saved searches live in extension `globalState`.

## Measured Baseline

Measured on the author's machine against real data, 2026-09-07:

| Measure | Value |
|---|---|
| `.jsonl` files (recursive) | 576 |
| Total size | 479 MB |
| Total lines | 149,497 |
| Median / p90 / max file size | 339 KB / 1.2 MB / 52.6 MB |
| Longest single line | 1,359,665 bytes (base64 image in a `tool_result`) |
| Full scan, `/re/i.test()` per raw line | **774 ms** |
| Full scan, `JSON.parse` every line | 1,306 ms |

**Decision: no index, no cache, no new dependency.** A brute-force async scan is fast enough that the first results appear in tens of milliseconds when files are walked newest-first. This keeps the repo's zero-runtime-dependency constraint intact and removes all index-invalidation complexity. Revisit only if these numbers regress by an order of magnitude.

## Decisions Made

- **Match strategy**: build one `RegExp` per query and test it against the **raw JSONL line**, then `JSON.parse` only matching lines. Do not lowercase lines (2.3× slower) and do not prefilter on a line-header substring — field order is not stable and `"type"` typically sits ~120 bytes into a line, so a header prefilter silently returns zero hits.
- **Search reads disk directly**, not the panel's `_projects` cache. `claudeReader.ts:7` sets `MAX_SESSION_AGE_DAYS = 30` and `:266` drops older sessions; search must not inherit that cutoff.
- **The walk is recursive.** `parseSession` (`claudeReader.ts:269-284`) does a flat `readdirSync` of `subagents/`, which misses the 91 nested `subagents/workflows/wf_*/agent-*.jsonl` files — about 22% of subagent files. Subagent messages are never duplicated into the parent file, so a flat walk loses roughly 40% of all messages (36,633 of 92,340 user+assistant lines).
- **Results are messages, not files.** A hit identifies `(filePath, lineNumber, sessionId, agentId|null, uuid)`.
- **Streaming and cancellable.** Results arrive in batches as the scan proceeds; a new query cancels the in-flight one.
- **Async, chunked, off the critical path.** Existing readers are synchronous on the extension host main thread (`readFileSync` + `split('\n')`, including on the 30s refresh). The scanner must use async I/O with bounded concurrency and yield between files so typing stays responsive.
- **Search state is a new tab**, not a replacement for the sidebar project filter. The existing `/` shortcut and `#search` box keep their current meaning.
- **Default scope is prompts + assistant text.** Thinking and tool I/O are opt-in.
- **Queries are literal by default**, with an explicit regex toggle. User input is escaped before compiling the `RegExp` unless the toggle is on.
- **Timeline is its own tab.**

## Resolved Questions

Confirmed during review, 2026-09-07:

1. **Default search scope** — user prompts + assistant text. Thinking and tool I/O are opt-in toggles. Tool output is the bulk of the 479 MB and is mostly file dumps and command output, so including it by default would drown the signal.
2. **Timeline placement** — its own tab, not a mode inside Search.
3. **Notes/tags storage** — `globalState`. A syncable JSON file may be added later behind a setting; it is not in this scope.
4. **Phasing** — all five phases ship together in one PR. The phase table is a build order, not a release boundary.
5. **Regex input** — literal by default, with an explicit regex toggle in the query box. An unescaped user string is both a ReDoS risk and a source of confusing results, so regex is never inferred from the query text.

## Architecture

### New module: `src/sessionScanner.ts`

The single disk-walking primitive. Both search and reverse lookup consume it.

```typescript
export interface ScanTarget {
  filePath: string;
  projectKey: string;
  projectPath: string;
  sessionId: string;
  agentId?: string;      // set for subagent files
  mtimeMs: number;
}

/** Recursive walk of ~/.claude/projects, newest-first by mtime. No age cutoff. */
export async function listScanTargets(): Promise<ScanTarget[]>;

/**
 * Streams each line of each target to `onLine`, newest file first.
 * Bounded concurrency; yields to the event loop between files.
 * Aborts promptly when `signal` fires.
 */
export async function scanLines(
  targets: ScanTarget[],
  onLine: (line: string, lineNumber: number, target: ScanTarget) => void,
  signal: AbortSignal,
): Promise<void>;
```

Target classification from the on-disk layout:

```
<projectDir>/<sessionId>.jsonl                                    → session
<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl          → subagent
<projectDir>/<sessionId>/subagents/workflows/wf_*/agent-*.jsonl   → subagent (nested)
<projectDir>/<sessionId>/subagents/workflows/wf_*/journal.jsonl   → skip
<projectDir>/<sessionId>/tool-results/*.txt                       → not .jsonl, skipped
<projectDir>/memory/                                              → skip
```

`agentId` is derived as today (`basename(f, '.jsonl').replace(/^agent-/, '')`), which tolerates slugged names like `agent-aboard-fixer-39a692d3f2ffdb3a`. Subagent files reuse the parent's `sessionId`, so **index on `(sessionId, agentId|null)`** — `sessionId` alone does not identify a file.

Reader hardening required by the data:
- Lines up to ~1.4 MB must survive. Any buffer cap below 2 MB truncates and produces a `JSON.parse` failure that today's `catch {}` swallows silently.
- Skip base64 payloads before parsing: if a line exceeds a size threshold and contains `"type":"base64"`, match against it but do not retain its content in a snippet.
- The 52.6 MB max file must not be materialised twice (current `parseJsonlFile` does `readFileSync` then `split('\n')`, holding the file plus an array of every line).

### New module: `src/sessionSearch.ts`

```typescript
export type SearchScope = 'prompts' | 'assistant' | 'thinking' | 'toolInput' | 'toolOutput';

export interface SearchQuery {
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
  scopes: SearchScope[];        // default: ['prompts', 'assistant']
  projectKeys?: string[];
  branches?: string[];
  tools?: string[];             // session used this tool at all
  after?: string;               // ISO date
  before?: string;
  tags?: string[];              // from Phase 4
}

export interface SearchHit {
  projectKey: string;
  projectPath: string;
  sessionId: string;
  agentId?: string;
  uuid: string;
  role: 'user' | 'assistant';
  scope: SearchScope;
  timestamp?: string;
  gitBranch?: string;
  snippet: string;              // plain text, ±120 chars around the match
  matchStart: number;           // offset within snippet
  matchLength: number;
}
```

Extraction per scope, from the facts established about the format:

| Scope | Source |
|---|---|
| `prompts` | `user` lines: `message.content` when it is a string, plus `text` blocks when it is an array |
| `assistant` | `assistant` lines: **all** `text` blocks |
| `thinking` | `assistant` lines: `thinking` blocks |
| `toolInput` | `assistant` lines: `tool_use.input`, serialised |
| `toolOutput` | `user` lines: `tool_result` blocks, and `toolUseResult` |

Note this deliberately does **not** reuse `extractText` (`claudeReader.ts:34-43`), which returns only the *first* `text` block of an array and would silently lose content, nor `extractBlocks` (`:577-594`), which drops all 16,568 `thinking` blocks. Those remain correct for their current purpose (`firstPrompt`, conversation rendering) and are left unchanged.

Lines to ignore entirely: `attachment` (24,962 lines, mostly `total_tokens_reminder` noise), `system`, `mode`, `permission-mode`, `queue-operation`, `cost-state`, and the other sidecar types. Lines with `isMeta: true` are excluded, matching `readConversation`.

Session titles for result display come from the sidecar lines the current reader ignores: `custom-title` (`customTitle`) wins over `ai-title` (`aiTitle`), falling back to `firstPrompt`. These lines carry no `timestamp` or `uuid`.

### New module: `src/fileUsageIndex.ts`

Reverse lookup: absolute file path → sessions that read or modified it. Same scan pass, different extractor. Confidence tiers, strongest first:

| Tier | Source | Reliability |
|---|---|---|
| **Modified (authoritative)** | `file-history-delta.trackingPath`; `file-history-snapshot.snapshot.trackedFileBackups` keys | Explicit record of every file Claude modified |
| **Read/written (exact)** | `toolUseResult.filePath` on the user line following `Read`/`Edit`/`Write` | Post-resolution, structured |
| **Read/written (exact)** | `tool_use.input.file_path` for `Read`/`Edit`/`Write`; `input.path` for `EnterWorktree` | 3,303 of 3,304 values are absolute; 0 relative, 0 tilde |
| **Mentioned (heuristic)** | Path-like tokens in `Bash.command` | Weak — only 37% of `Bash` commands contain a literal `/Users/`; the rest rely on `cwd` after `cd` |

All `file_path` values observed are absolute, so **no `cwd` resolution is needed** for the exact tiers. The UI must show which tier a result came from and must let the heuristic tier be turned off.

Tools absent from real data and therefore not special-cased: `Grep`, `Glob`, `MultiEdit`, `NotebookEdit`, `TodoWrite`, `Task`. `mcp__*` inputs are non-uniform and ignored.

## Type Changes

`src/types.ts` gains the interfaces above, plus one change to an existing type:

```typescript
export interface ConversationMessage {
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  timestamp?: string;
  uuid?: string;        // NEW — lets the webview scroll to and highlight a specific message
}
```

`readConversation` must populate `uuid` from the raw line. This is what makes "click a result, land on that message" work rather than merely opening the session.

## Message Protocol

The protocol is untyped string matching: one `case` in the switch at `agentManagerPanel.ts:103-221`, one `if` in the listener at `main.js:141-224`.

### Webview → Extension

| `command` | Payload |
|---|---|
| `search` | `{ query: SearchQuery, requestId: number }` |
| `cancelSearch` | `{ requestId: number }` |
| `findFileUsage` | `{ path: string, includeHeuristic: boolean }` |
| `saveSearch` | `{ name: string, query: SearchQuery }` |
| `deleteSavedSearch` | `{ id: string }` |
| `setSessionMeta` | `{ sessionId: string, agentId?: string, note?: string, tags?: string[] }` |
| `getTimeline` | `{ after: string, before: string }` |

### Extension → Webview

| `command` | Payload |
|---|---|
| `searchProgress` | `{ requestId, hits: SearchHit[], filesScanned, filesTotal }` — sent in batches |
| `searchDone` | `{ requestId, totalHits, durationMs, truncated: boolean }` |
| `fileUsage` | `{ path, sessions: FileUsageEntry[] }` |
| `savedSearches` | `{ items: SavedSearch[] }` |
| `sessionMeta` | `{ items: Record<string, SessionMeta> }` |
| `timeline` | `{ days: TimelineDay[] }` |

`loadConversation` gains an optional `scrollToUuid`, and `conversation` echoes it back so the webview can scroll and flash the target message.

Stale-response guard: the webview drops any `searchProgress` whose `requestId` is not the current one.

## UI

### Search tab

A fifth tab, `data-tab="search"`, bound to `5`. Like Stats and Health, it renders into `#conversation-container`.

```
┌─ Search ─────────────────────────────────────────────────────┐
│ [ retry logic in the uploader                     ] [Aa] [.*]│
│ Scope:  [✓ Prompts] [✓ Assistant] [ Thinking] [ Tools]       │
│ Filter: [Project ▾] [Branch ▾] [Any time ▾] [Tag ▾]  [Save]  │
├──────────────────────────────────────────────────────────────┤
│ 41 results · scanned 380/576 files · 210 ms          [Stop]   │
├──────────────────────────────────────────────────────────────┤
│ vscode-cc-agent-manager · main · 2d ago              #a3f21e │
│   "…add **retry logic** to the uploader so a 502 doesn't…"    │
│                                       [Open] [Resume] [Export]│
│                                                              │
│ content-contact-sheets · INC-4471 · 3w ago    ⤷ Explore agent │
│   "…the **retry logic in the uploader** was swallowing…"      │
└──────────────────────────────────────────────────────────────┘
```

- Results stream in as they are found; the header counter updates live.
- Each hit shows project · branch · relative time, and a subagent badge when `agentId` is set.
- `[Open]` posts `loadConversation` with `scrollToUuid`, switches to the Sessions tab, and flashes the message.
- `[Resume]` reuses `openInClaudeCode` (`agentManagerPanel.ts:191-195`); `[Export]` reuses `exportChat`.
- Keyboard: `j`/`k` move between results, `Enter` opens. The global handler already skips shortcuts while an `INPUT` has focus (`main.js:1449-1455`), so the query box behaves.

### Reverse lookup

New command `claudeAgentManager.findSessionsForFile`, contributed to `explorer/context` and `editor/title/context`. It opens the panel on the Search tab in file-usage mode, seeded with the file's absolute path. Results group by session and show the tier badge (`modified` / `read` / `mentioned`).

### Saved searches

Saved queries render as additional chips in `#filter-bar` alongside `active`/`waiting`/`pinned`. Clicking one opens the Search tab with the query applied.

### Notes & tags

A note field and a tag input appear in the conversation header for the selected session. Tags render as chips on sidebar rows and are matchable via the `tags` filter — a hand-written label beats full-text guessing for finding work later.

### Timeline

A sixth tab, `data-tab="timeline"`, bound to `6`, rendering into `#conversation-container` like the others. A day-per-row view over the scan's session metadata: date, projects touched, session count, and the titles of each session, with the same click-through as search results.

## Constraints to Respect

- **CSP** (`agentManagerPanel.ts:516`) is `default-src 'none'; style-src ${cspSource}; script-src 'nonce-...'`. No inline `<script>`, no inline event handlers, no `fetch`, no remote images, no new `<style>` element, no `eval`. Use `addEventListener` with delegated `data-action` handlers, as the existing sidebar does (`main.js:778-869`), and inline SVG for icons.
- **Snippet highlighting is the XSS foot-gun.** Escape the snippet with `esc()` (`main.js:653`) **first**, then wrap the match in `<mark>` using offsets computed against the escaped string. Never interpolate raw JSONL text.
- **The 30s auto-refresh replaces the whole sidebar DOM** (`agentManagerPanel.ts:224-226` → `main.js:152`). Search results live in the main panel and must be re-rendered from a JS-held result array, never assumed to survive an `update`.
- **Do not model the scanner on `readClaudeProjects`.** It is fully synchronous and re-reads every file on every refresh; a synchronous search would block the extension host and interleave badly with the 500 ms watcher debounce.
- **Search state must be added to `vscode.setState`**, which currently persists only `{ activeFilter, filterText, sidebarWidth }` (`main.js:495-498`).
- Settings live in `globalState`, not `contributes.configuration`. Follow the existing migration pattern (`agentManagerPanel.ts:289-297`) if `ManagerSettings` gains search defaults.
- **The help overlay is a hardcoded string** (`main.js:1597-1620`) and is already out of date — it lists `3 = About` when `3` is Health. Adding tabs `5` and `6` means correcting it, not just appending to it.

## Testing

Per `CLAUDE.md`, every change starts with a failing test.

**Unit (Jest, `src/test/unit/<module>.test.ts`)** — follow `claudeReader.test.ts`, which mocks `os.homedir` and `fs` against a `/home/test/.claude/projects` fixture tree.

- `sessionScanner.test.ts` — recursive walk finds nested `subagents/workflows/wf_*/agent-*.jsonl`; `journal.jsonl` and `tool-results/` are skipped; newest-first ordering; `agentId` parsed from slugged filenames; `AbortSignal` stops the scan.
- `sessionSearch.test.ts` — each scope extracts from the right blocks; **all** assistant `text` blocks are searched, not just the first; `thinking` is found only when its scope is on; `attachment`/`system`/`isMeta` lines are ignored; a 1.4 MB line parses without truncation; a base64 `tool_result` does not leak into a snippet; sessions older than 30 days are still returned.
- `fileUsageIndex.test.ts` — each tier extracts correctly; `file-history-snapshot` map keys are picked up; the `Bash` heuristic is excluded when disabled.
- `webviewSearch.test.ts` — follow `webviewKeyboard.test.ts`: jsdom env, `eval` of `media/main.js`, dispatch `MessageEvent`s. Cover streaming batches rendering incrementally, stale `requestId` batches being dropped, and **a snippet containing `<script>` rendering escaped**.

**Regression risk to cover explicitly:** both webview test files hand-mirror the panel HTML in a `WEBVIEW_BODY` constant and are already stale (they still contain `export-dest` radios and an `All` filter chip). Adding DOM elements without updating those constants makes `main.js` null-deref during `eval`. Update all copies.

## Implementation Phases

| Phase | Scope | Files |
|---|---|---|
| **1** | Scanner + search engine + Search tab | `sessionScanner.ts`, `sessionSearch.ts`, `types.ts`, `agentManagerPanel.ts`, `main.js`, `style.css` |
| **2** | File reverse lookup + context-menu command | `fileUsageIndex.ts`, `package.json`, `extension.ts`, `main.js` |
| **3** | Saved searches | `agentManagerPanel.ts`, `main.js` |
| **4** | Notes & tags | `types.ts`, `agentManagerPanel.ts`, `main.js` |
| **5** | Timeline | `main.js`, `sessionScanner.ts` |

All five phases ship in one PR. The table is a build order — each phase is independently testable and should be a separate commit — not a release boundary.

## Acceptance Criteria

### Phase 1 — Cross-session search
- [ ] A Search tab exists, reachable by click and by `5`
- [ ] Typing a query returns hits from every session on disk, including sessions older than 30 days
- [ ] Hits from subagent files are found, including nested `workflows/wf_*/agent-*.jsonl`
- [ ] Results stream in during the scan; the counter shows files scanned and elapsed time
- [ ] A new query cancels the in-flight scan; stale batches never render
- [ ] The UI stays responsive during a full-corpus scan
- [ ] Scope toggles for prompts / assistant / thinking / tool I/O work independently; default is prompts + assistant
- [ ] Project, branch, and date filters narrow results
- [ ] Case-sensitivity and regex toggles work; an invalid regex shows an inline error rather than throwing
- [ ] Matches are highlighted, and a snippet containing HTML renders escaped
- [ ] Clicking a result opens that conversation scrolled to the matching message
- [ ] Resume and Export work from a result
- [ ] A full-corpus search over ~479 MB completes in under 3 s

### Phase 2 — File reverse lookup
- [ ] Right-clicking a file in the explorer or editor offers "Show Claude sessions that touched this"
- [ ] Results are grouped by session and tiered as modified / read / mentioned
- [ ] `file-history-delta` and `file-history-snapshot` records are treated as authoritative for modifications
- [ ] The `Bash` heuristic tier can be toggled off
- [ ] A file with no history reports that clearly rather than showing an empty pane

### Phase 3 — Saved searches
- [ ] A query can be saved with a name and appears as a sidebar chip
- [ ] Clicking a saved chip reopens the Search tab with the query applied
- [ ] Saved searches persist across window reloads and can be deleted

### Phase 4 — Notes & tags
- [ ] A note and tags can be attached to a session and persist across reloads
- [ ] Tags render on sidebar rows and are filterable
- [ ] Notes and tags are matched by search
- [ ] Nothing is ever written under `~/.claude`

### Phase 5 — Timeline
- [ ] A Timeline tab exists, reachable by click and by `6`
- [ ] A day-by-day view lists sessions grouped by date across all projects
- [ ] Each entry shows project, branch, and session title
- [ ] Clicking an entry opens that conversation
- [ ] The help overlay lists the correct tab numbers, including the two new tabs

## Out of Scope

- Any write to `~/.claude` — the extension stays read-only against Claude's data.
- A persistent search index. Justified by the measured 774 ms full scan; revisit only on an order-of-magnitude regression.
- Semantic or embedding-based search.
- Searching Claude Code data on remote machines.
- Extending the existing Stats tab; cross-session usage aggregation is a separate idea.
- Fixing `parseSession`'s flat subagent walk in the existing reader. The new scanner handles nesting correctly; changing the sidebar's subagent list is a separate behavioural change and should be its own spec.
