# Thinking Steps in Conversation Viewer — Design

**Status:** Approved
**Date:** 2026-04-28
**Author:** Kyle Walker (with Claude)

## Summary

Surface Claude Code's `thinking` content blocks in the Agent Manager panel. The
extension currently parses `text` and `tool_use` blocks from session JSONL files
and ignores `thinking` blocks entirely. This spec adds `thinking` as a
first-class `MessageBlock` type, renders non-empty thinking inline as a
collapsed pill, adds a new `'reasoning'` session status, and includes thinking
content in Markdown exports — all gated behind a single persisted toggle.

## Background and Constraints

Claude Code emits `thinking` content blocks of the form:

```json
{ "type": "thinking", "thinking": "...", "signature": "Ep..." }
```

A survey of 200 local JSONL files found 1,804 thinking blocks total; only 1 had
non-empty `thinking` text. The remaining 1,803 had empty text and a long opaque
`signature`. This is consistent with Anthropic's redacted-thinking behavior: the
client receives a verifiable signature placeholder, not the raw reasoning, on
most configurations.

Two consequences shape the design:

1. Rendering every thinking block by default would flood viewers with empty
   `(redacted)` placeholders that carry no information.
2. The *presence* of a thinking block is still meaningful — it tells us the
   model is reasoning between tool calls — even when content is redacted, so
   the status signal can use redacted blocks even though rendering does not.

## Goals

- Show non-empty thinking content inline in the conversation viewer when
  enabled.
- Add a distinct `'reasoning'` live status when the last assistant block is a
  thinking block.
- Export non-empty thinking content alongside the rest of the conversation.
- All three behaviors are controlled by a single persisted toggle, default OFF.
- Toggle is reachable from the top of the Agent Manager panel without a
  settings dive.

## Non-Goals

- Decoding or reconstructing redacted thinking content.
- Rendering thinking signatures or any cryptographic metadata.
- Filtering, searching, or analyzing thinking text (future work).
- Displaying thinking blocks anywhere outside the conversation viewer (e.g.
  not in session list previews or summary stats).

## User-Visible Behavior

### Toggle

A new control at the top of the Agent Manager panel, near the existing refresh
control, labeled **Show thinking** (with a tooltip: "Show Claude's reasoning
steps when available. Most thinking is redacted by Anthropic and won't display
even when enabled."). State persists in `ManagerSettings.showThinking` via the
existing `globalState.managerSettings` mechanism. Default: `false`.

### Conversation viewer

When `showThinking === true` and a `thinking` block has non-empty text:

- Render a collapsed pill above the surrounding text, styled like the existing
  tool-block badge: a 💭 icon, the label `Thinking`, and a short preview of
  the first ~60 chars of the thinking text.
- Click the pill to expand inline; expanded content is markdown-rendered using
  the existing `marked.min.js` and styled dim/italic to distinguish it from
  the assistant's user-facing reply.
- When `showThinking === false` or the block's `thinking.trim() === ''`, the
  block is not rendered at all (no badge, no placeholder).

### Session status

A new `SessionStatus` value: `'reasoning'`. `deriveStatus()` returns
`'reasoning'` when the last assistant content block has type `'thinking'`,
regardless of whether its text is empty (presence is the signal).

The panel UI maps `'reasoning'` to a distinct status dot only when
`showThinking === true`; when the toggle is off, the panel falls back to
displaying the existing `'thinking'` status dot for `'reasoning'` sessions, so
users who have not opted in see no behavior change.

### Markdown export

When `showThinking === true`, non-empty thinking blocks render in the export as:

```markdown
<details>
<summary>💭 Thinking</summary>

{thinking text, verbatim}

</details>
```

When `showThinking === false`, or for redacted (empty) thinking blocks,
nothing is emitted. Thinking sections appear positionally in the assistant's
block stream, before any text or tool block they precede in the source JSONL.

## Architecture

```
~/.claude/projects/**/*.jsonl
   └── assistant message.content[]
        ├── { type: "thinking", thinking, signature }   ← parsed
        ├── { type: "text", text }                      ← parsed (today)
        └── { type: "tool_use", ... }                   ← parsed (today)
                       │
                       ▼
src/claudeReader.ts   (always parses; toggle-agnostic)
   • extractBlocks() emits MessageBlock { type: 'thinking', content }
   • deriveStatus() returns 'reasoning' when last assistant block
     has type 'thinking'
                       │
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
agentManagerPanel    exporter.ts     media/main.js
   reads               renders         renders
   showThinking;       <details>       collapsed pill;
   maps                blocks for      hides redacted
   reasoning→thinking  non-empty       and the entire
   when toggle off     thinking when   block when
                       showThinking    showThinking
                       === true        === false
```

The reader is a pure function of file content. All three consumers receive the
full block stream and the current `showThinking` flag and decide what to
render. This keeps parsing deterministic, allows the toggle to flip without
re-reading any files, and avoids special-casing `'reasoning'` outside the
panel UI.

## Components and Changes

### `src/types.ts`

```ts
export type SessionStatus =
  | 'active' | 'thinking' | 'reasoning' | 'waiting' | 'recent' | 'idle';

export interface MessageBlock {
  type: 'text' | 'tool' | 'thinking';
  content: string;          // for thinking: the raw thinking text (may be '')
  toolUseId?: string;
  description?: string;
  input?: string;
  output?: string;
  isError?: boolean;
  preview?: string;
}

export interface ManagerSettings {
  soundEnabled: boolean;
  soundRepeatSec: number;
  exportTemplate: string;
  exportLinkStyle: 'markdown' | 'wiki';
  exportToolFormat: 'compact' | 'expanded' | 'omit';
  showThinking: boolean;    // NEW
}
```

`MessageBlock` retains its existing shape; thinking blocks set `type:
'thinking'` and use `content` for the thinking text. No new fields are added —
the cryptographic `signature` is intentionally discarded at the parser
boundary since it has no UI use.

### `src/claudeReader.ts`

- `extractBlocks()` gains a branch:
  ```ts
  } else if (item.type === 'thinking') {
    blocks.push({ type: 'thinking', content: item.thinking ?? '' });
  }
  ```
  The raw JSONL uses `thinking` as the field name; `ContentItem` is widened to
  include `thinking?: string`.
- `getLastContentBlock()` continues to return the last raw content item
  unchanged.
- `deriveStatus()` adds a branch *before* the existing tool/text branches:
  ```ts
  if (lastContentBlockType === 'thinking') return 'reasoning';
  ```
  This applies whether the thinking text is empty or not.
- The session/sub-agent stat counters (`assistantLines`, `userChars`,
  `codeLines`, `toolCounts`) intentionally **do not** count thinking text;
  these counters reflect user-visible work, and thinking is mostly redacted.

### `src/agentManagerPanel.ts`

- Add `showThinking: false` to `DEFAULT_SETTINGS`.
- The settings round-trip in `_getSettings()`/`_updateSettings()` already
  spreads over defaults, so persisted settings without `showThinking` keep
  default OFF; no migration is needed.
- Pass `showThinking` to the webview via the existing settings broadcast.
- Pass `showThinking` to `exporter` calls (new parameter; see below).
- The panel maps `'reasoning'` status → `'thinking'` for status-dot display
  when `settings.showThinking === false`. This is a UI-side fallback and lives
  in the panel/webview, not in `deriveStatus()`.

### `src/exporter.ts`

- `renderMessages(messages, format, showThinking)` gains a `showThinking`
  parameter (or, equivalently, a single options object — chosen during
  implementation to minimise call-site churn).
- Inside the block loop:
  ```ts
  if (block.type === 'thinking') {
    if (showThinking && block.content.trim() !== '') {
      parts.push(`<details>\n<summary>💭 Thinking</summary>\n\n${block.content}\n\n</details>\n\n`);
    }
    continue;
  }
  ```
- `buildRootMarkdown()` and the agent export path receive `showThinking` from
  the panel. Tests in `exporter.test.ts` use `defaultSettings` already and add
  `showThinking: false` to satisfy the type.

### `media/main.js` and `media/style.css`

- Add a top-bar `<label><input type="checkbox" id="show-thinking">Show thinking</label>` next to the existing top-bar controls. Wire it to post a settings update message and to re-render.
- The block renderer adds a `'thinking'` branch that mirrors the tool-block
  pattern: a clickable pill that expands to show markdown-rendered content.
  Skip rendering entirely when `!settings.showThinking || !block.content.trim()`.
- CSS: a new `.thinking-block` class with dim text colour, italic emphasis,
  and a left-border accent distinct from tool blocks. The collapsed pill uses
  a 💭 icon and shares the existing pill base styles.

## Data Flow

1. User opens panel → `agentManagerPanel.ts` reads `managerSettings` from
   `globalState`, fills in defaults including `showThinking: false`.
2. Panel sends settings + project list to webview.
3. User toggles **Show thinking**. Webview posts `{type: 'updateSettings',
   settings}` → panel persists → panel rebroadcasts settings.
4. User opens a session → panel calls `readConversation()`. Returned
   `ConversationMessage[]` always includes thinking blocks.
5. Webview renders blocks honouring `settings.showThinking` (filter + visual
   treatment).
6. Status dots: panel computes session status with `deriveStatus()` (returns
   `'reasoning'` when applicable) → webview maps `'reasoning'` → `'thinking'`
   for display when `settings.showThinking === false`.
7. Export: panel passes `settings.showThinking` to `exporter.ts`, which emits
   `<details>` blocks for non-empty thinking when enabled.

## Error Handling

- Malformed thinking blocks (missing `thinking` field): `extractBlocks()`
  treats `content` as `''`. Empty thinking is already filtered from
  rendering and export, so it disappears silently.
- Stat counters are unaffected by thinking blocks, so corrupt thinking data
  cannot poison session aggregates.
- Toggle persistence failures fall through to defaults via the existing
  spread-over-defaults pattern — no new failure modes.
- The webview must guard against running marked() on the empty string for
  thinking-block render paths (already handled by the empty-content filter
  above).

## Testing

All work follows TDD. Each cycle: failing test → minimal implementation → green.

### `src/test/unit/claudeReader.test.ts`

- `extractBlocks()` returns a `'thinking'` block with the raw text when given
  `{type: 'thinking', thinking: '...'}`.
- `extractBlocks()` returns a `'thinking'` block with empty `content` when
  given an empty/missing `thinking` field.
- `deriveStatus()` returns `'reasoning'` when last assistant block is
  `'thinking'`, regardless of empty/non-empty.
- `parseSession()` does not increment `assistantLines` or `codeLines` for
  thinking blocks.
- A fixture JSONL is added under `src/test/fixtures/` containing assistant
  messages whose content arrays mix thinking, text, and tool_use blocks in
  realistic order.

### `src/test/unit/exporter.test.ts`

- With `showThinking: true` and a non-empty thinking block, output contains
  the expected `<details>…</details>` section.
- With `showThinking: true` and an empty thinking block, output contains no
  `<details>` section for that block.
- With `showThinking: false`, output contains no `<details>` section even
  when a non-empty thinking block exists.
- Existing exporter tests are updated to pass `showThinking: false` (matches
  the default) so behaviour is unchanged for current callers.

### Webview / integration

- A Mocha integration test (`src/test/integration/...`) covers the toggle
  round-trip: panel-open → toggle on → settings persisted → panel-reopen →
  toggle still on. The webview rendering itself is exercised manually (per
  `docs/testing.md`), not via headless integration.

## Migration / Compatibility

- Existing persisted `managerSettings` without `showThinking` get `false`
  on load via the spread-over-defaults pattern. No migration code required.
- `MessageBlock` consumers must handle the new `'thinking'` type. TypeScript's
  exhaustiveness on the discriminated union catches missing branches at
  compile time.
- `SessionStatus` consumers must handle `'reasoning'`. The webview maps it
  for display; status-aware tests are updated accordingly.

## Out of Scope (future work)

- Per-project or per-session toggle granularity (ship as global only).
- Thinking-block search or aggregation UI.
- Rendering of thinking signatures or hashes.
- Capturing thinking from upstream-redacted sessions.

## Acceptance Criteria

1. With `showThinking: false` (default), the conversation viewer, status
   dots, and exported Markdown are byte-for-byte equivalent to today's
   output for any session that contains thinking blocks.
2. With `showThinking: true`, non-empty thinking blocks render as collapsed
   pills that expand on click and show markdown-rendered content.
3. Empty thinking blocks never render in the viewer or appear in exports
   regardless of toggle state.
4. A session whose last assistant block is `thinking` shows the `'reasoning'`
   status dot when `showThinking: true`, and the existing `'thinking'` dot
   when `showThinking: false`.
5. The toggle persists across panel reopens via `globalState.managerSettings`.
6. All new behaviour is covered by unit tests in `claudeReader.test.ts` and
   `exporter.test.ts`; existing tests still pass.
