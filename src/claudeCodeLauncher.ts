/**
 * Pure helpers for launching sessions in the native Claude Code editor panel
 * (see docs/superpowers/specs/2026-06-14-fork-resume-in-panel-design.md).
 */

/** Claude Code extension command that opens a session in its native editor panel. */
export const CLAUDE_CODE_OPEN_COMMAND = 'claude-vscode.editor.open';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when `value` looks like a Claude Code session id (UUID). */
export function isSessionId(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Prompt pre-filled into a fresh Claude Code panel to fork-resume a past session.
 * Contains only the session id — never a resolved filesystem path — and is phrased
 * as a near no-op when the panel genuinely resumed the session.
 */
export function buildForkResumePrompt(sessionId: string): string {
  return (
    `You are a continuation of an earlier Claude Code session, id \`${sessionId}\`. ` +
    `Determine whether that session has already been resumed here, or whether this is a ` +
    `new session (if this is the only prompt in the current session, it's a new session). ` +
    `For a new session, restore the earlier session's context by locating and reading its ` +
    `transcript — the \`${sessionId}.jsonl\` file under your \`~/.claude/projects\` ` +
    `directory (JSONL: one message/tool record per line; read at least the last ~15 ` +
    `text/tool events). Identify from it the last in-flight work, verify on disk the ` +
    `state of the files it touched (a final Write may not have persisted), and summarize ` +
    `(in the language of the previous conversation) exactly where we ended and what's ` +
    `unfinished. Then we'll continue.`
  );
}
