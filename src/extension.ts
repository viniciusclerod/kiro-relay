import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { runDiagnostics } from './auth/diagnose.ts';
import { KiroAuthError, NotLoggedInError, TokenExpiredError } from './auth/errors.ts';
import { createAuth, type AuthConfig, type SourceId } from './auth/factory.ts';
import { LoginSettingsError, buildLoginArgs, type LoginSettings } from './auth/login.ts';
import { formatHoursMinutes } from './auth/redact.ts';
import { SessionTracker, type SessionRecord } from './auth/session.ts';
import { FirstOutputTimeoutError, streamChat } from './chat/client.ts';
import { RequestBuildError, buildRequest } from './chat/request.ts';
import { KiroStreamError } from './chat/response.ts';
import { TurnUsageTracker, estimateContextTokens, interactionKey } from './chat/turnUsage.ts';
import { fromVsCodeMessages, fromVsCodeTools } from './chat/vscodeMessages.ts';
import { UsageTracker, creditItem, formatPercent, type UsageSummary } from './kiro/usage.ts';
import { KiroApiError, ModelCatalog, toChatModelInfo, type ChatModelInfo } from './models/catalog.ts';
import { resolveEffort } from './models/effort.ts';
import { renderPanel, type PanelLink, type PanelRow, type PanelSection } from './ui/panel.ts';

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
  const usage = new UsageTracker({
    getToken: () => auth.provider.getAccessToken(),
    userAgent,
    log,
    onChange: () => renderStatus(),
  });
  const usageTimers: Array<ReturnType<typeof setTimeout>> = [];
  /**
   * Refreshes usage after the last chat response (agent turns come in bursts). Measured on 2026-10-21:
   * the backend reflects consumption 30 to 60 s later, so refresh at 20 s and again at 75 s.
   */
  const refreshUsageSoon = () => {
    for (const t of usageTimers.splice(0)) clearTimeout(t);
    for (const delay of [20_000, 75_000]) {
      usageTimers.push(setTimeout(() => void usage.refresh({ force: true }), delay));
    }
  };
  const turnUsage = new TurnUsageTracker();
  const SESSION_KEY = 'kirorelay.session';
  const session = new SessionTracker(
    {
      get: () => context.globalState.get<SessionRecord>(SESSION_KEY),
      set: (r) => void context.globalState.update(SESSION_KEY, r),
    },
    () => vscode.workspace.getConfiguration('kirorelay').get<number>('auth.sessionHours', 8),
  );
  /** Context window of the model of the last interaction, for the token estimate in the hover. */
  let lastTurnMaxInput = 0;
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
      maxInputTokens: kiroModel?.maxInputTokens ?? 0,
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
      const { effort, chatMessages, tools, maxInputTokens } = prepared;
      const conversationId = randomUUID();
      const turnKey = interactionKey(chatMessages);
      const images = chatMessages.flatMap((m) => m.parts).filter((p) => p.type === 'image');
      log(
        `chat request: model ${model.id}, effort ${effort.level ?? 'n/a'} (${effort.source}), ` +
          `${chatMessages.length} messages, ${tools.length} tools, ${images.length} images` +
          (images.length ? ` (${images.map((i) => `${i.mimeType} ${i.data.length} B`).join(', ')})` : ''),
      );

      // LanguageModelThinkingPart is proposed API; VS Code 1.142 exposes it without a proposal check.
      const ThinkingPart = (vscode as unknown as {
        LanguageModelThinkingPart?: new (
          value: string,
          id?: string,
          metadata?: Record<string, unknown>,
        ) => vscode.LanguageModelResponsePart;
      }).LanguageModelThinkingPart;
      let thinkingOpen = false;
      /** Closes the thinking block like Copilot does; otherwise the answer can end up inside it. */
      const closeThinking = () => {
        if (!thinkingOpen || !ThinkingPart) return;
        thinkingOpen = false;
        progress.report(new ThinkingPart('', undefined, { vscode_reasoning_done: true }));
      };

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
              closeThinking();
              progress.report(new vscode.LanguageModelTextPart(event.text));
              break;
            case 'reasoning':
              // Kiro sends "..." when it hides the reasoning: nothing worth showing.
              if (ThinkingPart && !/^[\s.…]*$/.test(event.text)) {
                thinkingOpen = true;
                progress.report(new ThinkingPart(event.text));
              }
              break;
            case 'toolCall':
              closeThinking();
              progress.report(new vscode.LanguageModelToolCallPart(event.id, event.name, event.input));
              break;
            case 'end': {
              closeThinking();
              turnUsage.add(turnKey, event.credits, event.contextUsagePercentage);
              lastTurnMaxInput = maxInputTokens;
              renderStatus();
              refreshUsageSoon();
              log(
                `chat done: ${event.stopReason ?? 'no stop reason'}, ` +
                  `${event.credits?.toFixed(4) ?? '?'} credits, ${Date.now() - started} ms`,
              );
              break;
            }
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
  // Hover = the Copilot-style panel; click = the Kiro Relay menu. (VS Code only opens a status bar hover
  // on click for its own items: Copilot uses an internal command compared by identity.)
  status.command = 'kirorelay.manage';

  /** What the status bar and the menu show, refreshed by refreshStatus(). */
  let state: {
    kind: 'ok' | 'expired' | 'signed-out' | 'error';
    summary: string;
    detail?: string;
    remaining?: string;
    /** e.g. "IAM Identity Center · https://example.awsapps.com/start · us-east-1" (no secrets). */
    login?: string;
  } = {
    kind: 'error',
    summary: vscode.l10n.t('Checking kiro-cli credentials…'),
  };

  async function refreshStatus(forceReload = false): Promise<void> {
    try {
      const t = await auth.provider.getAccessToken({ forceReload });
      state = {
        kind: 'ok',
        summary: vscode.l10n.t('Signed in, token valid for {0}', formatHoursMinutes(t.expiresAt.getTime() - Date.now())),
        detail: [t.source, t.region].filter(Boolean).join(' · '),
        remaining: formatHoursMinutes(t.expiresAt.getTime() - Date.now()),
        login: [t.startUrl ? vscode.l10n.t('IAM Identity Center') : undefined, t.startUrl, t.region]
          .filter(Boolean)
          .join(' · '),
      };
      const renewal = auth.renewer.last;
      session.observe(t, Date.now(), renewal?.status === 'ran' ? renewal.at : undefined);
      if (lastTokenOk === false) modelsChanged.fire();
      lastTokenOk = true;
      void usage.refresh();
    } catch (e) {
      lastTokenOk = false;
      if (e instanceof TokenExpiredError) {
        state = { kind: 'expired', summary: vscode.l10n.t('Kiro: token expired'), detail: describeError(e) };
      } else if (e instanceof NotLoggedInError) {
        state = { kind: 'signed-out', summary: vscode.l10n.t('Kiro: sign-in required'), detail: describeError(e) };
      } else {
        state = { kind: 'error', summary: vscode.l10n.t('Kiro: error'), detail: describeError(e) };
      }
    }
    renderStatus();
  }

  const lang = vscode.env.language;
  const fmtNumber = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 2 });
  // The extension host may run in a container (UTC): show the reset day in UTC, like the Kiro IDE.
  const fmtResetDay = (d: Date) => d.toLocaleDateString(lang, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  /** "KIRO PRO" -> "Kiro Pro". */
  const planName = (plan: string) => plan.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());

  const fmtPercent1 = (n: number) => n.toLocaleString(lang, { maximumFractionDigits: 1 });
  const fmtCompact = (n: number) => n.toLocaleString(lang, { notation: 'compact', maximumFractionDigits: 1 });

  /** One line about credits, for the menu (plain text). */
  function creditsLine(u: UsageSummary | undefined): string | undefined {
    const c = u && creditItem(u);
    if (!c) return undefined;
    const amount = c.limit === undefined ? fmtNumber(c.used) : `${fmtNumber(c.used)} / ${fmtNumber(c.limit)}`;
    const percent = formatPercent(c, lang);
    const pct = percent === undefined ? '' : ` (${vscode.l10n.t('{0}% used', percent)})`;
    return `${c.name}: ${amount}${pct}`;
  }

  /** Copilot-style hover panel (layout in src/ui/panel.ts). */
  function usageTooltip(): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.supportHtml = true;
    md.isTrusted = {
      enabledCommands: [
        'kirorelay.refreshUsage',
        'kirorelay.manage',
        'kirorelay.diagnose',
        'kirorelay.signIn',
        'workbench.action.openSettings',
      ],
    };
    const u = usage.current;
    const sections: PanelSection[] = [];

    // Account
    if (state.kind === 'ok') {
      const rows: PanelRow[] = [
        { label: vscode.l10n.t('Token'), value: vscode.l10n.t('{0} left', state.remaining ?? '?') },
        { label: vscode.l10n.t('Kiro session'), ...sessionValue() },
      ];
      if (state.login) {
        const [kind, url, region] = state.login.split(' · ');
        let host: string | undefined;
        try {
          host = url ? new URL(url).hostname : undefined;
        } catch {
          host = undefined;
        }
        if (url) {
          rows.push({
            label: kind ?? '',
            value: [host ?? url, region].filter(Boolean).join(' · '),
            href: host ? url : undefined,
          });
        }
      }
      sections.push({ title: vscode.l10n.t('Account'), aside: vscode.l10n.t('Signed in'), asideIcon: KIRO_ICON_ID, rows });
    } else {
      sections.push({
        title: vscode.l10n.t('Account'),
        aside: state.summary,
        asideIcon: state.kind === 'error' ? 'error' : 'warning',
        rows: state.detail ? [{ label: state.detail, value: '' }] : [],
      });
    }

    // Credits
    const c = u && creditItem(u);
    if (c) {
      const percent = formatPercent(c, lang);
      const rows: PanelRow[] = [];
      if (c.limit !== undefined) {
        rows.push({ label: vscode.l10n.t('Used'), value: `${fmtNumber(c.used)} / ${fmtNumber(c.limit)}` });
      } else {
        rows.push({ label: vscode.l10n.t('Used'), value: vscode.l10n.t('{0} used, no limit', fmtNumber(c.used)) });
      }
      for (const b of u.bonuses) {
        const expires = b.expiresAt ? ` · ${vscode.l10n.t('expires {0}', fmtResetDay(b.expiresAt))}` : '';
        rows.push({ label: b.name, value: `${fmtNumber(b.used)} / ${fmtNumber(b.total)}${expires}`, icon: 'gift' });
      }
      if (u.overagesEnabled) rows.push({ label: vscode.l10n.t('Overages'), value: vscode.l10n.t('Enabled') });
      sections.push({
        title: c.name,
        aside: u.resetsAt ? vscode.l10n.t('Resets {0}', fmtResetDay(u.resetsAt)) : undefined,
        highlight: percent === undefined ? undefined : { value: `${percent}%`, caption: vscode.l10n.t('used') },
        progress: c.limit === undefined ? undefined : (c.used / c.limit) * 100,
        rows,
      });
    } else if (usage.lastError) {
      sections.push({ title: vscode.l10n.t('Credits'), aside: vscode.l10n.t('Credit usage unavailable.'), asideIcon: 'warning' });
    }

    // Last interaction
    const last = turnUsage.last;
    if (last) {
      const rows: PanelRow[] = [];
      if (last.contextPercent !== undefined) {
        const tokens = estimateContextTokens(last.contextPercent, lastTurnMaxInput);
        rows.push({
          label: vscode.l10n.t('Context'),
          value: `${fmtPercent1(last.contextPercent)}%${tokens === undefined ? '' : ` · ≈${fmtCompact(tokens)} tokens`}`,
        });
      }
      if (last.requests > 1) rows.push({ label: vscode.l10n.t('Requests'), value: String(last.requests) });
      const sess = turnUsage.session;
      const count = sess.interactions === 1 ? vscode.l10n.t('1 interaction') : vscode.l10n.t('{0} interactions', sess.interactions);
      rows.push({ label: vscode.l10n.t('This session'), value: `${vscode.l10n.t('{0} credits', fmtNumber(sess.credits))} · ${count}` });
      sections.push({ title: vscode.l10n.t('Last interaction'), aside: vscode.l10n.t('{0} credits', fmtNumber(last.credits)), rows });
    }

    const links: PanelLink[] = [
      { label: vscode.l10n.t('Refresh'), href: 'command:kirorelay.refreshUsage', icon: 'refresh' },
      { label: vscode.l10n.t('Diagnose'), href: 'command:kirorelay.diagnose', icon: 'pulse' },
      { label: vscode.l10n.t('Menu'), href: 'command:kirorelay.manage', icon: 'list-unordered' },
    ];
    if (state.kind === 'signed-out' || state.kind === 'expired') {
      links.unshift({ label: vscode.l10n.t('Sign in'), href: 'command:kirorelay.signIn', icon: 'sign-in' });
    }

    const settingsArg = encodeURIComponent(JSON.stringify([`@ext:${context.extension.id}`]));
    md.appendMarkdown(
      renderPanel({
        title: u?.plan ? `Kiro ${planName(u.plan).replace(/^Kiro\s+/i, '')}` : 'Kiro Relay',
        settings: { href: `command:workbench.action.openSettings?${settingsArg}`, tooltip: vscode.l10n.t('Open settings') },
        sections,
        links,
      }),
    );
    return md;
  }

  /** Remaining time of the IAM Identity Center session, marked "≈" when estimated. */
  function sessionValue(): { value: string; mutedValue?: boolean } {
    const est = session.estimate();
    const left = est.endsAt ? est.endsAt.getTime() - Date.now() : undefined;
    if (left === undefined || left <= 0) {
      const hours = vscode.workspace.getConfiguration('kirorelay').get<number>('auth.sessionHours', 8);
      return { value: vscode.l10n.t('unknown (up to {0} h after sign-in)', hours), mutedValue: true };
    }
    const text = vscode.l10n.t('{0} left', formatHoursMinutes(left));
    return { value: est.exact ? text : `≈ ${text} (${vscode.l10n.t('estimate')})` };
  }

  function renderStatus(): void {
    const icon = `$(${KIRO_ICON_ID})`;
    if (state.kind === 'ok') {
      status.text = icon;
      status.backgroundColor = undefined;
    } else {
      status.text = `${icon} ${state.kind === 'error' ? '$(error)' : '$(warning)'}`;
      status.backgroundColor = new vscode.ThemeColor(
        state.kind === 'error' ? 'statusBarItem.errorBackground' : 'statusBarItem.warningBackground',
      );
    }
    status.tooltip = usageTooltip();
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

  const refreshUsageCmd = vscode.commands.registerCommand('kirorelay.refreshUsage', async () => {
    const u = await usage.refresh({ force: true });
    renderStatus();
    if (!u) {
      void vscode.window.showWarningMessage(vscode.l10n.t('Credit usage unavailable.'));
    } else if (creditsLine(u)) {
      void vscode.window.showInformationMessage(`Kiro: ${creditsLine(u)}`);
    }
  });

  const signIn = vscode.commands.registerCommand('kirorelay.signIn', async () => {
    const c = vscode.workspace.getConfiguration('kirorelay.login');
    const settings: LoginSettings = {
      license: c.get<string>('license'),
      startUrl: c.get<string>('startUrl'),
      region: c.get<string>('region'),
      deviceFlow: c.get<LoginSettings['deviceFlow']>('deviceFlow'),
    };
    let args: string[];
    try {
      args = buildLoginArgs(settings, vscode.env.remoteName !== undefined);
    } catch (e) {
      if (!(e instanceof LoginSettingsError)) throw e;
      const open = vscode.l10n.t('Open settings');
      const pick = await vscode.window.showErrorMessage(vscode.l10n.t('Invalid setting {0}: {1}', e.setting, e.message), open);
      if (pick === open) await vscode.commands.executeCommand('workbench.action.openSettings', e.setting);
      return;
    }
    log(`sign-in: running "${cliPath} ${args.join(' ')}" in a terminal`);
    // kiro-cli runs as the terminal's process: no shell, so no setting can inject commands.
    const terminal = vscode.window.createTerminal({ name: 'kiro-cli login', shellPath: cliPath, shellArgs: args });
    terminal.show();
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Finish signing in in the terminal. Kiro Relay picks up the new token within a minute.'),
    );
    // Pick the new token up as soon as kiro-cli exits.
    const closed = vscode.window.onDidCloseTerminal((t) => {
      if (t !== terminal) return;
      closed.dispose();
      auth.provider.invalidate();
      void refreshStatus(true).then(() => refreshModels());
    });
    context.subscriptions.push(closed);
  });

  const manage = vscode.commands.registerCommand('kirorelay.manage', async () => {
    type Item = vscode.QuickPickItem & { run?: () => unknown };
    const action = (icon: string, label: string, run: () => unknown): Item => ({ label: `$(${icon}) ${label}`, run });
    const stateIcon = state.kind === 'ok' ? KIRO_ICON_ID : state.kind === 'error' ? 'error' : 'warning';
    const items: Item[] = [
      { label: `$(${stateIcon}) ${state.summary}`, detail: state.detail },
      ...(creditsLine(usage.current)
        ? [{ label: `$(credit-card) ${creditsLine(usage.current)}`, detail: usage.current?.plan } as Item]
        : []),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
    ];
    if (state.kind === 'signed-out' || state.kind === 'expired') {
      items.push(action('sign-in', vscode.l10n.t('Sign in with kiro-cli'), () => vscode.commands.executeCommand('kirorelay.signIn')));
    }
    items.push(
      action('credit-card', vscode.l10n.t('Refresh credit usage'), () => vscode.commands.executeCommand('kirorelay.refreshUsage')),
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
    refreshUsageCmd,
    onConfig,
    { dispose: () => usageTimers.forEach((t) => clearTimeout(t)) },
    { dispose: () => clearInterval(timer) },
    registration,
    modelsChanged,
  );

  void refreshStatus(true);
}

export function deactivate(): void {}
