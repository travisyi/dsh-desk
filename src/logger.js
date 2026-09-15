'use strict';

/**
 * Two small logs:
 *   - `logs/desktop.log`  — the shell itself (start/stop, resolved paths, errors)
 *   - `logs/service.log`  — everything the `dsh web` child process prints
 *
 * Both keep a bounded in-memory tail that the in-app log window renders, and
 * both are capped on disk so a long-running service cannot fill the disk.
 */

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { LOG_DIR } = require('./config');

const MAX_BYTES = 4 * 1024 * 1024;
const TAIL_LINES = 2000;

/** One append-only log file with rotation plus an in-memory tail. */
class LogFile extends EventEmitter {
  /** @param {string} file base name inside `logs/`. */
  constructor(file) {
    super();
    this.setMaxListeners(0);
    this.file = path.join(LOG_DIR, file);
    /** @type {string[]} */
    this.tail = [];
    this.bytes = 0;
    try {
      fs.mkdirSync(LOG_DIR, { recursive: true });
      this.bytes = fs.statSync(this.file).size;
    } catch {
      /* A fresh or unreadable log starts empty. */
    }
  }

  /** Append a timestamped, scope-tagged entry. */
  entry(scope, message) {
    this.append(`[${new Date().toISOString()}] [${scope}] ${message}`);
  }

  /** Append raw text exactly as received (the child's own lines). */
  append(text) {
    const chunk = text.endsWith('\n') || text === '' ? text : `${text}\n`;
    const parts = chunk.split(/\r?\n/u);
    if (parts.length > 1) parts.pop(); // the trailing element is the empty tail
    for (const line of parts) this.#push(line);
    try {
      if (this.bytes > MAX_BYTES) this.#rotate();
      fs.appendFileSync(this.file, chunk, 'utf8');
      this.bytes += Buffer.byteLength(chunk);
    } catch {
      /* Logging must never take the app down. */
    }
  }

  /** The last {@link TAIL_LINES} lines, oldest first. */
  recent() {
    return this.tail.slice();
  }

  #push(line) {
    this.tail.push(line);
    if (this.tail.length > TAIL_LINES) this.tail.splice(0, this.tail.length - TAIL_LINES);
    this.emit('line', line);
  }

  #rotate() {
    try {
      fs.renameSync(this.file, `${this.file}.1`);
    } catch {
      /* If the rename fails we simply keep appending. */
    }
    this.bytes = 0;
  }
}

/** The shell's own log. */
const desktop = new LogFile('desktop.log');
/** The `dsh web` child's output. */
const service = new LogFile('service.log');

module.exports = { desktop, service, LogFile, LOG_DIR };
