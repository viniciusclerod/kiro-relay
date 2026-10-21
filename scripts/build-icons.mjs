// Builds media/kirorelay-icons.woff from the SVGs in media/ (one glyph per icon).
// The font is committed; run `npm run build:icons` after changing an icon.
//
// Monochrome glyphs: VS Code paints them with the theme's foreground color, so they work in light,
// dark and high-contrast themes.

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';

const require = createRequire(import.meta.url);
const svg2ttf = require('svg2ttf');
const ttf2woff = require('ttf2woff');

/** Keep in sync with contributes.icons in package.json. */
export const ICONS = [{ name: 'kiro', file: 'media/kiro.svg', codepoint: 0xe001 }];
const OUT = 'media/kirorelay-icons.woff';

const svgFont = await new Promise((resolve, reject) => {
  const chunks = [];
  const stream = new SVGIcons2SVGFontStream({
    fontName: 'kirorelay-icons',
    fontHeight: 1000,
    normalize: true,
    centerHorizontally: true,
    log: () => {},
  });
  stream.on('data', (c) => chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8')));
  stream.on('end', () => resolve(chunks.join('')));
  stream.on('error', reject);
  for (const icon of ICONS) {
    const glyph = createReadStream(icon.file);
    glyph.metadata = { name: icon.name, unicode: [String.fromCodePoint(icon.codepoint)] };
    stream.write(glyph);
  }
  stream.end();
});

// Fixed timestamp so the generated font is byte-for-byte reproducible.
const ttf = svg2ttf(svgFont, { ts: 0, version: '1.0' });
const woff = ttf2woff(new Uint8Array(ttf.buffer));
writeFileSync(OUT, Buffer.from(woff.buffer));
console.log(`${OUT}: ${ICONS.length} glyph(s), ${woff.buffer.byteLength} bytes`);
// Sanity check: the input SVGs must be monochrome (currentColor or no fill).
for (const icon of ICONS) {
  if (/fill="(?!currentColor|none)[^"]+"/.test(readFileSync(icon.file, 'utf8'))) {
    console.warn(`warning: ${icon.file} has an explicit fill color; fonts ignore it`);
  }
}
