import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readClaudeProjects, readConversation } from './claudeReader';
import {
  ManagerSettings,
  ClaudeProject,
  ClaudeSession,
  SavedSearch,
  SearchQuery,
  SearchHit,
  SessionMeta,
} from './types';
import { listScanTargets } from './sessionScanner';
import { compileMatcher, runSearch } from './sessionSearch';
import { findFileUsage } from './fileUsageIndex';
import { buildTimeline } from './sessionTimeline';
import { exportConversation, expandTemplate } from './exporter';
import { TerminalManager } from './terminalManager';
import { getHooksHealth } from './hookHealth';
import { CLAUDE_CODE_OPEN_COMMAND, buildForkResumePrompt, isSessionId } from './claudeCodeLauncher';

const DEFAULT_SETTINGS: ManagerSettings = {
  soundEnabled: false,
  soundRepeatSec: 0,
  exportTemplate: '~/Documents/claude-exports/{slug}.md',
  exportLinkStyle: 'markdown',
  exportToolFormat: 'compact',
};

export class AgentManagerPanel {
  public static currentPanel: AgentManagerPanel | undefined;
  private static readonly viewType = 'claudeAgentManager';

  private readonly _panel: vscode.WebviewPanel;
  private readonly _context: vscode.ExtensionContext;
  private _disposables: vscode.Disposable[] = [];
  private _refreshTimer: ReturnType<typeof setInterval> | undefined;
  private _projects: ClaudeProject[] = [];
  private _fileWatcher: fs.FSWatcher | undefined;
  private _watchDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _watchedProjectKey: string | undefined;
  private _watchedSessionId: string | undefined;
  private _watchedAgentId: string | undefined;
  // _currentCwd and _currentSessionId are set on every loadConversation and used
  // by the focusTerminal and sendMessage handlers below.
  private _currentCwd: string | undefined;
  private _currentSessionId: string | undefined;
  private _terminalManager: TerminalManager;
  private _searchAbort: AbortController | undefined;

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column =
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (AgentManagerPanel.currentPanel) {
      AgentManagerPanel.currentPanel._panel.reveal(column);
      AgentManagerPanel.currentPanel._sendUpdate();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      AgentManagerPanel.viewType,
      'Claude Code Agent Manager',
      column,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
        retainContextWhenHidden: true,
      }
    );

    AgentManagerPanel.currentPanel = new AgentManagerPanel(panel, context);
  }

  /** Opens the panel on the Search tab, seeded with a reverse lookup for `filePath`. */
  public static showFileUsage(context: vscode.ExtensionContext, filePath: string): void {
    AgentManagerPanel.createOrShow(context);
    const panel = AgentManagerPanel.currentPanel;
    if (!panel) return;

    panel._panel.webview.postMessage({ command: 'startFileUsage', path: filePath });
    panel._handleFileUsage(filePath, false);
  }

  private constructor(
    panel: vscode.WebviewPanel,
    context: vscode.ExtensionContext
  ) {
    this._panel = panel;
    this._context = context;

    this._panel.webview.html = this._getHtml(this._panel.webview);
    this._terminalManager = new TerminalManager((msg) =>
      this._panel.webview.postMessage(msg)
    );

    // Send initial data after a tick so the webview JS has loaded
    setTimeout(() => this._sendUpdate(), 100);

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.onDidChangeViewState(
      (e) => {
        if (e.webviewPanel.visible) {
          this._sendUpdate();
          this._terminalManager.resumeScan();
          // Resume watcher if we had one paused
          const pk = this._watchedProjectKey;
          const sid = this._watchedSessionId;
          const aid = this._watchedAgentId;
          if (pk && sid) {
            this._setupFileWatcher(pk, sid, aid);
          }
        } else {
          // Pause watcher but keep IDs for resume
          this._pauseFileWatcher();
          this._terminalManager.pauseScan();
        }
      },
      null,
      this._disposables
    );

    this._panel.webview.onDidReceiveMessage(
      (message) => {
        switch (message.command) {
          case 'openFolder':
            if (message.path) {
              this._openFolder(message.path);
            }
            break;
          case 'refresh':
            this._sendUpdate();
            break;
          case 'togglePin':
            if (message.key) { this._togglePin(message.key); }
            break;
          case 'updateSettings':
            if (message.settings) { this._updateSettings(message.settings); }
            break;
          case 'loadConversation':
            if (message.projectKey && message.sessionId) {
              // CWD lookup uses the _projects cache (populated by _sendUpdate). If the panel
              // loads a session before the first _sendUpdate cycle, cwd will be undefined.
              const proj = this._projects.find((p) => p.key === message.projectKey);
              const sess = proj?.sessions.find((s) => s.sessionId === message.sessionId);
              this._currentCwd = sess?.cwd;
              this._currentSessionId = message.sessionId;
              this._terminalManager.setCurrentCwd(this._currentCwd);

              const messages = readConversation(
                message.projectKey,
                message.sessionId,
                message.agentId
              );
              this._panel.webview.postMessage({
                command: 'conversation',
                messages,
                sessionId: message.sessionId,
                agentId: message.agentId,
                cwd: this._currentCwd,
                scrollToUuid: message.scrollToUuid,
              });
              this._setupFileWatcher(message.projectKey, message.sessionId, message.agentId);
            }
            break;
          case 'exportChat':
            if (message.projectKey && message.sessionId) {
              this._handleExportChat(message.projectKey, message.sessionId);
            }
            break;
          case 'focusTerminal':
            if (this._currentCwd) {
              this._terminalManager.focusSession(this._currentCwd);
            }
            break;
          case 'sendMessage':
            if (!this._currentCwd) {
              this._panel.webview.postMessage({
                command: 'sendMessageResult',
                success: false,
                error: 'Session has no working directory',
              });
              break;
            }
            if (typeof message.text !== 'string' || !message.text.trim()) {
              this._panel.webview.postMessage({
                command: 'sendMessageResult',
                success: false,
                error: 'No message text provided',
              });
              break;
            }
            void (async () => {
              try {
                if (!this._terminalManager.getTerminalForCwd(this._currentCwd!)) {
                  await this._terminalManager.resumeSession(
                    this._currentSessionId ?? '',
                    this._currentCwd!
                  );
                }
                await this._terminalManager.sendToSession(this._currentCwd!, message.text);
                this._panel.webview.postMessage({ command: 'sendMessageResult', success: true });
              } catch (e: unknown) {
                this._panel.webview.postMessage({
                  command: 'sendMessageResult',
                  success: false,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            })();
            break;
          case 'openInClaudeCode':
            if (message.sessionId) {
              void this._openInClaudeCode(message.sessionId);
            }
            break;
          case 'search':
            this._handleSearch(message.query, message.requestId);
            break;
          case 'cancelSearch':
            this._searchAbort?.abort();
            break;
          case 'findFileUsage':
            this._handleFileUsage(message.path, !!message.includeHeuristic);
            break;
          case 'saveSearch':
            if (message.name && message.query) {
              this._saveSearch(message.name, message.query);
            }
            break;
          case 'deleteSavedSearch':
            if (message.id) { this._deleteSavedSearch(message.id); }
            break;
          case 'setSessionMeta':
            if (message.sessionId) {
              this._setSessionMeta(message.sessionId, message.agentId, message.note, message.tags);
            }
            break;
          case 'getTimeline':
            this._handleTimeline();
            break;
          case 'getHooksHealth':
            void (async () => {
              try {
                const health = await getHooksHealth();
                this._panel.webview.postMessage({
                  command: 'hooksHealth',
                  payload: health,
                });
              } catch (e: unknown) {
                this._panel.webview.postMessage({
                  command: 'hooksHealth',
                  payload: {
                    timestamp: new Date().toISOString(),
                    hooks: [],
                    summary: { healthy: 0, warnings: 0, failures: 0 },
                  },
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            })();
            break;
        }
      },
      null,
      this._disposables
    );

    // Auto-refresh every 30 seconds when visible
    this._refreshTimer = setInterval(() => {
      if (this._panel.visible) { this._sendUpdate(); }
    }, 30000);
  }

  private _openFolder(folderPath: string): void {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const isCurrentWindow = folders.length === 0 || folders.some(f => f.uri.fsPath === folderPath);
    vscode.commands.executeCommand(
      'vscode.openFolder',
      vscode.Uri.file(folderPath),
      { forceNewWindow: !isCurrentWindow }
    );
  }

  /**
   * Fork-resume a session in the native Claude Code panel
   * (see docs/superpowers/specs/2026-06-14-fork-resume-in-panel-design.md).
   *
   * We open a fresh panel pre-filled with a prompt telling Claude to find the prior transcript and
   * continue. We still pass the session id first so the panel genuinely resumes when its cwd matches.
   * CC does not auto-send the pre-filled prompt, hence the press-Enter toast. Falls back to copying
   * `claude -r <id>`.
   */
  private async _openInClaudeCode(sessionId: string): Promise<void> {
    if (!isSessionId(sessionId)) {
      void vscode.window.showErrorMessage(`Not a valid session id: "${sessionId}"`);
      return;
    }

    const fallbackCmd = `claude -r ${sessionId}`;
    const commands = await vscode.commands.getCommands(true);

    if (!commands.includes(CLAUDE_CODE_OPEN_COMMAND)) {
      await vscode.env.clipboard.writeText(fallbackCmd);
      void vscode.window.showWarningMessage(
        `Claude Code extension not found. Copied "${fallbackCmd}" to the clipboard instead.`
      );
      return;
    }

    try {
      const prompt = buildForkResumePrompt(sessionId);
      await vscode.commands.executeCommand(CLAUDE_CODE_OPEN_COMMAND, sessionId, prompt);
      void vscode.window.showInformationMessage(
        'Opened in Claude Code — press Enter to continue this session.'
      );
    } catch (e: unknown) {
      await vscode.env.clipboard.writeText(fallbackCmd);
      void vscode.window.showErrorMessage(
        `Could not open the session in Claude Code: ${
          e instanceof Error ? e.message : String(e)
        }. Copied "${fallbackCmd}" to the clipboard instead.`
      );
    }
  }

  private _getPinnedKeys(): string[] {
    return this._context.globalState.get<string[]>('pinnedProjectKeys', []);
  }

  private _getSettings(): ManagerSettings {
    const stored = this._context.globalState.get<Record<string, unknown>>('managerSettings');
    if (!stored) return { ...DEFAULT_SETTINGS };

    // Migration: convert old exportDestination to exportTemplate on first load after upgrade
    if (stored['exportDestination'] !== undefined && stored['exportTemplate'] === undefined) {
      switch (stored['exportDestination']) {
        case 'dialog': stored['exportTemplate'] = 'dialog'; break;
        case 'cwd': stored['exportTemplate'] = '{cwd}/{slug}.md'; break;
        default: stored['exportTemplate'] = '~/Documents/claude-exports/{slug}.md';
      }
      void this._context.globalState.update('managerSettings', stored);
    }

    return { ...DEFAULT_SETTINGS, ...stored } as ManagerSettings;
  }

  private _togglePin(key: string): void {
    const pinned = new Set(this._getPinnedKeys());
    if (pinned.has(key)) {
      pinned.delete(key);
    } else {
      pinned.add(key);
    }
    this._context.globalState.update('pinnedProjectKeys', [...pinned]);
    this._sendUpdate();
  }

  private _updateSettings(settings: ManagerSettings): void {
    this._context.globalState.update('managerSettings', settings);
  }

  private _sendUpdate(): void {
    const projects = readClaudeProjects();
    this._projects = projects;
    const pinnedKeys = this._getPinnedKeys();
    const settings = this._getSettings();
    this._panel.webview.postMessage({
      command: 'update',
      projects,
      pinnedKeys,
      settings,
      savedSearches: this._getSavedSearches(),
      sessionMeta: this._getSessionMeta(),
    });
  }

  private _getSavedSearches(): SavedSearch[] {
    return this._context.globalState.get<SavedSearch[]>('savedSearches', []);
  }

  private _sendSavedSearches(items: SavedSearch[]): void {
    void this._context.globalState.update('savedSearches', items);
    this._panel.webview.postMessage({ command: 'savedSearches', items });
  }

  private _saveSearch(name: string, query: SearchQuery): void {
    const items = this._getSavedSearches().filter((s) => s.name !== name);
    items.push({ id: `${Date.now()}-${items.length}`, name, query });
    this._sendSavedSearches(items);
  }

  private _deleteSavedSearch(id: string): void {
    this._sendSavedSearches(this._getSavedSearches().filter((s) => s.id !== id));
  }

  private _getSessionMeta(): Record<string, SessionMeta> {
    return this._context.globalState.get<Record<string, SessionMeta>>('sessionMeta', {});
  }

  private _setSessionMeta(
    sessionId: string,
    agentId: string | undefined,
    note: string | undefined,
    tags: string[] | undefined
  ): void {
    const items = { ...this._getSessionMeta() };
    const key = agentId ? `${sessionId}:${agentId}` : sessionId;
    const entry: SessionMeta = { ...items[key] };

    if (note !== undefined) { entry.note = note; }
    if (tags !== undefined) { entry.tags = tags; }

    if (!entry.note && !entry.tags?.length) {
      delete items[key];
    } else {
      items[key] = entry;
    }

    void this._context.globalState.update('sessionMeta', items);
    this._panel.webview.postMessage({ command: 'sessionMeta', items });
  }

  private _handleSearch(query: SearchQuery, requestId: number): void {
    this._searchAbort?.abort();
    const controller = new AbortController();
    this._searchAbort = controller;

    void (async () => {
      try {
        const noteHits = this._matchNotes(query);
        if (noteHits.length) {
          this._panel.webview.postMessage({
            command: 'searchProgress',
            requestId,
            hits: noteHits,
            filesScanned: 0,
            filesTotal: 0,
          });
        }

        const targets = await listScanTargets();
        const summary = await runSearch(
          this._matchTags(query),
          targets,
          (hits, filesScanned, filesTotal) => {
            this._panel.webview.postMessage({
              command: 'searchProgress',
              requestId,
              hits,
              filesScanned,
              filesTotal,
            });
          },
          controller.signal
        );
        this._panel.webview.postMessage({
          command: 'searchDone',
          requestId,
          totalHits: summary.totalHits,
          durationMs: summary.durationMs,
          filesScanned: summary.filesScanned,
          titles: summary.titles,
          truncated: summary.aborted,
        });
      } catch (e: unknown) {
        this._panel.webview.postMessage({
          command: 'searchDone',
          requestId,
          totalHits: 0,
          durationMs: 0,
          filesScanned: 0,
          titles: {},
          truncated: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }

  /**
   * Notes are stored in globalState rather than in the transcripts, so the disk
   * scan cannot see them. Matching them here keeps a hand-written label — the
   * most reliable way to find a session later — searchable alongside content.
   */
  private _matchNotes(query: SearchQuery): SearchHit[] {
    if (!query.scopes.includes('note') || !query.text.trim()) return [];

    let matcher: RegExp;
    try {
      matcher = compileMatcher(query);
    } catch {
      return [];
    }

    const hits: SearchHit[] = [];
    for (const [key, entry] of Object.entries(this._getSessionMeta())) {
      const haystack = [entry.note ?? '', ...(entry.tags ?? [])].join(' ').trim();
      if (!haystack) continue;

      const match = matcher.exec(haystack);
      if (!match) continue;

      const [sessionId, agentId] = key.split(':');
      const project = this._projects.find((p) =>
        p.sessions.some((s) => s.sessionId === sessionId)
      );

      hits.push({
        projectKey: project?.key ?? '',
        projectPath: project?.path ?? '',
        sessionId,
        agentId,
        uuid: '',
        role: 'user',
        scope: 'note',
        snippet: haystack,
        matchStart: match.index,
        matchLength: match[0].length,
      });
    }

    return hits;
  }

  /** Tag filtering happens here because tags live in globalState, not on disk. */
  private _matchTags(query: SearchQuery): SearchQuery {
    if (!query.tags?.length) return query;

    const meta = this._getSessionMeta();
    const wanted = new Set(query.tags);
    const keys = new Set<string>();
    for (const [key, entry] of Object.entries(meta)) {
      if (entry.tags?.some((t) => wanted.has(t))) { keys.add(key.split(':')[0]); }
    }

    return { ...query, tags: undefined, sessionIds: Array.from(keys) };
  }

  private _handleFileUsage(filePath: string, includeHeuristic: boolean): void {
    this._searchAbort?.abort();
    const controller = new AbortController();
    this._searchAbort = controller;

    void (async () => {
      try {
        const targets = await listScanTargets();
        const sessions = await findFileUsage(filePath, targets, controller.signal, {
          includeHeuristic,
        });
        this._panel.webview.postMessage({ command: 'fileUsage', path: filePath, sessions });
      } catch (e: unknown) {
        this._panel.webview.postMessage({
          command: 'fileUsage',
          path: filePath,
          sessions: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }

  private _handleTimeline(): void {
    void (async () => {
      try {
        const targets = await listScanTargets();
        const days = await buildTimeline(targets, new AbortController().signal);
        this._panel.webview.postMessage({ command: 'timeline', days });
      } catch (e: unknown) {
        this._panel.webview.postMessage({
          command: 'timeline',
          days: [],
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }

  private _setupFileWatcher(projectKey: string, sessionId: string, agentId?: string): void {
    this._teardownFileWatcher();

    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    const filePath = agentId
      ? path.join(projectsDir, projectKey, sessionId, 'subagents', `agent-${agentId}.jsonl`)
      : path.join(projectsDir, projectKey, `${sessionId}.jsonl`);

    if (!fs.existsSync(filePath)) return;

    this._watchedProjectKey = projectKey;
    this._watchedSessionId = sessionId;
    this._watchedAgentId = agentId;

    try {
      this._fileWatcher = fs.watch(filePath, () => {
        if (this._watchDebounceTimer) { clearTimeout(this._watchDebounceTimer); }
        this._watchDebounceTimer = setTimeout(() => {
          this._sendConversationTail();
        }, 500);
      });
    } catch {
      // fs.watch unavailable — 30s poll is the fallback
    }
  }

  /** Close the watcher but preserve watched IDs (for pause/resume on visibility). */
  private _pauseFileWatcher(): void {
    if (this._fileWatcher) {
      this._fileWatcher.close();
      this._fileWatcher = undefined;
    }
    if (this._watchDebounceTimer) {
      clearTimeout(this._watchDebounceTimer);
      this._watchDebounceTimer = undefined;
    }
  }

  /** Close the watcher AND clear all watched IDs. */
  private _teardownFileWatcher(): void {
    this._pauseFileWatcher();
    this._watchedProjectKey = undefined;
    this._watchedSessionId = undefined;
    this._watchedAgentId = undefined;
    // _currentCwd and _currentSessionId are intentionally NOT cleared here.
    // _teardownFileWatcher is called by _setupFileWatcher on every loadConversation,
    // so clearing them here would immediately nullify the values set by the handler.
  }

  private _sendConversationTail(): void {
    if (!this._watchedProjectKey || !this._watchedSessionId) return;
    const messages = readConversation(
      this._watchedProjectKey,
      this._watchedSessionId,
      this._watchedAgentId
    );
    this._panel.webview.postMessage({
      command: 'conversationTail',
      messages,
      sessionId: this._watchedSessionId,
      agentId: this._watchedAgentId,
    });

    // Targeted sidebar update for the watched session
    const projects = readClaudeProjects();
    this._projects = projects;
    const project = projects.find((p) => p.key === this._watchedProjectKey);
    if (project) {
      const session = project.sessions.find((s) => s.sessionId === this._watchedSessionId);
      if (session) {
        this._panel.webview.postMessage({
          command: 'sidebarRowUpdate',
          sessionId: session.sessionId,
          lastMessageRole: session.lastMessageRole,
          status: session.status,
          lastTimestamp: session.lastTimestamp,
          messageCount: session.messageCount,
        });
      }
    }
  }

  private async _handleExportChat(projectKey: string, sessionId: string): Promise<void> {
    try {
      const project = this._projects.find((p) => p.key === projectKey);
      if (!project) {
        vscode.window.showErrorMessage('Claude Code Agent Manager: Project not found.');
        this._panel.webview.postMessage({ command: 'exportDone' });
        return;
      }
      const session = project.sessions.find((s) => s.sessionId === sessionId);
      if (!session) {
        vscode.window.showErrorMessage('Claude Code Agent Manager: Session not found.');
        this._panel.webview.postMessage({ command: 'exportDone' });
        return;
      }

      const settings = this._getSettings();
      const outPath = await this._resolveExportPath(session, project, settings);
      if (!outPath) {
        // User cancelled dialog — silent abort
        this._panel.webview.postMessage({ command: 'exportDone' });
        return;
      }

      const result = exportConversation(
        { projectKey, sessionId, displayName: project.displayName, session, readConversation },
        settings,
        outPath,
      );

      let msg = `Exported to ${result.rootPath}`;
      if (result.skippedAgents > 0) {
        msg += ` (${result.skippedAgents} agent(s) could not be read)`;
      }
      vscode.window.showInformationMessage(msg);
    } catch (e: unknown) {
      vscode.window.showErrorMessage(
        `Claude Code Agent Manager: Export failed: ${e instanceof Error ? e.message : String(e)}`
      );
    } finally {
      this._panel.webview.postMessage({ command: 'exportDone' });
    }
  }

  private async _resolveExportPath(
    session: ClaudeSession,
    project: ClaudeProject,
    settings: ManagerSettings,
  ): Promise<string | undefined> {
    const template = settings.exportTemplate ?? 'dialog';

    if (template === 'dialog') {
      const raw = session.firstPrompt ?? session.sessionId.slice(0, 8);
      const filename = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) + '.md';
      return this._showSaveDialog(filename);
    }

    const resolved = expandTemplate(template, session, project);
    if (!resolved) {
      vscode.window.showWarningMessage(
        'Export template resolved to an invalid path. Please update your export template in settings.'
      );
      const raw = session.firstPrompt ?? session.sessionId.slice(0, 8);
      const filename = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) + '.md';
      return this._showSaveDialog(filename);
    }

    // Create directory
    const dir = path.dirname(resolved);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e: unknown) {
      vscode.window.showErrorMessage(
        `Claude Code Agent Manager: Failed to create export directory: ${e instanceof Error ? e.message : String(e)}`
      );
      return undefined;
    }

    // Collision handling and content dedup are done inside exportConversation
    return resolved;
  }

  private async _showSaveDialog(filename: string, fullPath?: string): Promise<string | undefined> {
    const defaultUri = fullPath
      ? vscode.Uri.file(fullPath)
      : vscode.Uri.file(path.join(os.homedir(), 'Documents', filename));
    const uri = await vscode.window.showSaveDialog({
      defaultUri,
      filters: { 'Markdown': ['md'] },
    });
    return uri?.fsPath;
  }

  private _getHtml(webview: vscode.Webview): string {
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'marked.min.js')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._context.extensionUri, 'media', 'style.css')
    );
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link href="${styleUri}" rel="stylesheet">
  <title>Agent Manager</title>
</head>
<body>
  <div id="app">
    <!-- ── Left Sidebar ── -->
    <div id="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title" title="Keyboard: j/k to navigate, ? for help">Agent Manager</span>
        <div class="sidebar-actions">
          <span class="last-updated" id="last-updated"></span>
          <button class="icon-btn" id="refresh-btn" title="Refresh">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.5 2.5a.5.5 0 0 1 .5.5v3a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1 0-1h1.79A5.5 5.5 0 1 0 13.5 8a.5.5 0 0 1 1 0 6.5 6.5 0 1 1-2.035-4.715L13.5 2.5z"/></svg>
          </button>
          <div class="settings-wrap">
            <button class="icon-btn" id="settings-btn" title="Settings">
              <svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M6.562 1.94a1.5 1.5 0 0 1 2.876 0l.213.806a.5.5 0 0 0 .691.305l.763-.357a1.5 1.5 0 0 1 2.035 2.035l-.357.763a.5.5 0 0 0 .305.691l.806.213a1.5 1.5 0 0 1 0 2.876l-.806.213a.5.5 0 0 0-.305.691l.357.763a1.5 1.5 0 0 1-2.035 2.035l-.763-.357a.5.5 0 0 0-.691.305l-.213.806a1.5 1.5 0 0 1-2.876 0l-.213-.806a.5.5 0 0 0-.691-.305l-.763.357a1.5 1.5 0 0 1-2.035-2.035l.357-.763a.5.5 0 0 0-.305-.691l-.806-.213a1.5 1.5 0 0 1 0-2.876l.806-.213a.5.5 0 0 0 .305-.691l-.357-.763a1.5 1.5 0 0 1 2.035-2.035l.763.357a.5.5 0 0 0 .691-.305l.213-.806zM8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z"/></svg>
            </button>
            <div class="settings-panel" id="settings-panel">
              <div class="settings-title">Notification Settings</div>
              <label class="settings-row">
                <input type="checkbox" id="sound-enabled" />
                <span>Sound when waiting for input</span>
              </label>
              <div class="settings-row repeat-row">
                <label for="sound-repeat">Repeat every</label>
                <select id="sound-repeat">
                  <option value="0">Never</option>
                  <option value="30">30s</option>
                  <option value="60">1 min</option>
                  <option value="120">2 min</option>
                  <option value="300">5 min</option>
                </select>
              </div>
              <button class="settings-test-btn" id="test-sound-btn">Test sound</button>
              <div class="settings-divider"></div>
              <div class="settings-title">Export Settings</div>
              <div class="settings-group-label">Export path</div>
              <textarea id="export-template" class="settings-template-input" placeholder="~/Documents/claude-exports/{slug}.md" rows="1" spellcheck="false"></textarea>
              <div class="export-preset-row">
                <button class="export-preset-btn" id="preset-dialog">Ask each time</button>
                <button class="export-preset-btn" id="preset-default">Default path</button>
                <button class="export-preset-btn" id="preset-cwd">Session dir</button>
              </div>
              <details class="export-token-hint">
                <summary>Available tokens</summary>
                <div class="export-token-list">
                  <span class="token">{date}</span> <span class="token">{yyyy}</span> <span class="token">{yy}</span> <span class="token">{mm}</span> <span class="token">{dd}</span>
                  <span class="token">{slug}</span> <span class="token">{short-slug}</span> <span class="token">{project}</span>
                  <span class="token">{branch}</span> <span class="token">{session-id}</span> <span class="token">{cwd}</span>
                </div>
              </details>
              <label class="settings-row">
                <input type="checkbox" id="export-wiki-links" />
                <span>Use Obsidian wiki links ([[…]])</span>
              </label>
              <div class="settings-group-label">Tool calls</div>
              <label class="settings-radio-row">
                <input type="radio" name="export-tool" value="compact" id="export-tool-compact" />
                <span>Compact</span>
              </label>
              <label class="settings-radio-row">
                <input type="radio" name="export-tool" value="expanded" id="export-tool-expanded" />
                <span>Expanded</span>
              </label>
              <label class="settings-radio-row">
                <input type="radio" name="export-tool" value="omit" id="export-tool-omit" />
                <span>Omit</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div class="search-wrap">
        <svg class="search-icon" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001c.03.04.062.078.098.115l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85a1.007 1.007 0 0 0-.115-.1zM12 6.5a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0z"/>
        </svg>
        <input type="text" id="search" placeholder="Filter projects…" autocomplete="off" spellcheck="false" />
        <button class="clear-btn" id="clear-search" title="Clear">&times;</button>
      </div>

      <div class="filter-bar" id="filter-bar">
        <button class="filter-chip" data-filter="active"><span class="status-dot tiny active"></span>Active</button>
        <button class="filter-chip" data-filter="waiting"><span class="status-dot tiny waiting"></span>Waiting</button>
        <button class="filter-chip" data-filter="pinned">Pinned</button>
      </div>

      <div id="projects-container">
        <div class="loading">
          <div class="spinner"></div>
          Loading…
        </div>
      </div>
    </div>

    <div id="sidebar-resize-handle"></div>

    <!-- ── Main Panel ── -->
    <div id="main-panel">
      <div id="tab-bar">
        <button class="tab-btn active" data-tab="sessions">Agents</button>
        <button class="tab-btn" data-tab="stats">Stats</button>
        <button class="tab-btn" data-tab="health">Health</button>
        <button class="tab-btn" data-tab="about">About</button>
        <button class="tab-btn" data-tab="search">Search</button>
        <button class="tab-btn" data-tab="timeline">Timeline</button>
      </div>
      <div id="conversation-header">
        <span id="conv-breadcrumb">Select a session to view its conversation</span>
        <span id="live-indicator" class="live-indicator">
          <span class="live-dot"></span>
          LIVE
        </span>
        <button class="action-btn" id="focus-btn" title="Focus terminal" style="display:none">&#10548; Focus</button>
        <button class="action-btn" id="send-btn" title="Send message" style="display:none">&#9993; Send</button>
        <button class="action-btn" id="notes-btn" title="Notes and tags" style="display:none">&#9998; Notes</button>
        <button class="export-btn" id="export-btn" title="Export conversation">Export</button>
      </div>
      <div id="conversation-container" tabindex="0">
        <div class="conv-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="conv-empty-icon">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <p>Click on a session or agent in the sidebar to view the conversation.</p>
        </div>
      </div>
      <div id="health-container" style="display:none">
        <div class="health-loading">Loading hook status…</div>
      </div>
      <div id="send-bar">
        <div id="send-bar-inner">
          <textarea id="send-input" placeholder="Send a message to Claude…" rows="1" spellcheck="false"></textarea>
          <button id="send-submit-btn" disabled>Send</button>
        </div>
        <div id="send-error"></div>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  public dispose(): void {
    AgentManagerPanel.currentPanel = undefined;
    if (this._refreshTimer) { clearInterval(this._refreshTimer); }
    this._teardownFileWatcher();
    this._terminalManager.dispose();
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}

function getNonce(): string {
  const chars =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length))
  ).join('');
}
