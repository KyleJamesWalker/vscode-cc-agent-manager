export type SessionStatus = 'active' | 'thinking' | 'reasoning' | 'waiting' | 'recent' | 'idle';

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
  type: 'text' | 'tool' | 'thinking';
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
}

export interface ManagerSettings {
  soundEnabled: boolean;
  soundRepeatSec: number;
  exportTemplate: string;
  exportLinkStyle: 'markdown' | 'wiki';
  exportToolFormat: 'compact' | 'expanded' | 'omit';
  showThinking: boolean;
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
