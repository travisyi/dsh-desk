'use strict';

/**
 * DeepSeek Harness — desktop shell.
 *
 * Responsibilities:
 *   1. boot the local `dsh web` service (see supervisor.js) so the user never
 *      has to start one by hand,
 *   2. show that service's GUI in its own window, with a tray icon, a menu and
 *      an in-app service log,
 *   3. stop the service cleanly when the app is really closed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  app, BrowserWindow, Menu, Tray, dialog, shell, nativeImage, session, ipcMain, clipboard,
} = require('electron');

const config = require('./config');
const { DshService } = require('./supervisor');
const { desktop: desktopLog, service: serviceLog } = require('./logger');
const usageStats = require('./usage-stats');

const APP_NAME = 'DeepSeek Harness';
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');
/** Started by the Windows start-up entry: boot the service, stay in the tray. */
const START_HIDDEN = process.argv.includes('--hidden');
/** Same-origin navigation stays in the app; anything else goes to the browser. */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
/** The launch token is a credential: never print it in full. */
const TOKEN_QUERY_PATTERN = /([?&]token=)[^&\s]*/gu;

/** @type {object} */
let settings;
/** @type {DshService} */
let service;
/** @type {BrowserWindow|null} */
let mainWindow = null;
/** @type {BrowserWindow|null} */
let splashWindow = null;
/** @type {BrowserWindow|null} */
let logWindow = null;
/** @type {BrowserWindow|null} */
let usageWindow = null;
/** The last usage report the window rendered, reused for "copy as text". */
let lastUsageReport = null;
/** @type {Tray|null} */
let tray = null;
let quitting = false;
let booting = false;

/* ------------------------------------------------------------------ helpers */

/** Path to a generated asset, or `undefined` when it has not been built yet. */
function assetPath(name) {
  const file = path.join(config.ASSET_DIR, name);
  return fs.existsSync(file) ? file : undefined;
}

/** The window/tray icon, falling back to an empty image. */
function appIcon() {
  const ico = assetPath('icon.ico');
  const png = assetPath('icon.png');
  for (const file of [ico, png]) {
    if (file === undefined) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return nativeImage.createEmpty();
}

/** Tray icons are always PNG; Windows picks the closest size. */
function trayIcon() {
  const file = assetPath('tray.png') ?? assetPath('icon.png');
  if (file === undefined) return nativeImage.createEmpty();
  return nativeImage.createFromPath(file);
}

/** A short, human-readable service state for the tray and menus. */
function statusLabel() {
  const info = service?.describe();
  switch (info?.state) {
    case 'ready':
      return `运行中 · 127.0.0.1:${info.port}`;
    case 'starting':
      return '正在启动服务…';
    case 'stopping':
      return '正在停止服务…';
    case 'failed':
      return '服务启动失败';
    default:
      return '服务已停止';
  }
}

/* ------------------------------------------------------------ window set-up */

/** Build the splash window shown until the service reports its URL. */
function createSplash() {
  splashWindow = new BrowserWindow({
    width: 460,
    height: 260,
    frame: false,
    resizable: false,
    movable: true,
    show: false,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b1020',
    icon: appIcon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch(() => {});
  splashWindow.once('ready-to-show', () => splashWindow?.show());
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

/** Push one line of progress text into the splash window. */
function splashStatus(text) {
  splashEval(`window.__setStatus && window.__setStatus(${JSON.stringify(text)})`);
}

/** Show the most recent service line under the splash status. */
function splashDetail(text) {
  splashEval(`window.__setDetail && window.__setDetail(${JSON.stringify(text)})`);
}

/** Run a snippet in the splash window, ignoring a window that is already gone. */
function splashEval(script) {
  if (splashWindow === null || splashWindow.isDestroyed()) return;
  splashWindow.webContents.executeJavaScript(script).catch(() => {});
}

/** Tear the splash window down. */
function closeSplash() {
  if (splashWindow !== null && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

/** Restore the last window geometry, clamped to the visible work area. */
function initialBounds() {
  const saved = config.loadWindowState();
  const fallback = { width: 1440, height: 900 };
  if (saved === undefined || typeof saved.width !== 'number' || typeof saved.height !== 'number') {
    return fallback;
  }
  const bounds = {
    width: Math.max(900, Math.round(saved.width)),
    height: Math.max(600, Math.round(saved.height)),
  };
  if (typeof saved.x === 'number' && typeof saved.y === 'number') {
    const area = require('electron').screen.getDisplayMatching({
      x: Math.round(saved.x), y: Math.round(saved.y), width: bounds.width, height: bounds.height,
    }).workArea;
    const visible =
      saved.x + bounds.width > area.x + 40 &&
      saved.y + bounds.height > area.y + 40 &&
      saved.x < area.x + area.width - 40 &&
      saved.y < area.y + area.height - 40;
    if (visible) {
      bounds.x = Math.round(saved.x);
      bounds.y = Math.round(saved.y);
    }
  }
  return bounds;
}

/** Create (once) the window that hosts the Harness GUI. */
function createMainWindow() {
  if (mainWindow !== null && !mainWindow.isDestroyed()) return mainWindow;
  const bounds = initialBounds();
  mainWindow = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0b1020',
    icon: appIcon(),
    autoHideMenuBar: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (settings.openDevTools) mainWindow.webContents.openDevTools({ mode: 'detach' });

  const remember = () => {
    if (mainWindow === null || mainWindow.isDestroyed() || mainWindow.isMinimized()) return;
    const box = mainWindow.getNormalBounds();
    config.saveWindowState(box);
  };
  mainWindow.on('resize', remember);
  mainWindow.on('move', remember);

  mainWindow.on('close', (event) => {
    if (quitting || !settings.closeToTray) return;
    event.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { action: 'deny' };
    }
    if (service.url !== null && parsed.origin === new URL(service.url).origin) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
        },
      };
    }
    if (EXTERNAL_PROTOCOLS.has(parsed.protocol)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (service.url !== null && url.startsWith(new URL(service.url).origin)) return;
    event.preventDefault();
    try {
      if (EXTERNAL_PROTOCOLS.has(new URL(url).protocol)) shell.openExternal(url).catch(() => {});
    } catch {
      /* Ignore unparseable targets. */
    }
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    desktopLog.entry('window', `load failed (${code}) ${description} ${validatedUrl}`);
  });

  mainWindow.once('ready-to-show', () => {
    if (!IS_SMOKE_TEST && !START_HIDDEN) mainWindow?.show();
  });
  return mainWindow;
}

/** Load the authenticated Harness URL into the main window. */
async function showHarness(url) {
  const win = createMainWindow();
  if (win.webContents.getURL() === url && !win.webContents.isLoading()) return;
  await win.loadURL(url);
  if (settings.openDevTools) win.webContents.openDevTools({ mode: 'detach' });
}

/** Bring the GUI to the front. */
function revealMainWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    if (service.url !== null) showHarness(service.url).catch(() => {});
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/* --------------------------------------------------------------- log window */

/** Open (or focus) the in-app service log window. */
function openLogWindow() {
  if (logWindow !== null && !logWindow.isDestroyed()) {
    logWindow.focus();
    return;
  }
  logWindow = new BrowserWindow({
    width: 980,
    height: 620,
    title: `${APP_NAME} — 服务日志`,
    backgroundColor: '#0b1020',
    icon: appIcon(),
    parent: mainWindow ?? undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'logs-preload.js'),
    },
  });
  logWindow.setMenuBarVisibility(false);
  logWindow.loadFile(path.join(__dirname, 'logs.html')).catch(() => {});
  logWindow.on('closed', () => {
    logWindow = null;
  });
}

/* --------------------------------------------------------------- usage window */

/** Open (or focus) the token usage window. */
function openUsageWindow() {
  if (usageWindow !== null && !usageWindow.isDestroyed()) {
    usageWindow.focus();
    return;
  }
  usageWindow = new BrowserWindow({
    width: 940,
    height: 640,
    title: `${APP_NAME} — Token 用量`,
    backgroundColor: '#0b1020',
    icon: appIcon(),
    parent: mainWindow ?? undefined,
    // The self-check loads this page too; don't flash it on screen for that.
    show: !IS_SMOKE_TEST,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'usage-preload.js'),
    },
  });
  usageWindow.setMenuBarVisibility(false);
  usageWindow.loadFile(path.join(__dirname, 'usage.html')).catch(() => {});
  usageWindow.on('closed', () => {
    usageWindow = null;
  });
}

/* ------------------------------------------------------------------- service */

/** Start the service and show its GUI, reporting failures to the user. */
async function bootService({ quiet = false } = {}) {
  if (booting) return;
  booting = true;
  updateMenus();
  try {
    const info = await service.start();
    splashStatus(`已就绪：127.0.0.1:${info.port}`);
    await showHarness(info.url);
    closeSplash();
  } catch (error) {
    closeSplash();
    desktopLog.entry('dsh', `start failed: ${error.message}`);
    if (!IS_SMOKE_TEST && !quiet) reportBootFailure(error);
  } finally {
    booting = false;
    updateMenus();
  }
}

/** Explain a failed boot and offer the useful next steps. */
function reportBootFailure(error) {
  const detail = error instanceof Error ? error.message : String(error);
  const choice = dialog.showMessageBoxSync({
    type: 'error',
    title: `${APP_NAME} — 服务未能启动`,
    message: '本地 DeepSeek Harness 服务未能启动。',
    detail: `${detail}\n\ndsh: ${service.launch?.script ?? service.launch?.command ?? '未找到'}\nnode: ${service.launch?.node ?? '未找到'}`,
    buttons: ['重试', '查看日志', '打开设置', '退出'],
    defaultId: 0,
    cancelId: 3,
    noLink: true,
  });
  if (choice === 0) bootService().catch(() => {});
  else if (choice === 1) openLogWindow();
  else if (choice === 2) openSettingsFile();
  else app.quit();
}

/** Stop then start the service, keeping the window on the GUI. */
async function restartService() {
  closeSplashOnRestart();
  try {
    const info = await service.restart();
    await showHarness(info.url);
  } catch (error) {
    desktopLog.entry('dsh', `restart failed: ${error.message}`);
    if (!IS_SMOKE_TEST) reportBootFailure(error);
    return;
  } finally {
    updateMenus();
  }
}

/** Show the splash again while a restart is in flight. */
function closeSplashOnRestart() {
  createSplash();
  splashStatus('正在重启服务…');
  updateMenus();
}

/** Stop the service at the user's request. */
async function stopService() {
  try {
    await service.stop();
  } finally {
    updateMenus();
  }
}

/* ---------------------------------------------------------------- menus/tray */

/** Open `settings.json` in the OS default editor. */
function openSettingsFile() {
  desktopLog.entry('app', `settings: ${config.SETTINGS_PATH}`);
  shell.openPath(config.SETTINGS_PATH).then((message) => {
    if (message !== '') dialog.showErrorBox('无法打开设置文件', `${config.SETTINGS_PATH}\n\n${message}`);
  });
}

/** Open the workspace folder the service starts sessions in. */
function openWorkspace() {
  shell.openPath(settings.workspace).then((message) => {
    if (message !== '') dialog.showErrorBox('无法打开工作区', `${settings.workspace}\n\n${message}`);
  });
}

/** Copy the authenticated URL (token included) to the clipboard. */
function copyUrl() {
  if (service.url === null) return;
  clipboard.writeText(service.url);
}

/** Open the GUI in the system browser instead of the app window. */
function openInBrowser() {
  if (service.url === null) {
    dialog.showMessageBox({ type: 'info', message: '服务尚未运行。', buttons: ['好'] });
    return;
  }
  shell.openExternal(service.url).catch(() => {});
}

/** Show version and path information. */
function showAbout() {
  const info = service.describe();
  dialog.showMessageBox({
    type: 'info',
    title: `关于 ${APP_NAME}`,
    message: `${APP_NAME} 桌面版 ${app.getVersion()}`,
    detail: [
      `Electron ${process.versions.electron} · Chromium ${process.versions.chrome} · Node ${process.versions.node}`,
      '',
      `服务状态：${statusLabel()}`,
      `dsh：${info.dsh ?? '未解析'}`,
      `node：${info.node ?? '未解析'}`,
      `工作区：${settings.workspace}`,
      `设置：${config.SETTINGS_PATH}`,
      `日志：${config.LOG_DIR}`,
    ].join('\n'),
    buttons: ['好'],
    noLink: true,
  });
}

/** Toggle "start with Windows". */
function setOpenAtLogin(enabled) {
  settings.openAtLogin = enabled;
  try {
    config.save(settings);
  } catch (error) {
    desktopLog.entry('app', `could not save settings: ${error.message}`);
  }
  applyLoginItem();
  updateMenus();
}

/** Register or unregister the app as a Windows start-up item. */
function applyLoginItem() {
  try {
    const options = { openAtLogin: settings.openAtLogin === true };
    if (!app.isPackaged) {
      options.path = process.execPath;
      options.args = [app.getAppPath(), '--hidden'];
    }
    app.setLoginItemSettings(options);
  } catch (error) {
    desktopLog.entry('app', `setLoginItemSettings failed: ${error.message}`);
  }
}

/** Rebuild the application menu and the tray menu from the current state. */
function updateMenus() {
  const state = service?.describe() ?? { state: 'stopped' };
  const ready = state.state === 'ready';
  const busy = state.state === 'starting' || state.state === 'stopping' || booting;

  const trayMenu = Menu.buildFromTemplate([
    { label: `状态：${statusLabel()}`, enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: revealMainWindow },
    { label: '在浏览器中打开', enabled: ready, click: openInBrowser },
    { label: '复制访问地址', enabled: ready, click: copyUrl },
    { type: 'separator' },
    { label: '重启服务', enabled: !busy, click: () => restartService().catch(() => {}) },
    ready
      ? { label: '停止服务', click: () => stopService().catch(() => {}) }
      : { label: '启动服务', enabled: !busy, click: () => bootService().catch(() => {}) },
    { type: 'separator' },
    { label: '打开服务日志', click: openLogWindow },
    { label: 'Token 用量统计', click: openUsageWindow },
    { label: '打开工作区目录', click: openWorkspace },
    { label: '打开设置文件', click: openSettingsFile },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: settings.openAtLogin === true,
      click: (item) => setOpenAtLogin(item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);

  if (tray !== null && !tray.isDestroyed()) {
    tray.setToolTip(`${APP_NAME} — ${statusLabel()}`);
    tray.setContextMenu(trayMenu);
    tray.setImage(trayIcon());
  }

  const appMenu = Menu.buildFromTemplate([
    {
      label: '应用',
      submenu: [
        { label: '显示主窗口', accelerator: 'CmdOrCtrl+Shift+H', click: revealMainWindow },
        { label: '在浏览器中打开', enabled: ready, click: openInBrowser },
        { label: '复制访问地址', enabled: ready, click: copyUrl },
        { type: 'separator' },
        { label: '重启服务', accelerator: 'CmdOrCtrl+Shift+R', enabled: !busy, click: () => restartService().catch(() => {}) },
        ready
          ? { label: '停止服务', click: () => stopService().catch(() => {}) }
          : { label: '启动服务', enabled: !busy, click: () => bootService().catch(() => {}) },
        { type: 'separator' },
        { label: '打开服务日志', accelerator: 'CmdOrCtrl+Shift+L', click: openLogWindow },
        { label: 'Token 用量统计', accelerator: 'CmdOrCtrl+Shift+U', click: openUsageWindow },
        { label: '打开工作区目录', click: openWorkspace },
        { label: '打开设置文件', click: openSettingsFile },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于', click: showAbout },
        { label: '打开 README', click: () => shell.openPath(path.join(config.APP_DIR, 'README.md')).catch(() => {}) },
        {
          label: '打开日志目录',
          click: () => shell.openPath(config.LOG_DIR).catch(() => {}),
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);
}

/** Create the tray icon once. */
function createTray() {
  const image = trayIcon();
  if (image.isEmpty()) {
    desktopLog.entry('app', 'tray icon missing; run `npm run icon` to generate assets');
    return;
  }
  tray = new Tray(image);
  tray.on('click', revealMainWindow);
  tray.on('double-click', revealMainWindow);
}

/* ------------------------------------------------------------------ lifetime */

/** Hide rather than quit when the last window closes, if the user asked for it. */
function onWindowAllClosed() {
  if (!settings.closeToTray) app.quit();
}

/** Stop the service before the process really goes away. */
function wireQuit() {
  app.on('before-quit', (event) => {
    if (quitting) return;
    if (service === undefined || service.child === null) {
      quitting = true;
      return;
    }
    event.preventDefault();
    quitting = true;
    desktopLog.entry('app', 'stopping service before exit');
    service
      .stop()
      .catch(() => {})
      .finally(() => {
        app.quit();
      });
  });
}

/** Make sure a hard window close also stops the child. */
function wireProcessGuards() {
  const emergency = () => {
    if (service?.child != null) {
      try {
        require('./supervisor').killTree(service.child.pid);
      } catch {
        /* Ignore. */
      }
    }
  };
  process.on('exit', emergency);
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  process.on('uncaughtException', (error) => {
    desktopLog.entry('app', `uncaught: ${error.stack ?? error.message}`);
    if (!IS_SMOKE_TEST) {
      dialog.showErrorBox(`${APP_NAME} — 内部错误`, error.stack ?? String(error));
    }
  });
  process.on('unhandledRejection', (reason) => {
    desktopLog.entry('app', `unhandled rejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
  });
}

/** Allow the clipboard and a few harmless capabilities; deny the rest. */
function wirePermissions() {
  const allowed = new Set([
    'clipboard-read',
    'clipboard-sanitized-write',
    'fullscreen',
    'notifications',
  ]);
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
    callback(allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => allowed.has(permission));
}

/* --------------------------------------------------------------- smoke test */

/**
 * Headless-ish self check used by `npm run smoke`: boot, load the GUI, confirm
 * the React root actually rendered, then exit with a machine-readable report.
 * The report goes to a file as well as stdout, because a GUI-subsystem process
 * does not always have a usable console.
 */
async function runSmokeTest() {
  const reportPath = process.env.DSH_SMOKE_REPORT ?? path.join(config.LOG_DIR, 'smoke-report.json');
  /** @param {object} report */
  const publish = (report) => {
    const line = `SMOKE_REPORT ${JSON.stringify(report)}\n`;
    try {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, line, 'utf8');
    } catch {
      /* The stdout copy below is the fallback. */
    }
    process.stdout.write(line);
  };
  const watchdog = setTimeout(() => {
    publish({ ok: false, error: 'watchdog: the smoke test did not finish in time' });
    app.exit(3);
  }, 240_000);

  const report = { ok: false, steps: [] };
  try {
    const info = await service.start();
    report.steps.push(`node: ${service.launch?.node ?? 'unresolved'}`);
    report.steps.push(`dsh: ${service.launch?.script ?? service.launch?.command ?? 'unresolved'}`);
    report.url = info.url.replace(TOKEN_QUERY_PATTERN, '$1<redacted>');
    report.port = info.port;
    report.steps.push(`ready on port ${info.port}`);
    await showHarness(info.url);
    report.steps.push('window loaded');
    const deadline = Date.now() + 40_000;
    let rendered = 0;
    while (Date.now() < deadline) {
      rendered = await mainWindow.webContents
        .executeJavaScript('document.querySelector("#root") ? document.querySelector("#root").childElementCount : 0')
        .catch(() => 0);
      if (rendered > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    report.renderedRootChildren = rendered;
    report.steps.push(rendered > 0 ? 'react root rendered' : 'react root stayed empty');
    report.title = mainWindow.webContents.getTitle();
    report.localStorageKeys = await mainWindow.webContents
      .executeJavaScript('Object.keys(window.localStorage).length')
      .catch(() => null);

    // Token usage: the aggregation module and its window must both work.
    const usage = await usageStats.collectUsage();
    report.usage = {
      files: usage.scanned.files,
      activeSessions: usage.scanned.activeSessions,
      days: usage.days.length,
      total: usage.subtotals.all.usage,
    };
    report.steps.push(
      `usage: ${usage.scanned.activeSessions}/${usage.scanned.files} session logs have usage, ${usage.days.length} days`,
    );

    openUsageWindow();
    const usageDeadline = Date.now() + 30_000;
    let usageRows = 0;
    while (Date.now() < usageDeadline) {
      usageRows = await usageWindow?.webContents
        .executeJavaScript('document.querySelectorAll("#rows tr").length')
        .catch(() => 0);
      if (usageRows > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    report.usageRows = usageRows;
    report.steps.push(`usage window rendered ${usageRows} day rows`);

    report.ok = rendered > 0;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(watchdog);
    await service.stop().catch(() => {});
  }
  publish(report);
  app.exit(report.ok ? 0 : 1);
}

/* --------------------------------------------------------------------- main */

/** Resolve settings and fix up the workspace before anything else runs. */
function prepare() {
  settings = config.load();
  applyLoginItem();
  try {
    fs.mkdirSync(settings.workspace, { recursive: true });
  } catch {
    desktopLog.entry('app', `workspace ${settings.workspace} is unusable; falling back to ${os.homedir()}`);
    settings.workspace = os.homedir();
  }
  service = new DshService(settings);
  service.on('status', ({ state, detail }) => {
    desktopLog.entry('dsh', `state=${state}${detail ? ` (${detail})` : ''}`);
    if (!quitting) updateMenus();
  });
  service.on('line', (line) => {
    const text = String(line).trim();
    if (text !== '') splashDetail(text.length > 150 ? `${text.slice(0, 150)}…` : text);
  });
  service.on('exit', ({ code, expected }) => {
    if (expected) return;
    if (IS_SMOKE_TEST) return;
    if (quitting) return;
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: `${APP_NAME} — 服务已停止`,
      message: '本地服务意外退出。',
      detail: `退出码：${code ?? 'null'}`,
      buttons: ['重启服务', '查看日志', '退出'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice === 0) restartService().catch(() => {});
    else if (choice === 1) openLogWindow();
    else app.quit();
  });
  wireProcessGuards();
}

/** Electron entry point. */
function main() {
  app.setName(APP_NAME);
  app.setAppUserModelId('com.deepseekai.harness.desktop');
  // Portable profile: cookies, storage and cache live inside the app folder, so
  // "uninstall" really is "delete this folder".
  const userData = path.join(config.APP_DIR, 'user-data');
  try {
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
    app.setPath('sessionData', userData);
  } catch (error) {
    desktopLog.entry('app', `could not use a portable profile (${error.message}); using the default one`);
  }
  if (process.platform === 'win32') app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');

  const gotLock = IS_SMOKE_TEST ? true : app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', revealMainWindow);

  app.on('window-all-closed', onWindowAllClosed);

  app.whenReady().then(async () => {
    try {
      prepare();
    } catch (error) {
      dialog.showErrorBox(`${APP_NAME} — 设置无法读取`, error.message);
      app.exit(1);
      return;
    }
    wirePermissions();
    wireQuit();
    createTray();
    updateMenus();
    ipcMain.handle('logs:read', () => ({
      desktop: desktopLog.recent(),
      service: serviceLog.recent(),
      files: { desktop: desktopLog.file, service: serviceLog.file },
      status: { label: statusLabel(), ...service.describe() },
      settings: { workspace: settings.workspace, settingsPath: config.SETTINGS_PATH },
    }));
    ipcMain.handle('logs:openFolder', () => shell.openPath(config.LOG_DIR));
    ipcMain.handle('logs:openSettings', () => shell.openPath(config.SETTINGS_PATH));
    ipcMain.handle('usage:read', async () => {
      lastUsageReport = await usageStats.collectUsage();
      return lastUsageReport;
    });
    ipcMain.handle('usage:asText', () => {
      if (lastUsageReport === null) return false;
      clipboard.writeText(usageStats.formatReport(lastUsageReport));
      return true;
    });
    ipcMain.handle('usage:openFolder', () => shell.openPath(path.join(usageStats.dshHome(), 'sessions')));

    if (IS_SMOKE_TEST) {
      createMainWindow();
      await runSmokeTest();
      return;
    }
    createSplash();
    splashStatus('正在启动本地服务…');
    if (settings.autoStartServer) {
      bootService().catch(() => {});
    } else {
      closeSplash();
      createMainWindow();
      updateMenus();
    }
  });
}

main();
