# Webview UI

## File Locations

- **HTML template**: inline in `src/agentManagerPanel.ts` (`_getHtml()` method)
- **JavaScript**: `media/main.js` — all client-side logic (IIFE, no build step)
- **CSS**: `media/style.css`
- **Markdown renderer**: `media/marked.min.js` — vendored, loaded before `main.js`

## Communication Protocol

Extension → Webview:
```json
{ "command": "update", "projects": [...], "pinnedKeys": [...], "settings": {...} }
{ "command": "conversation", "messages": [...], "sessionId": "...", "agentId": "..." }
{ "command": "conversationTail", "messages": [...], "sessionId": "...", "agentId": "..." }
{ "command": "sidebarRowUpdate", "sessionId": "...", "lastMessageRole": "...", "lastTimestamp": "...", "messageCount": N }
{ "command": "exportDone" }
```

Webview → Extension:
```json
{ "command": "refresh" }
{ "command": "openFolder", "path": "/abs/path" }
{ "command": "togglePin", "key": "project-dir-name" }
{ "command": "updateSettings", "settings": { "soundEnabled": bool, "soundRepeatSec": number, "exportDestination": "dialog"|"default"|"cwd", "exportToolFormat": "compact"|"expanded"|"omit" } }
{ "command": "loadConversation", "projectKey": "...", "sessionId": "...", "agentId": "..." }
{ "command": "exportChat", "projectKey": "...", "sessionId": "..." }
{ "command": "openInClaudeCode", "sessionId": "..." }
```

`openInClaudeCode` (hash dropdown → "Resume/Fork session") asks the extension to fork-resume the
session in the native Claude Code panel via `claude-vscode.editor.open`, pre-filling a prompt that
tells Claude to read the prior transcript and continue (see
[the fork-resume spec](superpowers/specs/2026-06-14-fork-resume-in-panel-design.md)). Falls back to
copying `claude -r <id>` when the Claude Code extension is unavailable.

## Layout

The panel is a two-column flex layout (`#app`):
- **Left**: `#sidebar` — project/session tree, search, filter bar
- **Right**: `#main-panel` — conversation header + conversation container

In narrow mode (< 600px), the sidebar is hidden and replaced by an `#icon-rail` strip. Clicking a dot in the rail opens a `#sidebar-overlay` drawer. `ResizeObserver` on `#app` drives mode switching.

## UI Components

### Toolbar (inside `#sidebar`)
- Title text ("Agent Manager")
- Last-updated timestamp (`#last-updated`)
- Refresh button (`#refresh-btn`) → sends `refresh` message
- Settings gear (`#settings-btn`) → toggles `#settings-panel` dropdown

### Settings Panel
Two sections:
- **Notification Settings**: sound enabled checkbox, repeat interval select, test button
- **Export Settings**: destination radio (dialog / ~/Documents/claude-exports / session cwd), tool format radio (compact / expanded / omit)

### Search Bar
- Text filter on `displayName` and `path`
- State persisted via `vscode.getState()`/`setState()`

### Filter Bar
Chips: All | Active | Waiting | Pinned — each shows a count badge when > 0.

### Project Cards (`.tree-project`)
- Collapsible (click header to toggle); expansion state tracked in `expandedProjectKeys`
- Shows: collapse chevron, status dot, name, time ago
- Actions: Pin (star), Open (→), Open in New Window (↗)
- Lists up to 8 recent sessions with `+N older` overflow indicator

### Session Rows (`.tree-session`)
- Clickable — sends `loadConversation` and selects the session
- Line 1: status dot, first prompt (truncated to 60 chars), time ago
- Line 2: waiting badge, git branch, message count, agent count
- Expands to show subagent rows inline

### Subagent Rows (`.tree-subagent`)
- Clickable — sends `loadConversation` with `agentId`
- Shows: status dot, slug or short ID, waiting badge ("w"), time ago

### Main Conversation Panel (`#main-panel`)
- **Header** (`#conversation-header`): breadcrumb path, live indicator, export button
- **Conversation container** (`#conversation-container`): scrollable, `tabindex="0"` for keyboard focus

### Conversation Messages
Each message (`.msg`) has a header (role + timestamp) and a body with content blocks:
- **Text blocks** (`.msg-text`): rendered as Markdown via `marked`
- **Tool badge groups** (`.tool-badges`): consecutive tool calls grouped into a flex row

### Tool Badges (`.tool-badge`)
Collapsed by default; click to expand. Shows:
- Status dot: `success` (has output), `error` (isError), `pending` (no result yet)
- Tool name, preview snippet, optional description
- Expanded: IN / OUT code blocks

### Live Indicator (`#live-indicator`)
Shown when the file watcher has delivered a tail update; auto-hides after 60 seconds of no new messages.

### New Message Pill (`#new-msg-pill`)
Appears when new messages arrive while the user is scrolled up. Click to jump to bottom.

### Icon Rail (`#icon-rail`)
Visible in narrow mode only. One dot per project with status color. Click → opens sidebar overlay.

### Keyboard Shortcuts
Active when sidebar has focus (gained via `Tab` or after any sidebar interaction):

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate down / up |
| `h` | Collapse project / jump to parent |
| `l` | Expand project / enter first child |
| `Enter` | Open selected session/agent conversation |
| `Escape` | Deselect / close overlays |
| `p` | Toggle pin on focused project |
| `g g` | Jump to top |
| `G` | Jump to bottom |
| `/` | Focus search input |
| `?` | Show keyboard help overlay |
| `Tab` | Switch focus between sidebar and conversation panel |

## Status Indicators

| Class | Condition | Visual |
|-------|-----------|--------|
| `active` | < 5 min, last msg from user | Green dot |
| `waiting` | < 5 min, last msg from assistant | Orange dot + label |
| `recent` | 5 min – 2 hours | Dimmer dot |
| `idle` | > 2 hours | Gray dot |

## Sound Notifications

- Web Audio API two-note chime (880Hz → 1175Hz)
- Triggers on NEW waiting items (not already in `previousWaitingIds`)
- Optional repeat interval (30s / 1m / 2m / 5m)
- Settings persisted via extension `globalState`

## Export

Export button (`#export-btn`) visible when a session is selected. Sends `exportChat` to the extension, which calls `exportConversation()` in `src/exporter.ts`. Button is disabled while export is in flight; re-enabled on `exportDone`.
