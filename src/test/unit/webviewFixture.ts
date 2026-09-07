/**
 * Shared jsdom harness for the webview tests.
 *
 * WEBVIEW_BODY mirrors the markup from AgentManagerPanel._getHtml() (minus the
 * nonce and asset URIs). It lives here rather than in each test file because
 * main.js null-derefs during eval when an element it queries is missing, and
 * three hand-maintained copies had already drifted from the real HTML.
 */

import * as fs from 'fs';
import * as path from 'path';

export const MAIN_JS = fs.readFileSync(
  path.resolve(__dirname, '../../../media/main.js'),
  'utf8'
);

export const WEBVIEW_BODY = `
  <div id="app">
    <div id="sidebar">
      <div class="sidebar-header">
        <span class="sidebar-title">Claude</span>
        <div class="sidebar-actions">
          <span id="last-updated"></span>
          <button id="refresh-btn"></button>
          <div class="settings-wrap">
            <button id="settings-btn"></button>
            <div id="settings-panel">
              <input type="checkbox" id="sound-enabled" />
              <select id="sound-repeat"><option value="0">Never</option></select>
              <button id="test-sound-btn"></button>
              <input type="text" id="export-template" />
              <input type="checkbox" id="export-wiki-links" />
              <input type="radio" name="export-tool" value="compact" id="export-tool-compact" />
              <input type="radio" name="export-tool" value="expanded" id="export-tool-expanded" />
              <input type="radio" name="export-tool" value="omit" id="export-tool-omit" />
            </div>
          </div>
        </div>
      </div>

      <div class="search-wrap">
        <input type="text" id="search" />
        <button class="clear-btn" id="clear-search"></button>
      </div>

      <div class="filter-bar" id="filter-bar">
        <button class="filter-chip" data-filter="active">Active</button>
        <button class="filter-chip" data-filter="waiting">Waiting</button>
        <button class="filter-chip" data-filter="pinned">Pinned</button>
      </div>

      <div id="projects-container"></div>
    </div>

    <div id="sidebar-resize-handle"></div>

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
        <span id="conv-breadcrumb"></span>
        <span id="live-indicator" class="live-indicator"></span>
        <button class="action-btn" id="focus-btn" style="display:none"></button>
        <button class="action-btn" id="send-btn" style="display:none"></button>
        <button class="action-btn" id="notes-btn" style="display:none"></button>
        <button class="export-btn" id="export-btn"></button>
      </div>
      <div id="conversation-container" tabindex="0"></div>
      <div id="health-container" style="display:none"></div>
      <div id="send-bar">
        <div id="send-bar-inner">
          <textarea id="send-input"></textarea>
          <button id="send-submit-btn" disabled></button>
        </div>
        <div id="send-error"></div>
      </div>
    </div>
  </div>
`;

export const DEFAULT_SETTINGS = {
  soundEnabled: false,
  soundRepeatSec: 0,
  exportTemplate: '~/Documents/claude-exports/{slug}.md',
  exportLinkStyle: 'markdown',
  exportToolFormat: 'compact',
};

export interface Harness {
  posted: Array<Record<string, unknown>>;
}

/**
 * Rebuilds the document (document.open clears every listener) and re-evaluates
 * main.js so a suite starts from clean closure state.
 */
export function resetEnv(): Harness {
  const posted: Array<Record<string, unknown>> = [];

  document.open();
  document.write(`<!DOCTYPE html><html><body>${WEBVIEW_BODY}</body></html>`);
  document.close();

  const win = window as unknown as Record<string, unknown>;
  win.acquireVsCodeApi = () => ({
    postMessage: (msg: Record<string, unknown>) => posted.push(msg),
    getState: () => undefined,
    setState: () => undefined,
  });
  win.marked = {
    Marked: class {
      constructor(_opts: unknown) {}
      parse(text: string) {
        return text;
      }
    },
  };
  win.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!('scrollIntoView' in HTMLElement.prototype)) {
    (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView = () => undefined;
  }
  (HTMLElement.prototype as unknown as Record<string, unknown>).scrollIntoView = () => undefined;
  if (!(window as unknown as { CSS?: unknown }).CSS) {
    (window as unknown as Record<string, unknown>).CSS = {
      escape: (value: string) => value.replace(/["\\]/g, '\\$&'),
    };
  }

  (window as unknown as { eval: (code: string) => void }).eval(MAIN_JS);
  return { posted };
}

/** Delivers an extension → webview message. */
export function send(data: Record<string, unknown>): void {
  window.dispatchEvent(new MessageEvent('message', { data }));
}
