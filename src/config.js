'use strict';

/**
 * Settings for the DeepSeek Harness desktop shell.
 *
 * The file lives next to the app (`settings.json`) so the whole folder stays
 * portable: copy it anywhere, the settings travel with it. `DSH_DESKTOP_SETTINGS`
 * points somewhere else when you want machine-local settings instead.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** This app's root folder (the folder holding package.json). */
const APP_DIR = path.resolve(__dirname, '..');
/** Where logs, generated icons and the run state live. */
const LOG_DIR = path.join(APP_DIR, 'logs');
const ASSET_DIR = path.join(APP_DIR, 'assets');
/** Default settings location, overridable for machine-local settings. */
const SETTINGS_PATH = process.env.DSH_DESKTOP_SETTINGS
  ? path.resolve(process.env.DSH_DESKTOP_SETTINGS)
  : path.join(APP_DIR, 'settings.json');

/** Built-in defaults. Every key is documented in README.md. */
function defaults() {
  return {
    /* --- what to run ------------------------------------------------------ */
    /** A `dsh` entry point (`.../@deepseek-ai/dsh/lib/bin.js`) or a `dsh` command.
     *  Empty means "auto-detect". */
    dshBin: '',
    /** node.exe used to run dsh. Empty means "auto-detect". */
    nodePath: '',
    /** Working directory of the service: the workspace a new session starts in. */
    workspace: path.dirname(APP_DIR),
    /** Extra arguments appended to `dsh web --no-open …`. */
    extraArgs: [],
    /** Extra environment variables for the service process. */
    env: {},

    /* --- how it listens -------------------------------------------------- */
    /** Preferred listen port. */
    port: 3080,
    /** When the preferred port is taken, let the OS pick a free one. */
    autoPort: true,
    /** Bind host; only loopback is supported by dsh itself. */
    host: '127.0.0.1',
    /** Extra accepted authorities (host or host:port) for the API trust fence. */
    trustedHosts: [],
    /** Seconds to wait for the service's ready line before reporting failure. */
    startupTimeoutSeconds: 120,

    /* --- window behaviour ------------------------------------------------ */
    /** Closing the window hides it to the tray instead of stopping the service. */
    closeToTray: true,
    /** Boot the service when the app starts. */
    autoStartServer: true,
    /** Start the app with Windows. */
    openAtLogin: false,
    /** Open Chromium devtools alongside the window (troubleshooting). */
    openDevTools: false,
  };
}

/** Read `settings.json`, filling in anything the file does not name. */
function load() {
  const base = defaults();
  let raw;
  try {
    raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      // First run: write the defaults out so the file is discoverable.
      try {
        save(base);
      } catch {
        /* A read-only install still works with in-memory defaults. */
      }
      return base;
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`settings.json is not valid JSON (${SETTINGS_PATH}): ${error.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`settings.json must contain a JSON object (${SETTINGS_PATH})`);
  }
  const merged = { ...base };
  for (const [key, value] of Object.entries(parsed)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return normalize(merged);
}

/** Coerce loosely-typed settings into the shapes the rest of the app expects. */
function normalize(settings) {
  const out = { ...settings };
  out.dshBin = typeof out.dshBin === 'string' ? out.dshBin.trim() : '';
  out.nodePath = typeof out.nodePath === 'string' ? out.nodePath.trim() : '';
  out.workspace = typeof out.workspace === 'string' && out.workspace.trim() !== ''
    ? path.resolve(out.workspace.trim())
    : path.dirname(APP_DIR);
  out.host = typeof out.host === 'string' && out.host.trim() !== '' ? out.host.trim() : '127.0.0.1';
  const port = Number(out.port);
  out.port = Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 3080;
  out.autoPort = out.autoPort !== false;
  out.trustedHosts = Array.isArray(out.trustedHosts) ? out.trustedHosts.map(String) : [];
  out.extraArgs = Array.isArray(out.extraArgs) ? out.extraArgs.map(String) : [];
  out.env = out.env && typeof out.env === 'object' && !Array.isArray(out.env)
    ? Object.fromEntries(Object.entries(out.env).map(([k, v]) => [k, String(v)]))
    : {};
  out.closeToTray = out.closeToTray !== false;
  out.autoStartServer = out.autoStartServer !== false;
  out.openAtLogin = out.openAtLogin === true;
  out.openDevTools = out.openDevTools === true;
  const timeout = Number(out.startupTimeoutSeconds);
  out.startupTimeoutSeconds = Number.isFinite(timeout) && timeout > 0 ? timeout : 120;
  return out;
}

/** Write settings back to disk atomically. */
function save(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

/** Where the window remembers its size and position. */
const STATE_PATH = path.join(APP_DIR, 'window-state.json');

/** Read the saved window geometry, or `undefined` when there is none. */
function loadWindowState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* No usable state yet. */
  }
  return undefined;
}

/** Remember the window geometry for the next launch. */
function saveWindowState(state) {
  try {
    fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {
    /* Geometry is a convenience; never fail on it. */
  }
}

module.exports = {
  APP_DIR,
  LOG_DIR,
  ASSET_DIR,
  SETTINGS_PATH,
  STATE_PATH,
  defaults,
  load,
  save,
  normalize,
  loadWindowState,
  saveWindowState,
  homeDir: os.homedir(),
};
