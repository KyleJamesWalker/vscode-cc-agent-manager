import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { decodeDirName } from './claudeReader';

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');

/** Abort is checked this often while walking a single file's lines. */
const ABORT_CHECK_INTERVAL = 2000;

export interface ScanTarget {
  filePath: string;
  projectKey: string;
  projectPath: string;
  sessionId: string;
  /** Set only for subagent files; a subagent reuses its parent's sessionId. */
  agentId?: string;
  mtimeMs: number;
}

async function collectJsonlFiles(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(full, out);
    } else if (entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

/**
 * Classifies a .jsonl path within a project directory. Returns null for files
 * that carry no conversation: workflow journals, memory/, and anything else
 * that is neither a session file nor an `agent-*` subagent file.
 */
function classify(
  filePath: string,
  projectDir: string
): { sessionId: string; agentId?: string } | null {
  const rel = path.relative(projectDir, filePath);
  const parts = rel.split(path.sep);
  const base = parts[parts.length - 1];

  if (parts.length === 1) {
    return { sessionId: base.replace(/\.jsonl$/, '') };
  }

  const subagentsAt = parts.indexOf('subagents');
  if (subagentsAt !== 1 || !base.startsWith('agent-')) return null;

  return {
    sessionId: parts[0],
    agentId: base.replace(/\.jsonl$/, '').replace(/^agent-/, ''),
  };
}

/**
 * Recursive walk of the projects root, newest file first.
 *
 * Unlike the sidebar reader this applies no age cutoff and descends into
 * `subagents/workflows/`, where a large share of subagent transcripts live.
 */
export async function listScanTargets(root: string = DEFAULT_ROOT): Promise<ScanTarget[]> {
  let projectDirs: fs.Dirent[];
  try {
    projectDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const targets: ScanTarget[] = [];

  for (const projectEntry of projectDirs) {
    if (!projectEntry.isDirectory()) continue;

    const projectKey = projectEntry.name;
    const projectDir = path.join(root, projectKey);
    const files: string[] = [];
    await collectJsonlFiles(projectDir, files);

    for (const filePath of files) {
      const classified = classify(filePath, projectDir);
      if (!classified) continue;

      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.promises.stat(filePath)).mtimeMs;
      } catch {
        continue;
      }

      targets.push({
        filePath,
        projectKey,
        projectPath: decodeDirName(projectKey),
        sessionId: classified.sessionId,
        agentId: classified.agentId,
        mtimeMs,
      });
    }
  }

  targets.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return targets;
}

/**
 * Streams each non-empty line of each target to `onLine`, newest file first.
 *
 * Lines are sliced out of the file buffer rather than split into an array, so a
 * 50 MB transcript costs one allocation rather than two, and a single 1.4 MB
 * line (a base64 image in a tool result) survives intact.
 */
export async function scanLines(
  targets: ScanTarget[],
  onLine: (line: string, lineNumber: number, target: ScanTarget) => void,
  signal: AbortSignal
): Promise<void> {
  for (const target of targets) {
    if (signal.aborted) return;

    let content: string;
    try {
      content = await fs.promises.readFile(target.filePath, 'utf-8');
    } catch {
      continue;
    }

    let lineNumber = 0;
    let start = 0;
    while (start <= content.length) {
      let end = content.indexOf('\n', start);
      if (end === -1) end = content.length;

      if (end > start) {
        lineNumber++;
        onLine(content.slice(start, end), lineNumber, target);
        if (lineNumber % ABORT_CHECK_INTERVAL === 0 && signal.aborted) return;
      }

      if (end === content.length) break;
      start = end + 1;
    }

    // Yield so the extension host stays responsive between files.
    await new Promise((resolve) => setImmediate(resolve));
  }
}
