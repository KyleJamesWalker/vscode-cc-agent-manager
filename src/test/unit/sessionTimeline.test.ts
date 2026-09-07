import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { listScanTargets } from '../../sessionScanner';
import { buildTimeline } from '../../sessionTimeline';

let root: string;

function write(rel: string, lines: string[]): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, lines.join('\n') + '\n');
}

function userLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'user',
    uuid: 'u',
    timestamp,
    gitBranch: 'main',
    message: { role: 'user', content: text },
  });
}

async function build() {
  return buildTimeline(await listScanTargets(root), new AbortController().signal);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'timeline-test-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('buildTimeline', () => {
  test('groups sessions by the day of their last activity, newest first', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      userLine('first', '2026-09-01T10:00:00.000Z'),
      userLine('last', '2026-09-01T12:00:00.000Z'),
    ]);
    write('-Users-bob-proj/sess-b.jsonl', [userLine('other', '2026-09-03T09:00:00.000Z')]);

    const days = await build();

    expect(days.map((d) => d.date)).toEqual(['2026-09-03', '2026-09-01']);
    expect(days[1].entries[0].sessionId).toBe('sess-a');
  });

  test('records first and last timestamps and a message count', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      userLine('one', '2026-09-01T10:00:00.000Z'),
      userLine('two', '2026-09-01T11:00:00.000Z'),
      userLine('three', '2026-09-01T12:00:00.000Z'),
    ]);

    const entry = (await build())[0].entries[0];

    expect(entry.firstTimestamp).toBe('2026-09-01T10:00:00.000Z');
    expect(entry.lastTimestamp).toBe('2026-09-01T12:00:00.000Z');
    expect(entry.messageCount).toBe(3);
    expect(entry.gitBranch).toBe('main');
    expect(entry.projectPath).toBe('/Users/alice/work');
  });

  test('prefers a custom title, then an ai title, then the first prompt', async () => {
    write('-Users-a-p/only-prompt.jsonl', [userLine('do the thing', '2026-09-01T10:00:00.000Z')]);
    write('-Users-b-p/ai.jsonl', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI title' }),
      userLine('do the thing', '2026-09-02T10:00:00.000Z'),
    ]);
    write('-Users-c-p/custom.jsonl', [
      JSON.stringify({ type: 'ai-title', aiTitle: 'AI title' }),
      JSON.stringify({ type: 'custom-title', customTitle: 'Custom title' }),
      userLine('do the thing', '2026-09-03T10:00:00.000Z'),
    ]);

    const titles: Record<string, string> = {};
    for (const day of await build()) {
      for (const entry of day.entries) titles[entry.sessionId] = entry.title;
    }

    expect(titles['custom']).toBe('Custom title');
    expect(titles['ai']).toBe('AI title');
    expect(titles['only-prompt']).toBe('do the thing');
  });

  test('does not fall back to a slash-command prompt for the title', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      userLine('<command-name>/clear</command-name> <command-message>clear</command-message>', '2026-09-01T10:00:00.000Z'),
      userLine('the real first prompt', '2026-09-01T10:01:00.000Z'),
    ]);

    expect((await build())[0].entries[0].title).toBe('the real first prompt');
  });

  test('skips harness-generated tag-wrapped prompts when picking a title', async () => {
    write('-Users-alice-work/sess-a.jsonl', [
      userLine('<local-command-stdout>Set model to Opus</local-command-stdout>', '2026-09-01T10:00:00.000Z'),
      userLine('a genuine prompt', '2026-09-01T10:01:00.000Z'),
    ]);

    expect((await build())[0].entries[0].title).toBe('a genuine prompt');
  });

  test('excludes subagent files, which would otherwise flood the view', async () => {
    write('-Users-alice-work/sess-a.jsonl', [userLine('main', '2026-09-01T10:00:00.000Z')]);
    write('-Users-alice-work/sess-a/subagents/agent-x.jsonl', [
      userLine('sub', '2026-09-01T10:30:00.000Z'),
    ]);

    const days = await build();

    expect(days).toHaveLength(1);
    expect(days[0].entries).toHaveLength(1);
    expect(days[0].entries[0].agentId).toBeUndefined();
  });

  test('skips sessions with no timestamped messages', async () => {
    write('-Users-alice-work/empty.jsonl', [JSON.stringify({ type: 'system', subtype: 'x' })]);

    expect(await build()).toEqual([]);
  });

  test('honours the abort signal', async () => {
    for (let i = 0; i < 20; i++) {
      write(`-Users-alice-work/sess-${i}.jsonl`, [userLine('x', '2026-09-01T10:00:00.000Z')]);
    }
    const controller = new AbortController();
    controller.abort();

    expect(await buildTimeline(await listScanTargets(root), controller.signal)).toEqual([]);
  });
});
