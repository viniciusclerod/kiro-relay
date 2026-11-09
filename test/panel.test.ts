import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { barColorsFor, escapeHtml, progressBar, renderPanel, type PanelData } from '../src/ui/panel.ts';
import { renderTooltip } from '../src/ui/tooltip.ts';
import { PANEL_COMMANDS, panelToggleAction, renderPanelWebview, type WebviewOptions } from '../src/ui/webview.ts';

test('status view targets a valid container in the secondary side bar', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const containers = manifest.contributes.viewsContainers.secondarySidebar;
  assert.equal(containers.length, 1);
  const container = containers[0];
  assert.match(container.id, /^[a-z0-9_-]+$/i, 'VS Code rejects dots in view container IDs');
  assert.equal(container.title, 'Kiro Relay');
  const view = manifest.contributes.views[container.id].find(
    (view: { id: string; type: string }) => view.id === 'kirorelay.statusPanel' && view.type === 'webview',
  );
  assert.ok(view);
  assert.equal(view.icon, container.icon);
  assert.ok(readFileSync(new URL(`../${view.icon}`, import.meta.url)).length > 0);
});

test('Agents editor title contributes the editor-only Toggle without the broken input status button', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const command = manifest.contributes.commands.find(
    (command: { command: string }) => command.command === 'kirorelay.toggleChatPanel',
  );
  assert.ok(command);
  assert.equal(command.icon, '$(kirorelay-logo)');
  assert.ok(manifest.contributes.icons['kirorelay-logo']);
  assert.deepEqual(manifest.contributes.menus['editor/title'], [{
    command: command.command,
    when: 'isSessionsWindow',
    group: 'navigation@20',
  }]);
  assert.equal(manifest.contributes.menus['chat/input/status'], undefined);
  assert.equal(command.title, '%command.toggleChatPanel.title%');
  assert.deepEqual(manifest.contributes.menus.commandPalette, [{ command: command.command, when: 'isSessionsWindow' }]);
  assert.equal(manifest.enabledApiProposals, undefined);
});

test('toggle opens or closes the editor panel when the sidebar focus command is missing', () => {
  assert.equal(panelToggleAction({ sidebarVisible: false, sidebarAvailable: false, editorVisible: false }), 'open-editor');
  assert.equal(panelToggleAction({ sidebarVisible: false, sidebarAvailable: false, editorVisible: true }), 'close-editor');
});

test('chat Toggle opens and closes the editor even when a sidebar view is available', () => {
  for (const sidebarVisible of [false, true]) {
    for (const sidebarAvailable of [false, true]) {
      assert.equal(panelToggleAction({ sidebarVisible, sidebarAvailable, editorVisible: false, preferEditor: true }), 'open-editor');
      assert.equal(panelToggleAction({ sidebarVisible, sidebarAvailable, editorVisible: true, preferEditor: true }), 'close-editor');
    }
  }
});

test('toggle preserves sidebar behavior when its focus command is registered', () => {
  assert.equal(panelToggleAction({ sidebarVisible: false, sidebarAvailable: true, editorVisible: false }), 'open-sidebar');
  assert.equal(panelToggleAction({ sidebarVisible: false, sidebarAvailable: true, editorVisible: true }), 'close-editor');
  assert.equal(panelToggleAction({ sidebarVisible: true, sidebarAvailable: true, editorVisible: false }), 'close-sidebar');
  assert.equal(panelToggleAction({ sidebarVisible: true, sidebarAvailable: false, editorVisible: false }), 'close-sidebar');
});

const DATA: PanelData = {
  barColors: barColorsFor('dark'),
  title: 'Kiro Pro',
  settings: { href: 'command:workbench.action.openSettings?%5B%22%40ext%3Ax.y%22%5D', tooltip: 'Open settings' },
  sections: [
    {
      title: 'Account',
      aside: 'Signed in',
      asideIcon: 'kirorelay-logo',
      rows: [
        { label: 'Token', value: '9 min left' },
        { label: 'Kiro session', value: 'unknown (up to 8 h after sign-in)', mutedValue: true },
        { label: 'IAM Identity Center', value: 'example.awsapps.com · us-east-1', href: 'https://example.awsapps.com/start/' },
      ],
    },
    {
      title: 'Credits',
      aside: 'Resets Nov 1, 12:00 AM UTC',
      highlight: { value: '0.9%', caption: 'used', alt: { value: '9.97 / 1,000', caption: 'used' } },
      progress: 0.9,
    },
  ],
  links: [
    { label: 'Refresh', href: 'command:kirorelay.refreshUsage', icon: 'refresh' },
    { label: 'Menu', href: 'command:kirorelay.manage', icon: 'list-unordered' },
  ],
};

test('skeleton: header, one full-width table per section, separators, right-aligned values', () => {
  const html = renderPanel(DATA);
  assert.equal((html.match(/<hr>/g) ?? []).length, DATA.sections.length + 1);
  assert.ok((html.match(/<table width="100%">/g) ?? []).length >= DATA.sections.length + 1);
  assert.match(html, /<td align="right"><a href="command:workbench\.action\.openSettings\?[^"]+" title="Open settings"><span class="codicon codicon-settings-gear"><\/span><\/a><\/td>/);
  assert.match(html, /<h3><span class="swap-main">0\.9% <small>/);
  assert.match(html, /Resets Nov 1, 12:00 AM UTC/);
  assert.match(html, /<a href="https:\/\/example\.awsapps\.com\/start\/">example\.awsapps\.com · us-east-1<\/a>/);
  assert.ok(!html.includes('$('), 'theme icon syntax is not processed inside HTML: codicon spans are used');
});

test('text is escaped, including markdown and theme-icon characters', () => {
  assert.equal(escapeHtml('<b>&$(x)[y]|*'), '&#60;b&#62;&#38;&#36;(x)&#91;y&#93;&#124;&#42;');
  const html = renderPanel({ ...DATA, title: '<script>' });
  assert.ok(!html.includes('<script>'));
});

test('progressBar: SVG image stretched to the panel, proportional, a sliver for any usage', () => {
  const colors = barColorsFor('dark');
  const svgOf = (html: string) =>
    Buffer.from(html.match(/base64,([A-Za-z0-9+/=]+)"/)![1]!, 'base64').toString('utf8');
  const html = progressBar(20, colors);
  assert.match(html, /^<img src="data:image\/svg\+xml;base64,[^"]+" width="100%" height="4" alt="20\.0%">$/);
  assert.match(svgOf(html), /<rect width="20\.00" height="4" rx="2" fill="#0E70C0"\/>/);
  assert.match(svgOf(progressBar(0.9, colors)), /<rect width="1\.50"/);
  assert.equal((svgOf(progressBar(0, colors)).match(/<rect/g) ?? []).length, 1, 'only the track');
  assert.match(svgOf(progressBar(150, colors)), /<rect width="100\.00" height="4" rx="2" fill="#0E70C0"/);
  // Invalid colors never reach the SVG.
  assert.ok(!svgOf(progressBar(5, { fill: 'red"/><script>', track: 'x' })).includes('script'));
});

test('highlight: percentage by default, credits swapped in on hover or focus', () => {
  const html = renderPanel({
    ...DATA,
    sections: [{ title: 'Credits', highlight: { value: '0.9%', caption: 'used', alt: { value: '9.97 / 1,000', caption: 'used' } } }],
  });
  assert.match(
    html,
    /<tr class="swap" tabindex="0"><td colspan="2"><h3><span class="swap-main">0\.9% <small>.*used.*<\/small><\/span><span class="swap-alt">9\.97 \/ 1,000 <small>.*used.*<\/small><\/span><\/h3><\/td><\/tr>/,
  );
  const plain = renderPanel({ ...DATA, sections: [{ title: 'Credits', highlight: { value: '5%', caption: 'used' } }] });
  assert.ok(!plain.includes('swap'), 'no swap without an alternative value');
});

test('rows with altValue swap the value; others stay static', () => {
  const html = renderPanel({
    ...DATA,
    sections: [{ title: 'Last interaction', rows: [
      { label: 'Context', value: '8%', altValue: '≈16K tokens' },
      { label: 'Requests', value: '3' },
    ] }],
  });
  assert.match(html, /<tr class="swap" tabindex="0"><td>.*Context.*<\/td><td align="right"><span class="swap-main">8%<\/span><span class="swap-alt">≈16K tokens<\/span><\/td><\/tr>/);
  assert.match(html, /<tr><td>.*Requests.*<\/td><td align="right">3<\/td><\/tr>/);
  assert.ok(!renderPanel({ ...DATA, sections: [{ title: 'x', rows: [{ label: 'a', value: '<b>', altValue: '<i>' }] }] }).includes('<i>'));
});

const WEBVIEW: WebviewOptions = {
  language: 'en',
  cspSource: 'https://test.vscode-cdn.net',
  logoFontUri: 'https://test.vscode-cdn.net/media/kirorelay-icons.woff',
  codiconsUri: 'https://test.vscode-cdn.net/dist/codicons/codicon.css',
};

test('webview embeds the complete panel, restricts resources and supports themes without scripts', () => {
  const html = renderPanelWebview(DATA, WEBVIEW);
  assert.match(html, /^<!DOCTYPE html>\n<html lang="en">/);
  assert.ok(html.includes(`<body><main>${renderPanel(DATA)}</main></body>`));
  assert.match(html, /Content-Security-Policy/);
  assert.ok(html.includes('default-src &#39;none&#39;'));
  assert.ok(html.includes('img-src data:;'));
  assert.ok(html.includes(`font-src ${WEBVIEW.cspSource};`));
  assert.ok(html.includes(`style-src ${WEBVIEW.cspSource} &#39;unsafe-inline&#39;;`));
  assert.match(html, /var\(--vscode-panel-background\)/);
  assert.match(html, /a:focus-visible/);
  assert.match(html, /\.swap \.swap-alt,\n\.swap:hover \.swap-main,\n\.swap:focus \.swap-main \{ display: none; \}/);
  assert.match(html, /\.swap:hover \.swap-alt,\n\.swap:focus \.swap-alt \{ display: inline; \}/);
  assert.ok(!/<script\b|<iframe\b/.test(html));
  const links = [...html.matchAll(/<link\b[^>]*>/g)].map((m) => m[0]);
  assert.deepEqual(links, [`<link rel="stylesheet" href="${WEBVIEW.codiconsUri}">`], 'only the codicons stylesheet');
  assert.ok(html.includes(`url("${WEBVIEW.logoFontUri}")`));
});

test('webview escapes document metadata as well as panel content', () => {
  const html = renderPanelWebview(
    { ...DATA, title: '</title><script>alert(1)</script>' },
    { ...WEBVIEW, language: 'en" onload="alert(1)' },
  );
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('lang="en" onload='));
  assert.ok(html.includes('lang="en&#34; onload=&#34;alert(1)"'));
});

test('panel actions are restricted to an explicit command allowlist', () => {
  const data: PanelData = {
    ...DATA,
    links: PANEL_COMMANDS.filter((id) => id.startsWith('kirorelay.')).map((id) => ({
      label: id,
      href: `command:${id}`,
    })),
  };
  const html = renderPanelWebview(data, WEBVIEW);
  for (const match of html.matchAll(/href="command:([^"?]+)(?:\?[^"]*)?"/g)) {
    assert.ok(PANEL_COMMANDS.some((id) => id === match[1]), `command not allowed: ${match[1]}`);
  }
  assert.ok(!PANEL_COMMANDS.some((id: string) => id === 'workbench.action.terminal.new'));
});

test('tooltip contains only localized token and session expiry as plain text', () => {
  assert.equal(
    renderTooltip({
      tokenLabel: 'Token',
      tokenValue: '9 min left',
      sessionLabel: 'Kiro session',
      sessionValue: 'approximately 7 h left (estimate)',
    }),
    'Token: 9 min left\nKiro session: approximately 7 h left (estimate)',
  );
  assert.equal(
    renderTooltip({
      tokenLabel: 'Token',
      tokenValue: 'Kiro: sign-in required',
      sessionLabel: 'Sessão do Kiro',
      sessionValue: 'Indisponível',
    }),
    'Token: Kiro: sign-in required\nSessão do Kiro: Indisponível',
  );
});
