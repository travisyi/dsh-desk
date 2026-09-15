'use strict';

/**
 * Find two things without the user having to configure anything:
 *   - a real `node.exe` (the service must run on Node, not on Electron's
 *     bundled runtime, which has a different native-module ABI), and
 *   - the `dsh` CLI entry point (`@deepseek-ai/dsh/lib/bin.js`).
 *
 * The search order is deliberately broad, because `dsh` commonly arrives in one
 * of four ways: installed into this app, installed globally by npm, kept alive
 * by an `npx` cache, or simply on `PATH`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { APP_DIR } = require('./config');

/** The entry inside a `@deepseek-ai/dsh` package. */
const DSH_ENTRY = path.join('@deepseek-ai', 'dsh', 'lib', 'bin.js');
const DSH_PACKAGE = path.join('@deepseek-ai', 'dsh', 'package.json');

/** True when `candidate` is an existing regular file. */
function isFile(candidate) {
  if (typeof candidate !== 'string' || candidate === '') return false;
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Run a tiny external lookup (`where.exe`) and return its non-empty lines. */
function whereAll(name) {
  try {
    const result = spawnSync('where.exe', [name], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    if (result.status !== 0 || typeof result.stdout !== 'string') return [];
    return result.stdout.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Expand `${VAR}` / `%VAR%` in one npmrc value. */
function expandEnv(value) {
  return value
    .replace(/\$\{([^}]+)\}/gu, (_, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? '')
    .replace(/%([^%]+)%/gu, (_, name) => process.env[name] ?? '');
}

/** Read the `key=value` lines we care about from the npmrc files that exist. */
function readNpmrc() {
  const found = { cache: undefined, prefix: undefined };
  const home = os.homedir();
  const files = [
    process.env.npm_config_userconfig,
    path.join(home, '.npmrc'),
    process.env.NPM_CONFIG_GLOBALCONFIG,
    path.join(path.dirname(process.execPath), 'etc', 'npmrc'),
  ].filter((file) => typeof file === 'string' && file !== '');
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim().toLowerCase();
      const value = expandEnv(line.slice(eq + 1).trim());
      if (value === '' || value.includes('${')) continue;
      if (key === 'cache' && found.cache === undefined) found.cache = value;
      if (key === 'prefix' && found.prefix === undefined) found.prefix = value;
    }
  }
  return found;
}

/** Every `node_modules` root that could hold `@deepseek-ai/dsh`. */
function* candidateModuleRoots() {
  yield path.join(APP_DIR, 'node_modules');
  const { cache, prefix } = readNpmrc();
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  const globalPrefixes = [prefix, path.join(appData, 'npm')].filter(Boolean);
  for (const dir of globalPrefixes) yield path.join(dir, 'node_modules');
  for (const exe of whereAll('dsh')) {
    // `<prefix>\dsh.cmd` lives directly in the prefix; the package is a sibling.
    yield path.join(path.dirname(exe), 'node_modules');
  }
  const npxCaches = [
    cache ? path.join(cache, '_npx') : undefined,
    process.env.npm_config_cache ? path.join(process.env.npm_config_cache, '_npx') : undefined,
    path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx'),
  ].filter(Boolean);
  for (const root of npxCaches) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) yield path.join(root, entry.name, 'node_modules');
    }
  }
}

/** Pick the newest installed `@deepseek-ai/dsh` among the candidate roots. */
function findInstalledDsh() {
  /** @type {{ entry: string, version: string, mtime: number }[]} */
  const hits = [];
  for (const root of candidateModuleRoots()) {
    const entry = path.join(root, DSH_ENTRY);
    if (!isFile(entry)) continue;
    let version = 'unknown';
    let mtime = 0;
    try {
      version = JSON.parse(fs.readFileSync(path.join(root, DSH_PACKAGE), 'utf8')).version ?? 'unknown';
    } catch {
      /* Keep the unknown version. */
    }
    try {
      mtime = fs.statSync(entry).mtimeMs;
    } catch {
      /* Keep zero. */
    }
    hits.push({ entry, version, mtime });
  }
  if (hits.length === 0) return undefined;
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0];
}

/** Find a real Node executable; Electron's own runtime is the last resort. */
function findNode(preferred) {
  if (preferred !== undefined && preferred !== '' && isFile(preferred)) {
    return { path: preferred, source: 'settings.nodePath' };
  }
  if (isFile(process.env.DSH_DESKTOP_NODE)) {
    return { path: process.env.DSH_DESKTOP_NODE, source: 'env DSH_DESKTOP_NODE' };
  }
  for (const found of whereAll('node')) {
    if (isFile(found)) return { path: found, source: 'PATH' };
  }
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  const guesses = [
    path.join(programFiles, 'nodejs', 'node.exe'),
    path.join(programFilesX86, 'nodejs', 'node.exe'),
    path.join(localAppData, 'Programs', 'nodejs', 'node.exe'),
    path.join(path.dirname(process.execPath), 'node.exe'),
  ];
  for (const guess of guesses) {
    if (isFile(guess)) return { path: guess, source: 'well-known location' };
  }
  return { path: process.execPath, source: "Electron's bundled Node (ELECTRON_RUN_AS_NODE)" };
}

/**
 * Resolve how to launch the service.
 * @param {object} settings normalized settings.
 * @returns {{ node: string, script: string|null, command: string|null,
 *             nodeSource: string, dshSource: string, version: string|undefined }}
 */
function resolveDsh(settings) {
  const node = findNode(settings.nodePath);
  const explicit = settings.dshBin;
  if (explicit !== '') {
    if (isFile(explicit)) {
      return {
        node: node.path,
        script: explicit,
        command: null,
        nodeSource: node.source,
        dshSource: 'settings.dshBin',
        version: readVersion(path.join(path.dirname(explicit), '..', 'package.json')),
      };
    }
    return {
      node: node.path,
      script: null,
      command: explicit,
      nodeSource: node.source,
      dshSource: 'settings.dshBin (command)',
      version: undefined,
    };
  }
  const installed = findInstalledDsh();
  if (installed !== undefined) {
    return {
      node: node.path,
      script: installed.entry,
      command: null,
      nodeSource: node.source,
      dshSource: installed.entry,
      version: installed.version,
    };
  }
  return {
    node: node.path,
    script: null,
    command: 'dsh',
    nodeSource: node.source,
    dshSource: 'PATH (dsh)',
    version: undefined,
  };
}

/** Best-effort version read for a resolved entry. */
function readVersion(packageJsonPath) {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
  } catch {
    return undefined;
  }
}

module.exports = { resolveDsh, findNode, findInstalledDsh, readNpmrc, DSH_ENTRY };
