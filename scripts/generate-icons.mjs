/**
 * Generates the PNG icons and favicon.ico in public/icons/ from
 * public/icons/logo.svg. Run with `npm run icons` after changing the logo;
 * the generated files are committed.
 *
 * Rasterises with the Chromium that Playwright already installs
 * (`npx playwright install chromium`), so no image library is needed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const ICONS_DIR = join(import.meta.dirname, '..', 'public', 'icons');
const logo = readFileSync(join(ICONS_DIR, 'logo.svg'), 'utf8');

/** The logo as drawn: rounded square, transparent corners. */
const rounded = logo;

/**
 * Full-bleed variant for maskable and Apple icons, where the platform applies
 * its own mask: square background, with the mark scaled into the central
 * "safe zone" so no mask shape can clip it.
 */
function fullBleed(markScale) {
  const offset = (512 * (1 - markScale)) / 2;
  return logo
    .replace(/<rect width="512" height="512" rx="112"/, '<rect width="512" height="512"')
    .replace(
      '<g id="mark">',
      `<g id="mark" transform="translate(${offset} ${offset}) scale(${markScale})">`,
    );
}

/** file name → [svg, size in px] */
const PNGS = {
  'icon-192.png': [rounded, 192],
  'icon-512.png': [rounded, 512],
  'icon-maskable-192.png': [fullBleed(0.72), 192],
  'icon-maskable-512.png': [fullBleed(0.72), 512],
  'apple-touch-icon.png': [fullBleed(0.86), 180],
};
const ICO_SIZES = [16, 32, 48];

const browser = await chromium.launch();
const page = await browser.newPage();

async function render(svg, size) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  return page.screenshot({ omitBackground: true });
}

/** An .ico is a small directory followed by the images; modern readers accept PNG entries. */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  let offset = header.length + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size, 0); // width
    entry.writeUInt8(size, 1); // height
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map(({ png }) => png)]);
}

if (!fullBleed(0.5).includes('transform=') || fullBleed(0.5).includes('rx="112"')) {
  throw new Error(
    `logo.svg no longer has the structure this script edits (the 512px background <rect rx="112"> and <g id="mark">)`,
  );
}

for (const [name, [svg, size]] of Object.entries(PNGS)) {
  writeFileSync(join(ICONS_DIR, name), await render(svg, size));
  console.log(`${name} (${size}x${size})`);
}

const icoImages = [];
for (const size of ICO_SIZES) icoImages.push({ size, png: await render(rounded, size) });
writeFileSync(join(ICONS_DIR, 'favicon.ico'), ico(icoImages));
console.log(`favicon.ico (${ICO_SIZES.join(', ')})`);

await browser.close();
