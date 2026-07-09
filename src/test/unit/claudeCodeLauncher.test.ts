import { buildForkResumePrompt, isSessionId } from '../../claudeCodeLauncher';

const SESSION_ID = '93649f04-3fbe-49a3-bdda-effd1bc10c27';

describe('buildForkResumePrompt', () => {
  test('contains the session id', () => {
    expect(buildForkResumePrompt(SESSION_ID)).toContain(SESSION_ID);
  });

  test('instructs locating the transcript under ~/.claude/projects', () => {
    const prompt = buildForkResumePrompt(SESSION_ID);
    expect(prompt).toContain('~/.claude/projects');
    expect(prompt).toContain(`${SESSION_ID}.jsonl`);
  });

  test('is safe to continue when the session genuinely resumes', () => {
    // The prompt must be conditional ("if new session…") so it reads as a
    // near no-op when the panel truly resumed the session.
    expect(buildForkResumePrompt(SESSION_ID)).toMatch(/already\s+(been\s+)?resumed/i);
  });

  test('does not embed a resolved filesystem path, only the session id', () => {
    const prompt = buildForkResumePrompt(SESSION_ID);
    // No absolute paths — the only path-like text allowed is the literal
    // ~/.claude/projects hint.
    expect(prompt.replace(/~\/\.claude\/projects/g, '')).not.toMatch(/(^|[\s`("'])\/[A-Za-z]/);
  });
});

describe('isSessionId', () => {
  test('accepts a UUID session id', () => {
    expect(isSessionId(SESSION_ID)).toBe(true);
    expect(isSessionId(SESSION_ID.toUpperCase())).toBe(true);
  });

  test('rejects non-UUID strings', () => {
    expect(isSessionId('')).toBe(false);
    expect(isSessionId('not-a-session-id')).toBe(false);
    expect(isSessionId(`${SESSION_ID}; rm -rf ~`)).toBe(false);
    expect(isSessionId(`$(whoami)`)).toBe(false);
  });
});
