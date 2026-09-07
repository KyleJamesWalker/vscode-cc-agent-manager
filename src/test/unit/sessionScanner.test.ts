import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listScanTargets, scanLines, ScanTarget } from '../../sessionScanner';

/**
 * Real fixture trees on disk: the scanner's job is directory recursion, which a
 * mocked fs would not actually exercise.
 */
let root: string;

function write(rel: string, lines: string[]): string {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join('\n') + '\n');
  return full;
}

function line(type: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, ...extra });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scanner-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function byPath(targets: ScanTarget[]): Record<string, ScanTarget> {
  const out: Record<string, ScanTarget> = {};
  for (const t of targets) out[path.relative(root, t.filePath)] = t;
  return out;
}

describe('listScanTargets', () => {
  test('finds top-level session files', async () => {
    write('-Users-alice-work/sess-a.jsonl', [line('user')]);

    const targets = await listScanTargets(root);

    expect(targets).toHaveLength(1);
    expect(targets[0].sessionId).toBe('sess-a');
    expect(targets[0].agentId).toBeUndefined();
    expect(targets[0].projectKey).toBe('-Users-alice-work');
    expect(targets[0].projectPath).toBe('/Users/alice/work');
  });

  test('finds flat subagent files and parses agentId', async () => {
    write('-Users-alice-work/sess-a.jsonl', [line('user')]);
    write('-Users-alice-work/sess-a/subagents/agent-abc123.jsonl', [line('user')]);

    const found = byPath(await listScanTargets(root));
    const sub = found['-Users-alice-work/sess-a/subagents/agent-abc123.jsonl'];

    expect(sub).toBeDefined();
    expect(sub.agentId).toBe('abc123');
    expect(sub.sessionId).toBe('sess-a');
  });

  test('finds NESTED workflow subagent files', async () => {
    write('-Users-alice-work/sess-a.jsonl', [line('user')]);
    write('-Users-alice-work/sess-a/subagents/workflows/wf_xyz/agent-nested1.jsonl', [
      line('user'),
    ]);

    const found = byPath(await listScanTargets(root));
    const nested =
      found['-Users-alice-work/sess-a/subagents/workflows/wf_xyz/agent-nested1.jsonl'];

    expect(nested).toBeDefined();
    expect(nested.agentId).toBe('nested1');
    expect(nested.sessionId).toBe('sess-a');
  });

  test('parses agentId from a slugged filename', async () => {
    write('-Users-alice-work/sess-a.jsonl', [line('user')]);
    write('-Users-alice-work/sess-a/subagents/agent-aboard-fixer-39a692d3.jsonl', [
      line('user'),
    ]);

    const found = byPath(await listScanTargets(root));

    expect(
      found['-Users-alice-work/sess-a/subagents/agent-aboard-fixer-39a692d3.jsonl'].agentId
    ).toBe('aboard-fixer-39a692d3');
  });

  test('skips journal.jsonl, non-jsonl files, and memory/', async () => {
    write('-Users-alice-work/sess-a.jsonl', [line('user')]);
    write('-Users-alice-work/sess-a/subagents/workflows/wf_xyz/journal.jsonl', [line('user')]);
    write('-Users-alice-work/sess-a/tool-results/big.txt', ['not jsonl']);
    write('-Users-alice-work/memory/notes.jsonl', [line('user')]);

    const targets = await listScanTargets(root);

    expect(targets.map((t) => path.basename(t.filePath))).toEqual(['sess-a.jsonl']);
  });

  test('orders targets newest-first by mtime', async () => {
    const older = write('-Users-alice-work/old.jsonl', [line('user')]);
    const newer = write('-Users-bob-proj/new.jsonl', [line('user')]);
    fs.utimesSync(older, new Date(1000), new Date(1000));
    fs.utimesSync(newer, new Date(9000), new Date(9000));

    const targets = await listScanTargets(root);

    expect(targets.map((t) => t.sessionId)).toEqual(['new', 'old']);
  });

  test('returns empty array when the root does not exist', async () => {
    expect(await listScanTargets(path.join(root, 'nope'))).toEqual([]);
  });
});

describe('scanLines', () => {
  test('streams every line with its 1-based line number and target', async () => {
    write('-Users-alice-work/sess-a.jsonl', [line('user'), line('assistant')]);
    const targets = await listScanTargets(root);

    const seen: Array<[string, number]> = [];
    await scanLines(
      targets,
      (raw, lineNumber) => {
        seen.push([JSON.parse(raw).type, lineNumber]);
      },
      new AbortController().signal
    );

    expect(seen).toEqual([
      ['user', 1],
      ['assistant', 2],
    ]);
  });

  test('skips blank lines', async () => {
    const full = path.join(root, '-Users-alice-work/sess-a.jsonl');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, line('user') + '\n\n' + line('assistant') + '\n');

    const seen: string[] = [];
    await scanLines(await listScanTargets(root), (raw) => seen.push(raw), new AbortController().signal);

    expect(seen).toHaveLength(2);
  });

  test('handles a 1.4 MB line without truncating it', async () => {
    const huge = line('user', { blob: 'x'.repeat(1_400_000) });
    write('-Users-alice-work/sess-a.jsonl', [huge]);

    let received = '';
    await scanLines(
      await listScanTargets(root),
      (raw) => {
        received = raw;
      },
      new AbortController().signal
    );

    expect(received.length).toBe(huge.length);
    expect(() => JSON.parse(received)).not.toThrow();
  });

  test('stops promptly when the signal aborts', async () => {
    for (let i = 0; i < 20; i++) {
      write(`-Users-alice-work/sess-${i}.jsonl`, [line('user')]);
    }
    const targets = await listScanTargets(root);
    const controller = new AbortController();

    let count = 0;
    await scanLines(
      targets,
      () => {
        count++;
        if (count === 3) controller.abort();
      },
      controller.signal
    );

    expect(count).toBeLessThan(targets.length);
  });

  test('a file deleted mid-scan does not reject the scan', async () => {
    write('-Users-alice-work/sess-a.jsonl', [line('user')]);
    const targets = await listScanTargets(root);
    fs.rmSync(targets[0].filePath);

    await expect(
      scanLines(targets, () => undefined, new AbortController().signal)
    ).resolves.toBeUndefined();
  });
});
