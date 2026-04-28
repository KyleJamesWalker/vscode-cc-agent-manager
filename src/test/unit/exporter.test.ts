jest.mock('fs');

import * as fs from 'fs';
import {
  exportConversation,
  deduplicateLabels,
  renderToolBlock,
  ExportParams,
} from '../../exporter';
import type { SubAgent, ClaudeSession, ManagerSettings, ConversationMessage } from '../../types';

const defaultSettings: ManagerSettings = {
  soundEnabled: false,
  soundRepeatSec: 0,
  exportTemplate: '~/Documents/claude-exports/{slug}.md',
  exportLinkStyle: 'markdown',
  exportToolFormat: 'compact',
  showThinking: false,
};

const baseSession: ClaudeSession = {
  sessionId: 'sess1',
  firstPrompt: 'Hello test',
  firstTimestamp: '2024-01-01T00:00:00Z',
  lastTimestamp: '2024-01-01T00:01:00Z',
  messageCount: 2,
  subAgents: [],
  lastMessageRole: 'assistant',
  status: 'waiting',
  toolCounts: {},
  userChars: 0,
  assistantLines: 0,
  codeLines: 0,
};

const textMessage = (role: 'user' | 'assistant', text: string): ConversationMessage => ({
  role,
  blocks: [{ type: 'text', content: text }],
  timestamp: '2024-01-01T00:00:00Z',
});

describe('deduplicateLabels', () => {
  test('unique slugs map to their own slug', () => {
    const agents: SubAgent[] = [
      { agentId: 'abc1', slug: 'explore', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 },
      { agentId: 'abc2', slug: 'build', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 },
    ];
    const map = deduplicateLabels(agents);
    expect(map.get(agents[0])).toBe('explore');
    expect(map.get(agents[1])).toBe('build');
  });

  test('duplicate slugs get indexed suffixes starting at 2', () => {
    const agents: SubAgent[] = [
      { agentId: 'abc1', slug: 'build', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 },
      { agentId: 'abc2', slug: 'build', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 },
    ];
    const map = deduplicateLabels(agents);
    expect(map.get(agents[0])).toBe('build');
    expect(map.get(agents[1])).toBe('build-2');
  });

  test('three duplicate slugs get -2 and -3 suffixes', () => {
    const agents: SubAgent[] = [
      { agentId: 'abc1', slug: 'build', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 },
      { agentId: 'abc2', slug: 'build', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 },
      { agentId: 'abc3', slug: 'build', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 },
    ];
    const map = deduplicateLabels(agents);
    expect(map.get(agents[0])).toBe('build');
    expect(map.get(agents[1])).toBe('build-2');
    expect(map.get(agents[2])).toBe('build-3');
  });

  test('no slug falls back to first 8 chars of agentId', () => {
    const agents: SubAgent[] = [{ agentId: 'abcdefgh1234', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 }];
    const map = deduplicateLabels(agents);
    expect(map.get(agents[0])).toBe('abcdefgh');
  });
});

describe('renderToolBlock', () => {
  const block = {
    content: 'Read',
    preview: 'bar.ts',
    input: '/foo/bar.ts',
    output: 'file contents',
    isError: false,
  };

  test('omit returns empty string', () => {
    expect(renderToolBlock(block, 'omit')).toBe('');
  });

  test('compact returns preview line', () => {
    expect(renderToolBlock(block, 'compact')).toBe('> **Read** bar.ts\n\n');
  });

  test('compact without preview returns just tool name', () => {
    const noPreview = { content: 'Agent', isError: false };
    expect(renderToolBlock(noPreview, 'compact')).toBe('> **Agent**\n\n');
  });

  test('expanded contains input and output sections', () => {
    const result = renderToolBlock(block, 'expanded');
    expect(result).toContain('> **Read**');
    expect(result).toContain('> *Input*');
    expect(result).toContain('/foo/bar.ts');
    expect(result).toContain('> *Output*');
    expect(result).toContain('file contents');
  });

  test('expanded with isError labels section as Error', () => {
    const errBlock = { ...block, isError: true };
    expect(renderToolBlock(errBlock, 'expanded')).toContain('> *Error*');
  });
});

describe('exportConversation', () => {
  beforeEach(() => jest.clearAllMocks());

  const baseParams: ExportParams = {
    projectKey: 'proj',
    sessionId: 'sess1',
    displayName: 'my-project',
    session: baseSession,
    readConversation: () => [textMessage('user', 'Hello')],
  };

  test('root file is written to the provided path', () => {
    exportConversation(baseParams, defaultSettings, '/tmp/session.md');
    const writtenPaths = jest.mocked(fs.writeFileSync).mock.calls.map((c) => c[0]);
    expect(writtenPaths).toContain('/tmp/session.md');
  });

  test('compact format renders tool block as preview line', () => {
    const params: ExportParams = {
      ...baseParams,
      readConversation: () => [
        {
          role: 'assistant',
          blocks: [{ type: 'tool', content: 'Read', preview: 'bar.ts' }],
          timestamp: '2024-01-01T00:00:01Z',
        },
      ],
    };
    exportConversation(params, defaultSettings, '/tmp/session.md');
    const rootContent = String(jest.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(rootContent).toContain('> **Read** bar.ts');
  });

  test('omit format excludes tool blocks from output', () => {
    const params: ExportParams = {
      ...baseParams,
      readConversation: () => [
        {
          role: 'assistant',
          blocks: [{ type: 'tool', content: 'Read', preview: 'bar.ts' }],
          timestamp: '2024-01-01T00:00:01Z',
        },
      ],
    };
    const omitSettings = { ...defaultSettings, exportToolFormat: 'omit' as const };
    exportConversation(params, omitSettings, '/tmp/session.md');
    const rootContent = String(jest.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(rootContent).not.toContain('**Read**');
  });

  test('agent with empty conversation is counted as skipped', () => {
    const agent: SubAgent = { agentId: 'abc1', slug: 'explore', messageCount: 0, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 };
    const params: ExportParams = {
      ...baseParams,
      session: { ...baseSession, subAgents: [agent] },
      readConversation: (_key, _sess, agentId) =>
        agentId ? [] : [textMessage('user', 'Hello')],
    };
    const result = exportConversation(params, defaultSettings, '/tmp/session.md');
    expect(result.skippedAgents).toBe(1);
    expect(result.agentPaths).toHaveLength(0);
  });

  test('agent file is written with back-link to root', () => {
    const agent: SubAgent = { agentId: 'abc1', slug: 'explore', messageCount: 1, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 };
    const params: ExportParams = {
      ...baseParams,
      session: { ...baseSession, subAgents: [agent] },
      readConversation: (_key, _sess, agentId) =>
        agentId ? [textMessage('user', 'Go')] : [textMessage('user', 'Hello')],
    };
    const result = exportConversation(params, defaultSettings, '/tmp/session.md');
    // Agent file is written first (before root)
    const agentContent = String(jest.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(agentContent).toContain('← [Back to session](./session.md)');
    expect(result.agentPaths).toEqual(['/tmp/session-agent-explore.md']);
  });

  test('renders non-empty thinking block as <details> when showThinking is true', () => {
    const params: ExportParams = {
      ...baseParams,
      readConversation: () => [
        {
          role: 'assistant',
          blocks: [{ type: 'thinking', content: 'I should consider edge cases.' }],
          timestamp: '2024-01-01T00:00:01Z',
        },
      ],
    };
    const settings = { ...defaultSettings, showThinking: true };
    exportConversation(params, settings, '/tmp/session.md');
    const rootContent = String(jest.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(rootContent).toContain('<details>');
    expect(rootContent).toContain('<summary>💭 Thinking</summary>');
    expect(rootContent).toContain('I should consider edge cases.');
    expect(rootContent).toContain('</details>');
  });

  test('omits empty thinking block even when showThinking is true', () => {
    const params: ExportParams = {
      ...baseParams,
      readConversation: () => [
        {
          role: 'assistant',
          blocks: [{ type: 'thinking', content: '' }],
          timestamp: '2024-01-01T00:00:01Z',
        },
      ],
    };
    const settings = { ...defaultSettings, showThinking: true };
    exportConversation(params, settings, '/tmp/session.md');
    const rootContent = String(jest.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(rootContent).not.toContain('<details>');
    expect(rootContent).not.toContain('💭 Thinking');
  });

  test('omits thinking block when showThinking is false', () => {
    const params: ExportParams = {
      ...baseParams,
      readConversation: () => [
        {
          role: 'assistant',
          blocks: [{ type: 'thinking', content: 'Reasoning text.' }],
          timestamp: '2024-01-01T00:00:01Z',
        },
      ],
    };
    exportConversation(params, defaultSettings, '/tmp/session.md');
    const rootContent = String(jest.mocked(fs.writeFileSync).mock.calls[0][1]);
    expect(rootContent).not.toContain('<details>');
    expect(rootContent).not.toContain('Reasoning text.');
  });

  test('root file links to agent sub-file', () => {
    const agent: SubAgent = { agentId: 'abc1', slug: 'explore', messageCount: 1, status: 'idle', toolCounts: {}, userChars: 0, assistantLines: 0, codeLines: 0 };
    const params: ExportParams = {
      ...baseParams,
      session: { ...baseSession, subAgents: [agent] },
      readConversation: (_key, _sess, agentId) =>
        agentId ? [textMessage('user', 'Go')] : [textMessage('user', 'Hello')],
    };
    exportConversation(params, defaultSettings, '/tmp/session.md');
    // Root file is written last
    const calls = jest.mocked(fs.writeFileSync).mock.calls;
    const rootContent = String(calls[calls.length - 1][1]);
    expect(rootContent).toContain('[explore](./session-agent-explore.md)');
  });
});
