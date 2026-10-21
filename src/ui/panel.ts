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
  /** Big number under the title, e.g. "0.9%" + "used". */
  highlight?: { value: string; caption: string };
  /** 0..100: thin bar under the highlight. */
  progress?: number;
  rows?: PanelRow[];
}

export interface PanelLink {
  label: string;
  href: string;
  icon?: string;
}

export interface PanelData {
  title: string;
  settings: { href: string; tooltip: string };
  sections: PanelSection[];
  links: PanelLink[];
}

/** Characters of the progress bar: must fit on one line of the hover (46 wrapped). */
export const BAR_WIDTH = 30;

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

/** Thin bar: "━" glyphs colored like the theme's progress bar, the rest in a faint track color. */
export function progressBar(percent: number, width = BAR_WIDTH): string {
  const p = Math.max(0, Math.min(100, percent));
  // Any usage shows a visible sliver (2 glyphs), so 0.9% does not look like 0%.
  const filled = p === 0 ? 0 : Math.min(width, Math.max(2, Math.round((p / 100) * width)));
  const seg = (color: string, n: number) =>
    n > 0 ? `<span style="color:var(${color});">${'━'.repeat(n)}</span>` : '';
  return seg('--vscode-progressBar-background', filled) + seg('--vscode-scrollbarSlider-activeBackground', width - filled);
}

function row(left: string, right: string): string {
  return `<tr><td>${left}</td><td align="right">${right}</td></tr>`;
}

function sectionHtml(s: PanelSection): string {
  const aside = s.aside ? muted(`${s.asideIcon ? `${icon(s.asideIcon)} ` : ''}${escapeHtml(s.aside)}`) : '';
  const parts = [`<table width="100%">${row(`<strong>${escapeHtml(s.title)}</strong>`, aside)}</table>`];
  if (s.highlight) {
    parts.push(`<h3>${escapeHtml(s.highlight.value)} <small>${muted(escapeHtml(s.highlight.caption))}</small></h3>`);
  }
  if (s.progress !== undefined) parts.push(`<p>${progressBar(s.progress)}</p>`);
  if (s.rows?.length) {
    const rows = s.rows.map((r) => {
      let value = escapeHtml(r.value);
      if (r.href) value = link(r.href, value);
      if (r.mutedValue) value = muted(value);
      if (r.icon) value = `${icon(r.icon)} ${value}`;
      return row(muted(escapeHtml(r.label)), value);
    });
    parts.push(`<table width="100%">${rows.join('')}</table>`);
  }
  return parts.join('\n\n');
}

export function renderPanel(data: PanelData): string {
  const header = `<table width="100%">${row(
    `<strong>${escapeHtml(data.title)}</strong>`,
    link(data.settings.href, icon('settings-gear'), data.settings.tooltip),
  )}</table>`;
  const links = data.links
    .map((l) => link(l.href, `${l.icon ? `${icon(l.icon)} ` : ''}${escapeHtml(l.label)}`))
    .join(' &nbsp;&nbsp; ');
  return [header, ...data.sections.map(sectionHtml), `<p>${links}</p>`].join('\n\n<hr>\n\n');
}
