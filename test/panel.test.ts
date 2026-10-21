import test from 'node:test';
import assert from 'node:assert/strict';
import { BAR_WIDTH, escapeHtml, progressBar, renderPanel, type PanelData } from '../src/ui/panel.ts';

// Rules of the VS Code 1.142 markdown sanitizer (workbench: allowed tags, ICe attributes, style/class checks).
const ALLOWED_TAGS = new Set(
  'a abbr b bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure h1 h2 h3 h4 h5 h6 hr i img ins kbd label li mark ol p pre q rp rt ruby s samp small source span strike strong sub summary sup table tbody td tfoot th thead time tr tt u ul var video wbr'.split(' '),
);
const ALLOWED_ATTRS = new Set(
  'align autoplay alt colspan controls draggable height href loop muted playsinline poster rowspan src target title type width start checked disabled value data-code data-href data-severity'.split(' '),
);
const SPAN_STYLE =
  /^(color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(background-color\:(#[0-9a-fA-F]+|var\(--vscode(-[a-zA-Z0-9]+)+\));)?(display\:inline-block;)?(border-radius:[0-9]+px;)?$/;
const SPAN_CLASS = /^codicon codicon-[a-z\-]+( codicon-modifier-[a-z\-]+)?$/;

/** Returns the attributes the VS Code sanitizer would drop (empty = everything survives). */
function droppedBySanitizer(html: string): string[] {
  const dropped: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z0-9]+)([^>]*)>/g)) {
    const tag = m[2]!.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) dropped.push(`<${tag}>`);
    for (const a of m[3]!.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      const [, name, value] = a as unknown as [string, string, string];
      if (name === 'style') {
        if (tag !== 'span' || !SPAN_STYLE.test(value)) dropped.push(`${tag}[style="${value}"]`);
      } else if (name === 'class') {
        if (tag !== 'span' || !SPAN_CLASS.test(value)) dropped.push(`${tag}[class="${value}"]`);
      } else if (!ALLOWED_ATTRS.has(name)) {
        dropped.push(`${tag}[${name}]`);
      }
    }
  }
  return dropped;
}

const DATA: PanelData = {
  title: 'Kiro Pro',
  settings: { href: 'command:workbench.action.openSettings?%5B%22%40ext%3Ax.y%22%5D', tooltip: 'Open settings' },
  sections: [
    {
      title: 'Account',
      aside: 'Signed in',
      asideIcon: 'kirorelay-kiro',
      rows: [
        { label: 'Token', value: '9 min left' },
        { label: 'Kiro session', value: 'unknown (up to 8 h after sign-in)', mutedValue: true },
        { label: 'IAM Identity Center', value: 'example.awsapps.com · us-east-1', href: 'https://example.awsapps.com/start/' },
      ],
    },
    {
      title: 'Credits',
      aside: 'Resets Nov 1',
      highlight: { value: '0.9%', caption: 'used' },
      progress: 0.9,
      rows: [{ label: 'Used', value: '9.97 / 1,000' }],
    },
  ],
  links: [
    { label: 'Refresh', href: 'command:kirorelay.refreshUsage', icon: 'refresh' },
    { label: 'Menu', href: 'command:kirorelay.manage', icon: 'list-unordered' },
  ],
};

test('the whole panel survives the VS Code markdown sanitizer', () => {
  assert.deepEqual(droppedBySanitizer(renderPanel(DATA)), []);
});

test('skeleton: header, one full-width table per section, separators, right-aligned values', () => {
  const html = renderPanel(DATA);
  assert.equal((html.match(/<hr>/g) ?? []).length, DATA.sections.length + 1);
  assert.ok((html.match(/<table width="100%">/g) ?? []).length >= DATA.sections.length + 1);
  assert.match(html, /<td align="right"><a href="command:workbench\.action\.openSettings\?[^"]+" title="Open settings"><span class="codicon codicon-settings-gear"><\/span><\/a><\/td>/);
  assert.match(html, /<h3>0\.9% <small>/);
  assert.match(html, /<a href="https:\/\/example\.awsapps\.com\/start\/">example\.awsapps\.com · us-east-1<\/a>/);
  assert.ok(!html.includes('$('), 'theme icon syntax is not processed inside HTML: codicon spans are used');
});

test('text is escaped, including markdown and theme-icon characters', () => {
  assert.equal(escapeHtml('<b>&$(x)[y]|*'), '&#60;b&#62;&#38;&#36;(x)&#91;y&#93;&#124;&#42;');
  const html = renderPanel({ ...DATA, title: '<script>' });
  assert.ok(!html.includes('<script>'));
});

test('progressBar: proportional, at least a sliver for any usage, always the same width', () => {
  const filledOf = (html: string) => (html.match(/progressBar-background\);">(━*)</)?.[1] ?? '').length;
  const total = (html: string) => (html.match(/━/g) ?? []).length;
  assert.equal(filledOf(progressBar(0)), 0);
  assert.equal(filledOf(progressBar(0.9)), 2);
  assert.equal(filledOf(progressBar(50)), BAR_WIDTH / 2);
  assert.equal(filledOf(progressBar(150)), BAR_WIDTH);
  for (const p of [0, 0.9, 50, 100]) assert.equal(total(progressBar(p)), BAR_WIDTH);
});
