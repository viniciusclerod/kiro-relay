import * as vscode from 'vscode';
import { runDiagnostics } from './auth/diagnose.ts';
import { KiroAuthError, NotLoggedInError, TokenExpiredError } from './auth/errors.ts';
import { createAuth, type AuthConfig, type SourceId } from './auth/factory.ts';
import { formatDuration } from './auth/redact.ts';
import { ModelCatalog, toChatModelInfo, type ChatModelInfo } from './models/catalog.ts';

/** Estimativa grosseira (~4 caracteres por token); o Kiro não expõe tokenizador. */
function estimateTokens(input: string | vscode.LanguageModelChatRequestMessage): number {
  const text =
    typeof input === 'string'
      ? input
      : input.content
          .map((p) => (p instanceof vscode.LanguageModelTextPart ? p.value : ''))
          .join('');
  return Math.ceil(text.length / 4);
}

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

  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  const catalog = new ModelCatalog({
    getToken: (o) => auth.provider.getAccessToken(o),
    userAgent: `kiro-relay/${version} vscode/${vscode.version}`,
    log,
  });
  const modelsChanged = new vscode.EventEmitter<void>();
  let lastTokenOk: boolean | undefined;

  const provider: vscode.LanguageModelChatProvider<ChatModelInfo> = {
    onDidChangeLanguageModelChatInformation: modelsChanged.event,

    async provideLanguageModelChatInformation(options) {
      try {
        const list = await catalog.get();
        return list.models.map((m) => toChatModelInfo(m, list.defaultModelId));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`catálogo indisponível: ${msg}`);
        if (!options.silent) {
          void vscode.window
            .showWarningMessage(`Kiro: não foi possível listar os modelos. ${msg}`, 'Diagnosticar')
            .then((pick) => {
              if (pick) void vscode.commands.executeCommand('kirorelay.diagnose');
            });
        }
        return [];
      }
    },

    async provideLanguageModelChatResponse() {
      throw new Error(
        'Kiro Relay: o chat ainda não foi implementado nesta versão (só a listagem de modelos).',
      );
    },

    async provideTokenCount(_model, text) {
      return estimateTokens(text);
    },
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.command = 'kirorelay.diagnose';

  async function refreshStatus(forceReload = false): Promise<void> {
    try {
      const t = await auth.provider.getAccessToken({ forceReload });
      status.text = `$(check) Kiro ${formatDuration(t.expiresAt.getTime() - Date.now()).replace('expira em ', '')}`;
      status.tooltip = `Autenticado via ${t.source}\nClique para diagnosticar.`;
      status.backgroundColor = undefined;
      if (lastTokenOk === false) modelsChanged.fire();
      lastTokenOk = true;
    } catch (e) {
      lastTokenOk = false;
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

  async function refreshModels(): Promise<void> {
    catalog.invalidate();
    modelsChanged.fire();
  }

  const refreshModelsCmd = vscode.commands.registerCommand('kirorelay.refreshModels', async () => {
    try {
      const list = await catalog.get({ force: true });
      modelsChanged.fire();
      vscode.window.showInformationMessage(`Kiro: ${list.models.length} modelos disponíveis.`);
    } catch (e) {
      vscode.window.showWarningMessage(
        `Kiro: não foi possível listar os modelos. ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  });

  const manage = vscode.commands.registerCommand('kirorelay.manage', async () => {
    const items = [
      { label: '$(refresh) Atualizar lista de modelos', command: 'kirorelay.refreshModels' },
      { label: '$(key) Recarregar credenciais do kiro-cli', command: 'kirorelay.reloadCredentials' },
      { label: '$(pulse) Diagnosticar autenticação', command: 'kirorelay.diagnose' },
    ];
    const pick = await vscode.window.showQuickPick(items, { title: 'Kiro Relay' });
    if (pick) await vscode.commands.executeCommand(pick.command);
  });

  const reload = vscode.commands.registerCommand('kirorelay.reloadCredentials', async () => {
    auth.provider.invalidate();
    await refreshStatus(true);
    await refreshModels();
    vscode.window.showInformationMessage(`Kiro: ${status.text.replace(/\$\([^)]+\)\s*/, '')}`);
  });

  const onConfig = vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (!e.affectsConfiguration('kirorelay')) return;
    const cfg = readConfig();
    auth = createAuth(cfg.auth, log);
    cliPath = cfg.cliPath;
    await refreshStatus(true);
    await refreshModels();
  });

  const timer = setInterval(() => void refreshStatus(), 60_000);

  const registration = vscode.lm.registerLanguageModelChatProvider('kirorelay', provider);

  context.subscriptions.push(out, status, diagnose, reload, refreshModelsCmd, manage, onConfig, {
    dispose: () => clearInterval(timer),
  }, registration, modelsChanged);

  void refreshStatus(true);
}

export function deactivate(): void {}
