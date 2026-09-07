export type SessionStatus = 'active' | 'thinking' | 'waiting' | 'recent' | 'idle';

export interface SubAgent {
  agentId: string;
  slug?: string;
  firstPrompt?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  messageCount: number;
  lastMessageRole?: string;
  status: SessionStatus;
  toolCounts: Record<string, number>;
  userChars: number;
  assistantLines: number;
  codeLines: number;
}

export interface ClaudeSession {
  sessionId: string;
  cwd?: string;
  gitBranch?: string;
  firstPrompt?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  messageCount: number;
  subAgents: SubAgent[];
  lastMessageRole?: string;
  status: SessionStatus;
  toolCounts: Record<string, number>;
  userChars: number;
  assistantLines: number;
  codeLines: number;
}

export interface ClaudeProject {
  key: string;
  path: string;
  displayName: string;
  sessions: ClaudeSession[];
  lastActivity?: string;
  peacockColor?: string;
}

export interface MessageBlock {
  type: 'text' | 'tool';
  content: string;
  /** Tool-specific fields (present when type === 'tool') */
  toolUseId?: string;
  description?: string;
  input?: string;
  output?: string;
  isError?: boolean;
  /** Short preview shown in collapsed tool badge */
  preview?: string;
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  timestamp?: string;
  /** Lets the webview scroll to and highlight the message a search hit points at. */
  uuid?: string;
}

export interface ManagerSettings {
  soundEnabled: boolean;
  soundRepeatSec: number;
  exportTemplate: string;
  exportLinkStyle: 'markdown' | 'wiki';
  exportToolFormat: 'compact' | 'expanded' | 'omit';
}

export interface HookCheck {
  name: string;
  status: 'success' | 'warning' | 'failure';
  message?: string;
}

export interface HookHealth {
  path: string;
  event: string;
  status: 'healthy' | 'warning' | 'failure';
  checks: HookCheck[];
  lastRun: string;
  duration: number;
}

export interface HookHealthReport {
  timestamp: string;
  hooks: HookHealth[];
  summary: {
    healthy: number;
    warnings: number;
    failures: number;
  };
}

export type SearchScope =
  | 'prompts'
  | 'assistant'
  | 'thinking'
  | 'toolInput'
  | 'toolOutput'
  | 'note';

export interface SearchQuery {
  text: string;
  isRegex: boolean;
  caseSensitive: boolean;
  scopes: SearchScope[];
  projectKeys?: string[];
  sessionIds?: string[];
  branches?: string[];
  after?: string;
  before?: string;
  tags?: string[];
}

export interface SearchHit {
  projectKey: string;
  projectPath: string;
  sessionId: string;
  agentId?: string;
  uuid: string;
  role: 'user' | 'assistant';
  scope: SearchScope;
  timestamp?: string;
  gitBranch?: string;
  snippet: string;
  matchStart: number;
  matchLength: number;
}

export interface SearchSummary {
  totalHits: number;
  filesScanned: number;
  durationMs: number;
  aborted: boolean;
  /** sessionId -> display title, from custom-title / ai-title sidecar lines. */
  titles: Record<string, string>;
}

export interface SavedSearch {
  id: string;
  name: string;
  query: SearchQuery;
}

export interface SessionMeta {
  note?: string;
  tags?: string[];
}

export interface TimelineEntry {
  projectKey: string;
  projectPath: string;
  sessionId: string;
  agentId?: string;
  title: string;
  gitBranch?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
  messageCount: number;
}

export interface TimelineDay {
  date: string;
  entries: TimelineEntry[];
}
