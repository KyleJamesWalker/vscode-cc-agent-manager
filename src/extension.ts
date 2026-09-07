import * as vscode from 'vscode';
import { AgentManagerPanel } from './agentManagerPanel';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('claudeAgentManager.openPanel', () => {
      AgentManagerPanel.createOrShow(context);
    }),
    vscode.commands.registerCommand(
      'claudeAgentManager.findSessionsForFile',
      (resource?: vscode.Uri) => {
        const target = resource ?? vscode.window.activeTextEditor?.document.uri;
        if (!target) {
          vscode.window.showWarningMessage(
            'Claude Code Agent Manager: open a file first, or right-click one in the explorer.'
          );
          return;
        }
        AgentManagerPanel.showFileUsage(context, target.fsPath);
      }
    )
  );
}

export function deactivate(): void {}
