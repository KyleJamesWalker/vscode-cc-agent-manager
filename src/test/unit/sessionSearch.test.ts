import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listScanTargets, ScanTarget } from '../../sessionScanner';
import { compileMatcher, extractHits, runSearch } from '../../sessionSearch';
import { SearchQuery } from '../../types';

const TARGET: ScanTarget = {
  filePath: '/root/-Users-alice-work/sess-a.jsonl',
  projectKey: '-Users-alice-work',
  projectPath: '/Users/alice/work',
  sessionId: 'sess-a',
  mtimeMs: 0,
};

function query(partial: Partial<SearchQuery> = {}): SearchQuery {
  return {
    text: 'needle',
    isRegex: false,
    caseSensitive: false,
    scopes: ['prompts', 'assistant'],
    ...partial,
  };
}

function userLine(content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-09-01T10:00:00.000Z',
    gitBranch: 'main',
    message: { role: 'user', content },
    ...extra,
  });
}

function assistantLine(content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-01T10:01:00.000Z',
    gitBranch: 'main',
    message: { role: 'assistant', content },
    ...extra,
  });
}

function hits(raw: string, q: SearchQuery = query()) {
  return extractHits(raw, TARGET, compileMatcher(q), q);
}

describe('compileMatcher', () => {
  test('treats the query as a literal by default', () => {
    expect(compileMatcher(query({ text: 'a.c' })).test('abc')).toBe(false);
    expect(compileMatcher(query({ text: 'a.c' })).test('a.c')).toBe(true);
  });

  test('honours regex syntax when the toggle is on', () => {
    expect(compileMatcher(query({ text: 'a.c', isRegex: true })).test('abc')).toBe(true);
  });

  test('is case-insensitive by default and case-sensitive on request', () => {
    expect(compileMatcher(query({ text: 'Needle' })).test('needle')).toBe(true);
    expect(compileMatcher(query({ text: 'Needle', caseSensitive: true })).test('needle')).toBe(
      false
    );
  });

  test('throws a readable error on invalid regex', () => {
    expect(() => compileMatcher(query({ text: '([', isRegex: true }))).toThrow();
  });
});

describe('extractHits — scopes', () => {
  test('matches a plain string user prompt', () => {
    const result = hits(userLine('please find the needle here'));

    expect(result).toHaveLength(1);
    expect(result[0].scope).toBe('prompts');
    expect(result[0].role).toBe('user');
    expect(result[0].uuid).toBe('u1');
    expect(result[0].gitBranch).toBe('main');
    expect(result[0].sessionId).toBe('sess-a');
  });

  test('matches text blocks in an array user prompt', () => {
    const result = hits(userLine([{ type: 'text', text: 'the needle' }]));
    expect(result).toHaveLength(1);
  });

  test('searches EVERY assistant text block, not just the first', () => {
    const result = hits(
      assistantLine([
        { type: 'text', text: 'nothing here' },
        { type: 'text', text: 'the needle is in block two' },
      ])
    );

    expect(result).toHaveLength(1);
    expect(result[0].snippet).toContain('block two');
  });

  test('finds thinking blocks only when that scope is enabled', () => {
    const line = assistantLine([{ type: 'thinking', thinking: 'the needle in thought' }]);

    expect(hits(line)).toHaveLength(0);
    expect(hits(line, query({ scopes: ['thinking'] }))).toHaveLength(1);
  });

  test('finds tool input only when that scope is enabled', () => {
    const line = assistantLine([
      { type: 'tool_use', name: 'Bash', input: { command: 'grep needle .' } },
    ]);

    expect(hits(line)).toHaveLength(0);
    expect(hits(line, query({ scopes: ['toolInput'] }))).toHaveLength(1);
  });

  test('finds tool output only when that scope is enabled', () => {
    const line = userLine([
      { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'found needle' }] },
    ]);

    expect(hits(line)).toHaveLength(0);
    expect(hits(line, query({ scopes: ['toolOutput'] }))).toHaveLength(1);
  });
});

describe('extractHits — lines that must be ignored', () => {
  test.each([
    ['attachment', JSON.stringify({ type: 'attachment', attachment: { text: 'needle' } })],
    ['system', JSON.stringify({ type: 'system', subtype: 'turn_duration', content: 'needle' })],
    ['ai-title', JSON.stringify({ type: 'ai-title', aiTitle: 'needle' })],
    ['queue-operation', JSON.stringify({ type: 'queue-operation', data: 'needle' })],
  ])('ignores %s lines', (_name, raw) => {
    expect(hits(raw)).toHaveLength(0);
  });

  test('ignores isMeta messages', () => {
    expect(hits(userLine('a needle', { isMeta: true }))).toHaveLength(0);
  });

  test('ignores unparsable lines rather than throwing', () => {
    expect(hits('{not json needle')).toHaveLength(0);
  });
});

describe('extractHits — snippets', () => {
  test('reports the match offset within the snippet', () => {
    const result = hits(userLine('xx needle yy'));

    expect(result[0].snippet.slice(result[0].matchStart, result[0].matchStart + result[0].matchLength)).toBe(
      'needle'
    );
    expect(result[0].matchLength).toBe(6);
  });

  test('trims a long segment around the match', () => {
    const result = hits(userLine('a'.repeat(5000) + ' needle ' + 'b'.repeat(5000)));

    expect(result[0].snippet.length).toBeLessThan(400);
    expect(result[0].snippet).toContain('needle');
  });

  test('never leaks base64 image payloads into a snippet', () => {
    const raw = userLine(
      [
        {
          type: 'tool_result',
          tool_use_id: 't1',
          content: [
            { type: 'text', text: 'needle nearby' },
            { type: 'image', source: { type: 'base64', data: 'AAAA'.repeat(50_000) } },
          ],
        },
      ]
    );

    const result = hits(raw, query({ scopes: ['toolOutput'] }));

    expect(result).toHaveLength(1);
    expect(result[0].snippet).not.toContain('AAAAAAAA');
  });

  test('collapses newlines so a snippet stays one line', () => {
    const result = hits(userLine('before\n\nneedle\n\nafter'));
    expect(result[0].snippet).not.toContain('\n');
  });
});

describe('runSearch', () => {
  let root: string;

  function write(rel: string, lines: string[]): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, lines.join('\n') + '\n');
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-test-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function collect(q: SearchQuery) {
    const targets = await listScanTargets(root);
    const all: unknown[] = [];
    const summary = await runSearch(
      q,
      targets,
      (batch) => all.push(...batch),
      new AbortController().signal
    );
    return { all, summary };
  }

  test('finds hits across projects and subagent files', async () => {
    write('-Users-alice-work/sess-a.jsonl', [userLine('the needle')]);
    write('-Users-alice-work/sess-a/subagents/workflows/wf_1/agent-x.jsonl', [
      userLine('another needle'),
    ]);
    write('-Users-bob-proj/sess-b.jsonl', [userLine('unrelated')]);

    const { all, summary } = await collect(query());

    expect(all).toHaveLength(2);
    expect(summary.totalHits).toBe(2);
  });

  test('does not apply an age cutoff', async () => {
    const old = path.join(root, '-Users-alice-work/ancient.jsonl');
    write('-Users-alice-work/ancient.jsonl', [
      userLine('the needle', { timestamp: '2020-01-01T00:00:00.000Z' }),
    ]);
    const longAgo = new Date(Date.now() - 400 * 24 * 3600 * 1000);
    fs.utimesSync(old, longAgo, longAgo);

    const { all } = await collect(query());

    expect(all).toHaveLength(1);
  });

  test('filters by project, branch, and date range', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      userLine('needle one', { gitBranch: 'main', timestamp: '2026-01-01T00:00:00.000Z' }),
    ]);
    write('-Users-bob-proj/sess-b.jsonl', [
      userLine('needle two', { gitBranch: 'feat/x', timestamp: '2026-06-01T00:00:00.000Z' }),
    ]);

    expect((await collect(query({ projectKeys: ['-Users-bob-proj'] }))).all).toHaveLength(1);
    expect((await collect(query({ branches: ['main'] }))).all).toHaveLength(1);
    expect((await collect(query({ after: '2026-03-01T00:00:00.000Z' }))).all).toHaveLength(1);
    expect((await collect(query({ before: '2026-03-01T00:00:00.000Z' }))).all).toHaveLength(1);
  });

  test('filters by sessionIds, which backs tag filtering', async () => {
    write('-Users-alice-work/sess-a.jsonl', [userLine('needle one')]);
    write('-Users-alice-work/sess-b.jsonl', [userLine('needle two')]);

    const { all } = await collect(query({ sessionIds: ['sess-b'] }));

    expect(all).toHaveLength(1);
  });

  test('resolves session titles, preferring custom over ai titles', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'Generated title' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'My title' }),
      userLine('the needle'),
    ]);

    const { summary } = await collect(query());

    expect(summary.titles['sess-a']).toBe('My title');
  });

  test('stops early when aborted and reports the truncation', async () => {
    for (let i = 0; i < 30; i++) {
      write(`-Users-alice-work/sess-${i}.jsonl`, [userLine('the needle')]);
    }
    const targets = await listScanTargets(root);
    const controller = new AbortController();
    const seen: unknown[] = [];

    const summary = await runSearch(
      query(),
      targets,
      (batch) => {
        seen.push(...batch);
        controller.abort();
      },
      controller.signal
    );

    expect(seen.length).toBeLessThan(30);
    expect(summary.aborted).toBe(true);
  });
});
