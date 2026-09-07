import { ScanTarget, scanLines } from './sessionScanner';
import { SearchHit, SearchQuery, SearchScope, SearchSummary } from './types';

const SNIPPET_RADIUS = 120;
/** Guards against pathological segments such as a serialised 50 MB tool result. */
const MAX_SEGMENT_CHARS = 200_000;

interface Segment {
  scope: SearchScope;
  text: string;
}

interface RawLine {
  type?: string;
  uuid?: string;
  timestamp?: string;
  gitBranch?: string;
  isMeta?: boolean;
  message?: { role?: string; content?: unknown };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileMatcher(query: SearchQuery): RegExp {
  const source = query.isRegex ? query.text : escapeRegExp(query.text);
  return new RegExp(source, query.caseSensitive ? '' : 'i');
}

/** Whitespace is collapsed up front so snippets stay on one line and offsets stay valid. */
function normalise(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > MAX_SEGMENT_CHARS
    ? collapsed.slice(0, MAX_SEGMENT_CHARS)
    : collapsed;
}

function push(segments: Segment[], scope: SearchScope, text: unknown): void {
  if (typeof text !== 'string' || !text) return;
  const normalised = normalise(text);
  if (normalised) segments.push({ scope, text: normalised });
}

/** Flattens `tool_result` content, keeping text blocks and dropping base64 images. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => (b as { text?: string }).text ?? '')
    .join(' ');
}

function collectSegments(line: RawLine, scopes: SearchScope[]): Segment[] {
  const segments: Segment[] = [];
  const want = (scope: SearchScope) => scopes.includes(scope);
  const content = line.message?.content;

  if (line.type === 'user') {
    if (typeof content === 'string') {
      if (want('prompts')) push(segments, 'prompts', content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        const b = block as { type?: string; text?: string; content?: unknown };
        if (b.type === 'text' && want('prompts')) push(segments, 'prompts', b.text);
        if (b.type === 'tool_result' && want('toolOutput')) {
          push(segments, 'toolOutput', toolResultText(b.content));
        }
      }
    }
    return segments;
  }

  if (line.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as { type?: string; text?: string; thinking?: string; input?: unknown };
      if (b.type === 'text' && want('assistant')) push(segments, 'assistant', b.text);
      if (b.type === 'thinking' && want('thinking')) push(segments, 'thinking', b.thinking);
      if (b.type === 'tool_use' && want('toolInput') && b.input !== undefined) {
        push(segments, 'toolInput', JSON.stringify(b.input));
      }
    }
  }

  return segments;
}

function passesFilters(line: RawLine, target: ScanTarget, query: SearchQuery): boolean {
  if (query.projectKeys?.length && !query.projectKeys.includes(target.projectKey)) return false;
  if (query.sessionIds?.length && !query.sessionIds.includes(target.sessionId)) return false;
  if (query.branches?.length && !query.branches.includes(line.gitBranch ?? '')) return false;

  if (query.after || query.before) {
    const at = line.timestamp ? Date.parse(line.timestamp) : NaN;
    if (Number.isNaN(at)) return false;
    if (query.after && at < Date.parse(query.after)) return false;
    if (query.before && at > Date.parse(query.before)) return false;
  }

  return true;
}

function snippetAround(text: string, index: number, length: number) {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return {
    snippet: prefix + text.slice(start, end) + suffix,
    matchStart: prefix.length + (index - start),
    matchLength: length,
  };
}

/**
 * Parses one raw JSONL line and returns a hit per matching segment.
 *
 * Deliberately does not reuse claudeReader's extractText/extractBlocks: the
 * former keeps only the first text block of an array, the latter drops thinking
 * blocks entirely. Both are correct for their own callers and stay unchanged.
 */
export function extractHits(
  raw: string,
  target: ScanTarget,
  matcher: RegExp,
  query: SearchQuery
): SearchHit[] {
  let line: RawLine;
  try {
    line = JSON.parse(raw) as RawLine;
  } catch {
    return [];
  }

  if (line.type !== 'user' && line.type !== 'assistant') return [];
  if (line.isMeta) return [];
  if (!passesFilters(line, target, query)) return [];

  const hits: SearchHit[] = [];
  for (const segment of collectSegments(line, query.scopes)) {
    const match = matcher.exec(segment.text);
    if (!match) continue;

    hits.push({
      projectKey: target.projectKey,
      projectPath: target.projectPath,
      sessionId: target.sessionId,
      agentId: target.agentId,
      uuid: line.uuid ?? '',
      role: line.type,
      scope: segment.scope,
      timestamp: line.timestamp,
      gitBranch: line.gitBranch,
      ...snippetAround(segment.text, match.index, match[0].length),
    });
  }

  return hits;
}

function readTitle(raw: string): { title: string; custom: boolean } | null {
  try {
    const line = JSON.parse(raw) as { type?: string; aiTitle?: string; customTitle?: string };
    if (line.type === 'custom-title' && line.customTitle) {
      return { title: line.customTitle, custom: true };
    }
    if (line.type === 'ai-title' && line.aiTitle) {
      return { title: line.aiTitle, custom: false };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Streams matches over the given targets, flushing a batch per file so results
 * appear while the scan is still running.
 */
export async function runSearch(
  query: SearchQuery,
  targets: ScanTarget[],
  onBatch: (hits: SearchHit[], filesScanned: number, filesTotal: number) => void,
  signal: AbortSignal
): Promise<SearchSummary> {
  const started = Date.now();
  const matcher = compileMatcher(query);
  const scoped = query.projectKeys?.length
    ? targets.filter((t) => query.projectKeys!.includes(t.projectKey))
    : targets;

  const titles: Record<string, string> = {};
  const customTitled = new Set<string>();
  let pending: SearchHit[] = [];
  let totalHits = 0;
  let filesScanned = 0;
  let currentFile: string | null = null;

  const flush = () => {
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    onBatch(batch, filesScanned, scoped.length);
  };

  await scanLines(
    scoped,
    (raw, _lineNumber, target) => {
      if (currentFile !== target.filePath) {
        flush();
        if (currentFile !== null) filesScanned++;
        currentFile = target.filePath;
      }

      if (raw.indexOf('-title"') !== -1) {
        const title = readTitle(raw);
        if (title && (title.custom || !customTitled.has(target.sessionId))) {
          titles[target.sessionId] = title.title;
          if (title.custom) customTitled.add(target.sessionId);
        }
      }

      // Cheap prefilter: a regex test over the raw line, before any JSON parsing.
      if (!matcher.test(raw)) return;

      const hits = extractHits(raw, target, matcher, query);
      if (hits.length) {
        totalHits += hits.length;
        pending.push(...hits);
      }
    },
    signal
  );

  if (currentFile !== null) filesScanned++;
  flush();

  return {
    totalHits,
    filesScanned,
    durationMs: Date.now() - started,
    aborted: signal.aborted,
    titles,
  };
}
