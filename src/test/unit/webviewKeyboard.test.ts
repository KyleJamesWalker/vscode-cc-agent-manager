/**
 * @jest-environment jest-environment-jsdom
 *
 * Keyboard navigation regression tests for media/main.js.
 * Each test gets a fresh document (event listeners reset via document.open)
 * and a fresh eval of main.js to avoid shared closure state.
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

/**
 * Reset the jsdom document completely (clears event listeners) and re-run
 * main.js so each test gets fresh closure state.
 */
function resetEnv() {
  // document.open() per spec removes all event listeners and resets the document.
  document.open();
  document.write(`<!DOCTYPE html><html><body>${WEBVIEW_BODY}</body></html>`);
  document.close();

  // Globals required by main.js
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

  // jsdom does not implement scrollIntoView or CSS.escape — stub them out.
  window.HTMLElement.prototype.scrollIntoView = () => {};
  (window as any).CSS = { escape: (s: string) => s };

  // Run the webview script in the jsdom window context.
  // eslint-disable-next-line no-eval
  (window as any).eval(MAIN_JS);
}

// main.js is eval'd exactly once — document.open() does not clear
// document.addEventListener listeners in jsdom v26, so re-eval'ing in
// beforeEach would accumulate duplicate listeners and corrupt test state.
beforeAll(resetEnv);

// Lightweight per-test cleanup: reset only mutable DOM/closure state.
let _keyCounter = 0;
function freshKey() { return `proj-${++_keyCounter}`; }

beforeEach(() => {
  // Fire Escape to reset closure state: sidebarHasFocus=true, selectedSession=null,
  // conv-focused removed. If search is focused Escape blurs it too.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  // Clear any remaining .focused highlights (Escape doesn't do this).
  document.querySelectorAll('.focused').forEach(el => el.classList.remove('focused'));
  // Clear search value and blur if still focused.
  const search = document.getElementById('search') as HTMLInputElement | null;
  if (search) {
    search.value = '';
    if (document.activeElement === search) { search.blur(); }
  }
  // Flush the projects list so renderSidebar resets focusedIndex=-1.
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { command: 'update', projects: [], pinnedKeys: [], settings: DEFAULT_SETTINGS },
    })
  );
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function sendUpdate(projects: unknown[]) {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { command: 'update', projects, pinnedKeys: [], settings: DEFAULT_SETTINGS },
    })
  );
}

function fireKey(key: string) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
}

function expandFirstProject() {
  (document.querySelector('.tree-project-header') as HTMLElement | null)?.click();
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

// ── Bug 1: vim keybindings work immediately ──────────────────────────────────

describe('Bug 1: sidebarHasFocus starts true', () => {
  test('j moves focus to first item without pressing Tab first', () => {
    sendUpdate([makeProject(freshKey(), 2)]);
    expandFirstProject();

    fireKey('j');

    expect(document.querySelector('.focused')).not.toBeNull();
  });

  test('k after j returns focus to the previous item', () => {
    sendUpdate([makeProject(freshKey(), 3)]);
    expandFirstProject(); // focusedIndex → 0 (header)

    fireKey('j'); // → sess0 (index 1)
    fireKey('k'); // → header (index 0)

    const focused = document.querySelector('.focused') as HTMLElement | null;
    expect(focused?.classList.contains('tree-project-header')).toBe(true);
  });
});

// ── Bug 2: mouse selection syncs keyboard position ───────────────────────────

describe('Bug 2: mouse selection syncs focusedIndex', () => {
  test('j after clicking a session moves to the next session', () => {
    sendUpdate([makeProject(freshKey(), 5)]);
    expandFirstProject();

    const sessions = document.querySelectorAll('.tree-session');
    (sessions[2] as HTMLElement).click();

    fireKey('j');

    expect(document.querySelector('.focused')).toBe(sessions[3]);
  });

  test('k after clicking a session moves to the previous session', () => {
    sendUpdate([makeProject(freshKey(), 5)]);
    expandFirstProject();

    const sessions = document.querySelectorAll('.tree-session');
    (sessions[2] as HTMLElement).click();

    fireKey('k');

    expect(document.querySelector('.focused')).toBe(sessions[1]);
  });

  test('j after clicking a project header continues from that project', () => {
    sendUpdate([makeProject(freshKey(), 3)]);

    // Click header → expands and syncs focusedIndex to 0
    (document.querySelector('.tree-project-header') as HTMLElement).click();

    fireKey('j'); // → sess0 (index 1)

    const sessions = document.querySelectorAll('.tree-session');
    expect(document.querySelector('.focused')).toBe(sessions[0]);
  });

  test('mouse click applies .selected but not .focused', () => {
    sendUpdate([makeProject(freshKey(), 3)]);
    expandFirstProject();

    const sessions = document.querySelectorAll('.tree-session');
    (sessions[1] as HTMLElement).click();

    expect(sessions[1].classList.contains('focused')).toBe(false);
    expect(sessions[1].classList.contains('selected')).toBe(true);
  });
});

// ── Bug 3: Enter exits search ─────────────────────────────────────────────────

describe('Bug 3: Enter exits search input', () => {
  test('Enter blurs the search input', () => {
    const search = document.getElementById('search') as HTMLInputElement;
    search.focus();
    expect(document.activeElement).toBe(search);

    fireKey('Enter');

    expect(document.activeElement).not.toBe(search);
  });

  test('Escape also blurs the search input', () => {
    const search = document.getElementById('search') as HTMLInputElement;
    search.focus();

    fireKey('Escape');

    expect(document.activeElement).not.toBe(search);
  });

  test('j works immediately after Enter exits search', () => {
    sendUpdate([makeProject(freshKey(), 2)]);
    expandFirstProject();

    const search = document.getElementById('search') as HTMLInputElement;
    search.focus();
    fireKey('Enter');

    fireKey('j');

    expect(document.querySelector('.focused')).not.toBeNull();
  });
});

// ── Bug 4: / selects existing search text ────────────────────────────────────

describe('Bug 4: / selects existing search text', () => {
  test('/ focuses the search input', () => {
    sendUpdate([makeProject(freshKey(), 2)]);

    fireKey('/');

    expect(document.activeElement).toBe(document.getElementById('search'));
  });

  test('/ selects all existing text in the search input', () => {
    sendUpdate([makeProject(freshKey(), 2)]);
    const search = document.getElementById('search') as HTMLInputElement;
    search.value = 'existing query';

    fireKey('/');

    expect(search.selectionStart).toBe(0);
    expect(search.selectionEnd).toBe('existing query'.length);
  });
});

// ── Feature: conversation panel vim navigation ───────────────────────────────

describe('Feature: conversation panel focus', () => {
  /** Navigate sidebar to sess0 then press l to enter conversation focus. */
  function enterConvFocus() {
    sendUpdate([makeProject(freshKey(), 3)]);
    expandFirstProject(); // focusedIndex → 0 (header)
    fireKey('j');         // → sess0 (index 1)
    fireKey('l');         // open conversation + conv-focused
  }

  function convContainer() {
    return document.getElementById('conversation-container')!;
  }

  test('l on a focused session adds conv-focused to the conversation container', () => {
    enterConvFocus();
    expect(convContainer().classList.contains('conv-focused')).toBe(true);
  });

  test('h when conversation is focused removes conv-focused', () => {
    enterConvFocus();
    fireKey('h');
    expect(convContainer().classList.contains('conv-focused')).toBe(false);
  });

  test('j scrolls conversation down 80px when conversation is focused', () => {
    enterConvFocus();
    convContainer().scrollTop = 0;

    fireKey('j');

    expect(convContainer().scrollTop).toBe(80);
  });

  test('k scrolls conversation up 80px when conversation is focused', () => {
    enterConvFocus();
    convContainer().scrollTop = 200;

    fireKey('k');

    expect(convContainer().scrollTop).toBe(120);
  });

  test('G scrolls conversation to bottom when conversation is focused', () => {
    enterConvFocus();
    Object.defineProperty(convContainer(), 'scrollHeight', { get: () => 500, configurable: true });

    fireKey('G');

    expect(convContainer().scrollTop).toBe(500);
  });

  test('gg scrolls conversation to top when conversation is focused', () => {
    enterConvFocus();
    convContainer().scrollTop = 300;

    fireKey('g');
    fireKey('g');

    expect(convContainer().scrollTop).toBe(0);
  });

  test('Escape from conversation focus removes conv-focused', () => {
    enterConvFocus();
    fireKey('Escape');
    expect(convContainer().classList.contains('conv-focused')).toBe(false);
  });

  test('Tab shifts focus to conversation panel', () => {
    sendUpdate([makeProject(freshKey(), 2)]);

    fireKey('Tab');

    expect(convContainer().classList.contains('conv-focused')).toBe(true);
  });

  test('Tab again returns focus to sidebar', () => {
    sendUpdate([makeProject(freshKey(), 2)]);

    fireKey('Tab');
    fireKey('Tab');

    expect(convContainer().classList.contains('conv-focused')).toBe(false);
  });

  test('l on a project expands it instead of entering conversation focus', () => {
    sendUpdate([makeProject(freshKey(), 2)]);
    // Project starts collapsed; j → header (index 0)
    fireKey('j');
    fireKey('l'); // should expand the collapsed project, not shift to conversation

    expect(convContainer().classList.contains('conv-focused')).toBe(false);
    expect(document.querySelector('.tree-project')!.classList.contains('collapsed')).toBe(false);
  });
});
