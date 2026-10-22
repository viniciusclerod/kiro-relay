// Builds media/kirorelay-icons.woff (status bar / model icons) from the monochrome glyphs in media/,
// and media/icon.png (Marketplace icon, 128x128) from media/icon.svg. Both are committed; run
// `npm run build:icons` after changing an icon. All artwork is original (MIT).
//
// Monochrome glyphs: VS Code paints them with the theme's foreground color, so they work in light,
// dark and high-contrast themes.

import { createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SVGIcons2SVGFontStream } from 'svgicons2svgfont';

const require = createRequire(import.meta.url);
const svg2ttf = require('svg2ttf');
const ttf2woff = require('ttf2woff');
const { Resvg } = require('@resvg/resvg-js');

/** Keep in sync with contributes.icons in package.json. */
export const ICONS = [{ name: 'logo', file: 'media/kiro-relay.svg', codepoint: 0xe001 }];
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

// Marketplace icon.
const png = new Resvg(readFileSync('media/icon.svg', 'utf8'), { fitTo: { mode: 'width', value: 128 } }).render().asPng();
writeFileSync('media/icon.png', png);
console.log(`media/icon.png: 128x128, ${png.length} bytes`);

// Optional previews (e.g. PREVIEW_DIR=/tmp/x npm run build:icons): the glyph at a few sizes, dark and light.
if (process.env.PREVIEW_DIR) {
  const glyph = readFileSync(ICONS[0].file, 'utf8');
  for (const [name, color, bg] of [['dark', '#CCCCCC', '#181818'], ['light', '#333333', '#F8F8F8']]) {
    const svg = glyph.replace('fill="currentColor"', `fill="${color}"`).replace('<svg ', `<svg style="background:${bg}" `);
    for (const size of [16, 64]) {
      const img = new Resvg(svg, { fitTo: { mode: 'width', value: size }, background: bg }).render().asPng();
      writeFileSync(`${process.env.PREVIEW_DIR}/glyph-${name}-${size}.png`, img);
    }
  }
  console.log(`previews written to ${process.env.PREVIEW_DIR}`);
}
