import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { runDiagnostics } from './auth/diagnose.ts';
import { KiroAuthError, NotLoggedInError, TokenExpiredError } from './auth/errors.ts';
import { createAuth, type AuthConfig, type SourceId } from './auth/factory.ts';
import { formatHoursMinutes } from './auth/redact.ts';
import { FirstOutputTimeoutError, streamChat } from './chat/client.ts';
import { RequestBuildError, buildRequest } from './chat/request.ts';
import { KiroStreamError } from './chat/response.ts';
import { fromVsCodeMessages, fromVsCodeTools } from './chat/vscodeMessages.ts';
import { KiroApiError, ModelCatalog, toChatModelInfo, type ChatModelInfo } from './models/catalog.ts';
import { resolveEffort } from './models/effort.ts';

/**
 * Model info sent to VS Code. `statusIcon` is proposed API (not in @types/vscode); VS Code 1.142 uses
 * it for the model's icon in the picker and the chat input instead of guessing one from the name.
 */
type ProviderModelInfo = ChatModelInfo & { statusIcon?: vscode.ThemeIcon };

/** Contributed in package.json (contributes.icons), built from media/kiro.svg. */
const KIRO_ICON_ID = 'kirorelay-kiro';

// UI text goes through vscode.l10n.t (English source, translations in l10n/).
// Logs and the diagnostics report stay in English.

/** Rough estimate (~4 characters per token); Kiro does not expose a tokenizer. */
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
  const cliPath = c.get<string>('cli.path') || 'kiro-cli';
  const renew = c.get<unknown>('auth.renewCommand');
  return {
    cliPath,
    auth: {
      sources: c.get<SourceId[]>('auth.sources') ?? ['kiro-cli-db', 'sso-cache'],
      databasePath: c.get<string>('auth.databasePath') || undefined,
      ssoCachePath: c.get<string>('auth.ssoCachePath') || undefined,
      leewaySeconds: c.get<number>('auth.refreshLeewaySeconds') ?? 300,
      cliPath,
      renewCommand: Array.isArray(renew) ? renew.filter((a): a is string => typeof a === 'string') : ['whoami'],
    },
  };
}

/** Part kinds in the request, for the log (never their content), e.g. "TextPart x5, DataPart(image/png) x1". */
function describeParts(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
  const counts = new Map<string, number>();
  for (const m of messages) {
    for (const p of m.content) {
      let kind = (p as object | null)?.constructor?.name ?? typeof p;
      if (p instanceof vscode.LanguageModelDataPart) kind = `DataPart(${p.mimeType})`;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  return [...counts].map(([k, n]) => `${k} x${n}`).join(', ') || 'none';
}

/** Localized, user-facing description of an error. */
function describeError(e: unknown): string {
  if (e instanceof TokenExpiredError) {
    return vscode.l10n.t(
      'The kiro-cli token expired at {0}. Use kiro-cli (or run "kiro-cli login") to renew it.',
      e.expiredAt.toLocaleString(),
    );
  }
  if (e instanceof NotLoggedInError) {
    return vscode.l10n.t('No kiro-cli credentials found. Run "kiro-cli login" and try again.');
  }
  if (e instanceof KiroAuthError && e.code === 'sqlite-unavailable') {
    return vscode.l10n.t('The node:sqlite module is not available in this VS Code. Use the "sso-cache" source.');
  }
  if (e instanceof KiroApiError || e instanceof KiroStreamError) {
    if (e.reason === 'MONTHLY_REQUEST_COUNT') {
      return vscode.l10n.t('Your Kiro usage limit for this period has been reached.');
    }
    if (e instanceof KiroApiError) {
      return vscode.l10n.t('The Kiro service answered HTTP {0}: {1}', e.status, e.detail);
    }
    return vscode.l10n.t('The Kiro service reported an error: {0}', e.message);
  }
  if (e instanceof FirstOutputTimeoutError) {
    return vscode.l10n.t('Kiro did not start answering in time. Try again.');
  }
  if (e instanceof RequestBuildError) {
    return vscode.l10n.t('The request cannot be sent to Kiro: {0}', e.message);
  }
  return e instanceof Error ? e.message : String(e);
}

export function activate(context: vscode.ExtensionContext): void {
  const out = vscode.window.createOutputChannel('Kiro Relay');
  const log = (m: string) => out.appendLine(`[${new Date().toISOString()}] ${m}`);

  let { auth, cliPath } = (() => {
    const cfg = readConfig();
    return { auth: createAuth(cfg.auth, log), cliPath: cfg.cliPath };
  })();

  const version = String(context.extension.packageJSON.version ?? '0.0.0');
  const userAgent = `kiro-relay/${version} vscode/${vscode.version}`;
  const catalog = new ModelCatalog({
    getToken: (o) => auth.provider.getAccessToken(o),
    userAgent,
    log,
  });
  const modelsChanged = new vscode.EventEmitter<void>();
  let lastTokenOk: boolean | undefined;

  const cannotListModels = (e: unknown) =>
    vscode.l10n.t('Kiro: could not list the models. {0}', describeError(e));

  async function prepareChat(
    modelId: string,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
  ) {
    // modelConfiguration is proposed API (not in @types/vscode); VS Code 1.142 already sends it.
    const modelConfiguration = (options as { modelConfiguration?: Record<string, unknown> })
      .modelConfiguration;
    const kiroModel = (await catalog.get()).models.find((m) => m.id === modelId);
    const settings = vscode.workspace
      .getConfiguration('kirorelay')
      .get<Record<string, unknown>>('reasoningEffort');
    return {
      effort: resolveEffort(modelId, kiroModel?.effort, modelConfiguration, settings),
      chatMessages: fromVsCodeMessages(messages),
      tools: fromVsCodeTools(options.tools),
    };
  }

  const kiroIcon = new vscode.ThemeIcon(KIRO_ICON_ID);

  const provider: vscode.LanguageModelChatProvider<ProviderModelInfo> = {
    onDidChangeLanguageModelChatInformation: modelsChanged.event,

    async provideLanguageModelChatInformation(options) {
      try {
        const list = await catalog.get();
        const note = vscode.l10n.t('Default Kiro model.');
        return list.models.map((m) => ({ ...toChatModelInfo(m, list.defaultModelId, note), statusIcon: kiroIcon }));
      } catch (e) {
        log(`catalog unavailable: ${e instanceof Error ? e.message : String(e)}`);
        if (!options.silent) {
          const diagnoseAction = vscode.l10n.t('Diagnose');
          void vscode.window.showWarningMessage(cannotListModels(e), diagnoseAction).then((pick) => {
            if (pick === diagnoseAction) void vscode.commands.executeCommand('kirorelay.diagnose');
          });
        }
        return [];
      }
    },

    async provideLanguageModelChatResponse(model, messages, options, progress, token) {
      log(`chat request received: model ${model.id}, ${messages.length} messages, parts: ${describeParts(messages)}`);
      let prepared;
      try {
        prepared = await prepareChat(model.id, messages, options);
      } catch (e) {
        log(`chat preparation failed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        throw new Error(describeError(e));
      }
      const { effort, chatMessages, tools } = prepared;
      const conversationId = randomUUID();
      const images = chatMessages.flatMap((m) => m.parts).filter((p) => p.type === 'image');
      log(
        `chat request: model ${model.id}, effort ${effort.level ?? 'n/a'} (${effort.source}), ` +
          `${chatMessages.length} messages, ${tools.length} tools, ${images.length} images` +
          (images.length ? ` (${images.map((i) => `${i.mimeType} ${i.data.length} B`).join(', ')})` : ''),
      );

      // LanguageModelThinkingPart is proposed API; VS Code 1.142 exposes it without a proposal check.
      const ThinkingPart = (vscode as unknown as {
        LanguageModelThinkingPart?: new (value: string) => vscode.LanguageModelResponsePart;
      }).LanguageModelThinkingPart;

      const abort = new AbortController();
      const cancel = token.onCancellationRequested(() => abort.abort());
      const started = Date.now();
      try {
        for await (const event of streamChat({
          getToken: (o) => auth.provider.getAccessToken(o),
          buildBody: (t) =>
            buildRequest({
              modelId: model.id,
              messages: chatMessages,
              tools,
              profileArn: t.profileArn,
              requestFields: effort.requestFields,
              conversationId,
            }),
          userAgent,
          signal: abort.signal,
          log,
        })) {
          switch (event.type) {
            case 'text':
              progress.report(new vscode.LanguageModelTextPart(event.text));
              break;
            case 'reasoning':
              if (ThinkingPart) progress.report(new ThinkingPart(event.text));
              break;
            case 'toolCall':
              progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, event.input));
              break;
            case 'end':
              log(
                `chat done: ${event.stopReason ?? 'no stop reason'}, ` +
                  `${event.credits?.toFixed(4) ?? '?'} credits, ${Date.now() - started} ms`,
              );
              break;
          }
        }
        if (token.isCancellationRequested) log('chat cancelled');
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        log(`chat failed: ${message}`);
        // Validation errors name the tool by index (e.g. "toolConfig.tools.46..."): log which one it is.
        const index = /tools\.(\d+)\./.exec(message)?.[1];
        const tool = index === undefined ? undefined : tools[Number(index)];
        if (tool) {
          const schema = tool.inputSchema as { type?: unknown } | undefined;
          log(`  tool #${index} is "${tool.name}" (input schema type: ${JSON.stringify(schema?.type)})`);
        }
        throw new Error(describeError(e));
      } finally {
        cancel.dispose();
      }
    },

    async provideTokenCount(_model, text) {
      return estimateTokens(text);
    },
  };

  const status = vscode.window.createStatusBarItem('kirorelay.status', vscode.StatusBarAlignment.Right, 50);
  status.name = 'Kiro Relay';
  status.command = 'kirorelay.manage';

  /** What the status bar and the menu show, refreshed by refreshStatus(). */
  let state: { kind: 'ok' | 'expired' | 'signed-out' | 'error'; summary: string; detail?: string } = {
    kind: 'error',
    summary: vscode.l10n.t('Checking kiro-cli credentials…'),
  };

  async function refreshStatus(forceReload = false): Promise<void> {
    const icon = `$(${KIRO_ICON_ID})`;
    try {
      const t = await auth.provider.getAccessToken({ forceReload });
      const remaining = formatHoursMinutes(t.expiresAt.getTime() - Date.now());
      state = {
        kind: 'ok',
        summary: vscode.l10n.t('Signed in, token valid for {0}', remaining),
        detail: [t.source, t.region].filter(Boolean).join(' · '),
      };
      status.text = `${icon} ${remaining}`;
      status.backgroundColor = undefined;
      if (lastTokenOk === false) modelsChanged.fire();
      lastTokenOk = true;
    } catch (e) {
      lastTokenOk = false;
      const warn = new vscode.ThemeColor('statusBarItem.warningBackground');
      if (e instanceof TokenExpiredError) {
        state = { kind: 'expired', summary: vscode.l10n.t('Kiro: token expired'), detail: describeError(e) };
        status.backgroundColor = warn;
      } else if (e instanceof NotLoggedInError) {
        state = { kind: 'signed-out', summary: vscode.l10n.t('Kiro: sign-in required'), detail: describeError(e) };
        status.backgroundColor = warn;
      } else {
        state = { kind: 'error', summary: vscode.l10n.t('Kiro: error'), detail: describeError(e) };
        status.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      }
      status.text = `${icon} ${state.kind === 'error' ? '$(error)' : '$(warning)'}`;
    }
    status.tooltip = [state.summary, state.detail, vscode.l10n.t('Click for Kiro Relay options.')]
      .filter(Boolean)
      .join('\n');
    status.show();
  }

  const diagnose = vscode.commands.registerCommand('kirorelay.diagnose', async () => {
    const report = await runDiagnostics({
      cliPath,
      databaseCandidates: auth.databaseCandidates,
      ssoCacheDir: auth.ssoCacheDir,
      provider: auth.provider,
      renewer: auth.renewer,
      host: { vscode: vscode.version, app: vscode.env.appName, language: vscode.env.language },
    });
    out.clear();
    out.appendLine(report);
    out.show(true);
    const copyAction = vscode.l10n.t('Copy report');
    const pick = await vscode.window.showInformationMessage(
      vscode.l10n.t('Diagnostics written to the "Kiro Relay" output panel. The report contains no tokens.'),
      copyAction,
    );
    if (pick === copyAction) await vscode.env.clipboard.writeText(report);
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
      vscode.window.showInformationMessage(
        vscode.l10n.t('Kiro: {0} models available.', list.models.length),
      );
    } catch (e) {
      vscode.window.showWarningMessage(cannotListModels(e));
    }
  });

  const signIn = vscode.commands.registerCommand('kirorelay.signIn', () => {
    // In remote windows (devcontainer, SSH, WSL) there is no browser next to kiro-cli: use the device code flow.
    const args = vscode.env.remoteName ? ' login --use-device-flow' : ' login';
    const terminal = vscode.window.createTerminal({ name: 'kiro-cli login' });
    terminal.show();
    terminal.sendText(`"${cliPath}"${args}`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Finish signing in in the terminal. Kiro Relay picks up the new token within a minute.'),
    );
  });

  const manage = vscode.commands.registerCommand('kirorelay.manage', async () => {
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const action = (icon: string, label: string, run: () => unknown): Item => ({ label: `$(${icon}) ${label}`, run });
    const stateIcon = state.kind === 'ok' ? KIRO_ICON_ID : state.kind === 'error' ? 'error' : 'warning';
    const items: Item[] = [
      { label: `$(${stateIcon}) ${state.summary}`, detail: state.detail },
      { label: '', kind: vscode.QuickPickItemKind.Separator },
    ];
    if (state.kind === 'signed-out' || state.kind === 'expired') {
      items.push(action('sign-in', vscode.l10n.t('Sign in with kiro-cli'), () => vscode.commands.executeCommand('kirorelay.signIn')));
    }
    items.push(
      action('refresh', vscode.l10n.t('Refresh model list'), () => vscode.commands.executeCommand('kirorelay.refreshModels')),
      action('key', vscode.l10n.t('Reload kiro-cli credentials'), () => vscode.commands.executeCommand('kirorelay.reloadCredentials')),
      action('pulse', vscode.l10n.t('Diagnose authentication'), () => vscode.commands.executeCommand('kirorelay.diagnose')),
      action('output', vscode.l10n.t('Show log'), () => out.show()),
      action('settings-gear', vscode.l10n.t('Open settings'), () =>
        vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`),
      ),
    );
    const pick = await vscode.window.showQuickPick(items, { title: 'Kiro Relay', placeHolder: state.summary });
    await pick?.run?.();
  });

  const reload = vscode.commands.registerCommand('kirorelay.reloadCredentials', async () => {
    auth.provider.invalidate();
    await refreshStatus(true);
    await refreshModels();
    vscode.window.showInformationMessage(state.summary);
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

  context.subscriptions.push(
    out,
    status,
    diagnose,
    reload,
    refreshModelsCmd,
    manage,
    signIn,
    onConfig,
    { dispose: () => clearInterval(timer) },
    registration,
    modelsChanged,
  );

  void refreshStatus(true);
}

export function deactivate(): void {}
