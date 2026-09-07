/**
 * @jest-environment jest-environment-jsdom
 *
 * Search, timeline and saved-search behaviour in media/main.js.
 */

import { DEFAULT_SETTINGS, Harness, resetEnv, send } from './webviewFixture';

let harness: Harness;

function posted(command: string): Array<Record<string, unknown>> {
  return harness.posted.filter((m) => m.command === command);
}

function lastPosted(command: string): Record<string, unknown> | undefined {
  const all = posted(command);
  return all[all.length - 1];
}

function clickTab(tab: string): void {
  const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`) as HTMLElement;
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

function openSearchTab(): void {
  clickTab('search');
}

function typeQuery(text: string): void {
  const input = document.getElementById('search-query') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  jest.advanceTimersByTime(250);
}

function hit(overrides: Record<string, unknown> = {}) {
  return {
    projectKey: '-Users-alice-work',
    projectPath: '/Users/alice/work',
    sessionId: 'sess-a',
    uuid: 'uuid-1',
    role: 'user',
    scope: 'prompts',
    timestamp: '2026-09-01T10:00:00.000Z',
    gitBranch: 'main',
    snippet: 'the needle is here',
    matchStart: 4,
    matchLength: 6,
    ...overrides,
  };
}

/**
 * main.js is evaluated ONCE. Re-evaluating it per test leaves the previous
 * closure's message listener attached, and a stale requestId then matches that
 * older closure's counter — the exact bug this suite asserts against.
 */
beforeAll(() => {
  harness = resetEnv();
});

beforeEach(() => {
  jest.useFakeTimers();
  harness.posted.length = 0;
  (document.activeElement as HTMLElement | null)?.blur();
  clickTab('sessions');
  send({ command: 'update', projects: [], pinnedKeys: [], settings: DEFAULT_SETTINGS });
  send({ command: 'savedSearches', items: [] });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('search tab', () => {
  test('opens from the tab bar and shows a query box', () => {
    openSearchTab();
    expect(document.getElementById('search-query')).not.toBeNull();
  });

  test('opens with the 5 key and timeline with the 6 key', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }));
    expect(document.getElementById('search-query')).not.toBeNull();

    // showSearch focuses the query box, and shortcuts are suppressed while an
    // input has focus, so a real user would blur before switching tabs by key.
    (document.activeElement as HTMLElement | null)?.blur();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '6', bubbles: true }));
    expect(lastPosted('getTimeline')).toBeDefined();
  });

  test('typing posts a search with the default scopes', () => {
    openSearchTab();
    typeQuery('needle');

    const msg = lastPosted('search');
    expect(msg).toBeDefined();
    const query = msg!.query as Record<string, unknown>;
    expect(query.text).toBe('needle');
    expect(query.scopes).toEqual(['prompts', 'assistant', 'note']);
    expect(query.isRegex).toBe(false);
    expect(query.caseSensitive).toBe(false);
  });

  test('an empty query posts no search', () => {
    openSearchTab();
    typeQuery('   ');
    expect(posted('search')).toHaveLength(0);
  });

  test('toggling a scope chip changes the posted scopes', () => {
    openSearchTab();
    typeQuery('needle');
    (document.querySelector('.search-chip[data-scope="thinking"]') as HTMLElement).click();

    const query = lastPosted('search')!.query as Record<string, unknown>;
    expect(query.scopes).toContain('thinking');
  });

  test('the regex and case toggles are reflected in the query', () => {
    openSearchTab();
    typeQuery('needle');
    (document.getElementById('search-regex') as HTMLElement).click();
    (document.getElementById('search-case') as HTMLElement).click();

    const query = lastPosted('search')!.query as Record<string, unknown>;
    expect(query.isRegex).toBe(true);
    expect(query.caseSensitive).toBe(true);
  });

  test('renders streamed batches incrementally', () => {
    openSearchTab();
    typeQuery('needle');
    const requestId = lastPosted('search')!.requestId;

    send({ command: 'searchProgress', requestId, hits: [hit()], filesScanned: 1, filesTotal: 9 });
    expect(document.querySelectorAll('.search-hit')).toHaveLength(1);

    send({
      command: 'searchProgress',
      requestId,
      hits: [hit({ uuid: 'uuid-2' })],
      filesScanned: 2,
      filesTotal: 9,
    });
    expect(document.querySelectorAll('.search-hit')).toHaveLength(2);
    expect(document.getElementById('search-status')!.textContent).toContain('2 results');
  });

  test('drops batches from a superseded request', () => {
    openSearchTab();
    typeQuery('needle');
    const stale = lastPosted('search')!.requestId as number;

    send({ command: 'searchProgress', requestId: stale - 1, hits: [hit()], filesScanned: 1, filesTotal: 9 });

    expect(document.querySelectorAll('.search-hit')).toHaveLength(0);
  });

  test('escapes HTML in a snippet and marks the match', () => {
    openSearchTab();
    typeQuery('needle');
    const requestId = lastPosted('search')!.requestId;

    send({
      command: 'searchProgress',
      requestId,
      hits: [hit({ snippet: '<script>alert(1)</script> needle', matchStart: 26, matchLength: 6 })],
      filesScanned: 1,
      filesTotal: 1,
    });

    const snippet = document.querySelector('.search-hit-snippet')!;
    expect(snippet.querySelector('script')).toBeNull();
    expect(snippet.innerHTML).toContain('&lt;script&gt;');
    expect(snippet.querySelector('mark')!.textContent).toBe('needle');
  });

  test('surfaces a search error instead of results', () => {
    openSearchTab();
    typeQuery('([');
    const requestId = lastPosted('search')!.requestId;

    send({
      command: 'searchDone',
      requestId,
      totalHits: 0,
      durationMs: 0,
      filesScanned: 0,
      titles: {},
      error: 'Invalid regular expression',
    });

    expect(document.querySelector('.search-error')!.textContent).toContain('Invalid regular');
  });

  test('clicking a result loads that conversation at the matching message', () => {
    openSearchTab();
    typeQuery('needle');
    const requestId = lastPosted('search')!.requestId;
    send({ command: 'searchProgress', requestId, hits: [hit()], filesScanned: 1, filesTotal: 1 });

    (document.querySelector('.search-hit [data-action="open"]') as HTMLElement).click();

    const msg = lastPosted('loadConversation');
    expect(msg).toMatchObject({
      projectKey: '-Users-alice-work',
      sessionId: 'sess-a',
      scrollToUuid: 'uuid-1',
    });
  });

  test('renders a note-scope hit alongside content hits', () => {
    openSearchTab();
    typeQuery('needle');
    const requestId = lastPosted('search')!.requestId;

    send({
      command: 'searchProgress',
      requestId,
      hits: [hit({ scope: 'note', snippet: 'the needle refactor', uuid: '' })],
      filesScanned: 0,
      filesTotal: 0,
    });

    expect(document.querySelector('.search-scope-badge')!.textContent).toBe('Notes');
  });

  test('shows session tags in the sidebar', () => {
    send({ command: 'sessionMeta', items: { 'sess-a': { tags: ['spike'] } } });
    send({
      command: 'update',
      projects: [
        {
          key: '-Users-alice-work',
          path: '/Users/alice/work',
          displayName: 'work',
          sessions: [
            { sessionId: 'sess-a', messageCount: 2, subAgents: [], status: 'idle', toolCounts: {} },
          ],
        },
      ],
      pinnedKeys: [],
      settings: DEFAULT_SETTINGS,
    });

    const tags = Array.from(document.querySelectorAll('.tree-session .search-tag'));
    expect(tags.map((t) => t.textContent)).toEqual(['spike']);
  });

  test('Resume and Export act on the hit\'s session', () => {
    openSearchTab();
    typeQuery('needle');
    const requestId = lastPosted('search')!.requestId;
    send({ command: 'searchProgress', requestId, hits: [hit()], filesScanned: 1, filesTotal: 1 });

    (document.querySelector('.search-hit [data-action="resume"]') as HTMLElement).click();
    expect(lastPosted('openInClaudeCode')).toMatchObject({ sessionId: 'sess-a' });

    (document.querySelector('.search-hit [data-action="export"]') as HTMLElement).click();
    expect(lastPosted('exportChat')).toMatchObject({
      projectKey: '-Users-alice-work',
      sessionId: 'sess-a',
    });
  });

  test('scrolls to and flashes the matching message when the conversation arrives', () => {
    send({
      command: 'conversation',
      messages: [
        { role: 'user', blocks: [{ type: 'text', content: 'one' }], uuid: 'uuid-1' },
        { role: 'user', blocks: [{ type: 'text', content: 'two' }], uuid: 'uuid-2' },
      ],
      sessionId: 'sess-a',
      scrollToUuid: 'uuid-2',
    });

    const target = document.querySelector('.msg[data-uuid="uuid-2"]')!;
    expect(target.classList.contains('msg-flash')).toBe(true);
    expect(document.querySelector('.msg[data-uuid="uuid-1"]')!.classList.contains('msg-flash')).toBe(false);
  });

  test('the stop button cancels the running search', () => {
    openSearchTab();
    typeQuery('needle');
    (document.getElementById('search-stop') as HTMLElement).click();
    expect(lastPosted('cancelSearch')).toBeDefined();
  });
});

describe('file reverse lookup', () => {
  test('startFileUsage switches to the search tab and renders tiers', () => {
    send({ command: 'startFileUsage', path: '/Users/alice/work/src/a.ts' });
    send({
      command: 'fileUsage',
      path: '/Users/alice/work/src/a.ts',
      sessions: [
        {
          projectKey: '-Users-alice-work',
          projectPath: '/Users/alice/work',
          sessionId: 'sess-a',
          tier: 'modified',
          occurrences: 3,
          timestamp: '2026-09-01T10:00:00.000Z',
        },
      ],
    });

    expect(document.querySelector('.search-tier-modified')).not.toBeNull();
    expect(document.getElementById('search-status')!.textContent).toContain('/Users/alice/work/src/a.ts');
  });

  test('the Bash heuristic tier can be toggled on', () => {
    send({ command: 'startFileUsage', path: '/Users/alice/work/src/a.ts' });
    send({ command: 'fileUsage', path: '/Users/alice/work/src/a.ts', sessions: [] });

    (document.getElementById('usage-heuristic') as HTMLElement).click();

    expect(lastPosted('findFileUsage')).toMatchObject({
      path: '/Users/alice/work/src/a.ts',
      includeHeuristic: true,
    });
  });

  test('reports a file nothing has touched', () => {
    send({ command: 'startFileUsage', path: '/nope.ts' });
    send({ command: 'fileUsage', path: '/nope.ts', sessions: [] });

    expect(document.querySelector('.search-empty')!.textContent).toContain('/nope.ts');
  });
});

describe('saved searches', () => {
  test('renders a chip per saved search and applies one on click', () => {
    send({
      command: 'savedSearches',
      items: [
        {
          id: 's1',
          name: 'retry logic',
          query: { text: 'retry logic', isRegex: false, caseSensitive: false, scopes: ['prompts'] },
        },
      ],
    });

    const chip = document.querySelector('.saved-search-chip') as HTMLElement;
    expect(chip.textContent).toContain('retry logic');

    chip.click();
    const query = lastPosted('search')!.query as Record<string, unknown>;
    expect(query.text).toBe('retry logic');
    expect(query.scopes).toEqual(['prompts']);
  });

  test('the remove control deletes without applying the search', () => {
    send({
      command: 'savedSearches',
      items: [{ id: 's1', name: 'x', query: { text: 'x', isRegex: false, caseSensitive: false, scopes: ['prompts'] } }],
    });

    (document.querySelector('.saved-search-remove') as HTMLElement).click();

    expect(lastPosted('deleteSavedSearch')).toMatchObject({ id: 's1' });
    expect(posted('search')).toHaveLength(0);
  });
});

describe('timeline', () => {
  test('groups entries under day headings and opens one on click', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: '6', bubbles: true }));
    send({
      command: 'timeline',
      days: [
        {
          date: '2026-09-03',
          entries: [
            {
              projectKey: '-Users-alice-work',
              projectPath: '/Users/alice/work',
              sessionId: 'sess-a',
              title: 'Session search feature',
              messageCount: 12,
              lastTimestamp: '2026-09-03T10:00:00.000Z',
            },
          ],
        },
      ],
    });

    expect(document.querySelectorAll('.timeline-day')).toHaveLength(1);
    expect(document.querySelector('.timeline-title')!.textContent).toBe('Session search feature');

    (document.querySelector('.timeline-entry') as HTMLElement).click();
    expect(lastPosted('loadConversation')).toMatchObject({ sessionId: 'sess-a' });
  });
});
