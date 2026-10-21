import * as vscode from 'vscode';
import { runDiagnostics } from './auth/diagnose.ts';
import { KiroAuthError, NotLoggedInError, TokenExpiredError } from './auth/errors.ts';
import { createAuth, type AuthConfig, type SourceId } from './auth/factory.ts';
import { formatDuration } from './auth/redact.ts';

function readConfig(): { auth: AuthConfig; cliPath: string } {
  const c = vscode.workspace.getConfiguration('kirorelay');
  return {
    cliPath: c.get<string>('cli.path') || 'kiro-cli',
    auth: {
      sources: c.get<SourceId[]>('auth.sources') ?? ['kiro-cli-db', 'sso-cache'],
      databasePath: c.get<string>('auth.databasePath') || undefined,
      ssoCachePath: c.get<string>('auth.ssoCachePath') || undefined,
      leewaySeconds: c.get<number>('auth.refreshLeewaySeconds') ?? 300,
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Kiro Relay');
  const log = (m: string) => out.appendLine(`[${new Date().toISOString()}] ${m}`);

  let { auth, cliPath } = (() => {
    const cfg = readConfig();
    return { auth: createAuth(cfg.auth, log), cliPath: cfg.cliPath };
  })();

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'kirorelay.diagnose';

  async function refreshStatus(forceReload = false): Promise<void> {
    try {
      const t = await auth.provider.getAccessToken({ forceReload });
      status.text = `$(check) Kiro ${formatDuration(t.expiresAt.getTime() - Date.now()).replace('expira em ', '')}`;
      status.tooltip = `Autenticado via ${t.source}\nClique para diagnosticar.`;
      status.backgroundColor = undefined;
    } catch (e) {
      const warn = new vscode.ThemeColor('statusBarItem.warningBackground');
      if (e instanceof TokenExpiredError) {
        status.text = '$(warning) Kiro: token expirado';
        status.tooltip = e.message;
        status.backgroundColor = warn;
      } else if (e instanceof NotLoggedInError) {
        status.text = '$(warning) Kiro: login necessário';
        status.tooltip = `${e.message}\nClique para diagnosticar.`;
        status.backgroundColor = warn;
      } else {
        status.text = '$(error) Kiro: erro';
        status.tooltip = e instanceof KiroAuthError ? e.message : String(e);
        status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      }
    }
    status.show();
  }

  const diagnose = vscode.commands.registerCommand('kirorelay.diagnose', async () => {
    const report = await runDiagnostics({
      cliPath,
      databaseCandidates: auth.databaseCandidates,
      ssoCacheDir: auth.ssoCacheDir,
      provider: auth.provider,
      host: { 'vscode': vscode.version, 'app': vscode.env.appName },
    });
    out.clear();
    out.appendLine(report);
    out.show(true);
    const pick = await vscode.window.showInformationMessage(
      'Diagnóstico gerado no painel "Kiro Relay". O relatório não contém tokens.',
      'Copiar relatório',
    );
    if (pick === 'Copiar relatório') await vscode.env.clipboard.writeText(report);
    await refreshStatus();
  });

  const reload = vscode.commands.registerCommand('kirorelay.reloadCredentials', async () => {
    auth.provider.invalidate();
    await refreshStatus(true);
    vscode.window.showInformationMessage(`Kiro: ${status.text.replace(/\$\([^)]+\)\s*/, '')}`);
  });

  const onConfig = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration('kirorelay')) return;
    const cfg = readConfig();
    auth = createAuth(cfg.auth, log);
    cliPath = cfg.cliPath;
    await refreshStatus(true);
  });

  const timer = setInterval(() => void refreshStatus(), 60_000);

  context.subscriptions.push(out, status, diagnose, reload, onConfig, {
    dispose: () => clearInterval(timer),
  });

  void refreshStatus(true);
}

export function deactivate(): void {}
