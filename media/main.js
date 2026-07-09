// @ts-check
/* global marked */
(function () {
  const vscode = acquireVsCodeApi();

  // Fixed colors per tool (consistent across renders)
  const TOOL_COLORS = {
    Bash:       '#007acc',
    Read:       '#4ec9b0',
    Edit:       '#e8a030',
    Write:      '#cc6633',
    Grep:       '#9b59b6',
    Glob:       '#2ecc71',
    WebSearch:  '#e74c3c',
    WebFetch:   '#3498db',
    Agent:      '#f39c12',
    TodoWrite:  '#1abc9c',
    ToolSearch: '#e67e22',
    Skill:      '#8e44ad',
  };
  const TOOL_COLOR_DEFAULT = '#7f8c8d';

  // Minimal 16x16 stroke-based SVG icons for tools (displayed on donut chart)
  const TOOL_ICONS = {
    Bash:       '<path d="M4 4l4 4-4 4" stroke-width="2"/><line x1="9" y1="12" x2="13" y2="12" stroke-width="2"/>',
    Read:       '<circle cx="8" cy="8" r="2" fill="white"/><path d="M1 8c2-4 5-6 7-6s5 2 7 6c-2 4-5 6-7 6s-5-2-7-6z" stroke-width="1.5"/>',
    Edit:       '<path d="M2 14l1-4L11 2l3 3-8 8z" fill="none" stroke-width="1.5"/>',
    Write:      '<path d="M4 2v12h8V6l-4-4H4z" fill="none" stroke-width="1.5"/>',
    Grep:       '<circle cx="7" cy="7" r="4" fill="none" stroke-width="2"/><line x1="10" y1="10" x2="14" y2="14" stroke-width="2"/>',
    Glob:       '<path d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" fill="none" stroke-width="1.2"/>',
    WebSearch:  '<circle cx="8" cy="8" r="6" fill="none" stroke-width="1.5"/><line x1="2" y1="8" x2="14" y2="8" stroke-width="1"/><path d="M8 2c-2.5 3-2.5 9 0 12M8 2c2.5 3 2.5 9 0 12" fill="none" stroke-width="1"/>',
    WebFetch:   '<path d="M3 3h10v10H3z" fill="none" stroke-width="1.5"/><line x1="3" y1="7" x2="13" y2="7" stroke-width="1.5"/>',
    Agent:      '<circle cx="8" cy="5" r="3" fill="none" stroke-width="1.5"/><path d="M3 15c0-3 2.5-5 5-5s5 2 5 5" fill="none" stroke-width="1.5"/>',
    TodoWrite:  '<path d="M3 4l2 2 4-4" fill="none" stroke-width="2"/><line x1="3" y1="12" x2="13" y2="12" stroke-width="1.5"/>',
  };

  let allProjects = [];
  let filterText = '';
  let activeFilter = 'all';
  let pinnedKeys = new Set();
  let settings = { soundEnabled: false, soundRepeatSec: 0, exportTemplate: '~/Documents/claude-exports/{slug}.md', exportLinkStyle: 'markdown', exportToolFormat: 'compact' };
  let previousWaitingIds = new Set();
  let soundRepeatTimer = null;
  let audioCtx = null;

  // Currently selected conversation
  /** @type {string | null} */
  let selectedSessionId = null;
  /** @type {string | null} */
  let selectedAgentId = null;
  /** @type {string | null} */
  let selectedProjectKey = null;
  let exportInProgress = false;
  let sendBarOpen = false;
  let sendInFlight = false;
  /** @type {string | null} */
  let currentSessionCwd = null;
  let hasLiveTerminal = false;
  /** @type {HTMLElement | null} */
  let _dropdownActiveBtn = null;

  // Forward declarations for later tasks (Task 3 will declare properly)
  let focusedIndex = -1;
  let layoutMode = 'wide';
  let renderedMessageCount = 0;

  // Tailing state
  /** @type {ReturnType<typeof setTimeout> | null} */
  let liveTimeout = null;
  let isUserAtBottom = true;

  // Sidebar expansion state — tracks which project keys are expanded
  /** @type {Set<string>} */
  let expandedProjectKeys = new Set();

  /** @type {Map<string, number>} projectKey → number of extra batches loaded (0 = default 8) */
  const expandedBatchCounts = new Map();

  /** @type {WeakSet<Element>} tracks elements that already have sidebar event listeners */
  const boundSidebarElements = new WeakSet();

  // Keyboard navigation state
  let sidebarHasFocus = true;
  let lastGPress = 0;
  let helpOverlayVisible = false;

  // Tab bar state
  /** @type {'sessions' | 'stats' | 'health' | 'about'} */
  let activeTab = 'sessions';
  /** @type {string | null} project key selected for stats (null = all) */
  let statsProjectKey = null;
  /** @type {'today' | '7d' | '30d' | 'all'} */
  let statsTimeRange = 'all';
  /** @type {any | null} */
  let currentHealthReport = null;

  // Sidebar resize state
  let sidebarWidth = 280;

  // Scroll tracking for conversation container
  const convContainerEl = document.getElementById('conversation-container');
  if (convContainerEl) {
    convContainerEl.addEventListener('scroll', function () {
      const threshold = 50;
      isUserAtBottom = (this.scrollHeight - this.scrollTop - this.clientHeight) < threshold;
      if (isUserAtBottom) {
        const pill = document.getElementById('new-msg-pill');
        if (pill) pill.remove();
        const div = document.querySelector('.new-msg-divider');
        if (div) div.remove();
      }
    });
  }

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const width = entry.contentRect.width;
      const newMode = width > 600 ? 'wide' : 'narrow';
      if (newMode !== layoutMode) {
        layoutMode = newMode;
        applyLayoutMode();
      }
    }
  });
  const appEl = document.getElementById('app');
  if (appEl) resizeObserver.observe(appEl);

  // Restore webview-local state
  const saved = vscode.getState();
  if (saved) {
    activeFilter = saved.activeFilter || 'all';
    filterText = saved.filterText || '';
    if (saved.sidebarWidth) sidebarWidth = saved.sidebarWidth;
  }

  // Apply persisted sidebar width
  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl) sidebarEl.style.width = sidebarWidth + 'px';

  // ── Message from extension ──────────────────────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.command === 'update') {
      allProjects = msg.projects ?? [];
      if (msg.pinnedKeys) pinnedKeys = new Set(msg.pinnedKeys);
      // Skip settings sync while the panel is open to avoid resetting the user's
      // in-progress edits (cursor position, typed text) during auto-refresh.
      if (msg.settings && !settingsPanel.classList.contains('open')) {
        settings = msg.settings;
        syncSettingsUI();
      }
      renderSidebar(filtered());
      checkWaitingAndNotify();
      // Refresh stats view if it's currently displayed
      if (activeTab === 'stats') showStats();
      document.getElementById('last-updated').textContent =
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    if (msg.command === 'conversation') {
      currentSessionCwd = msg.cwd ?? null;
      hasLiveTerminal = false;
      const focusBtn = document.getElementById('focus-btn');
      if (focusBtn) focusBtn.style.display = 'none';
      if (activeTab === 'sessions') {
        renderConversation(msg.messages, msg.sessionId, msg.agentId);
      }
    }
    if (msg.command === 'exportDone') {
      exportInProgress = false;
      exportBtn.disabled = false;
    }
    if (msg.command === 'conversationTail') {
      if (activeTab === 'sessions') {
        handleConversationTail(msg.messages, msg.sessionId, msg.agentId);
      }
    }
    if (msg.command === 'sidebarRowUpdate') {
      handleSidebarRowUpdate(msg);
    }
    if (msg.command === 'terminalStatus') {
      if (msg.cwd === currentSessionCwd) {
        hasLiveTerminal = msg.hasTerminal;
        const focusBtn = document.getElementById('focus-btn');
        if (focusBtn) focusBtn.style.display = hasLiveTerminal ? 'inline-block' : 'none';
      }
    }
    if (msg.command === 'sendMessageResult') {
      sendInFlight = false;
      const submitBtn = document.getElementById('send-submit-btn');
      const input = document.getElementById('send-input');
      const errorEl = document.getElementById('send-error');
      if (msg.success) {
        if (input) { input.value = ''; input.style.height = ''; }
        if (submitBtn) { submitBtn.textContent = 'Send'; submitBtn.disabled = true; }
        if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('visible'); }
      } else {
        if (input) input.disabled = false;
        if (submitBtn) { submitBtn.textContent = 'Send'; submitBtn.disabled = false; }
        if (errorEl) { errorEl.textContent = msg.error || 'Send failed'; errorEl.classList.add('visible'); }
      }
    }
    if (msg.command === 'hooksHealth') {
      currentHealthReport = msg.payload;
      if (activeTab === 'health') {
        const convContainer = document.getElementById('conversation-container');
        if (convContainer) {
          convContainer.innerHTML = renderHealthView(currentHealthReport);
          convContainer.style.display = '';
          // Attach event listeners for hook expansion and refresh
          convContainer.querySelectorAll('.health-hook-header').forEach((header) => {
            header.addEventListener('click', () => {
              header.closest('.health-hook').classList.toggle('expanded');
            });
          });
          const refreshBtn = convContainer.querySelector('#health-refresh');
          if (refreshBtn) {
            refreshBtn.addEventListener('click', () => {
              vscode.postMessage({ command: 'getHooksHealth' });
            });
          }
        }
      }
    }
  });

  // ── Toolbar ──────────────────────────────────────────────────────────────────
  document.getElementById('refresh-btn').addEventListener('click', () => {
    expandedBatchCounts.clear();
    document.getElementById('last-updated').textContent = '…';
    vscode.postMessage({ command: 'refresh' });
  });

  // ── Search ───────────────────────────────────────────────────────────────────
  const searchInput = document.getElementById('search');
  const clearBtn = document.getElementById('clear-search');

  if (filterText) {
    searchInput.value = filterText;
    clearBtn.style.display = 'flex';
  }

  searchInput.addEventListener('input', (e) => {
    filterText = e.target.value.toLowerCase();
    clearBtn.style.display = filterText ? 'flex' : 'none';
    renderSidebar(filtered());
    saveState();
  });

  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    filterText = '';
    clearBtn.style.display = 'none';
    renderSidebar(filtered());
    searchInput.focus();
    saveState();
  });

  // ── Filter bar ─────────────────────────────────────────────────────────────
  const filterBar = document.getElementById('filter-bar');

  filterBar.querySelectorAll('.filter-chip').forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.filter === activeFilter);
  });

  filterBar.addEventListener('click', (e) => {
    const chip = e.target.closest('.filter-chip');
    if (!chip) return;
    // Toggle: clicking the active filter deselects it (back to all)
    if (chip.classList.contains('selected')) {
      activeFilter = 'all';
    } else {
      activeFilter = chip.dataset.filter;
    }
    filterBar.querySelectorAll('.filter-chip').forEach((c) => {
      c.classList.toggle('selected', c.dataset.filter === activeFilter);
    });
    renderSidebar(filtered());
    saveState();
  });

  // ── Export button ──────────────────────────────────────────────────────────
  const exportBtn = document.getElementById('export-btn');

  exportBtn.addEventListener('click', () => {
    if (exportInProgress || !selectedSessionId || !selectedProjectKey) return;
    exportInProgress = true;
    exportBtn.disabled = true;
    vscode.postMessage({ command: 'exportChat', projectKey: selectedProjectKey, sessionId: selectedSessionId });
  });

  const focusBtnEl = document.getElementById('focus-btn');
  if (focusBtnEl) {
    focusBtnEl.addEventListener('click', () => {
      vscode.postMessage({ command: 'focusTerminal' });
    });
  }

  const sendBtnEl = document.getElementById('send-btn');
  if (sendBtnEl) {
    sendBtnEl.addEventListener('click', () => {
      if (sendBarOpen) {
        closeSendBar();
      } else {
        openSendBar();
      }
    });
  }

  // ── Settings ───────────────────────────────────────────────────────────────
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const soundEnabledCb = document.getElementById('sound-enabled');
  const soundRepeatSel = document.getElementById('sound-repeat');
  const testSoundBtn = document.getElementById('test-sound-btn');

  settingsBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    settingsPanel.classList.toggle('open');
    // Recalculate textarea height now that the panel is visible (scrollHeight is 0 when hidden).
    if (settingsPanel.classList.contains('open')) {
      resizeTemplateInput();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.settings-wrap')) {
      settingsPanel.classList.remove('open');
    }
  });

  document.addEventListener('click', function (e) {
    const btn = /** @type {HTMLElement} */ (e.target).closest('.hash-btn');
    if (btn) {
      const dropdown = document.getElementById('hash-dropdown');
      if (dropdown && dropdown.style.display !== 'none' && _dropdownActiveBtn === btn) {
        closeHashDropdown();
      } else {
        openHashDropdown(/** @type {HTMLElement} */ (btn));
      }
      return;
    }
    if (!/** @type {HTMLElement} */ (e.target).closest('#hash-dropdown')) {
      closeHashDropdown();
    }
  });

  soundEnabledCb.addEventListener('change', () => {
    settings.soundEnabled = soundEnabledCb.checked;
    pushSettings();
  });

  soundRepeatSel.addEventListener('change', () => {
    settings.soundRepeatSec = Number.parseInt(soundRepeatSel.value, 10);
    pushSettings();
    resetRepeatTimer();
  });

  testSoundBtn.addEventListener('click', () => {
    playNotificationSound();
  });

  const exportTemplateInput = document.getElementById('export-template');
  const exportWikiLinksCb = document.getElementById('export-wiki-links');
  /** Last known cursor position in the template input; null = never interacted. */
  let exportTemplateCursorPos = null;

  function resizeTemplateInput() {
    if (!exportTemplateInput) return;
    exportTemplateInput.style.height = 'auto';
    exportTemplateInput.style.height = exportTemplateInput.scrollHeight + 'px';
  }

  if (exportTemplateInput) {
    // Capture cursor position on blur so token clicks can insert at the right spot.
    // blur fires before click, so the stored value is always from the last edit position.
    exportTemplateInput.addEventListener('blur', () => {
      exportTemplateCursorPos = exportTemplateInput.selectionStart;
    });
    // Prevent Enter from inserting newlines into a path string.
    exportTemplateInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); }
    });
    exportTemplateInput.addEventListener('input', () => {
      resizeTemplateInput();
      settings.exportTemplate = exportTemplateInput.value;
      pushSettings();
    });
  }

  function insertTokenAtCursor(tokenText) {
    if (!exportTemplateInput) return;
    const val = exportTemplateInput.value;
    let insertPos;

    if (exportTemplateCursorPos === null) {
      // Input never interacted with — insert before .md extension at end
      const mdIdx = val.lastIndexOf('.md');
      insertPos = mdIdx >= 0 ? mdIdx : val.length;
    } else {
      // If the cursor was inside a {token}, jump past its closing }
      const before = val.slice(0, exportTemplateCursorPos);
      const lastOpen = before.lastIndexOf('{');
      if (lastOpen !== -1 && !before.slice(lastOpen).includes('}')) {
        const closingBrace = val.indexOf('}', exportTemplateCursorPos);
        insertPos = closingBrace >= 0 ? closingBrace + 1 : exportTemplateCursorPos;
      } else {
        insertPos = exportTemplateCursorPos;
      }
    }

    exportTemplateInput.value = val.slice(0, insertPos) + tokenText + val.slice(insertPos);
    const newPos = insertPos + tokenText.length;
    exportTemplateCursorPos = newPos;
    settings.exportTemplate = exportTemplateInput.value;
    pushSettings();
    resizeTemplateInput();
    exportTemplateInput.focus();
    // Defer selection to the next frame so the browser settles focus first,
    // which ensures the input scrolls to show the cursor rather than the end.
    requestAnimationFrame(() => {
      exportTemplateInput.setSelectionRange(newPos, newPos);
    });
  }

  document.querySelectorAll('.export-token-list .token').forEach((tokenEl) => {
    tokenEl.addEventListener('click', () => {
      insertTokenAtCursor(tokenEl.textContent.trim());
    });
  });

  const presetDialog = document.getElementById('preset-dialog');
  const presetDefault = document.getElementById('preset-default');
  const presetCwd = document.getElementById('preset-cwd');

  if (presetDialog) {
    presetDialog.addEventListener('click', () => {
      exportTemplateInput.value = 'dialog';
      settings.exportTemplate = 'dialog';
      pushSettings();
      resizeTemplateInput();
    });
  }

  if (presetDefault) {
    presetDefault.addEventListener('click', () => {
      exportTemplateInput.value = '~/Documents/claude-exports/{slug}.md';
      settings.exportTemplate = '~/Documents/claude-exports/{slug}.md';
      pushSettings();
      resizeTemplateInput();
    });
  }

  if (presetCwd) {
    presetCwd.addEventListener('click', () => {
      exportTemplateInput.value = '{cwd}/{slug}.md';
      settings.exportTemplate = '{cwd}/{slug}.md';
      pushSettings();
      resizeTemplateInput();
    });
  }

  if (exportWikiLinksCb) {
    exportWikiLinksCb.addEventListener('change', () => {
      settings.exportLinkStyle = exportWikiLinksCb.checked ? 'wiki' : 'markdown';
      pushSettings();
    });
  }

  document.querySelectorAll('input[name="export-tool"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      settings.exportToolFormat = radio.value;
      pushSettings();
    });
  });

  function syncSettingsUI() {
    soundEnabledCb.checked = settings.soundEnabled;
    soundRepeatSel.value = String(settings.soundRepeatSec);
    if (exportTemplateInput) {
      exportTemplateInput.value = settings.exportTemplate || '~/Documents/claude-exports/{slug}.md';
      resizeTemplateInput();
    }
    if (exportWikiLinksCb) {
      exportWikiLinksCb.checked = settings.exportLinkStyle === 'wiki';
    }
    const toolRadio = document.querySelector(`input[name="export-tool"][value="${settings.exportToolFormat || 'compact'}"]`);
    if (toolRadio) toolRadio.checked = true;
  }

  function pushSettings() {
    vscode.postMessage({ command: 'updateSettings', settings });
  }

  // ── State persistence ──────────────────────────────────────────────────────
  function saveState() {
    // statsTimeRange is intentionally not persisted — acceptable tradeoff for simplicity.
    vscode.setState({ activeFilter, filterText, sidebarWidth });
  }

  // ── Sound system ───────────────────────────────────────────────────────────
  function getAudioCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function playNotificationSound() {
    try {
      const ctx = getAudioCtx();
      const now = ctx.currentTime;
      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.value = 880;
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      gain1.gain.setValueAtTime(0.15, now);
      gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
      osc1.start(now);
      osc1.stop(now + 0.15);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.value = 1175;
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      gain2.gain.setValueAtTime(0.15, now + 0.15);
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.35);
      osc2.start(now + 0.15);
      osc2.stop(now + 0.35);
    } catch (_) {
      // Audio API unavailable
    }
  }

  // ── Waiting detection ──────────────────────────────────────────────────────
  function isItemWaiting(item) {
    if (!item.lastTimestamp) return false;
    const mins = (Date.now() - new Date(item.lastTimestamp).getTime()) / 60000;
    return mins < 5 && item.status === 'waiting';
  }

  function isProjectWaiting(project) {
    return project.sessions.some(
      (s) => isItemWaiting(s) || s.subAgents.some((a) => isItemWaiting(a))
    );
  }

  function isProjectActive(project) {
    if (!project.lastActivity) return false;
    return (Date.now() - new Date(project.lastActivity).getTime()) < 5 * 60 * 1000;
  }

  function checkWaitingAndNotify() {
    // Only track sessions for sound notifications, not subagents
    const waitingIds = new Set();
    for (const p of allProjects) {
      for (const s of p.sessions) {
        if (isItemWaiting(s)) waitingIds.add(s.sessionId);
      }
    }
    const hasNew = [...waitingIds].some((id) => !previousWaitingIds.has(id));
    if (hasNew && settings.soundEnabled) {
      playNotificationSound();
    }
    previousWaitingIds = waitingIds;
    resetRepeatTimer();
  }

  function resetRepeatTimer() {
    if (soundRepeatTimer) {
      clearInterval(soundRepeatTimer);
      soundRepeatTimer = null;
    }
    if (previousWaitingIds.size > 0 && settings.soundEnabled && settings.soundRepeatSec > 0) {
      soundRepeatTimer = setInterval(() => {
        const stillWaiting = allProjects.some((p) => p.sessions.some((s) => isItemWaiting(s)));
        if (stillWaiting) {
          playNotificationSound();
        } else {
          clearInterval(soundRepeatTimer);
          soundRepeatTimer = null;
        }
      }, settings.soundRepeatSec * 1000);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  function filtered() {
    let list = allProjects;
    if (activeFilter === 'active') {
      list = list.filter((p) => isProjectActive(p));
    } else if (activeFilter === 'waiting') {
      list = list.filter((p) => isProjectWaiting(p));
    } else if (activeFilter === 'pinned') {
      list = list.filter((p) => pinnedKeys.has(p.key));
    }
    if (filterText) {
      list = list.filter(
        (p) =>
          p.displayName.toLowerCase().includes(filterText) ||
          p.path.toLowerCase().includes(filterText)
      );
    }
    if (activeFilter !== 'pinned') {
      list = [...list].sort((a, b) => {
        const ap = pinnedKeys.has(a.key) ? 1 : 0;
        const bp = pinnedKeys.has(b.key) ? 1 : 0;
        if (ap !== bp) return bp - ap;
        return 0;
      });
    }
    return list;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diff = Date.now() - new Date(ts).getTime();
    const s = Math.floor(diff / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (s < 60) return 'just now';
    if (m < 60) return `${m}m ago`;
    if (h < 24) return `${h}h ago`;
    if (d < 7) return `${d}d ago`;
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function statusClass(ts, precomputedStatus) {
    if (!ts) return 'idle';
    const mins = (Date.now() - new Date(ts).getTime()) / 60000;
    if (mins < 5) {
      if (precomputedStatus === 'thinking') return 'thinking';
      if (precomputedStatus === 'waiting') return 'waiting';
      return 'active';
    }
    if (mins < 120) return 'recent';
    return 'idle';
  }

  function projectStatusClass(project) {
    if (isProjectWaiting(project)) return 'waiting';
    if (!project.lastActivity) return 'idle';
    const mins = (Date.now() - new Date(project.lastActivity).getTime()) / 60000;
    if (mins < 5) return 'active';
    if (mins < 120) return 'recent';
    return 'idle';
  }

  function esc(str) {
    if (!str) return '';
    return String(str)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;');
  }

  function trunc(str, n) {
    if (!str) return '';
    str = str.replaceAll(/\s+/g, ' ').trim();
    return str.length > n ? str.slice(0, n) + '…' : str;
  }

  // ── Responsive layout ──────────────────────────────────────────────────────
  function applyLayoutMode() {
    const app = document.getElementById('app');
    const handle = document.getElementById('sidebar-resize-handle');
    if (!app) return;

    if (layoutMode === 'narrow') {
      app.classList.add('narrow-mode');
      if (handle) handle.style.display = 'none';
    } else {
      app.classList.remove('narrow-mode');
      if (handle) handle.style.display = '';
      closeSidebarOverlay();
    }
  }

  // ── Sidebar resize ────────────────────────────────────────────────────────
  (function initSidebarResize() {
    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;

    let dragging = false;

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      dragging = true;
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      const mainPanel = document.getElementById('main-panel');
      if (mainPanel) mainPanel.style.pointerEvents = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const appRect = document.getElementById('app').getBoundingClientRect();
      const newWidth = Math.min(500, Math.max(180, e.clientX - appRect.left));
      sidebarWidth = newWidth;
      sidebar.style.width = newWidth + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      const mainPanel = document.getElementById('main-panel');
      if (mainPanel) mainPanel.style.pointerEvents = '';
      saveState();
    });

    handle.addEventListener('dblclick', () => {
      sidebarWidth = 280;
      sidebar.style.width = '280px';
      saveState();
    });
  })();

  function openSidebarOverlay() {
    closeSidebarOverlay();

    const backdrop = document.createElement('div');
    backdrop.className = 'sidebar-overlay-backdrop';
    backdrop.addEventListener('click', () => closeSidebarOverlay());

    const overlay = document.createElement('div');
    overlay.id = 'sidebar-overlay';
    overlay.className = 'sidebar-overlay';

    // Build overlay content — a minimal sidebar with just the project list
    overlay.innerHTML = `
      <div class="sidebar-header">
        <span class="sidebar-title">Agent Manager</span>
      </div>
      <div id="overlay-projects-container" style="flex:1;overflow-y:auto;padding:2px 0;"></div>
    `;

    const appEl2 = document.getElementById('app');
    if (appEl2) {
      appEl2.appendChild(backdrop);
      appEl2.appendChild(overlay);
    }

    // Render projects into overlay container
    const container = document.getElementById('overlay-projects-container');
    const projects = filtered();
    if (container && projects.length) {
      container.innerHTML = projects.map(renderProject).join('');
      bindSidebarEvents(container, true);
    } else if (container) {
      container.innerHTML = '<div class="empty">No projects</div>';
    }

    // Trigger slide-in animation
    void overlay.offsetHeight;
    overlay.classList.add('open');
  }

  function closeSidebarOverlay() {
    const backdrop = document.querySelector('.sidebar-overlay-backdrop');
    const overlay = document.getElementById('sidebar-overlay');
    if (backdrop) backdrop.remove();
    if (overlay) overlay.remove();
  }

  /**
   * Bind click events for sidebar content. Used by both main sidebar and overlay.
   * @param {HTMLElement} container
   * @param {boolean} closeOverlayOnSelect
   */
  function bindSidebarEvents(container, closeOverlayOnSelect) {
    container.querySelectorAll('[data-action]').forEach((el) => {
      if (boundSidebarElements.has(el)) return;
      boundSidebarElements.add(el);
      const elTyped = /** @type {HTMLElement} */ (el);
      elTyped.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = elTyped.dataset.action;
        if (action === 'select-all') {
          statsProjectKey = null;
          if (activeTab === 'stats') {
            showStats();
          }
          applySelectedState();
          return;
        }
        if (action === 'open') vscode.postMessage({ command: 'openFolder', path: elTyped.dataset.path });
        if (action === 'pin') vscode.postMessage({ command: 'togglePin', key: elTyped.dataset.key });
        if (action === 'load-more') {
          const key = elTyped.dataset.key;
          expandedBatchCounts.set(key, (expandedBatchCounts.get(key) || 0) + 1);
          const projData = allProjects.find((p) => p.key === key);
          if (projData) {
            const el = container.querySelector(`.tree-project[data-key="${CSS.escape(key)}"]`);
            if (el) {
              el.outerHTML = renderProject(projData);
              bindSidebarEvents(container, closeOverlayOnSelect);
            }
          }
        }
      });
    });

    container.querySelectorAll('.tree-project-header').forEach((hdr) => {
      if (boundSidebarElements.has(hdr)) return;
      boundSidebarElements.add(hdr);
      hdr.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest('[data-action]')) return;
        const proj = hdr.closest('.tree-project');
        const key = proj.dataset.key;

        // In stats mode, clicking a project header shows its stats
        if (activeTab === 'stats' && key) {
          statsProjectKey = key;
          showStats();
          applySelectedState();
        }

        proj.classList.toggle('collapsed');
        if (key) {
          if (proj.classList.contains('collapsed')) expandedProjectKeys.delete(key);
          else expandedProjectKeys.add(key);
        }
        // Sync keyboard focus index to clicked project header
        const items = getFlatNavigationList();
        const idx = items.findIndex((item) => item.el === hdr);
        if (idx >= 0) focusedIndex = idx;
      });
    });

    container.querySelectorAll('.tree-session').forEach((row) => {
      if (boundSidebarElements.has(row)) return;
      boundSidebarElements.add(row);
      const rowTyped = /** @type {HTMLElement} */ (row);
      rowTyped.addEventListener('click', (e) => {
        if (/** @type {HTMLElement} */ (e.target).closest('.tree-subagent')) return;
        const key = rowTyped.dataset.projectKey;
        const sid = rowTyped.dataset.sessionId;
        if (key && sid) {
          selectConversation(key, sid, null, rowTyped);
          if (closeOverlayOnSelect) closeSidebarOverlay();
        }
      });
    });

    container.querySelectorAll('.tree-subagent').forEach((row) => {
      if (boundSidebarElements.has(row)) return;
      boundSidebarElements.add(row);
      const rowTyped = /** @type {HTMLElement} */ (row);
      rowTyped.addEventListener('click', (e) => {
        e.stopPropagation();
        const key = rowTyped.dataset.projectKey;
        const sid = rowTyped.dataset.sessionId;
        const aid = rowTyped.dataset.agentId;
        if (key && sid && aid) {
          selectConversation(key, sid, aid, rowTyped);
          if (closeOverlayOnSelect) closeSidebarOverlay();
        }
      });
    });
  }

  // ── Sidebar Render ─────────────────────────────────────────────────────────
  function renderSidebar(projects) {
    const container = document.getElementById('projects-container');
    focusedIndex = -1; // Reset keyboard focus on re-render

    // Snapshot which projects are currently expanded before replacing DOM
    container.querySelectorAll('.tree-project:not(.collapsed)').forEach((el) => {
      const key = el.dataset.key;
      if (key) expandedProjectKeys.add(key);
    });
    container.querySelectorAll('.tree-project.collapsed').forEach((el) => {
      const key = el.dataset.key;
      if (key) expandedProjectKeys.delete(key);
    });

    updateFilterCounts();

    if (!projects.length) {
      let msg = 'No Claude projects found.';
      if (filterText) msg = 'No projects match your filter.';
      else if (activeFilter !== 'all') msg = `No ${activeFilter} projects.`;
      container.innerHTML = `<div class="empty">${msg}</div>`;
      return;
    }

    container.innerHTML = renderAllSessionsEntry() + projects.map(renderProject).join('');

    if (container) bindSidebarEvents(container, false);
    applyPeacockColors(container);
    applySelectedState();
  }

  function applyPeacockColors(container) {
    container.querySelectorAll('[data-peacock]').forEach((el) => {
      el.style.color = el.dataset.peacock;
    });
  }

  function ensureHashDropdown() {
    let el = document.getElementById('hash-dropdown');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'hash-dropdown';
    el.style.display = 'none';
    el.innerHTML =
      '<div class="hash-dropdown-item" data-action="open">Resume/Fork session</div>' +
      '<div class="hash-dropdown-sep"></div>' +
      '<div class="hash-dropdown-item" data-action="id">Copy ID</div>' +
      '<div class="hash-dropdown-item" data-action="cmd">Copy claude -r \u2026</div>' +
      '<div class="hash-dropdown-item" data-action="fork">Copy claude -r \u2026 --fork-session</div>';
    document.body.appendChild(el);
    el.addEventListener('click', function (ev) {
      ev.stopPropagation();
      const item = /** @type {HTMLElement} */ (ev.target).closest('.hash-dropdown-item');
      if (!item) return;
      const id = el.dataset.currentId || '';
      const action = item.dataset.action;
      if (action === 'open') {
        closeHashDropdown();
        vscode.postMessage({ command: 'openInClaudeCode', sessionId: id });
        return;
      }
      const text = action === 'cmd' ? `claude -r ${id}` : action === 'fork' ? `claude -r ${id} --fork-session` : id;
      const activeBtn = _dropdownActiveBtn;
      closeHashDropdown();
      navigator.clipboard.writeText(text).then(() => {
        if (!activeBtn) return;
        const orig = activeBtn.textContent;
        activeBtn.textContent = 'Copied!';
        setTimeout(() => { activeBtn.textContent = orig; }, 1500);
      });
    });
    return el;
  }

  function openHashDropdown(btn) {
    const dropdown = ensureHashDropdown();
    _dropdownActiveBtn = btn;
    dropdown.dataset.currentId = btn.dataset.id || '';
    const short = (btn.dataset.id || '').slice(0, 8);
    const cmdItem = dropdown.querySelector('[data-action="cmd"]');
    if (cmdItem) cmdItem.textContent = `Copy claude -r ${short}\u2026`;
    const forkItem = dropdown.querySelector('[data-action="fork"]');
    if (forkItem) forkItem.textContent = `Copy claude -r ${short}\u2026 --fork-session`;
    const rect = btn.getBoundingClientRect();
    dropdown.style.top = `${rect.bottom + 4}px`;
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.display = 'block';
  }

  function closeHashDropdown() {
    const el = document.getElementById('hash-dropdown');
    if (el) el.style.display = 'none';
    _dropdownActiveBtn = null;
  }

  function selectConversation(projectKey, sessionId, agentId, rowEl) {
    selectedSessionId = sessionId;
    selectedAgentId = agentId;
    selectedProjectKey = projectKey;
    renderedMessageCount = 0;

    // Always switch to Sessions tab when selecting a conversation
    if (activeTab !== 'sessions') {
      activeTab = 'sessions';
      const tabBar = document.getElementById('tab-bar');
      if (tabBar) tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === 'sessions'));
      hideStats();
    }

    deactivateLiveIndicator();
    exportBtn.style.display = 'block';
    exportBtn.disabled = exportInProgress;
    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.style.display = 'inline-block';
    const focusBtn2 = document.getElementById('focus-btn');
    if (focusBtn2) focusBtn2.style.display = 'none'; // hidden until terminalStatus arrives
    closeSendBar();

    // Remove existing pill/divider
    const pill = document.getElementById('new-msg-pill');
    if (pill) pill.remove();
    const divider = document.querySelector('.new-msg-divider');
    if (divider) divider.remove();

    // Visual selection
    document.querySelectorAll('.tree-session, .tree-subagent').forEach((r) => r.classList.remove('selected'));
    if (rowEl) rowEl.classList.add('selected');

    // Sync keyboard focus index to clicked row so j/k continues from here
    if (rowEl) {
      const items = getFlatNavigationList();
      const idx = items.findIndex((item) => item.el === rowEl);
      if (idx >= 0) focusedIndex = idx;
    }

    // Show loading in conversation panel
    const convContainer = document.getElementById('conversation-container');
    convContainer.innerHTML = '<div class="conv-loading"><div class="spinner"></div></div>';

    // Update breadcrumb
    const breadcrumb = document.getElementById('conv-breadcrumb');
    const project = allProjects.find((p) => p.key === projectKey);
    const projectName = project ? project.displayName : projectKey;
    function hashBtn(id) {
      return `<button class="hash-btn" data-id="${id}">${id.slice(0, 8)}\u2026</button>`;
    }
    if (agentId) {
      breadcrumb.innerHTML = `<span>${projectName}</span><span> / </span>${hashBtn(sessionId)}<span> / </span>${hashBtn(agentId)}`;
    } else {
      breadcrumb.innerHTML = `<span>${projectName}</span><span> / </span>${hashBtn(sessionId)}`;
    }

    vscode.postMessage({ command: 'loadConversation', projectKey, sessionId, agentId });
  }

  function applySelectedState() {
    // Clear all selected states
    document.querySelectorAll('.tree-session.selected, .tree-subagent.selected, .tree-project-header.selected, .tree-all-sessions.selected').forEach((el) => el.classList.remove('selected'));

    if (activeTab === 'stats') {
      if (statsProjectKey === null) {
        const allEl = document.querySelector('.tree-all-sessions');
        if (allEl) allEl.classList.add('selected');
      } else {
        const projEl = document.querySelector(`.tree-project[data-key="${CSS.escape(statsProjectKey)}"] .tree-project-header`);
        if (projEl) projEl.classList.add('selected');
      }
      return;
    }

    if (!selectedSessionId) return;
    const selector = selectedAgentId
      ? `.tree-subagent[data-agent-id="${CSS.escape(selectedAgentId)}"]`
      : `.tree-session[data-session-id="${CSS.escape(selectedSessionId)}"]`;
    const el = document.querySelector(selector);
    if (el) el.classList.add('selected');
  }

  function updateFilterCounts() {
    const activeCount = allProjects.filter((p) => isProjectActive(p)).length;
    const waitingCount = allProjects.filter((p) => isProjectWaiting(p)).length;
    const pinnedCount = allProjects.filter((p) => pinnedKeys.has(p.key)).length;

    filterBar.querySelectorAll('.filter-chip').forEach((chip) => {
      const f = chip.dataset.filter;
      const badge = chip.querySelector('.filter-count');
      let count = 0;
      if (f === 'active') count = activeCount;
      else if (f === 'waiting') count = waitingCount;
      else if (f === 'pinned') count = pinnedCount;

      if (f !== 'all' && count > 0) {
        if (badge) {
          badge.textContent = count;
        } else {
          const span = document.createElement('span');
          span.className = 'filter-count';
          span.textContent = count;
          chip.appendChild(span);
        }
      } else if (badge) {
        badge.remove();
      }
    });
  }

  // ── Project Render ─────────────────────────────────────────────────────────
  function renderProject(project) {
    const status = projectStatusClass(project);
    const isPinned = pinnedKeys.has(project.key);
    const batchCount = expandedBatchCounts.get(project.key) || 0;
    const visibleCount = 8 + batchCount * 8;
    const recentSessions = project.sessions.slice(0, visibleCount);
    const overflow = project.sessions.length - recentSessions.length;

    const isCollapsed = !expandedProjectKeys.has(project.key);

    return `
<div class="tree-project${isCollapsed ? ' collapsed' : ''}${isPinned ? ' pinned' : ''}" data-key="${esc(project.key)}">
  <div class="tree-project-header" title="${esc(project.path)}">
    <span class="collapse-chevron"></span>
    <span class="status-dot ${status}"></span>
    <span class="tree-project-name">${esc(project.displayName)}</span>
    <span class="tree-time">${timeAgo(project.lastActivity)}</span>
    <div class="tree-project-actions">
      <button class="btn-pin${isPinned ? ' pinned' : ''}" data-action="pin" data-key="${esc(project.key)}" title="${isPinned ? 'Unpin' : 'Pin'}">&#9733;</button>
      <button class="btn-action" data-action="open" data-path="${esc(project.path)}" title="Open in VS Code"${project.peacockColor ? ` data-peacock="${esc(project.peacockColor)}"` : ''}><svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1h6v1H2v12h12V8.5h1v6.5H1V1h.5zM9 1h6v6h-1V2.7L7.4 9.3l-.7-.7L13.3 2H9V1z"/></svg></button>
    </div>
  </div>
  <div class="tree-children">
    ${recentSessions.map((s) => renderSession(s, project.key)).join('')}
    ${overflow > 0 ? `<button class="btn-load-more" data-action="load-more" data-key="${esc(project.key)}">Load 8 more (${overflow} remaining)</button>` : ''}
  </div>
</div>`;
  }

  function renderSession(session, projectKey) {
    const status = statusClass(session.lastTimestamp, session.status);
    const hasAgents = session.subAgents && session.subAgents.length > 0;
    const prompt = trunc(session.firstPrompt || '(no prompt)', 60);
    const waiting = isItemWaiting(session);

    return `
<div class="tree-session${waiting ? ' waiting' : ''}"
     data-project-key="${esc(projectKey)}" data-session-id="${esc(session.sessionId)}">
  <div class="tree-session-line1">
    <span class="status-dot small ${status}"></span>
    <span class="tree-prompt">${esc(prompt)}</span>
    <span class="tree-time">${timeAgo(session.lastTimestamp)}</span>
  </div>
  <div class="tree-session-line2">
    ${waiting ? '<span class="tree-badge-waiting">waiting</span>' : ''}
    ${session.gitBranch ? `<span class="tree-branch">${esc(session.gitBranch)}</span>` : ''}
    ${session.messageCount ? `<span class="tree-msgs">${session.messageCount} msgs</span>` : ''}
    ${hasAgents ? `<span class="tree-agents">${session.subAgents.length} agent${session.subAgents.length === 1 ? '' : 's'}</span>` : ''}
  </div>
  ${hasAgents ? `<div class="tree-subagents">
    ${session.subAgents.map((a) => renderSubAgent(a, projectKey, session.sessionId)).join('')}
  </div>` : ''}
</div>`;
  }

  function renderSubAgent(agent, projectKey, sessionId) {
    const label = agent.slug || agent.agentId.slice(0, 8);
    const status = statusClass(agent.lastTimestamp, agent.status);
    const waiting = isItemWaiting(agent);

    return `
<div class="tree-subagent${waiting ? ' waiting' : ''}"
     data-project-key="${esc(projectKey)}" data-session-id="${esc(sessionId)}" data-agent-id="${esc(agent.agentId)}">
  <span class="status-dot tiny ${status}"></span>
  <span class="tree-agent-label">${esc(label)}</span>
  ${waiting ? '<span class="tree-badge-waiting">w</span>' : ''}
  <span class="tree-time">${timeAgo(agent.lastTimestamp)}</span>
</div>`;
  }

  // ── Conversation Render ────────────────────────────────────────────────────
  function renderConversation(messages, sessionId, agentId) {
    const container = document.getElementById('conversation-container');

    if (!messages || messages.length === 0) {
      container.innerHTML = '<div class="conv-empty"><p>No messages in this conversation.</p></div>';
      renderedMessageCount = 0;
      return;
    }

    const html = messages.map(renderMessage).join('');

    // Fade-in transition (fade out is instant clear, fade in is 150ms)
    const wrapper = document.createElement('div');
    wrapper.className = 'conv-messages conv-crossfade fading';
    wrapper.innerHTML = html;

    container.innerHTML = '';
    container.appendChild(wrapper);
    // Force reflow then remove fading class to trigger transition
    void wrapper.offsetHeight;
    wrapper.classList.remove('fading');

    // Tool badge click-to-expand
    container.querySelectorAll('.tool-badge-header').forEach((header) => {
      header.addEventListener('click', () => {
        header.closest('.tool-badge').classList.toggle('expanded');
      });
    });

    container.scrollTop = container.scrollHeight;
    renderedMessageCount = messages.length;
  }

  function renderMessage(msg) {
    const isUser = msg.role === 'user';
    const roleLabel = isUser ? 'You' : 'Claude';
    const timeStr = msg.timestamp
      ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    // Group consecutive tool blocks into a flex container
    let blocksHtml = '';
    let i = 0;
    while (i < msg.blocks.length) {
      const block = msg.blocks[i];
      if (block.type === 'tool') {
        let toolBadgesHtml = '';
        while (i < msg.blocks.length && msg.blocks[i].type === 'tool') {
          toolBadgesHtml += renderToolBadge(msg.blocks[i]);
          i++;
        }
        blocksHtml += `<div class="tool-badges">${toolBadgesHtml}</div>`;
      } else {
        blocksHtml += `<div class="msg-text">${formatText(block.content)}</div>`;
        i++;
      }
    }

    return `
<div class="msg ${isUser ? 'msg-user' : 'msg-assistant'}">
  <div class="msg-header">
    <span class="msg-role">${roleLabel}</span>
    <span class="msg-time">${timeStr}</span>
  </div>
  <div class="msg-body">${blocksHtml}</div>
</div>`;
  }

  function renderToolBadge(block) {
    const dotClass = block.isError ? 'error' : (block.output !== undefined ? 'success' : 'pending');
    const previewHtml = block.preview
      ? `<span class="tool-preview">${esc(trunc(block.preview, 90))}</span>`
      : '';
    const descHtml = block.description
      ? `<span class="tool-desc">${esc(trunc(block.description, 60))}</span>`
      : '';
    const inputText = block.input || '';
    const outputText = block.output || '';

    return `
<div class="tool-badge" data-tool-id="${esc(block.toolUseId || '')}">
  <div class="tool-badge-header">
    <span class="tool-dot ${dotClass}"></span>
    <span class="tool-name">${esc(block.content)}</span>
    ${previewHtml}
    ${descHtml}
  </div>
  <div class="tool-detail">
    <div class="tool-io-row">
      <span class="tool-io-label">IN</span>
      <pre class="tool-io-content${!inputText ? ' tool-io-empty' : ''}">${inputText ? esc(inputText) : '(no input)'}</pre>
    </div>
    <div class="tool-io-row">
      <span class="tool-io-label">OUT</span>
      <pre class="tool-io-content${!outputText ? ' tool-io-empty' : ''}">${outputText ? esc(trunc(outputText, 3000)) : '(no output)'}</pre>
    </div>
  </div>
</div>`;
  }

  // ── Live indicator ─────────────────────────────────────────────────────────
  function activateLiveIndicator() {
    const indicator = document.getElementById('live-indicator');
    if (indicator) indicator.classList.add('active');
    if (liveTimeout) clearTimeout(liveTimeout);
    liveTimeout = setTimeout(() => { deactivateLiveIndicator(); }, 60000);
  }

  function deactivateLiveIndicator() {
    const indicator = document.getElementById('live-indicator');
    if (indicator) indicator.classList.remove('active');
    if (liveTimeout) { clearTimeout(liveTimeout); liveTimeout = null; }
  }

  function openSendBar() {
    sendBarOpen = true;
    const bar = document.getElementById('send-bar');
    if (bar) bar.classList.add('open');
    const input = document.getElementById('send-input');
    if (input) { input.disabled = false; input.focus(); }
  }

  function closeSendBar() {
    sendBarOpen = false;
    const bar = document.getElementById('send-bar');
    if (bar) bar.classList.remove('open');
    const input = document.getElementById('send-input');
    if (input) { input.value = ''; input.style.height = ''; input.disabled = false; }
    const submitBtn = document.getElementById('send-submit-btn');
    if (submitBtn) { submitBtn.textContent = 'Send'; submitBtn.disabled = true; }
    const errorEl = document.getElementById('send-error');
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('visible'); }
    sendInFlight = false;
  }

  function submitSendBar() {
    const input = document.getElementById('send-input');
    if (!input || !input.value.trim() || sendInFlight) return;
    sendInFlight = true;
    const text = input.value;
    const submitBtn = document.getElementById('send-submit-btn');
    const errorEl = document.getElementById('send-error');
    const isResuming = !hasLiveTerminal;

    input.disabled = true;
    if (submitBtn) submitBtn.textContent = isResuming ? 'Resuming…' : '…';
    if (submitBtn) submitBtn.disabled = true;
    if (errorEl) { errorEl.textContent = ''; errorEl.classList.remove('visible'); }

    vscode.postMessage({ command: 'sendMessage', text });
  }

  // ── Send bar textarea event listeners ─────────────────────────────────────
  const sendInputEl = document.getElementById('send-input');
  if (sendInputEl) {
    sendInputEl.addEventListener('input', function () {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 88) + 'px';
      const submitBtn = document.getElementById('send-submit-btn');
      if (submitBtn) submitBtn.disabled = !this.value.trim() || sendInFlight;
    });

    sendInputEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitSendBar();
      }
      if (e.key === 'Escape') {
        e.stopPropagation(); // prevent global Escape from deselecting session
        closeSendBar();
      }
    });
  }

  const sendSubmitBtnEl = document.getElementById('send-submit-btn');
  if (sendSubmitBtnEl) {
    sendSubmitBtnEl.addEventListener('click', submitSendBar);
  }

  // ── Conversation tailing ───────────────────────────────────────────────────
  /**
   * @param {any[]} messages
   * @param {string} sessionId
   * @param {string | null | undefined} agentId
   */
  function handleConversationTail(messages, sessionId, agentId) {
    if (sessionId !== selectedSessionId) return;
    if ((agentId || null) !== (selectedAgentId || null)) return;
    if (!messages || messages.length === 0) return;

    const container = document.getElementById('conversation-container');
    if (!container) return;
    const convMessages = container.querySelector('.conv-messages');
    if (!convMessages) {
      renderConversation(messages, sessionId, agentId);
      return;
    }

    const newCount = messages.length;
    if (newCount <= renderedMessageCount) return;

    const newMessages = messages.slice(renderedMessageCount);
    renderedMessageCount = newCount;

    // Insert NEW divider if user is scrolled up
    if (!isUserAtBottom && !container.querySelector('.new-msg-divider')) {
      const divider = document.createElement('div');
      divider.className = 'new-msg-divider';
      divider.innerHTML = '<span>NEW</span>';
      convMessages.appendChild(divider);
    }

    // Append new messages with highlight
    for (const msg of newMessages) {
      const msgHtml = renderMessage(msg);
      const temp = document.createElement('div');
      temp.innerHTML = msgHtml;
      const msgEl = temp.firstElementChild;
      if (msgEl) {
        msgEl.classList.add('msg-new');
        convMessages.appendChild(msgEl);
        msgEl.querySelectorAll('.tool-badge-header').forEach((header) => {
          header.addEventListener('click', () => {
            header.closest('.tool-badge').classList.toggle('expanded');
          });
        });
        setTimeout(() => { msgEl.classList.add('msg-new-faded'); }, 2000);
      }
    }

    if (isUserAtBottom) {
      container.scrollTop = container.scrollHeight;
    } else {
      showNewMessagePill(newMessages.length);
    }

    activateLiveIndicator();
  }

  /** @param {number} count */
  function showNewMessagePill(count) {
    let pill = document.getElementById('new-msg-pill');
    if (!pill) {
      pill = document.createElement('div');
      pill.id = 'new-msg-pill';
      pill.className = 'new-msg-pill';
      const convCont = document.getElementById('conversation-container');
      if (convCont) convCont.appendChild(pill);
      pill.addEventListener('click', () => {
        const cont = document.getElementById('conversation-container');
        if (cont) cont.scrollTop = cont.scrollHeight;
        pill.remove();
        const d = document.querySelector('.new-msg-divider');
        if (d) d.remove();
      });
    }
    const total = parseInt(pill.dataset.count || '0', 10) + count;
    pill.dataset.count = String(total);
    pill.textContent = `${total} new message${total === 1 ? '' : 's'}`;
  }

  /** @returns {{ el: HTMLElement, type: string, projectEl?: HTMLElement }[]} */
  function getFlatNavigationList() {
    /** @type {{ el: HTMLElement, type: string, projectEl?: HTMLElement }[]} */
    const items = [];
    document.querySelectorAll('.tree-project').forEach((proj) => {
      const hdr = proj.querySelector('.tree-project-header');
      if (hdr) items.push({ el: /** @type {HTMLElement} */ (hdr), type: 'project', projectEl: /** @type {HTMLElement} */ (proj) });
      if (!proj.classList.contains('collapsed')) {
        proj.querySelectorAll('.tree-session').forEach((sess) => {
          items.push({ el: /** @type {HTMLElement} */ (sess), type: 'session' });
          sess.querySelectorAll('.tree-subagent').forEach((sub) => {
            items.push({ el: /** @type {HTMLElement} */ (sub), type: 'subagent' });
          });
        });
      }
    });
    return items;
  }

  /** @param {number} index */
  function setFocusedItem(index) {
    const items = getFlatNavigationList();
    document.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));
    if (index < 0 || index >= items.length) { focusedIndex = -1; return; }
    focusedIndex = index;
    items[index].el.classList.add('focused');
    items[index].el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function moveFocus(delta) {
    const items = getFlatNavigationList();
    if (items.length === 0) return;
    let next = focusedIndex + delta;
    if (next < 0) next = 0;
    if (next >= items.length) next = items.length - 1;
    setFocusedItem(next);
  }

  document.addEventListener('keydown', (e) => {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
      if (activeEl === searchInput) {
        if (e.key === 'Escape' || e.key === 'Enter') { searchInput.blur(); sidebarHasFocus = true; e.preventDefault(); }
      }
      return;
    }
    if (helpOverlayVisible) {
      if (e.key === 'Escape') { hideHelpOverlay(); e.preventDefault(); }
      return;
    }

    const items = getFlatNavigationList();

    switch (e.key) {
      case 'j':
        e.preventDefault();
        if (!sidebarHasFocus) { const conv = document.getElementById('conversation-container'); if (conv) conv.scrollTop += 80; }
        else { moveFocus(1); }
        break;
      case 'k':
        e.preventDefault();
        if (!sidebarHasFocus) { const conv = document.getElementById('conversation-container'); if (conv) conv.scrollTop -= 80; }
        else { moveFocus(-1); }
        break;
      case 'h': {
        e.preventDefault();
        if (!sidebarHasFocus) {
          sidebarHasFocus = true;
          document.getElementById('conversation-container').classList.remove('conv-focused');
          break;
        }
        if (focusedIndex < 0 || focusedIndex >= items.length) break;
        const item = items[focusedIndex];
        if (item.type === 'project') {
          item.projectEl.classList.add('collapsed');
          const key = item.projectEl.dataset.key;
          if (key) expandedProjectKeys.delete(key);
        }
        else { for (let i = focusedIndex - 1; i >= 0; i--) { if (items[i].type === 'project') { setFocusedItem(i); break; } } }
        break;
      }
      case 'l': {
        e.preventDefault();
        if (focusedIndex < 0 || focusedIndex >= items.length) break;
        const item = items[focusedIndex];
        if (item.type === 'session' || item.type === 'subagent') {
          item.el.click();
          sidebarHasFocus = false;
          document.getElementById('conversation-container').classList.add('conv-focused');
        } else if (item.type === 'project') {
          if (item.projectEl.classList.contains('collapsed')) {
            item.projectEl.classList.remove('collapsed');
            const key = item.projectEl.dataset.key;
            if (key) expandedProjectKeys.add(key);
          }
          else { moveFocus(1); }
        }
        break;
      }
      case 'Enter': {
        e.preventDefault();
        if (focusedIndex < 0 || focusedIndex >= items.length) break;
        const item = items[focusedIndex];
        if (item.type === 'session' || item.type === 'subagent') item.el.click();
        break;
      }
      case 'Escape': {
        closeHashDropdown();
        e.preventDefault();
        selectedSessionId = null; selectedAgentId = null; selectedProjectKey = null;
        exportBtn.style.display = 'none';
        const sendBtn2 = document.getElementById('send-btn');
        if (sendBtn2) sendBtn2.style.display = 'none';
        const focusBtn3 = document.getElementById('focus-btn');
        if (focusBtn3) focusBtn3.style.display = 'none';
        closeSendBar();
        document.querySelectorAll('.tree-session, .tree-subagent').forEach((r) => r.classList.remove('selected'));
        document.getElementById('conversation-container').innerHTML =
          '<div class="conv-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="conv-empty-icon"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><p>Click on a session or agent in the sidebar to view the conversation.</p></div>';
        document.getElementById('conv-breadcrumb').textContent = 'Select a session to view its conversation';
        document.getElementById('conversation-container').classList.remove('conv-focused');
        deactivateLiveIndicator(); sidebarHasFocus = true;
        break;
      }
      case 'p': {
        e.preventDefault();
        if (focusedIndex < 0 || focusedIndex >= items.length) break;
        const projEl = items[focusedIndex].type === 'project' ? items[focusedIndex].projectEl : items[focusedIndex].el.closest('.tree-project');
        if (projEl) { const key = projEl.dataset.key; if (key) vscode.postMessage({ command: 'togglePin', key }); }
        break;
      }
      case 'g': {
        const now = Date.now();
        if (now - lastGPress < 500) {
          e.preventDefault();
          if (!sidebarHasFocus) { const conv = document.getElementById('conversation-container'); if (conv) conv.scrollTop = 0; }
          else { setFocusedItem(0); }
          lastGPress = 0;
        } else { lastGPress = now; }
        break;
      }
      case 'G':
        e.preventDefault();
        if (!sidebarHasFocus) { const conv = document.getElementById('conversation-container'); if (conv) conv.scrollTop = conv.scrollHeight; }
        else { setFocusedItem(items.length - 1); }
        break;
      case '/':
        e.preventDefault(); searchInput.focus(); searchInput.select(); sidebarHasFocus = false; break;
      case '?':
        e.preventDefault(); showHelpOverlay(); break;
      case '1':
      case '2':
      case '3':
      case '4': {
        const tabs = ['sessions', 'stats', 'health', 'about'];
        const idx = Number(e.key) - 1;
        const tab = tabs[idx];
        if (tab && tab !== activeTab) {
          activeTab = tab;
          const tabBar = document.getElementById('tab-bar');
          if (tabBar) tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
          if (tab === 'stats') showStats();
          else if (tab === 'health') showHealth();
          else if (tab === 'about') showAbout();
          else hideStats();
        }
        e.preventDefault();
        break;
      }
      case 'Tab': {
        e.preventDefault();
        sidebarHasFocus = !sidebarHasFocus;
        const convEl = document.getElementById('conversation-container');
        if (sidebarHasFocus) {
          convEl.classList.remove('conv-focused');
        } else {
          document.querySelectorAll('.focused').forEach((el) => el.classList.remove('focused'));
          convEl.classList.add('conv-focused');
        }
        break;
      }
    }
  });

  function showHelpOverlay() {
    if (helpOverlayVisible) return;
    helpOverlayVisible = true;
    const overlay = document.createElement('div');
    overlay.className = 'help-overlay';
    overlay.innerHTML = `
    <div class="help-modal">
      <div class="help-title">Keyboard Shortcuts</div>
      <div class="help-grid">
        <div class="help-key">j / k</div><div class="help-desc">Navigate up / down</div>
        <div class="help-key">h</div><div class="help-desc">Collapse / go to parent / return to sidebar</div>
        <div class="help-key">l</div><div class="help-desc">Expand / open conversation (shifts focus right)</div>
        <div class="help-key">Enter</div><div class="help-desc">Open conversation</div>
        <div class="help-key">Escape</div><div class="help-desc">Deselect / close overlay</div>
        <div class="help-key">p</div><div class="help-desc">Toggle pin on project</div>
        <div class="help-key">g g</div><div class="help-desc">Jump to top</div>
        <div class="help-key">G</div><div class="help-desc">Jump to bottom</div>
        <div class="help-key">/</div><div class="help-desc">Focus search</div>
        <div class="help-key">?</div><div class="help-desc">This help</div>
        <div class="help-key">Tab</div><div class="help-desc">Switch sidebar / conversation</div>
        <div class="help-key">1</div><div class="help-desc">Agents tab</div>
        <div class="help-key">2</div><div class="help-desc">Stats tab</div>
        <div class="help-key">3</div><div class="help-desc">About tab</div>
      </div>
      <div class="help-dismiss">Press Escape to close</div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) hideHelpOverlay(); });
  }

  function hideHelpOverlay() {
    helpOverlayVisible = false;
    const overlay = document.querySelector('.help-overlay');
    if (overlay) overlay.remove();
  }

  /** @param {any} msg */
  function handleSidebarRowUpdate(msg) {
    // Update session row
    const row = document.querySelector(`.tree-session[data-session-id="${CSS.escape(msg.sessionId)}"]`);
    if (row) {
      const dot = row.querySelector('.status-dot');
      if (dot) dot.className = `status-dot small ${statusClass(msg.lastTimestamp, msg.status)}`;

      const isWait = isItemWaiting({ lastTimestamp: msg.lastTimestamp, status: msg.status });
      const line2 = row.querySelector('.tree-session-line2');
      if (line2) {
        const badge = line2.querySelector('.tree-badge-waiting');
        if (isWait && !badge) {
          const b = document.createElement('span');
          b.className = 'tree-badge-waiting';
          b.textContent = 'waiting';
          line2.prepend(b);
        } else if (!isWait && badge) {
          badge.remove();
        }
      }

      const msgsEl = row.querySelector('.tree-msgs');
      if (msgsEl && msg.messageCount) msgsEl.textContent = `${msg.messageCount} msgs`;
    }
  }

  // ── Tab bar ────────────────────────────────────────────────────────────────
  (function initTabBar() {
    const tabBar = document.getElementById('tab-bar');
    if (!tabBar) return;
    tabBar.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest('.tab-btn');
      if (!btn) return;
      const tab = btn.dataset.tab;
      if (tab === activeTab) return;
      activeTab = tab;
      tabBar.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      if (tab === 'stats') {
        showStats();
      } else if (tab === 'health') {
        showHealth();
      } else if (tab === 'about') {
        showAbout();
      } else {
        hideStats();
      }
    });
  })();

  function showStats() {
    const convContainer = document.getElementById('conversation-container');
    const convHeader = document.getElementById('conversation-header');
    const sendBar = document.getElementById('send-bar');
    if (convHeader) convHeader.style.display = 'none';
    if (sendBar) sendBar.style.display = 'none';
    if (convContainer) {
      convContainer.innerHTML = renderStatsView();
      convContainer.style.display = '';
      // Apply bar widths via JS (CSP blocks inline styles in innerHTML)
      convContainer.querySelectorAll('.stats-bar-fill').forEach((el) => {
        el.style.width = el.dataset.pct + '%';
      });
      // Apply donut gradient
      convContainer.querySelectorAll('.stats-donut').forEach((el) => {
        el.style.background = 'conic-gradient(' + el.dataset.gradient + ')';
      });
      // Position donut icons
      convContainer.querySelectorAll('.stats-donut-icon').forEach((el) => {
        el.style.left = (parseFloat(el.dataset.x) - 9) + 'px'; // 9 = half icon width
        el.style.top = (parseFloat(el.dataset.y) - 9) + 'px';
      });
      // Apply bar label colors (serve as donut legend)
      convContainer.querySelectorAll('.stats-bar-label[data-color]').forEach((el) => {
        el.style.color = el.dataset.color;
      });
      // Time range filter buttons
      convContainer.querySelectorAll('.stats-time-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          statsTimeRange = btn.dataset.range;
          showStats();
        });
      });
    }
  }

  function hideStats() {
    const convHeader = document.getElementById('conversation-header');
    const sendBar = document.getElementById('send-bar');
    if (convHeader) convHeader.style.display = '';
    if (sendBar) sendBar.style.display = '';
    // If a session was previously selected, reload it; otherwise show placeholder
    if (selectedSessionId && selectedProjectKey) {
      vscode.postMessage({ command: 'loadConversation', projectKey: selectedProjectKey, sessionId: selectedSessionId, agentId: selectedAgentId });
    } else {
      const convContainer = document.getElementById('conversation-container');
      if (convContainer) {
        convContainer.innerHTML = `<div class="conv-empty">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="conv-empty-icon">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          <p>Click on a session or agent in the sidebar to view the conversation.</p>
        </div>`;
      }
    }
  }

  // ── Stats computation & rendering ─────────────────────────────────────────
  function computeStats(sessions) {
    let totalMessages = 0;
    let totalAgents = 0;
    let totalDurationMs = 0;
    let maxDurationMs = 0;
    let durCount = 0;
    let totalUserChars = 0;
    let totalAssistantLines = 0;
    let totalCodeLines = 0;
    /** @type {Record<string, number>} */
    const toolCounts = {};
    /** @type {Record<string, number>} */
    const sessionsPerDay = {};
    /** @type {Record<string, number>} "YYYY-MM-DD|HH" → count */
    const activityByDayHour = {};

    for (const s of sessions) {
      totalMessages += s.messageCount || 0;
      totalAgents += (s.subAgents || []).length;
      totalUserChars += s.userChars || 0;
      totalAssistantLines += s.assistantLines || 0;
      totalCodeLines += s.codeLines || 0;

      if (s.firstTimestamp && s.lastTimestamp) {
        const dur = new Date(s.lastTimestamp).getTime() - new Date(s.firstTimestamp).getTime();
        if (dur > 0) { totalDurationMs += dur; if (dur > maxDurationMs) maxDurationMs = dur; durCount++; }
      }

      // Merge session tool counts
      if (s.toolCounts) {
        for (const [tool, count] of Object.entries(s.toolCounts)) {
          toolCounts[tool] = (toolCounts[tool] || 0) + /** @type {number} */ (count);
        }
      }

      // Merge subagent stats
      for (const a of (s.subAgents || [])) {
        totalUserChars += a.userChars || 0;
        totalAssistantLines += a.assistantLines || 0;
        totalCodeLines += a.codeLines || 0;
        if (a.toolCounts) {
          for (const [tool, count] of Object.entries(a.toolCounts)) {
            toolCounts[tool] = (toolCounts[tool] || 0) + /** @type {number} */ (count);
          }
        }
      }

      // Sessions per day + hourly activity
      if (s.firstTimestamp) {
        const dt = new Date(s.firstTimestamp);
        const day = s.firstTimestamp.slice(0, 10);
        sessionsPerDay[day] = (sessionsPerDay[day] || 0) + 1;
        const hourKey = day + '|' + dt.getHours();
        activityByDayHour[hourKey] = (activityByDayHour[hourKey] || 0) + 1;
      }
    }

    const avgDurationMin = durCount > 0 ? Math.round(totalDurationMs / durCount / 60000) : 0;
    const longestSessionMin = Math.round(maxDurationMs / 60000);
    const totalHours = Math.round(totalDurationMs / 3600000 * 10) / 10;
    const activeDays = Object.keys(sessionsPerDay).length;

    return { sessionCount: sessions.length, totalMessages, totalAgents, avgDurationMin, longestSessionMin, totalHours, totalUserChars, totalAssistantLines, totalCodeLines, toolCounts, sessionsPerDay, activityByDayHour, activeDays };
  }

  function formatDuration(minutes) {
    if (minutes < 60) return minutes + 'min';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? h + 'h ' + m + 'min' : h + 'h';
  }

  function filterSessionsByTimeRange(sessions, range) {
    if (range === 'all') return sessions;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let cutoff;
    if (range === 'today') {
      cutoff = startOfToday;
    } else if (range === '7d') {
      cutoff = new Date(startOfToday);
      cutoff.setDate(cutoff.getDate() - 6);
    } else {
      cutoff = new Date(startOfToday);
      cutoff.setDate(cutoff.getDate() - 29);
    }
    return sessions.filter((s) => s.firstTimestamp && new Date(s.firstTimestamp) >= cutoff);
  }

  function renderStatsView() {
    const project = statsProjectKey ? allProjects.find((p) => p.key === statsProjectKey) : null;
    const allSessions = project ? project.sessions : allProjects.flatMap((p) => p.sessions);
    const sessions = filterSessionsByTimeRange(allSessions, statsTimeRange);
    const label = project ? esc(project.displayName) : 'All sessions';

    if (allSessions.length === 0) {
      return `<div class="conv-empty"><p>No session data available for stats.</p></div>`;
    }

    const stats = computeStats(sessions);
    const allStats = statsTimeRange === 'all' ? stats : computeStats(allSessions);

    // Overview cards
    const formatNum = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
    let html = `<div class="stats-view"><div class="stats-header"><span class="stats-title">${label}</span>`;
    // Time range filter buttons
    const ranges = [['today', 'Today'], ['7d', '7d'], ['30d', '30d'], ['all', 'All']];
    html += `<div class="stats-time-filters">`;
    for (const [val, lbl] of ranges) {
      html += `<button class="stats-time-btn${statsTimeRange === val ? ' active' : ''}" data-range="${val}">${lbl}</button>`;
    }
    html += `</div></div>`;
    html += `<div class="stats-cards">
      <div class="stats-card"><div class="stats-card-value">${stats.sessionCount}</div><div class="stats-card-label">Sessions</div></div>
      <div class="stats-card"><div class="stats-card-value">${stats.totalHours}h</div><div class="stats-card-label">Total Time</div></div>
      <div class="stats-card"><div class="stats-card-value">${formatNum(stats.totalMessages)}</div><div class="stats-card-label">Messages</div></div>
      <div class="stats-card"><div class="stats-card-value">${stats.totalAgents}</div><div class="stats-card-label">Agents</div></div>
    </div>`;
    html += `<div class="stats-cards">
      <div class="stats-card"><div class="stats-card-value">${formatNum(stats.totalUserChars)}</div><div class="stats-card-label">Prompt Chars</div></div>
      <div class="stats-card"><div class="stats-card-value">${formatNum(stats.totalAssistantLines)}</div><div class="stats-card-label">Response Lines</div></div>
      <div class="stats-card"><div class="stats-card-value">${formatNum(stats.totalCodeLines)}</div><div class="stats-card-label">Code Lines</div></div>
      <div class="stats-card"><div class="stats-card-value">${formatDuration(stats.avgDurationMin)}</div><div class="stats-card-label">Avg Duration</div></div>
    </div>`;
    // Extra insight cards
    const avgMsg = stats.sessionCount > 0 ? Math.round(stats.totalMessages / stats.sessionCount) : 0;
    const mostActiveDay = Object.entries(stats.sessionsPerDay).sort((a, b) => b[1] - a[1])[0];
    const mostActiveDayLabel = mostActiveDay ? new Date(mostActiveDay[0] + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '-';
    const mostActiveDayCount = mostActiveDay ? mostActiveDay[1] : 0;
    html += `<div class="stats-cards">
      <div class="stats-card"><div class="stats-card-value">${formatDuration(stats.longestSessionMin)}</div><div class="stats-card-label">Longest Session</div></div>
      <div class="stats-card"><div class="stats-card-value">${avgMsg}</div><div class="stats-card-label">Avg Msg / Session</div></div>
      <div class="stats-card"><div class="stats-card-value">${mostActiveDayCount}</div><div class="stats-card-label">Peak Day (${mostActiveDayLabel})</div></div>
      <div class="stats-card"><div class="stats-card-value">${stats.activeDays}</div><div class="stats-card-label">Active Days</div></div>
    </div>`;

    // Top tools — bar chart + donut
    const toolEntries = Object.entries(stats.toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    if (toolEntries.length > 0) {
      const maxCount = toolEntries[0][1];
      const totalTools = toolEntries.reduce((sum, e) => sum + e[1], 0);

      const toolColors = toolEntries.map(([name]) => TOOL_COLORS[name] || TOOL_COLOR_DEFAULT);

      html += `<div class="stats-section"><div class="stats-section-title">Top Tools</div>`;
      html += `<div class="stats-tools-layout">`;

      // Donut chart (left, large)
      let gradientParts = [];
      let cumPct = 0;
      for (let i = 0; i < toolEntries.length; i++) {
        const pct = (toolEntries[i][1] / totalTools) * 100;
        gradientParts.push(`${toolColors[i]} ${cumPct}% ${cumPct + pct}%`);
        cumPct += pct;
      }
      html += `<div class="stats-donut-wrap">`;
      html += `<div class="stats-donut" data-gradient="${esc(gradientParts.join(', '))}"></div>`;
      // Tool icons on donut segments >5%
      let cumAngle = 0;
      for (let i = 0; i < toolEntries.length; i++) {
        const pct = (toolEntries[i][1] / totalTools) * 100;
        const midAngle = cumAngle + pct / 2;
        cumAngle += pct;
        if (pct < 5) continue;
        const icon = TOOL_ICONS[toolEntries[i][0]];
        if (!icon) continue;
        const rad = (midAngle * 3.6 - 90) * Math.PI / 180; // *3.6: pct→deg, -90: start from top
        const r = 59; // midpoint of donut ring
        const x = 80 + r * Math.cos(rad); // 80 = half of 160px donut
        const y = 80 + r * Math.sin(rad);
        html += `<svg class="stats-donut-icon" data-x="${x}" data-y="${y}" viewBox="0 0 16 16" fill="none" stroke="white" stroke-linecap="round" stroke-linejoin="round">${icon}</svg>`;
      }
      html += `</div>`;

      // Bar chart (right) — labels colored to match donut
      html += `<div class="stats-bars">`;
      for (let i = 0; i < toolEntries.length; i++) {
        const [tool, count] = toolEntries[i];
        const pct = Math.round((count / maxCount) * 100);
        html += `<div class="stats-bar-row">
          <span class="stats-bar-label" data-color="${toolColors[i]}">${esc(tool)}</span>
          <div class="stats-bar-track"><div class="stats-bar-fill" data-pct="${pct}"></div></div>
          <span class="stats-bar-count">${count}</span>
        </div>`;
      }
      html += `</div>`;

      html += `</div></div>`;
    }

    // Activity heatmap — GitHub-style: days (X) × 2h slots (Y)
    html += `<div class="stats-section"><div class="stats-section-title">Activity</div>`;
    const now = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      days.push(d);
    }

    // Aggregate into 2h slots and find max
    let heatmapMax = 0;
    const slotData = {};
    for (const [key, v] of Object.entries(allStats.activityByDayHour)) {
      const [day, hStr] = key.split('|');
      const slot = Math.floor(Number(hStr) / 2);
      const slotKey = day + '|' + slot;
      slotData[slotKey] = (slotData[slotKey] || 0) + v;
      if (slotData[slotKey] > heatmapMax) heatmapMax = slotData[slotKey];
    }

    const slotLabels = ['0h', '2h', '4h', '6h', '8h', '10h', '12h', '14h', '16h', '18h', '20h', '22h'];

    html += `<div class="stats-heatmap-wrap">`;
    // Y-axis labels
    html += `<div class="stats-heatmap-ylabels">`;
    for (let s = 0; s < 12; s++) {
      html += `<div class="stats-heatmap-ylabel">${slotLabels[s]}</div>`;
    }
    html += `</div>`;

    // Grid
    html += `<div class="stats-heatmap-grid">`;
    // Day header row
    html += `<div class="stats-heatmap-xlabels">`;
    for (const d of days) {
      const showLabel = d.getDate() === 1 || d.getDay() === 1;
      const lbl = showLabel ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '';
      html += `<div class="stats-heatmap-xlabel">${lbl}</div>`;
    }
    html += `</div>`;
    // Cells: each row = 2h slot, each column = 1 day
    for (let s = 0; s < 12; s++) {
      html += `<div class="stats-heatmap-row">`;
      for (const d of days) {
        const dayKey = d.toISOString().slice(0, 10);
        const count = slotData[dayKey + '|' + s] || 0;
        const level = heatmapMax === 0 ? 0 : count === 0 ? 0 : count <= heatmapMax * 0.25 ? 1 : count <= heatmapMax * 0.5 ? 2 : count <= heatmapMax * 0.75 ? 3 : 4;
        const dayLabel = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        const slotStart = s * 2;
        const isWeekend = d.getDay() === 0 || d.getDay() === 6;
        const dimClass = isWeekend ? ' heatmap-weekend' : '';
        html += `<div class="stats-activity-cell${dimClass}" data-level="${level}" title="${dayLabel} ${slotStart}h\u2013${slotStart + 2}h: ${count} session${count !== 1 ? 's' : ''}"></div>`;
      }
      html += `</div>`;
    }
    html += `</div></div>`;

    // Legend — right under the grid
    html += `<div class="stats-heatmap-legend">`;
    html += `<div class="stats-activity-cell stats-legend-cell" data-level="0"></div><span class="stats-heatmap-legend-label">No activity</span>`;
    html += `<span class="stats-heatmap-legend-sep"></span>`;
    html += `<span class="stats-heatmap-legend-label">Less</span>`;
    for (let l = 1; l <= 4; l++) {
      html += `<div class="stats-activity-cell stats-legend-cell" data-level="${l}"></div>`;
    }
    html += `<span class="stats-heatmap-legend-label">More</span>`;
    html += `</div></div>`;
    html += `</div>`; // close stats-view

    return html;
  }

  // ── "All sessions" sidebar entry + project click for stats ────────────────
  function renderAllSessionsEntry() {
    const isSelected = activeTab === 'stats' && statsProjectKey === null;
    return `<div class="tree-all-sessions${isSelected ? ' selected' : ''}" data-action="select-all">All sessions</div>`;
  }

  // ── Health view ────────────────────────────────────────────────────────────
  function showHealth() {
    const convContainer = document.getElementById('conversation-container');
    const convHeader = document.getElementById('conversation-header');
    const sendBar = document.getElementById('send-bar');
    if (convHeader) convHeader.style.display = 'none';
    if (sendBar) sendBar.style.display = 'none';
    if (convContainer) {
      convContainer.innerHTML = '<div class="health-loading">Loading hook status…</div>';
      convContainer.style.display = '';
      vscode.postMessage({ command: 'getHooksHealth' });
    }
  }

  function renderHealthView(report) {
    if (!report || !report.hooks) {
      return '<div class="health-empty">No hooks configured</div>';
    }

    const hooks = report.hooks || [];
    const summary = report.summary || { healthy: 0, warnings: 0, failures: 0 };

    let hooksHtml = '';
    for (const hook of hooks) {
      const statusIcon = hook.status === 'healthy' ? '✓' : hook.status === 'warning' ? '⚠' : '✕';
      const statusColor = hook.status === 'healthy' ? 'healthy' : hook.status === 'warning' ? 'warning' : 'failure';

      let checksHtml = '';
      for (const check of (hook.checks || [])) {
        const checkIcon = check.status === 'success' ? '✓' : check.status === 'warning' ? '⚠' : '✕';
        checksHtml += `<div class="health-check ${check.status}">
          <span class="health-check-icon">${checkIcon}</span>
          <span class="health-check-name">${check.name}${check.message ? ': ' + check.message : ''}</span>
        </div>`;
      }

      hooksHtml += `<div class="health-hook" data-status="${hook.status}">
        <div class="health-hook-header">
          <span class="health-hook-icon">${statusIcon}</span>
          <span class="health-hook-title">${hook.event}</span>
          <span class="health-hook-path">${hook.path}</span>
        </div>
        <div class="health-hook-details">
          ${checksHtml}
        </div>
      </div>`;
    }

    return `<div class="health-view">
      <div class="health-summary">
        <div class="health-stat healthy"><span class="health-icon">●</span><span>Healthy: ${summary.healthy}</span></div>
        <div class="health-stat warning"><span class="health-icon">⚠</span><span>Warnings: ${summary.warnings}</span></div>
        <div class="health-stat failure"><span class="health-icon">✕</span><span>Failures: ${summary.failures}</span></div>
        <button id="health-refresh" class="health-refresh-btn">Refresh</button>
      </div>
      <div class="health-hooks">
        ${hooksHtml}
      </div>
    </div>`;
  }

  // ── About view ─────────────────────────────────────────────────────────────
  function showAbout() {
    const convContainer = document.getElementById('conversation-container');
    const convHeader = document.getElementById('conversation-header');
    const sendBar = document.getElementById('send-bar');
    if (convHeader) convHeader.style.display = 'none';
    if (sendBar) sendBar.style.display = 'none';
    if (convContainer) {
      convContainer.innerHTML = renderAboutView();
      convContainer.style.display = '';
    }
  }

  function renderAboutView() {
    const productivity = [
      {
        name: 'Agents',
        icon: '\u{1F4AC}',
        desc: 'Live dashboard of all your Claude Code sessions and subagents across every workspace. Monitor status, read conversations, send messages, and export to Markdown.',
        ready: true,
      },
      {
        name: 'Usage Stats',
        icon: '\u{1F4CA}',
        desc: 'Per-project analytics: top tools, session activity heatmap, prompt volume, code output, and duration metrics. All computed from your existing session data.',
        ready: true,
      },
      {
        name: 'Tips',
        icon: '\u{1F4A1}',
        desc: 'Contextual tip engine with declarative rules, severity levels, and awareness of your custom agents, skills, and hooks. Detects unused assets.',
        ready: false,
      },
      {
        name: 'Health',
        icon: '\u{1F3E5}',
        desc: 'Hook health dashboard. Validates exit codes, checks dependencies, detects stale hooks, and shows green/yellow/red status per hook.',
        ready: false,
      },
      {
        name: 'Yolobash',
        icon: '\u{1F6E1}',
        desc: 'Intelligent permission layer. Rule-based auto-approve, risk scoring for destructive commands, audit trail, and learning mode.',
        ready: false,
      },
    ];

    const learning = [
      {
        name: 'Bashback',
        icon: '\u{1F4BB}',
        desc: 'Study the bash commands Claude uses. Augmented history with flag decomposition, man page parsing, quiz mode, and generated exercises.',
        ready: false,
      },
      {
        name: 'Grammar Check',
        icon: '\u{1F4DD}',
        desc: 'Prompt quality feedback. Clarity analysis, rewrite suggestions, pattern tracking, and grammar/spelling checks for non-native speakers.',
        ready: false,
      },
    ];

    function renderCards(cards) {
      let out = '';
      for (const sp of cards) {
        out += `<div class="about-card${sp.ready ? '' : ' about-card-soon'}">
          <div class="about-card-header">
            <span class="about-card-icon">${sp.icon}</span>
            <span class="about-card-name">${esc(sp.name)}</span>
            ${sp.ready ? '' : '<span class="about-badge-soon">SOON</span>'}
          </div>
          <div class="about-card-desc">${esc(sp.desc)}</div>
        </div>`;
      }
      return out;
    }

    let html = `<div class="about-view">`;
    html += `<div class="about-header">
      <div class="about-title">Claude Code Agent Manager</div>
      <div class="about-subtitle">The companion tool for serious Claude Code users</div>
    </div>`;

    html += `<div class="about-section">
      <div class="about-section-title">Productivity</div>
      <div class="about-grid">${renderCards(productivity)}</div>
    </div>`;

    html += `<div class="about-section">
      <div class="about-section-title">Learning</div>
      <div class="about-grid">${renderCards(learning)}</div>
    </div>`;

    html += `<div class="about-section">
      <div class="about-section-title">Keyboard Shortcuts</div>
      <div class="about-shortcuts">
        <div class="about-shortcut"><kbd>j</kbd> / <kbd>k</kbd> Navigate sessions</div>
        <div class="about-shortcut"><kbd>Enter</kbd> Open conversation</div>
        <div class="about-shortcut"><kbd>h</kbd> / <kbd>l</kbd> Collapse / Expand</div>
        <div class="about-shortcut"><kbd>p</kbd> Pin / Unpin project</div>
        <div class="about-shortcut"><kbd>g</kbd><kbd>g</kbd> Jump to top</div>
        <div class="about-shortcut"><kbd>G</kbd> Jump to bottom</div>
        <div class="about-shortcut"><kbd>/</kbd> Focus search</div>
        <div class="about-shortcut"><kbd>?</kbd> Toggle help</div>
        <div class="about-shortcut"><kbd>Esc</kbd> Deselect / Close</div>
        <div class="about-shortcut"><kbd>Tab</kbd> Switch sidebar / conversation</div>
        <div class="about-shortcut"><kbd>1</kbd>..<kbd>3</kbd> Select tab</div>
      </div>
    </div>`;

    html += `<div class="about-footer">
      <a href="https://github.com/KyleJamesWalker/vscode-cc-agent-manager">GitHub</a>
      <span class="about-footer-sep">\u00B7</span>
      <span>Ctrl+Shift+A to open</span>
    </div>`;

    html += `</div>`;
    return html;
  }

  // Configure marked for safe rendering
  const markedInstance = new marked.Marked({
    breaks: true,
    gfm: true,
  });

  function formatText(text) {
    if (!text) return '';
    try {
      return markedInstance.parse(text);
    } catch (e) {
      console.warn('Markdown parse failed, using plain text fallback', e);
      return esc(text).replaceAll('\n', '<br>');
    }
  }
})();
