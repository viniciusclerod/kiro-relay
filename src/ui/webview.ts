import { escapeHtml, renderPanel, type PanelData } from './panel.ts';

export const PANEL_COMMANDS = [
  'kirorelay.refreshPanel',
  'kirorelay.manage',
  'kirorelay.diagnose',
  'kirorelay.signIn',
  'workbench.action.openSettings',
] as const;

export interface WebviewOptions {
  language: string;
  cspSource: string;
  logoFontUri: string;
  /** dist/codicons/codicon.css, as a webview URI. */
  codiconsUri: string;
}

export function renderPanelWebview(data: PanelData, options: WebviewOptions): string {
  const csp = `default-src 'none'; img-src data:; font-src ${options.cspSource}; style-src ${options.cspSource} 'unsafe-inline';`;
  return `<!DOCTYPE html>
<html lang="${escapeHtml(options.language)}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(data.title)}</title>
<link rel="stylesheet" href="${escapeHtml(options.codiconsUri)}">
<style>
@font-face { font-family: kirorelay; src: url("${escapeHtml(options.logoFontUri)}") format("woff"); }
body {
  color: var(--vscode-foreground);
  background: var(--vscode-panel-background);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  padding: 12px 20px;
}
main { max-width: 640px; margin: 0 auto; }
table { border-collapse: collapse; }
td { padding: 5px 0; vertical-align: middle; overflow-wrap: anywhere; }
td + td { padding-left: 20px; }
h3 { margin: 4px 0; font-size: 1.6em; }
small { font-size: 0.65em; font-weight: normal; }
hr { border: 0; border-top: 1px solid var(--vscode-panel-border); margin: 12px 0; }
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 3px; }
.codicon { vertical-align: text-bottom; }
.codicon-kirorelay-logo::before { font-family: kirorelay; content: "\\e001"; }
.swap { cursor: default; }
.swap:focus { outline: none; }
.swap:focus-visible td { outline: 1px solid var(--vscode-focusBorder); }
.swap .swap-alt,
.swap:hover .swap-main,
.swap:focus .swap-main { display: none; }
.swap:hover .swap-alt,
.swap:focus .swap-alt { display: inline; }
</style>
</head>
<body><main>${renderPanel(data)}</main></body>
</html>`;
}
