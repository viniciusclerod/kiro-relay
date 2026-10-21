import test from 'node:test';
import assert from 'node:assert/strict';
import { barColorsFor, escapeHtml, progressBar, renderPanel, type PanelData } from '../src/ui/panel.ts';

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
  barColors: barColorsFor('dark'),
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
      highlight: { value: '0.9%', caption: 'used', detail: '9.97 / 1,000' },
      progress: 0.9,
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

test('highlight: big percentage left, credits right on the same line', () => {
  const html = renderPanel({
    ...DATA,
    sections: [{ title: 'Credits', highlight: { value: '0.9%', caption: 'used', detail: '9.97 / 1,000' } }],
  });
  assert.match(html, /<tr><td><h3>0\.9% <small>.*used.*<\/small><\/h3><\/td><td align="right"><span style="[^"]+">9\.97 \/ 1,000<\/span><\/td><\/tr>/);
  assert.deepEqual(droppedBySanitizer(html), []);
});
