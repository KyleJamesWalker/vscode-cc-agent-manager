import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findFileUsage } from '../../fileUsageIndex';
import { listScanTargets } from '../../sessionScanner';

/**
 * Real fixture trees on disk: the reverse lookup runs over the scanner's own
 * targets, so subagent attribution only gets exercised by a real directory tree.
 */
let root: string;

const TARGET_PATH = '/Users/alice/work/src/a/b.ts';

function write(rel: string, lines: string[]): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join('\n') + '\n');
}

function assistantLine(content: unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-09-01T10:00:00.000Z',
    gitBranch: 'main',
    message: { role: 'assistant', content },
    ...extra,
  });
}

function toolUse(name: string, input: unknown, extra: Record<string, unknown> = {}): string {
  return assistantLine([{ type: 'tool_use', id: 't1', name, input }], extra);
}

function userLine(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-09-01T10:01:00.000Z',
    gitBranch: 'main',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
    ...extra,
  });
}

async function usage(options?: { includeHeuristic?: boolean }) {
  return findFileUsage(TARGET_PATH, await listScanTargets(root), new AbortController().signal, options);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-usage-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('modified tier', () => {
  test('picks up file-history-delta trackingPath', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      JSON.stringify({ type: 'file-history-delta', trackingPath: TARGET_PATH }),
    ]);

    const entries = await usage();

    expect(entries).toHaveLength(1);
    expect(entries[0].tier).toBe('modified');
    expect(entries[0].sessionId).toBe('sess-a');
    expect(entries[0].projectKey).toBe('-Users-alice-work');
    expect(entries[0].projectPath).toBe('/Users/alice/work');
  });

  test('picks up file-history-snapshot trackedFileBackups keys', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      JSON.stringify({
        type: 'file-history-snapshot',
        snapshot: { trackedFileBackups: { [TARGET_PATH]: 'backup-1', '/other/x.ts': 'backup-2' } },
      }),
    ]);

    const entries = await usage();

    expect(entries.map((e) => e.tier)).toEqual(['modified']);
  });

  test('tolerates an empty trackedFileBackups map', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      JSON.stringify({ type: 'file-history-snapshot', snapshot: { trackedFileBackups: {} } }),
      JSON.stringify({ type: 'file-history-delta', trackingPath: TARGET_PATH }),
    ]);

    expect(await usage()).toHaveLength(1);
  });

  test('treats Edit and Write as modifications', async () => {
    write('-Users-alice-work/sess-edit.jsonl', [toolUse('Edit', { file_path: TARGET_PATH })]);
    write('-Users-alice-work/sess-write.jsonl', [toolUse('Write', { file_path: TARGET_PATH })]);

    const entries = await usage();

    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.tier === 'modified')).toBe(true);
  });
});

describe('read tier', () => {
  test('picks up Read tool_use input.file_path', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('Read', { file_path: TARGET_PATH })]);

    const entries = await usage();

    expect(entries).toHaveLength(1);
    expect(entries[0].tier).toBe('read');
    expect(entries[0].timestamp).toBe('2026-09-01T10:00:00.000Z');
    expect(entries[0].gitBranch).toBe('main');
  });

  test('picks up EnterWorktree input.path', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('EnterWorktree', { path: TARGET_PATH })]);

    expect((await usage()).map((e) => e.tier)).toEqual(['read']);
  });

  test('picks up toolUseResult.filePath on a user line', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      userLine({ toolUseResult: { type: 'text', filePath: TARGET_PATH } }),
    ]);

    expect((await usage()).map((e) => e.tier)).toEqual(['read']);
  });

  test('ignores an unrelated tool with a file_path input', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('SomeOtherTool', { file_path: TARGET_PATH })]);

    expect(await usage()).toEqual([]);
  });
});

describe('mentioned tier', () => {
  test('is excluded by default', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      toolUse('Bash', { command: `cat ${TARGET_PATH}` }),
    ]);

    expect(await usage()).toEqual([]);
  });

  test('is included when includeHeuristic is on', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      toolUse('Bash', { command: `cat ${TARGET_PATH}` }),
    ]);

    expect((await usage({ includeHeuristic: true })).map((e) => e.tier)).toEqual(['mentioned']);
  });

  test('matches a quoted path inside a longer command', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      toolUse('Bash', { command: `grep -n foo "${TARGET_PATH}" | head -5` }),
    ]);

    expect((await usage({ includeHeuristic: true })).map((e) => e.tier)).toEqual(['mentioned']);
  });
});

describe('path matching', () => {
  test('does not match a path that merely has the query as a prefix', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      toolUse('Read', { file_path: `${TARGET_PATH}.bak` }),
      toolUse('Bash', { command: `cat ${TARGET_PATH}.bak` }),
      JSON.stringify({ type: 'file-history-delta', trackingPath: `${TARGET_PATH}.bak` }),
    ]);

    expect(await usage({ includeHeuristic: true })).toEqual([]);
  });

  test('ignores a trailing slash on the query path', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('Read', { file_path: TARGET_PATH })]);

    const entries = await findFileUsage(
      `${TARGET_PATH}/`,
      await listScanTargets(root),
      new AbortController().signal
    );

    expect(entries).toHaveLength(1);
  });

  test('returns nothing for an empty path', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('Read', { file_path: TARGET_PATH })]);

    expect(
      await findFileUsage('', await listScanTargets(root), new AbortController().signal)
    ).toEqual([]);
  });
});

describe('aggregation', () => {
  test('keeps the strongest tier when a session both reads and edits a file', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      toolUse('Read', { file_path: TARGET_PATH }),
      toolUse('Edit', { file_path: TARGET_PATH }, { uuid: 'a2' }),
    ]);

    const entries = await usage();

    expect(entries).toHaveLength(1);
    expect(entries[0].tier).toBe('modified');
    expect(entries[0].occurrences).toBe(2);
  });

  test('counts distinct messages, not blocks', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      assistantLine([
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: TARGET_PATH } },
        { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: TARGET_PATH } },
      ]),
    ]);

    expect((await usage())[0].occurrences).toBe(1);
  });

  test('attributes a subagent file to its agentId, separately from the parent', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('Read', { file_path: TARGET_PATH })]);
    write('-Users-alice-work/sess-a/subagents/agent-explore-1.jsonl', [
      toolUse('Edit', { file_path: TARGET_PATH }),
    ]);

    const entries = await usage();

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => [e.agentId, e.tier])).toEqual([
      ['explore-1', 'modified'],
      [undefined, 'read'],
    ]);
    expect(entries.every((e) => e.sessionId === 'sess-a')).toBe(true);
  });

  test('sorts strongest tier first, then most recent timestamp first', async () => {
    write('-Users-alice-work/read-old.jsonl', [
      toolUse('Read', { file_path: TARGET_PATH }, { timestamp: '2026-08-01T00:00:00.000Z' }),
    ]);
    write('-Users-alice-work/read-new.jsonl', [
      toolUse('Read', { file_path: TARGET_PATH }, { timestamp: '2026-09-05T00:00:00.000Z' }),
    ]);
    write('-Users-alice-work/edited.jsonl', [
      toolUse('Edit', { file_path: TARGET_PATH }, { timestamp: '2026-07-01T00:00:00.000Z' }),
    ]);
    write('-Users-alice-work/mentioned.jsonl', [
      toolUse('Bash', { command: `cat ${TARGET_PATH}` }, { timestamp: '2026-09-06T00:00:00.000Z' }),
    ]);

    const entries = await usage({ includeHeuristic: true });

    expect(entries.map((e) => e.sessionId)).toEqual([
      'edited',
      'read-new',
      'read-old',
      'mentioned',
    ]);
  });

  test('reports the most recent timestamp that touched the path', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      toolUse('Read', { file_path: TARGET_PATH }, { timestamp: '2026-08-01T00:00:00.000Z' }),
      toolUse('Read', { file_path: TARGET_PATH }, { uuid: 'a2', timestamp: '2026-09-01T00:00:00.000Z' }),
    ]);

    expect((await usage())[0].timestamp).toBe('2026-09-01T00:00:00.000Z');
  });
});

describe('robustness', () => {
  test('ignores unparsable lines and lines missing fields', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      `{ broken json ${TARGET_PATH}`,
      JSON.stringify({ type: 'file-history-delta' }),
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'assistant', message: { content: 'a string' } }),
      JSON.stringify({ type: 'user', toolUseResult: 'plain text' }),
      toolUse('Read', { file_path: TARGET_PATH }),
    ]);

    expect(await usage()).toHaveLength(1);
  });

  test('does not throw when a target file has been deleted', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('Read', { file_path: TARGET_PATH })]);
    const targets = await listScanTargets(root);
    fs.rmSync(targets[0].filePath);

    await expect(
      findFileUsage(TARGET_PATH, targets, new AbortController().signal)
    ).resolves.toEqual([]);
  });

  test('returns nothing when the signal is already aborted', async () => {
    write('-Users-alice-work/sess-a.jsonl', [toolUse('Read', { file_path: TARGET_PATH })]);
    const controller = new AbortController();
    controller.abort();

    expect(await findFileUsage(TARGET_PATH, await listScanTargets(root), controller.signal)).toEqual(
      []
    );
  });

  test('stops early when the signal aborts mid-scan', async () => {
    for (let i = 0; i < 30; i++) {
      write(`-Users-alice-work/sess-${i}.jsonl`, [toolUse('Read', { file_path: TARGET_PATH })]);
    }
    const targets = await listScanTargets(root);
    const controller = new AbortController();

    const pending = findFileUsage(TARGET_PATH, targets, controller.signal);
    setImmediate(() => controller.abort());

    expect((await pending).length).toBeLessThan(targets.length);
  });
});
