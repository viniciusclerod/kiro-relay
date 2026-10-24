// HTML for the status panel webview (src/ui/webview.ts). Pure module: no vscode.
// Strings come in already localized. Rows with an alternative value swap it in on mouse-over or
// keyboard focus through CSS only (the webview runs without scripts).

export interface PanelRow {
  label: string;
  /** Right-aligned value (plain text). */
  value: string;
  /** Shown instead of `value` while the row is hovered or focused. */
  altValue?: string;
  /** Muted value (description color). */
  mutedValue?: boolean;
  /** Optional link for the value. */
  href?: string;
  /** Codicon id shown before the value. */
  icon?: string;
}

export interface PanelSection {
  title: string;
  /** Right side of the title row (muted), e.g. "Resets Nov 1, 12:00 AM UTC". */
  aside?: string;
  asideIcon?: string;
  /**
   * Big number under the title, e.g. "0.9%" + "used". `alt` (e.g. "9.97 / 1,000" + "used") replaces
   * it on mouse-over, like the Copilot panel.
   */
  highlight?: { value: string; caption: string; alt?: { value: string; caption: string } };
  /** 0..100: thin bar under the highlight. */
  progress?: number;
  rows?: PanelRow[];
}

export interface PanelLink {
  label: string;
  href: string;
  icon?: string;
}

/** Bar colors: an image cannot read theme colors, so they are picked per theme kind. */
export interface BarColors {
  fill: string;
  track: string;
}

/** Close to VS Code's default progress bar colors. */
export function barColorsFor(kind: 'light' | 'dark' | 'highContrast' | 'highContrastLight'): BarColors {
  switch (kind) {
    case 'light':
      return { fill: '#0E70C0', track: '#0000001A' };
    case 'highContrast':
      return { fill: '#FFFFFF', track: '#FFFFFF40' };
    case 'highContrastLight':
      return { fill: '#0F4A85', track: '#00000040' };
    default:
      return { fill: '#0E70C0', track: '#FFFFFF1F' };
  }
}

export interface PanelData {
  barColors: BarColors;
  title: string;
  settings: { href: string; tooltip: string };
  sections: PanelSection[];
  links: PanelLink[];
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`\\[\]|*_$]/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

const MUTED = 'color:var(--vscode-descriptionForeground);';

function muted(html: string): string {
  return `<span style="${MUTED}">${html}</span>`;
}

function icon(id: string): string {
  return `<span class="codicon codicon-${id.replace(/[^a-z0-9-]/g, '')}"></span>`;
}

function link(href: string, html: string, title?: string): string {
  const t = title ? ` title="${escapeHtml(title)}"` : '';
  return `<a href="${escapeHtml(href)}"${t}>${html}</a>`;
}

const HEX = /^#[0-9A-Fa-f]{3,8}$/;

/**
 * Thin rounded bar like Copilot's: an SVG data image stretched to the panel width (4 px high).
 * Any usage shows a visible sliver, so 0.9% does not look like 0%.
 */
export function progressBar(percent: number, colors: BarColors): string {
  const p = Math.max(0, Math.min(100, percent));
  const filled = p === 0 ? 0 : Math.max(1.5, p);
  const fill = HEX.test(colors.fill) ? colors.fill : '#0E70C0';
  const track = HEX.test(colors.track) ? colors.track : '#80808040';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 4" preserveAspectRatio="none">` +
    `<rect width="100" height="4" rx="2" fill="${track}"/>` +
    (filled > 0 ? `<rect width="${filled.toFixed(2)}" height="4" rx="2" fill="${fill}"/>` : '') +
    `</svg>`;
  return `<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="100%" height="4" alt="${p.toFixed(1)}%">`;
}

const SWAP_ROW = ' class="swap" tabindex="0"';

function row(left: string, right: string, swappable = false): string {
  return `<tr${swappable ? SWAP_ROW : ''}><td>${left}</td><td align="right">${right}</td></tr>`;
}

function swap(main: string, alt: string): string {
  return `<span class="swap-main">${main}</span><span class="swap-alt">${alt}</span>`;
}

function fullRow(html: string, swappable = false): string {
  return `<tr${swappable ? SWAP_ROW : ''}><td colspan="2">${html}</td></tr>`;
}

/**
 * One table per section: block elements (<p>, headings outside tables) bring their own margins and
 * made the spacing uneven, so every line of a section is a row of the same table.
 */
function sectionHtml(s: PanelSection, colors: BarColors): string {
  const aside = s.aside ? muted(`${s.asideIcon ? `${icon(s.asideIcon)} ` : ''}${escapeHtml(s.aside)}`) : '';
  const rows = [row(`<strong>${escapeHtml(s.title)}</strong>`, aside)];
  if (s.highlight) {
    const big = (h: { value: string; caption: string }) =>
      `${escapeHtml(h.value)} <small>${muted(escapeHtml(h.caption))}</small>`;
    const alt = s.highlight.alt;
    const content = alt ? swap(big(s.highlight), big(alt)) : big(s.highlight);
    rows.push(fullRow(`<h3>${content}</h3>`, !!alt));
  }
  if (s.progress !== undefined) rows.push(fullRow(progressBar(s.progress, colors)));
  for (const r of s.rows ?? []) {
    let value = r.altValue === undefined ? escapeHtml(r.value) : swap(escapeHtml(r.value), escapeHtml(r.altValue));
    if (r.href) value = link(r.href, value);
    if (r.mutedValue) value = muted(value);
    if (r.icon) value = `${icon(r.icon)} ${value}`;
    rows.push(row(muted(escapeHtml(r.label)), value, r.altValue !== undefined));
  }
  return `<table width="100%">${rows.join('')}</table>`;
}

export function renderPanel(data: PanelData): string {
  const header = `<table width="100%">${row(
    `<strong>${escapeHtml(data.title)}</strong>`,
    link(data.settings.href, icon('settings-gear'), data.settings.tooltip),
  )}</table>`;
  const links = data.links
    .map((l) => link(l.href, `${l.icon ? `${icon(l.icon)} ` : ''}${escapeHtml(l.label)}`))
    .join(' &nbsp;&nbsp; ');
  const footer = `<table width="100%">${fullRow(links)}</table>`;
  return [header, ...data.sections.map((s) => sectionHtml(s, data.barColors)), footer].join('\n\n<hr>\n\n');
}
