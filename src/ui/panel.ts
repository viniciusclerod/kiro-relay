// HTML for the status bar hover, laid out like the Copilot status panel. Pure module: no vscode.
//
// Markdown hovers (VS Code 1.142) keep only a subset of HTML (see test/panel.test.ts, which checks
// the output against the same rules): tables with width/align/colspan, <hr>, headings, <small>,
// <a href>, <span class="codicon codicon-…">, and <span style> limited to color, background-color,
// display:inline-block and border-radius, in that order. Strings come in already localized.

export interface PanelRow {
  label: string;
  /** Right-aligned value (plain text). */
  value: string;
  /** Muted value (description color). */
  mutedValue?: boolean;
  /** Optional link for the value. */
  href?: string;
  /** Codicon id shown before the value. */
  icon?: string;
}

export interface PanelSection {
  title: string;
  /** Right side of the title row (muted), e.g. "Resets Nov 1". */
  aside?: string;
  asideIcon?: string;
  /**
   * Big number under the title, e.g. "0.9%" + "used", with `detail` right-aligned on the same line
   * (e.g. "9.97 / 1,000"). Copilot swaps them on mouse-over; extension hovers cannot run scripts or
   * :hover styles, so both are shown.
   */
  highlight?: { value: string; caption: string; detail?: string };
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

function row(left: string, right: string): string {
  return `<tr><td>${left}</td><td align="right">${right}</td></tr>`;
}

function fullRow(html: string): string {
  return `<tr><td colspan="2">${html}</td></tr>`;
}

/**
 * One table per section: block elements (<p>, headings outside tables) bring their own margins and
 * made the spacing uneven, so every line of a section is a row of the same table.
 */
function sectionHtml(s: PanelSection, colors: BarColors): string {
  const aside = s.aside ? muted(`${s.asideIcon ? `${icon(s.asideIcon)} ` : ''}${escapeHtml(s.aside)}`) : '';
  const rows = [row(`<strong>${escapeHtml(s.title)}</strong>`, aside)];
  if (s.highlight) {
    const big = `<h3>${escapeHtml(s.highlight.value)} <small>${muted(escapeHtml(s.highlight.caption))}</small></h3>`;
    rows.push(row(big, s.highlight.detail ? muted(escapeHtml(s.highlight.detail)) : ''));
  }
  if (s.progress !== undefined) rows.push(fullRow(progressBar(s.progress, colors)));
  for (const r of s.rows ?? []) {
    let value = escapeHtml(r.value);
    if (r.href) value = link(r.href, value);
    if (r.mutedValue) value = muted(value);
    if (r.icon) value = `${icon(r.icon)} ${value}`;
    rows.push(row(muted(escapeHtml(r.label)), value));
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
