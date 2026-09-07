import { isCommandMessage } from './claudeReader';
import { ScanTarget, scanLines } from './sessionScanner';
import { TimelineDay, TimelineEntry } from './types';

const TITLE_FALLBACK_CHARS = 120;
/** Harness-injected turns such as <local-command-stdout> make useless titles. */
const HARNESS_WRAPPED_RE = /^<[a-z]+(-[a-z]+)+>/;

interface Accumulator extends TimelineEntry {
  hasCustomTitle: boolean;
  hasAiTitle: boolean;
}

function firstPromptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      return (block as { text?: string }).text;
    }
  }
  return undefined;
}

/**
 * Builds a day-by-day view of sessions, grouped by the day each session was
 * last active. Subagent transcripts are excluded: they share their parent's
 * session and would triple the row count without adding a distinct activity.
 */
export async function buildTimeline(
  targets: ScanTarget[],
  signal: AbortSignal
): Promise<TimelineDay[]> {
  const sessions = targets.filter((t) => !t.agentId);
  const accumulators = new Map<string, Accumulator>();

  await scanLines(
    sessions,
    (raw, _lineNumber, target) => {
      if (raw.indexOf('"type":"') === -1) return;

      let line: {
        type?: string;
        timestamp?: string;
        gitBranch?: string;
        isMeta?: boolean;
        aiTitle?: string;
        customTitle?: string;
        message?: { content?: unknown };
      };
      try {
        line = JSON.parse(raw);
      } catch {
        return;
      }

      let entry = accumulators.get(target.filePath);
      if (!entry) {
        entry = {
          projectKey: target.projectKey,
          projectPath: target.projectPath,
          sessionId: target.sessionId,
          title: '',
          messageCount: 0,
          hasCustomTitle: false,
          hasAiTitle: false,
        };
        accumulators.set(target.filePath, entry);
      }

      if (line.type === 'custom-title' && line.customTitle) {
        entry.title = line.customTitle;
        entry.hasCustomTitle = true;
        return;
      }
      if (line.type === 'ai-title' && line.aiTitle && !entry.hasCustomTitle) {
        entry.title = line.aiTitle;
        entry.hasAiTitle = true;
        return;
      }

      if (line.type !== 'user' && line.type !== 'assistant') return;
      if (line.isMeta) return;

      entry.messageCount++;
      if (line.gitBranch) entry.gitBranch = line.gitBranch;

      if (line.timestamp) {
        if (!entry.firstTimestamp || line.timestamp < entry.firstTimestamp) {
          entry.firstTimestamp = line.timestamp;
        }
        if (!entry.lastTimestamp || line.timestamp > entry.lastTimestamp) {
          entry.lastTimestamp = line.timestamp;
        }
      }

      if (!entry.hasCustomTitle && !entry.hasAiTitle && !entry.title && line.type === 'user') {
        const text = firstPromptText(line.message?.content);
        if (text && !isCommandMessage(text) && !HARNESS_WRAPPED_RE.test(text.trim())) {
          entry.title = text.replace(/\s+/g, ' ').trim().slice(0, TITLE_FALLBACK_CHARS);
        }
      }
    },
    signal
  );

  const byDate = new Map<string, TimelineEntry[]>();
  for (const entry of accumulators.values()) {
    if (!entry.lastTimestamp || entry.messageCount === 0) continue;

    const date = entry.lastTimestamp.slice(0, 10);
    const { hasCustomTitle: _c, hasAiTitle: _a, ...rest } = entry;
    const list = byDate.get(date);
    if (list) {
      list.push(rest);
    } else {
      byDate.set(date, [rest]);
    }
  }

  return Array.from(byDate.entries())
    .map(([date, entries]) => ({
      date,
      entries: entries.sort((a, b) => (b.lastTimestamp ?? '').localeCompare(a.lastTimestamp ?? '')),
    }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
