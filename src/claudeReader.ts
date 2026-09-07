import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ClaudeProject, ClaudeSession, SubAgent, ConversationMessage, MessageBlock, SessionStatus } from './types';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const MAX_SESSION_AGE_DAYS = 30;

interface ContentItem {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}

interface RawMessage {
  type: string;
  uuid?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: {
    content?: string | ContentItem[];
  };
  agentId?: string;
  slug?: string;
  isMeta?: boolean;
}

function extractText(msg: RawMessage): string | undefined {
  const content = msg.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text' && item.text) return item.text;
    }
  }
  return undefined;
}

function parseJsonlFile(filePath: string): RawMessage[] {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const messages: RawMessage[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch {
        // skip malformed lines
      }
    }
    return messages;
  } catch {
    return [];
  }
}

export function isCommandMessage(text: string): boolean {
  return (
    text.includes('<command-name>') ||
    text.includes('<command-message>') ||
    text.startsWith('/')
  );
}

const QUESTION_MARK_RE = /[?？؟]\s*$/;

function deriveStatus(
  lastMessageRole: string | undefined,
  lastContentBlockType: string | undefined,
  lastContentBlockText: string | undefined
): SessionStatus {
  if (!lastMessageRole) return 'idle';
  if (lastMessageRole === 'user') return 'active';
  // lastMessageRole === 'assistant'
  if (lastContentBlockType === 'tool_use') return 'thinking';
  // text block ending with a question mark → genuinely waiting for user input
  if (lastContentBlockType === 'text' && lastContentBlockText && QUESTION_MARK_RE.test(lastContentBlockText)) {
    return 'waiting';
  }
  // text block without question mark → likely mid-stream before next tool_use
  return 'thinking';
}
// Note: 'recent' is not returned here — it is a time-based overlay applied in the
// webview's statusClass() function and does not come from the parsed message content.

function getLastContentBlock(msg: { type: string; message?: { content?: unknown } }): { type?: string; text?: string } | undefined {
  if (msg.type !== 'assistant') return undefined;
  const content = msg.message?.content;
  if (Array.isArray(content) && content.length > 0) {
    return content[content.length - 1] as { type?: string; text?: string };
  }
  return undefined;
}

function countLines(text: string | undefined): number {
  if (!text) return 0;
  return text.split('\n').length;
}

function countContentLines(content: string | ContentItem[] | undefined): number {
  if (typeof content === 'string') return countLines(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const item of content) {
    if (item.type === 'text' && item.text) total += countLines(item.text);
  }
  return total;
}

function countContentChars(content: string | ContentItem[] | undefined): number {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const item of content) {
    if (item.type === 'text' && item.text) total += item.text.length;
  }
  return total;
}

function countCodeLines(content: ContentItem[] | undefined): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const item of content) {
    if (item.type === 'tool_use' && item.input) {
      if (item.name === 'Write' || item.name === 'Edit') {
        const c = item.input.content ?? item.input.new_string;
        if (typeof c === 'string') total += countLines(c);
      }
    }
  }
  return total;
}

function parseSubAgent(agentFilePath: string): SubAgent | null {
  const messages = parseJsonlFile(agentFilePath);
  if (messages.length === 0) return null;

  const agentId = path.basename(agentFilePath, '.jsonl').replace('agent-', '');
  let slug: string | undefined;
  let firstPrompt: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let messageCount = 0;
  let lastMessageRole: string | undefined;
  let lastContentBlockType: string | undefined;
  let lastContentBlockText: string | undefined;
  const toolCounts: Record<string, number> = {};
  let userChars = 0;
  let assistantLines = 0;
  let codeLines = 0;

  for (const msg of messages) {
    if (msg.timestamp) {
      if (!firstTimestamp) firstTimestamp = msg.timestamp;
      lastTimestamp = msg.timestamp;
    }
    if (msg.slug && !slug) slug = msg.slug;

    if (msg.type === 'user' && !msg.isMeta && !firstPrompt) {
      const text = extractText(msg);
      if (text && text.length > 10 && !isCommandMessage(text)) {
        firstPrompt = text.substring(0, 200);
      }
    }

    if (msg.type === 'user' || msg.type === 'assistant') {
      messageCount++;
      lastMessageRole = msg.type;
      const lastBlock = getLastContentBlock(msg);
      lastContentBlockType = lastBlock?.type;
      lastContentBlockText = lastBlock?.text;
    }

    if (msg.type === 'user' && !msg.isMeta) {
      userChars += countContentChars(msg.message?.content);
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      assistantLines += countContentLines(msg.message?.content);
      codeLines += countCodeLines(msg.message?.content as ContentItem[]);
      for (const item of msg.message!.content as ContentItem[]) {
        if (item.type === 'tool_use' && item.name) {
          toolCounts[item.name] = (toolCounts[item.name] || 0) + 1;
        }
      }
    }
  }

  return {
    agentId, slug, firstPrompt, firstTimestamp, lastTimestamp, messageCount,
    lastMessageRole,
    status: deriveStatus(lastMessageRole, lastContentBlockType, lastContentBlockText),
    toolCounts, userChars, assistantLines, codeLines,
  };
}

function parseSession(
  sessionFilePath: string,
  sessionId: string
): ClaudeSession | null {
  const messages = parseJsonlFile(sessionFilePath);
  if (messages.length === 0) return null;

  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let firstPrompt: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;
  let messageCount = 0;
  let lastMessageRole: string | undefined;
  let lastContentBlockType: string | undefined;
  let lastContentBlockText: string | undefined;
  const toolCounts: Record<string, number> = {};
  let userChars = 0;
  let assistantLines = 0;
  let codeLines = 0;

  for (const msg of messages) {
    if (msg.timestamp) {
      if (!firstTimestamp) firstTimestamp = msg.timestamp;
      lastTimestamp = msg.timestamp;
    }
    if (msg.cwd && !cwd) cwd = msg.cwd;
    if (msg.gitBranch && !gitBranch) gitBranch = msg.gitBranch;

    if (msg.type === 'user' && !msg.isMeta && !firstPrompt) {
      const text = extractText(msg);
      if (text && text.length > 10 && !isCommandMessage(text)) {
        firstPrompt = text.substring(0, 300);
      }
    }

    if (msg.type === 'user' || msg.type === 'assistant') {
      messageCount++;
      lastMessageRole = msg.type;
      const lastBlock = getLastContentBlock(msg);
      lastContentBlockType = lastBlock?.type;
      lastContentBlockText = lastBlock?.text;
    }

    if (msg.type === 'user' && !msg.isMeta) {
      userChars += countContentChars(msg.message?.content);
    }

    if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
      assistantLines += countContentLines(msg.message?.content);
      codeLines += countCodeLines(msg.message?.content as ContentItem[]);
      for (const item of msg.message!.content as ContentItem[]) {
        if (item.type === 'tool_use' && item.name) {
          toolCounts[item.name] = (toolCounts[item.name] || 0) + 1;
        }
      }
    }
  }

  if (lastTimestamp) {
    const ageDays =
      (Date.now() - new Date(lastTimestamp).getTime()) / 86400000;
    if (ageDays > MAX_SESSION_AGE_DAYS) return null;
  }

  const subAgents: SubAgent[] = [];
  const sessionDir = sessionFilePath.replace(/\.jsonl$/, '');
  const subagentsDir = path.join(sessionDir, 'subagents');

  if (fs.existsSync(subagentsDir)) {
    try {
      for (const file of fs.readdirSync(subagentsDir)) {
        if (file.endsWith('.jsonl')) {
          const agent = parseSubAgent(path.join(subagentsDir, file));
          if (agent) subAgents.push(agent);
        }
      }
    } catch {
      // ignore read errors
    }
  }

  return {
    sessionId,
    cwd,
    gitBranch,
    firstPrompt,
    firstTimestamp,
    lastTimestamp,
    messageCount,
    subAgents,
    lastMessageRole,
    status: deriveStatus(lastMessageRole, lastContentBlockType, lastContentBlockText),
    toolCounts, userChars, assistantLines, codeLines,
  };
}

function stripJsonc(text: string): string {
  return text
    .replace(/\/\/[^\n]*/g, '')        // single-line comments
    .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments
    .replace(/,(\s*[}\]])/g, '$1');    // trailing commas
}

const peacockColorCache = new Map<string, string | undefined>();

function readPeacockColor(projectPath: string): string | undefined {
  if (peacockColorCache.has(projectPath)) return peacockColorCache.get(projectPath);
  let color: string | undefined;
  try {
    const settingsPath = path.join(projectPath, '.vscode', 'settings.json');
    if (!fs.existsSync(settingsPath)) return undefined;
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(stripJsonc(content));
    const raw = settings['peacock.color'];
    color = typeof raw === 'string' ? raw : undefined;
  } catch {
    color = undefined;
  }
  peacockColorCache.set(projectPath, color);
  return color;
}

export function readClaudeProjects(): ClaudeProject[] {
  if (!fs.existsSync(PROJECTS_DIR)) return [];

  const projects: ClaudeProject[] = [];

  let projectDirs: string[];
  try {
    projectDirs = fs
      .readdirSync(PROJECTS_DIR)
      .filter((d) =>
        fs.statSync(path.join(PROJECTS_DIR, d)).isDirectory()
      );
  } catch {
    return [];
  }

  for (const dirName of projectDirs) {
    const projectPath = path.join(PROJECTS_DIR, dirName);
    const sessions: ClaudeSession[] = [];
    let projectCwd: string | undefined;

    try {
      const jsonlFiles = fs
        .readdirSync(projectPath)
        .filter((f) => f.endsWith('.jsonl'));

      for (const file of jsonlFiles) {
        const sessionId = file.replace(/\.jsonl$/, '');
        const session = parseSession(
          path.join(projectPath, file),
          sessionId
        );
        if (session) {
          sessions.push(session);
          if (!projectCwd && session.cwd) projectCwd = session.cwd;
        }
      }
    } catch {
      continue;
    }

    if (sessions.length === 0) continue;

    sessions.sort((a, b) => {
      const at = a.lastTimestamp ? new Date(a.lastTimestamp).getTime() : 0;
      const bt = b.lastTimestamp ? new Date(b.lastTimestamp).getTime() : 0;
      return bt - at;
    });

    const actualPath = projectCwd ?? decodeDirName(dirName);
    const displayName = path.basename(actualPath);
    const lastActivity = sessions[0]?.lastTimestamp;
    const peacockColor = readPeacockColor(actualPath);

    projects.push({
      key: dirName,
      path: actualPath,
      displayName,
      sessions,
      lastActivity,
      peacockColor,
    });
  }

  projects.sort((a, b) => {
    const at = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
    const bt = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
    return bt - at;
  });

  return projects;
}

export function decodeDirName(dirName: string): string {
  // Best-effort: leading - is /, each remaining - is /
  return '/' + dirName.replace(/^-/, '').replaceAll('-', '/');
}

/** Safely coerce an unknown value to string */
function str(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

function fileBasename(input: Record<string, unknown>): string {
  const fp = str(input.file_path || input.notebook_path);
  return fp ? path.basename(fp) : '';
}

function countOutputLines(output?: string): number {
  if (!output) return 0;
  return output.trim().split('\n').filter((l) => l.trim()).length;
}

function pluralSuffix(unit: string, count: number): string {
  if (count === 1) return '';
  return unit === 'match' ? 'es' : 's';
}

function searchPreview(pattern: unknown, output: string | undefined, unit: string): string {
  const p = str(pattern);
  let preview = p ? `"${p}"` : '';
  const count = countOutputLines(output);
  if (count > 0) preview += ` \u2192 ${count} ${unit}${pluralSuffix(unit, count)}`;
  return preview;
}

export function formatToolInput(name: string, input?: Record<string, unknown>): string {
  if (!input) return '';
  switch (name) {
    case 'Bash':
      return str(input.command);
    case 'Read':
    case 'Write':
    case 'Edit':
      return str(input.file_path);
    case 'Grep':
    case 'Glob':
      return `${str(input.pattern)}${input.path ? ' in ' + str(input.path) : ''}`;
    case 'TodoWrite': {
      if (Array.isArray(input.todos)) {
        return input.todos.map((t: Record<string, unknown>) =>
          `[${t.status === 'completed' ? 'x' : ' '}] ${str(t.content || t.id)}`
        ).join('\n');
      }
      try { return JSON.stringify(input, null, 2); } catch { return ''; }
    }
    case 'Agent': {
      const parts: string[] = [];
      if (input.subagent_type) parts.push(`type: ${str(input.subagent_type)}`);
      if (input.description) parts.push(`desc: ${str(input.description)}`);
      if (input.prompt) parts.push(str(input.prompt));
      return parts.join('\n');
    }
    case 'Skill':
      return `/${str(input.skill)}${input.args ? ' ' + str(input.args) : ''}`;
    case 'ToolSearch':
    case 'WebSearch':
      return `query: ${str(input.query)}`;
    case 'WebFetch':
      return str(input.url);
    case 'NotebookEdit':
      return str(input.file_path || input.notebook_path);
    default:
      try { return JSON.stringify(input, null, 2); } catch { return ''; }
  }
}

export function generateToolPreview(
  name: string,
  input: Record<string, unknown>,
  resultOutput?: string,
): string {
  switch (name) {
    case 'Bash': {
      const cmd = str(input.command);
      if (!cmd) return '';
      const line = cmd.split('\n')[0];
      return line.length > 80 ? '$ ' + line.slice(0, 77) + '\u2026' : '$ ' + line;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return fileBasename(input);
    case 'Grep':
      return searchPreview(input.pattern, resultOutput, 'match');
    case 'Glob':
      return searchPreview(input.pattern, resultOutput, 'file');
    case 'TodoWrite': {
      if (!Array.isArray(input.todos)) return '';
      const done = input.todos.filter((t: Record<string, unknown>) => t.status === 'completed').length;
      const checks = input.todos.map((t: Record<string, unknown>) =>
        t.status === 'completed' ? '\u2713' : '\u25CB'
      ).join('');
      return `${done}/${input.todos.length} done ${checks}`;
    }
    case 'ToolSearch': {
      const q = str(input.query);
      let preview = q ? `"${q}"` : '';
      if (resultOutput) {
        const n = (resultOutput.match(/"name":/g) || []).length;
        if (n > 0) preview += ` \u2192 ${n} found`;
      }
      return preview;
    }
    case 'Agent':
      return str(input.description || input.subagent_type);
    case 'WebSearch':
      return str(input.query);
    case 'WebFetch': {
      const url = str(input.url);
      try { return new URL(url).hostname; } catch { return url.slice(0, 60); }
    }
    case 'Skill':
      return `/${str(input.skill)}`;
    default:
      return '';
  }
}

function extractToolResultText(content: string | Array<{ type: string; text?: string }> | undefined): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((c) => c.type === 'text' && c.text)
      .map((c) => c.text)
      .join('\n');
  }
  return '';
}

function buildToolResultMap(rawMessages: RawMessage[]): Map<string, { output: string; isError: boolean }> {
  const map = new Map<string, { output: string; isError: boolean }>();
  for (const msg of rawMessages) {
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item.type === 'tool_result' && item.tool_use_id) {
        map.set(item.tool_use_id, {
          output: extractToolResultText(item.content),
          isError: !!item.is_error,
        });
      }
    }
  }
  return map;
}

function buildToolBlock(
  item: ContentItem,
  toolResults: Map<string, { output: string; isError: boolean }>,
): MessageBlock {
  const result = item.id ? toolResults.get(item.id) : undefined;
  const desc = item.input?.description == null ? undefined : str(item.input.description);
  return {
    type: 'tool',
    content: item.name!,
    toolUseId: item.id ?? '',
    description: desc,
    input: formatToolInput(item.name!, item.input),
    output: result?.output,
    isError: result?.isError,
    preview: item.input ? generateToolPreview(item.name!, item.input, result?.output) : undefined,
  };
}

function extractBlocks(
  content: string | ContentItem[] | undefined,
  toolResults: Map<string, { output: string; isError: boolean }>,
): MessageBlock[] {
  if (typeof content === 'string') {
    return content.trim() ? [{ type: 'text', content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: MessageBlock[] = [];
  for (const item of content) {
    if (item.type === 'text' && item.text) {
      blocks.push({ type: 'text', content: item.text });
    } else if (item.type === 'tool_use' && item.name) {
      blocks.push(buildToolBlock(item, toolResults));
    }
  }
  return blocks;
}

export function readConversation(
  projectKey: string,
  sessionId: string,
  agentId?: string
): ConversationMessage[] {
  const filePath = agentId
    ? path.join(PROJECTS_DIR, projectKey, sessionId, 'subagents', `agent-${agentId}.jsonl`)
    : path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);

  const rawMessages = parseJsonlFile(filePath);
  const toolResults = buildToolResultMap(rawMessages);

  const conversation: ConversationMessage[] = [];
  for (const msg of rawMessages) {
    if (msg.type !== 'user' && msg.type !== 'assistant') continue;
    if (msg.isMeta) continue;

    const blocks = extractBlocks(msg.message?.content, toolResults);
    if (blocks.length === 0) continue;

    conversation.push({
      role: msg.type === 'user' ? 'user' : 'assistant',
      blocks,
      timestamp: msg.timestamp,
      uuid: msg.uuid,
    });
  }

  return conversation;
}
