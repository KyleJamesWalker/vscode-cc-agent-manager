import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ClaudeSession, ClaudeProject, SubAgent, ConversationMessage, ManagerSettings } from './types';

export interface ExportParams {
  projectKey: string;
  sessionId: string;
  displayName: string;
  session: ClaudeSession;
  readConversation: (projectKey: string, sessionId: string, agentId?: string) => ConversationMessage[];
}

export interface ExportResult {
  rootPath: string;
  agentPaths: string[];
  skippedAgents: number;
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Expand a path template with session/project tokens.
 * Returns the resolved absolute path, or undefined if the result is invalid.
 * Callers must check for the "dialog" sentinel before calling this function.
 */
export function expandTemplate(template: string, session: ClaudeSession, project: ClaudeProject): string | undefined {
  // Tilde expansion
  let result = template.startsWith('~')
    ? os.homedir() + template.slice(1)
    : template;

  // Date tokens — prefer lastTimestamp, fall back to firstTimestamp, then 'unknown'
  const tsStr = session.lastTimestamp ?? session.firstTimestamp;
  let date: Date | undefined;
  if (tsStr) {
    try { date = new Date(tsStr); } catch { /* ignore */ }
  }
  const dateStr = date ? date.toISOString().slice(0, 10) : 'unknown';
  const yyyy = date ? String(date.getFullYear()) : 'unknown';
  const yy = date ? String(date.getFullYear()).slice(2) : 'unknown';
  const mm = date ? String(date.getMonth() + 1).padStart(2, '0') : 'unknown';
  const dd = date ? String(date.getDate()).padStart(2, '0') : 'unknown';

  // Slug tokens (same logic as the former _exportFilename)
  const rawPrompt = session.firstPrompt ?? session.sessionId.slice(0, 8);
  const slugFull = rawPrompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const slugShort = rawPrompt.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20).replace(/-+$/, '');

  // Project token — slugified display name
  const projectSlug = project.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  // Branch token — slugified, empty string if absent
  const branch = session.gitBranch
    ? session.gitBranch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
    : '';

  // Other tokens
  const sessionId8 = session.sessionId.slice(0, 8);
  const cwd = session.cwd ?? '';

  result = result
    .replace(/\{date\}/g, dateStr)
    .replace(/\{yyyy\}/g, yyyy)
    .replace(/\{yy\}/g, yy)
    .replace(/\{mm\}/g, mm)
    .replace(/\{dd\}/g, dd)
    .replace(/\{slug\}/g, slugFull)
    .replace(/\{short-slug\}/g, slugShort)
    .replace(/\{project\}/g, projectSlug)
    .replace(/\{branch\}/g, branch)
    .replace(/\{session-id\}/g, sessionId8)
    .replace(/\{cwd\}/g, cwd);

  // Normalize: handle forward slashes on all platforms, collapse repeated separators
  result = result.split('/').join(path.sep);
  result = path.normalize(result);

  // Must be an absolute path
  if (!path.isAbsolute(result)) {
    return undefined;
  }

  // Must have a real parent directory (not just the filesystem root)
  if (path.dirname(result) === path.parse(result).root) {
    return undefined;
  }

  return result;
}

/**
 * Find the path to write the root export file.
 * If `basePath` already exists with identical content, reuse it (no duplicate).
 * If it exists with different content, try -2 through -99 with the same check.
 * Falls back to overwriting `basePath` in the extreme case all slots are taken.
 */
function resolveRootPath(basePath: string, content: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  if (fs.readFileSync(basePath, 'utf-8') === content) return basePath;

  const dir = path.dirname(basePath);
  const base = path.basename(basePath, '.md');
  for (let i = 2; i <= 99; i++) {
    const candidate = path.join(dir, `${base}-${i}.md`);
    if (!fs.existsSync(candidate)) return candidate;
    if (fs.readFileSync(candidate, 'utf-8') === content) return candidate;
  }

  return basePath; // all 99 slots taken with different content — overwrite base
}

function agentLabel(agent: SubAgent): string {
  return agent.slug ? slugify(agent.slug) : agent.agentId.slice(0, 8);
}

export function deduplicateLabels(agents: SubAgent[]): Map<SubAgent, string> {
  const counts = new Map<string, number>();
  for (const agent of agents) {
    const base = agentLabel(agent);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  const result = new Map<SubAgent, string>();
  for (const agent of agents) {
    const base = agentLabel(agent);
    if (counts.get(base)! > 1) {
      const idx = (seen.get(base) ?? 0) + 1;
      seen.set(base, idx);
      result.set(agent, idx === 1 ? base : `${base}-${idx}`);
    } else {
      result.set(agent, base);
    }
  }

  return result;
}

function formatTimestamp(ts: string | undefined): string {
  if (!ts) return 'Unknown date';
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return 'Unknown date';
  }
}

function formatTime(ts: string | undefined): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export function renderToolBlock(block: { content: string; preview?: string; input?: string; output?: string; isError?: boolean }, format: ManagerSettings['exportToolFormat']): string {
  if (format === 'omit') return '';

  const name = block.content;

  if (format === 'compact') {
    if (block.preview) {
      const preview = truncate(block.preview, 60);
      return `> **${name}** ${preview}\n\n`;
    }
    return `> **${name}**\n\n`;
  }

  // expanded
  const inputSection = block.input
    ? `>\n> *Input*\n> \`\`\`\n> ${block.input.split('\n').join('\n> ')}\n> \`\`\`\n`
    : '';
  const outputLabel = block.isError ? '*Error*' : '*Output*';
  const outputContent = block.output ?? '';
  const outputSection = `>\n> ${outputLabel}\n> \`\`\`\n> ${outputContent.split('\n').join('\n> ')}\n> \`\`\`\n`;

  return `> **${name}**\n${inputSection}${outputSection}\n`;
}

function renderMessages(
  messages: ConversationMessage[],
  format: ManagerSettings['exportToolFormat'],
  showThinking: boolean,
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    const role = msg.role === 'user' ? 'You' : 'Claude';
    const timeStr = msg.timestamp ? ` · ${formatTime(msg.timestamp)}` : '';
    parts.push(`### ${role}${timeStr}\n`);

    for (const block of msg.blocks) {
      if (block.type === 'text') {
        parts.push(block.content.trim() + '\n\n');
      } else if (block.type === 'thinking') {
        if (showThinking && block.content.trim() !== '') {
          parts.push(`<details>\n<summary>💭 Thinking</summary>\n\n${block.content}\n\n</details>\n\n`);
        }
      } else {
        const rendered = renderToolBlock(block, format);
        if (rendered) parts.push(rendered);
      }
    }
  }

  return parts.join('\n');
}

function buildRootMarkdown(
  session: ClaudeSession,
  displayName: string,
  messages: ConversationMessage[],
  agentLinks: Array<{ label: string; filename: string }>,
  format: ManagerSettings['exportToolFormat'],
  linkStyle: ManagerSettings['exportLinkStyle'],
  showThinking: boolean,
): string {
  const titlePrompt = session.firstPrompt
    ? truncate(session.firstPrompt, 80)
    : session.sessionId.slice(0, 8);
  const date = formatTimestamp(session.firstTimestamp);

  const lines: string[] = [];
  lines.push(`# Session: ${titlePrompt}\n`);
  lines.push(`**Project:** ${displayName}`);
  if (session.gitBranch) {
    lines.push(`**Branch:** ${session.gitBranch}`);
  }
  lines.push(`**Date:** ${date}\n`);

  if (agentLinks.length > 0) {
    lines.push('## Agents\n');
    for (const { label, filename } of agentLinks) {
      const filenameNoExt = filename.replace(/\.md$/, '');
      const link = linkStyle === 'wiki'
        ? `- [[${filenameNoExt}|${label}]]`
        : `- [${label}](./${filename})`;
      lines.push(link);
    }
    lines.push('');
    lines.push('---\n');
  }

  lines.push('## Conversation\n');
  lines.push(renderMessages(messages, format, showThinking));

  return lines.join('\n');
}

function buildAgentMarkdown(
  agent: SubAgent,
  label: string,
  rootFilename: string,
  messages: ConversationMessage[],
  format: ManagerSettings['exportToolFormat'],
  linkStyle: ManagerSettings['exportLinkStyle'],
  showThinking: boolean,
): string {
  const title = agent.slug ?? agent.agentId.slice(0, 8);
  const rootFilenameNoExt = rootFilename.replace(/\.md$/, '');
  const backLink = linkStyle === 'wiki'
    ? `← [[${rootFilenameNoExt}|Back to session]]`
    : `← [Back to session](./${rootFilename})`;

  const lines: string[] = [];
  lines.push(`${backLink}\n`);
  lines.push(`# Agent: ${title}\n`);
  lines.push('## Conversation\n');
  lines.push(renderMessages(messages, format, showThinking));

  return lines.join('\n');
}

export function exportConversation(
  params: ExportParams,
  settings: ManagerSettings,
  rootPath: string,
): ExportResult {
  const { projectKey, sessionId, displayName, session, readConversation } = params;
  const format = settings.exportToolFormat;
  const linkStyle = settings.exportLinkStyle ?? 'markdown';
  const showThinking = settings.showThinking ?? false;

  const rootDir = path.dirname(rootPath);
  const rootBasename = path.basename(rootPath, '.md');

  // Resolve agent labels with deduplication
  const labelMap = deduplicateLabels(session.subAgents);

  // Read root conversation
  const rootMessages = readConversation(projectKey, sessionId);

  // Process each agent
  const agentLinks: Array<{ label: string; filename: string }> = [];
  const agentPaths: string[] = [];
  let skippedAgents = 0;

  for (const agent of session.subAgents) {
    const label = labelMap.get(agent)!;
    let agentMessages: ConversationMessage[];
    try {
      agentMessages = readConversation(projectKey, sessionId, agent.agentId);
      if (agentMessages.length === 0) throw new Error('empty');
    } catch {
      skippedAgents++;
      continue;
    }

    const agentFilename = `${rootBasename}-agent-${label}.md`;
    agentLinks.push({ label, filename: agentFilename });

    const agentContent = buildAgentMarkdown(agent, label, path.basename(rootPath), agentMessages, format, linkStyle, showThinking);
    const agentPath = path.join(rootDir, agentFilename);
    fs.writeFileSync(agentPath, agentContent, 'utf-8');
    agentPaths.push(agentPath);
  }

  // Write root file — content-aware path selection avoids duplicates
  const rootContent = buildRootMarkdown(session, displayName, rootMessages, agentLinks, format, linkStyle, showThinking);
  const actualRootPath = resolveRootPath(rootPath, rootContent);
  fs.writeFileSync(actualRootPath, rootContent, 'utf-8');

  return { rootPath: actualRootPath, agentPaths, skippedAgents };
}
