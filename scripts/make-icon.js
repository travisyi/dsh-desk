'use strict';

/**
 * Generate the app's icons from the shipped DeepSeek Harness mark.
 *
 * Run with Electron (`npm run icon`) because rasterising needs a renderer:
 *   node scripts/make-icon.js      -> not supported
 *   electron scripts/make-icon.js  -> writes assets/icon.png, assets/icon.ico, assets/tray.png
 *
 * The mark is read from `@deepseek-ai/dsh-web-frontend/dist/favicon.svg` in
 * whichever install holds it, and cached as `assets/logo.svg`. When no install
 * provides it, a plain monogram tile is drawn instead, so the step always
 * produces usable icons.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, nativeImage } = require('electron');

const config = require('../src/config');

/** Sizes embedded in the .ico container, largest last. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** Sizes written as standalone PNGs. */
const PNG_SIZES = { 'icon.png': 256, 'tray.png': 32 };

/** Every `node_modules` root that may hold the web frontend package. */
function frontendRoots() {
  const roots = [path.join(config.APP_DIR, 'node_modules')];
  const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  try {
    for (const entry of fs.readdirSync(path.join(dshHome, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(dshHome, 'profiles', entry.name, 'node_modules'));
    }
  } catch {
    /* No profile yet. */
  }
  const cache = process.env.npm_config_cache ?? path.join(os.homedir(), 'AppData', 'Local', 'npm-cache');
  try {
    for (const entry of fs.readdirSync(path.join(cache, '_npx'), { withFileTypes: true })) {
      if (entry.isDirectory()) roots.push(path.join(cache, '_npx', entry.name, 'node_modules'));
    }
  } catch {
    /* No npx cache. */
  }
  roots.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules'));
  return roots;
}

/** Copy the shipped mark into `assets/logo.svg`, recoloured for a dark tile. */
function ensureLogo() {
  const cached = path.join(config.ASSET_DIR, 'logo.svg');
  if (fs.existsSync(cached)) return cached;
  const relative = path.join('@deepseek-ai', 'dsh-web-frontend', 'dist', 'favicon.svg');
  for (const root of frontendRoots()) {
    const candidate = path.join(root, relative);
    if (!fs.existsSync(candidate)) continue;
    let svg = fs.readFileSync(candidate, 'utf8');
    // The shipped mark flips to white only under prefers-color-scheme: dark;
    // the tile is always dark, so pin the fill instead.
    svg = svg.replace(/<style>[\s\S]*?<\/style>/u, '<style>path { fill: #ffffff; }</style>');
    if (!svg.includes('#ffffff')) svg = svg.replace('<path', '<path fill="#ffffff"');
    fs.writeFileSync(cached, svg, 'utf8');
    process.stdout.write(`logo: ${candidate}\n`);
    return cached;
  }
  process.stdout.write('logo: not found; falling back to a monogram tile\n');
  return undefined;
}

/** The HTML page that is rasterised into the icon. */
function iconHtml(logoFile) {
  const mark = logoFile === undefined
    ? '<div class="monogram">DS</div>'
    : `<img class="logo" src="${path.basename(logoFile)}" alt="" />`;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 256px; height: 256px; background: transparent; }
  .tile {
    width: 256px; height: 256px; border-radius: 58px; box-sizing: border-box;
    background: linear-gradient(150deg, #5b78ff 0%, #4d6bfe 42%, #2a3fd6 100%);
    box-shadow: inset 0 2px 0 rgba(255,255,255,.28), inset 0 -18px 30px rgba(0,0,0,.18);
    display: flex; align-items: center; justify-content: center;
  }
  .logo { width: 152px; height: 152px; filter: drop-shadow(0 4px 10px rgba(6,12,40,.35)); }
  .monogram {
    color: #fff; font: 700 118px/1 "Segoe UI", system-ui, sans-serif; letter-spacing: -4px;
    text-shadow: 0 4px 10px rgba(6,12,40,.35);
  }
</style></head>
<body><div class="tile">${mark}</div></body></html>
`;
}

/** Pack PNG buffers into a multi-size .ico container. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  const payloads = [];
  let offset = 6 + images.length * 16;
  for (const { size, buffer } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2); // palette size
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(buffer.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += buffer.length;
    entries.push(entry);
    payloads.push(buffer);
  }
  return Buffer.concat([header, ...entries, ...payloads]);
}

/** Render, resize and write every icon artifact. */
async function generate() {
  fs.mkdirSync(config.ASSET_DIR, { recursive: true });
  const logoFile = ensureLogo();
  const page = path.join(config.ASSET_DIR, '.icon-source.html');
  fs.writeFileSync(page, iconHtml(logoFile), 'utf8');

  const window = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: false, contextIsolation: true, nodeIntegration: false },
  });
  try {
    await window.loadFile(page);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const source = await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
    if (source.isEmpty()) throw new Error('capture produced an empty image');
    const sizes = ICO_SIZES.map((size) => ({
      size,
      buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG(),
    }));
    fs.writeFileSync(path.join(config.ASSET_DIR, 'icon.ico'), buildIco(sizes));
    for (const [name, size] of Object.entries(PNG_SIZES)) {
      const match = sizes.find((entry) => entry.size === size) ?? { buffer: source.toPNG() };
      fs.writeFileSync(path.join(config.ASSET_DIR, name), match.buffer);
    }
    process.stdout.write(`icons: icon.ico (${ICO_SIZES.join(', ')}) + ${Object.keys(PNG_SIZES).join(', ')}\n`);
  } finally {
    window.destroy();
    fs.rmSync(page, { force: true });
  }
  // Sanity check: the .ico must load back as a real image.
  const check = nativeImage.createFromPath(path.join(config.ASSET_DIR, 'icon.ico'));
  if (check.isEmpty()) throw new Error('the generated icon.ico could not be read back');
  process.stdout.write(`icon check: ${JSON.stringify(check.getSize())}\n`);
}

app.disableHardwareAcceleration();
// Keep Chromium's profile out of %APPDATA%: the icon step must not leave traces.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-icon-'));
app.setPath('userData', scratch);
app.setPath('sessionData', scratch);

/** Best-effort removal of the throwaway Chromium profile. */
function cleanScratch() {
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* Chromium may still hold a lock; the OS cleans %TEMP% eventually. */
  }
}

app.whenReady()
  .then(generate)
  .then(() => {
    cleanScratch();
    app.exit(0);
  })
  .catch((error) => {
    process.stderr.write(`make-icon failed: ${error.stack ?? error.message}\n`);
    cleanScratch();
    app.exit(1);
  });
