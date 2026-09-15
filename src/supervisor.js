'use strict';

/**
 * Supervises the `dsh web` child process: starts it on a free port, reads the
 * authenticated URL the service prints once it is listening, streams its output
 * into the log, and tears the whole process tree down on shutdown.
 *
 * The URL matters: dsh binds each process to a one-shot launch token, so the
 * only reliable way in is the `dsh web: <url>` line rather than a URL we build.
 */

const net = require('node:net');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync } = require('node:child_process');
const { resolveDsh } = require('./dsh-locate');
const { service: serviceLog, desktop: desktopLog } = require('./logger');

/** Match the `dsh web: <url>` ready line, with or without colour codes. */
const READY_PATTERN = /dsh web:\s*(https?:\/\/\S+)/u;
/** The launch token is a credential: keep it out of the on-disk log. */
const TOKEN_PATTERN = /([?&]token=)[^&\s]*/gu;
// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001B\[[0-9;]*[A-Za-z]/gu;
/** How many trailing service lines to quote when the service dies at startup. */
const FAILURE_TAIL = 12;

/** Strip ANSI colour codes so the ready line can be matched and logged readably. */
function stripAnsi(text) {
  return text.replace(ANSI_PATTERN, '');
}

/** Resolve after `ms` milliseconds. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** True when `host:port` can still be bound. */
function isPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, host, () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Kill a process and its children; `taskkill` is the reliable way on Windows. */
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* Best effort. */
    }
    return;
  }
  try {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10000,
    });
  } catch {
    /* Best effort. */
  }
}

/**
 * One `dsh web` service instance.
 *
 * Events: `status` ({state, detail}), `line` (raw service output line),
 * `ready` ({url, port, pid}), `exit` ({code, signal, expected}), `failed` (Error).
 */
class DshService extends EventEmitter {
  /** @param {object} settings normalized settings. */
  constructor(settings) {
    super();
    this.settings = settings;
    /** @type {'stopped'|'starting'|'ready'|'stopping'|'failed'} */
    this.state = 'stopped';
    this.child = null;
    this.url = null;
    this.port = null;
    this.launch = null;
    this.stopping = false;
    /** @type {string[]} */
    this.recent = [];
  }

  /** A snapshot for menus and the log window header. */
  describe() {
    const version = this.launch?.version ? ` v${this.launch.version}` : '';
    return {
      state: this.state,
      url: this.url,
      port: this.port,
      pid: this.child?.pid ?? null,
      dsh: this.launch?.dshSource ?? null,
      node: this.launch?.nodeSource ?? null,
      version: version.trim(),
    };
  }

  #setStatus(state, detail) {
    this.state = state;
    this.emit('status', { state, detail });
  }

  /**
   * Boot the service.
   * @returns {Promise<{url: string, port: number, pid: number}>} the authenticated URL.
   */
  async start() {
    if (this.state === 'starting' || this.state === 'ready') {
      if (this.url !== null) return { url: this.url, port: this.port, pid: this.child?.pid };
      throw new Error('the service is already starting');
    }
    if (this.child !== null) await this.stop();
    const settings = this.settings;
    const launch = resolveDsh(settings);
    this.launch = launch;
    desktopLog.entry('dsh', `node=${launch.node} (${launch.nodeSource})`);
    desktopLog.entry('dsh', `dsh=${launch.script ?? launch.command} (${launch.dshSource})`);
    desktopLog.entry('dsh', `workspace=${settings.workspace}`);

    let port = settings.port;
    if (port !== 0 && !(await isPortFree(port, settings.host))) {
      if (!settings.autoPort) {
        throw new Error(`port ${port} is already in use; close the other service or enable autoPort`);
      }
      desktopLog.entry('dsh', `port ${port} is busy; letting the OS choose a free port`);
      port = 0;
    }

    const args = ['web', '--no-open', '--host', settings.host, '--port', String(port)];
    for (const authority of settings.trustedHosts) args.push('--trusted-host', authority);
    args.push(...settings.extraArgs);

    const env = { ...process.env, ...settings.env };
    // Never inherit the environment of another Harness surface: this process is
    // the parent of a brand-new service, not a child of an existing session.
    delete env.DSH_WEB_URL;
    delete env.DSH_SESSION_ID;
    delete env.DSH_SHELL;
    env.DSH_DESKTOP = '1';
    const usesElectronNode = launch.script !== null && launch.node === process.execPath;
    if (usesElectronNode) env.ELECTRON_RUN_AS_NODE = '1';
    else delete env.ELECTRON_RUN_AS_NODE;

    this.recent = [];
    this.#setStatus('starting', `port ${port === 0 ? 'auto' : port}`);

    const commandArgs = launch.script === null ? args : [launch.script, ...args];
    desktopLog.entry('dsh', `spawn ${launch.node} ${commandArgs.join(' ')}`);

    /** @type {import('node:child_process').ChildProcess} */
    let child;
    try {
      child = spawn(launch.node, commandArgs, {
        cwd: settings.workspace,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.#setStatus('failed', error.message);
      throw error;
    }
    this.child = child;
    this.stopping = false;
    this.#setStatus('starting');

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`the service did not report a URL within ${settings.startupTimeoutSeconds}s`));
      }, settings.startupTimeoutSeconds * 1000);

      /** Handle one chunk of child output. */
      const onChunk = (chunk) => {
        const text = stripAnsi(String(chunk));
        serviceLog.append(text.replace(TOKEN_PATTERN, '$1<redacted>'));
        for (const line of text.split(/\r?\n/u)) {
          if (line.trim() === '') continue;
          this.recent.push(line);
          if (this.recent.length > FAILURE_TAIL) this.recent.shift();
          this.emit('line', line);
        }
        if (this.url !== null) return;
        const match = READY_PATTERN.exec(text);
        if (match === null) return;
        const url = match[1];
        let parsed;
        try {
          parsed = new URL(url);
        } catch {
          return;
        }
        this.url = url;
        this.port = Number(parsed.port === '' ? (parsed.protocol === 'https:' ? 443 : 80) : parsed.port);
        this.#setStatus('ready', this.url);
        desktopLog.entry('dsh', `ready at ${url.replace(TOKEN_PATTERN, '$1<redacted>')} (pid ${child.pid})`);
        cleanup();
        resolve({ url, port: this.port, pid: child.pid });
      };

      const onExit = (code, signal) => {
        cleanup();
        reject(
          new Error(
            `the service exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}) before it was ready` +
              (this.recent.length > 0 ? `\n\n${this.recent.join('\n')}` : ''),
          ),
        );
      };

      const onSpawnError = (error) => {
        cleanup();
        reject(error);
      };

      /** Detach every listener this attempt installed. */
      const cleanup = () => {
        clearTimeout(timer);
        child.stdout?.off('data', onChunk);
        child.stderr?.off('data', onChunk);
        child.off('exit', onExit);
        child.off('error', onSpawnError);
      };

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', onChunk);
      child.stderr?.on('data', onChunk);
      child.once('exit', onExit);
      child.once('error', onSpawnError);
    });

    child.on('exit', (code, signal) => {
      const expected = this.stopping;
      this.child = null;
      this.url = null;
      this.port = null;
      if (!expected) {
        desktopLog.entry('dsh', `service exited unexpectedly (code ${code ?? 'null'})`);
        this.#setStatus('failed', `service exited with code ${code ?? 'null'}`);
      } else {
        this.#setStatus('stopped');
      }
      this.emit('exit', { code, signal, expected });
    });

    try {
      return await ready;
    } catch (error) {
      await this.stop();
      this.#setStatus('failed', error.message);
      this.emit('failed', error);
      throw error;
    }
  }

  /** Stop the service and wait for the process tree to be gone. */
  async stop({ graceMs = 4000 } = {}) {
    const child = this.child;
    if (child === null) {
      this.#setStatus('stopped');
      return;
    }
    this.stopping = true;
    this.#setStatus('stopping');
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      child.kill();
    } catch {
      /* Already gone. */
    }
    const forceTimer = setTimeout(() => killTree(child.pid), 1200);
    await Promise.race([exited, delay(graceMs)]);
    clearTimeout(forceTimer);
    if (this.child !== null) killTree(child.pid);
    this.child = null;
    this.url = null;
    this.port = null;
    this.#setStatus('stopped');
  }

  /** Stop (when running) and start again. */
  async restart() {
    await this.stop();
    return this.start();
  }
}

module.exports = { DshService, isPortFree, killTree, stripAnsi };
