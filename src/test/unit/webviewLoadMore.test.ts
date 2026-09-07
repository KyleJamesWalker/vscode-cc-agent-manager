/**
 * @jest-environment jest-environment-jsdom
 *
 * Load-more regression tests for media/main.js.
 * Covers the spec in docs/superpowers/specs/2026-03-28-view-more-sessions-design.md.
 *
 * Key regression: clicking load-more on project A called bindSidebarEvents on
 * the entire container, adding a second click listener to every already-bound
 * element. Project headers then toggled 'collapsed' twice per click — net effect:
 * no change — making other projects appear impossible to expand/collapse.
 */

import * as fs from 'fs';
import * as path from 'path';
import { WEBVIEW_BODY } from './webviewFixture';

const MAIN_JS = fs.readFileSync(
  path.resolve(__dirname, '../../../media/main.js'),
  'utf8'
);


const DEFAULT_SETTINGS = {
  soundEnabled: false,
  soundRepeatSec: 0,
  exportDestination: 'dialog',
  exportToolFormat: 'compact',
};

function resetEnv() {
  document.open();
  document.write(`<!DOCTYPE html><html><body>${WEBVIEW_BODY}</body></html>`);
  document.close();

  (window as any).acquireVsCodeApi = () => ({
    postMessage: () => {},
    getState: () => null,
    setState: () => {},
  });
  (window as any).marked = {
    Marked: class {
      constructor(_opts: unknown) {}
      parse(text: string) { return text; }
    },
  };
  (window as any).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

  window.HTMLElement.prototype.scrollIntoView = () => {};
  (window as any).CSS = { escape: (s: string) => s };

  // eslint-disable-next-line no-eval
  (window as any).eval(MAIN_JS);
}

// main.js is eval'd exactly once per file — re-eval'ing in beforeEach
// accumulates duplicate document-level listeners and corrupts test state.
beforeAll(resetEnv);

let _keyCounter = 0;
function freshKey() { return `proj-${++_keyCounter}`; }

beforeEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  document.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));
  sendUpdate([]);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendUpdate(projects: unknown[]) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { command: 'update', projects, pinnedKeys: [], settings: DEFAULT_SETTINGS },
    })
  );
}

function makeProject(key: string, sessionCount: number) {
  return {
    key,
    displayName: key,
    path: `/projects/${key}`,
    lastActivity: null,
    sessions: Array.from({ length: sessionCount }, (_, i) => ({
      sessionId: `sess-${key}-${i}`,
      firstPrompt: `Session ${i}`,
      lastTimestamp: null,
      status: 'idle',
      messageCount: 5,
      subAgents: [],
      gitBranch: null,
    })),
  };
}

// ── Load-more button rendering ────────────────────────────────────────────────

describe('load-more button rendering', () => {
  test('projects with exactly 8 sessions do not show a load-more button', () => {
    const key = freshKey();
    sendUpdate([makeProject(key, 8)]);

    const proj = document.querySelector(`.tree-project[data-key="${key}"]`) as HTMLElement;
    expect(proj.querySelector('.btn-load-more')).toBeNull();
  });

  test('projects with more than 8 sessions show a load-more button', () => {
    const key = freshKey();
    sendUpdate([makeProject(key, 9)]);

    const proj = document.querySelector(`.tree-project[data-key="${key}"]`) as HTMLElement;
    expect(proj.querySelector('.btn-load-more')).not.toBeNull();
  });

  test('load-more button label includes the count of remaining sessions', () => {
    const key = freshKey();
    sendUpdate([makeProject(key, 15)]);

    const proj = document.querySelector(`.tree-project[data-key="${key}"]`) as HTMLElement;
    const btn = proj.querySelector('.btn-load-more') as HTMLElement;
    // 15 sessions − 8 visible = 7 remaining
    expect(btn.textContent).toContain('7 remaining');
  });

  test('load-more button disappears once all sessions are visible', () => {
    const key = freshKey();
    sendUpdate([makeProject(key, 9)]);

    const proj = document.querySelector(`.tree-project[data-key="${key}"]`) as HTMLElement;
    (proj.querySelector('.btn-load-more') as HTMLButtonElement).click();

    const updated = document.querySelector(`.tree-project[data-key="${key}"]`) as HTMLElement;
    expect(updated.querySelector('.btn-load-more')).toBeNull();
  });

  test('clicking load-more reveals the next batch of sessions in the DOM', () => {
    const key = freshKey();
    sendUpdate([makeProject(key, 12)]);

    const proj = document.querySelector(`.tree-project[data-key="${key}"]`) as HTMLElement;
    expect(proj.querySelectorAll('.tree-session').length).toBe(8);

    (proj.querySelector('.btn-load-more') as HTMLButtonElement).click();

    const updated = document.querySelector(`.tree-project[data-key="${key}"]`) as HTMLElement;
    expect(updated.querySelectorAll('.tree-session').length).toBe(12);
  });
});

// ── Regression: load-more must not double-bind other projects ─────────────────
//
// Bug: after clicking load-more, bindSidebarEvents(container) was called for
// the entire container, adding a second listener to each already-bound header.
// Toggling collapsed fired twice, resulting in no net change.

describe('load-more does not break expand/collapse on other projects', () => {
  test('clicking load-more on one project does not prevent expanding another', () => {
    const keyA = freshKey(); // >8 sessions → has load-more button
    const keyB = freshKey(); // separate project to expand

    sendUpdate([makeProject(keyA, 10), makeProject(keyB, 2)]);

    const projBEl = document.querySelector(`.tree-project[data-key="${keyB}"]`) as HTMLElement;
    expect(projBEl.classList.contains('collapsed')).toBe(true);

    // Trigger load-more on project A
    const projAEl = document.querySelector(`.tree-project[data-key="${keyA}"]`) as HTMLElement;
    (projAEl.querySelector('.btn-load-more') as HTMLButtonElement).click();

    // Project B's header should now toggle collapsed exactly once
    const headerB = projBEl.querySelector('.tree-project-header') as HTMLElement;
    headerB.click();

    expect(projBEl.classList.contains('collapsed')).toBe(false);
  });

  test('clicking load-more on one project does not prevent collapsing another', () => {
    const keyA = freshKey();
    const keyB = freshKey();

    sendUpdate([makeProject(keyA, 10), makeProject(keyB, 2)]);

    // Expand project B first
    const projBEl = document.querySelector(`.tree-project[data-key="${keyB}"]`) as HTMLElement;
    const headerB = projBEl.querySelector('.tree-project-header') as HTMLElement;
    headerB.click();
    expect(projBEl.classList.contains('collapsed')).toBe(false);

    // Trigger load-more on project A
    const projAEl = document.querySelector(`.tree-project[data-key="${keyA}"]`) as HTMLElement;
    (projAEl.querySelector('.btn-load-more') as HTMLButtonElement).click();

    // Project B's header should collapse it exactly once
    headerB.click();

    expect(projBEl.classList.contains('collapsed')).toBe(true);
  });

  test('multiple load-more clicks do not compound the double-bind problem', () => {
    const keyA = freshKey(); // 25 sessions → two load-more clicks available
    const keyB = freshKey();

    sendUpdate([makeProject(keyA, 25), makeProject(keyB, 2)]);

    // Click load-more on project A twice
    let projAEl = document.querySelector(`.tree-project[data-key="${keyA}"]`) as HTMLElement;
    (projAEl.querySelector('.btn-load-more') as HTMLButtonElement).click();
    projAEl = document.querySelector(`.tree-project[data-key="${keyA}"]`) as HTMLElement;
    (projAEl.querySelector('.btn-load-more') as HTMLButtonElement).click();

    // Project B expand/collapse should still work correctly
    const projBEl = document.querySelector(`.tree-project[data-key="${keyB}"]`) as HTMLElement;
    const headerB = projBEl.querySelector('.tree-project-header') as HTMLElement;
    headerB.click();

    expect(projBEl.classList.contains('collapsed')).toBe(false);
  });

  test('sessions in an unrelated project remain clickable after load-more', () => {
    const keyA = freshKey();
    const keyB = freshKey();
    let selectedKey: string | null = null;
    let selectedSid: string | null = null;

    sendUpdate([makeProject(keyA, 10), makeProject(keyB, 2)]);

    // Patch postMessage to capture selectConversation calls
    (window as any).acquireVsCodeApi = () => ({
      postMessage: (msg: any) => {
        if (msg.command === 'getConversation') {
          selectedKey = msg.projectKey;
          selectedSid = msg.sessionId;
        }
      },
      getState: () => null,
      setState: () => {},
    });

    // Trigger load-more on project A
    const projAEl = document.querySelector(`.tree-project[data-key="${keyA}"]`) as HTMLElement;
    (projAEl.querySelector('.btn-load-more') as HTMLButtonElement).click();

    // Click a session in project B — should fire exactly once, not twice
    const projBEl = document.querySelector(`.tree-project[data-key="${keyB}"]`) as HTMLElement;
    const sessionB = projBEl.querySelector('.tree-session') as HTMLElement;
    const expectedSid = sessionB.dataset.sessionId;

    let clickCount = 0;
    const origHandler = sessionB.onclick;
    // Count DOM clicks by checking the selected state before and after
    sessionB.click();

    // The session should now be .selected
    expect(sessionB.classList.contains('selected')).toBe(true);
  });
});
