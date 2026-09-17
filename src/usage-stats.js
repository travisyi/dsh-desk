'use strict';

/**
 * Token usage, aggregated by calendar day.
 *
 * Where the numbers come from
 * ---------------------------
 * The Harness keeps one append-only log per session under
 * `<DSH_HOME>/sessions/<escaped-cwd>/<session-id>/session.vN.jsonl.zstd`. Each
 * `assistant/message` event carries the provider's own usage sample for that
 * attempt:
 *
 *   { inputTokens, outputTokens, cacheReadTokens, totalTokens }
 *
 * Summing those over a whole log reproduces the `tokenUsage` totals the Harness
 * itself projects, so this module reports the same numbers the GUI shows — just
 * grouped by day instead of per session.
 *
 * Reading the log
 * ---------------
 * The file is a container of concatenated, independently decodable Zstandard
 * frames (one per append batch), so Node's one-shot decoder stops after the
 * first frame. Frames all start with the Zstandard magic, and a candidate that
 * is not a real frame start fails validation, so scanning for the magic and
 * decoding each candidate in turn recovers every frame. A torn final frame (a
 * batch interrupted mid-write) is recovered best-effort with `ZSTD_e_flush`,
 * matching what the Harness' own backend does.
 *
 * This module is deliberately pure Node: `scripts/usage.js` runs it under a
 * plain `node`, and the Electron main process embeds it for the usage window.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

/** Every Zstandard frame begins with this little-endian magic. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** `session.v3.jsonl.zstd`, `session.v2.jsonl`, … */
const LOG_NAME = /^session\.v(\d+)\.jsonl(\.zstd)?$/u;

/** Where the Harness keeps its profiles, sessions and credentials. */
function dshHome() {
  const env = process.env.DSH_HOME;
  return env !== undefined && env !== '' ? path.resolve(env) : path.join(os.homedir(), '.dsh');
}

/** `YYYY-MM-DD` for a timestamp, in the machine's local time zone. */
function dayKey(ms) {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** Midnight at the start of the current week (weeks start on Monday). */
function weekStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** Midnight at the start of the current month. */
function monthStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  return d.getTime();
}

/** A finite number, or zero. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Add one usage sample into a `{ input, output, cacheRead }` accumulator. */
function addUsage(target, usage) {
  target.input += num(usage.inputTokens);
  target.output += num(usage.outputTokens);
  target.cacheRead += num(usage.cacheReadTokens);
  return target;
}

/** A zeroed accumulator. */
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0 };
}

/**
 * Pick the log to read in one session directory: highest format version wins,
 * and the compressed variant beats plaintext at the same version.
 * @param {string} dir an absolute session directory.
 * @returns {string|undefined} the chosen path.
 */
function pickLog(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  let best;
  let bestRank = -1;
  for (const name of entries) {
    const match = LOG_NAME.exec(name);
    if (match === null) continue;
    const rank = Number(match[1]) * 2 + (match[2] === '.zstd' ? 1 : 0);
    if (rank > bestRank) {
      bestRank = rank;
      best = path.join(dir, name);
    }
  }
  return best;
}

/**
 * Every session log under the sessions root.
 * @returns {{ id: string, file: string, dir: string }[]}
 */
function listSessionLogs(sessionsRoot) {
  /** @type {{ id: string, file: string, dir: string }[]} */
  const found = [];
  let projects = [];
  try {
    projects = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectDir = path.join(sessionsRoot, project.name);
    let sessions = [];
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      const dir = path.join(projectDir, session.name);
      const file = pickLog(dir);
      if (file !== undefined) found.push({ id: session.name, file, dir });
    }
  }
  return found;
}

/** Decode one candidate frame; a torn final frame is recovered best-effort. */
function decodeFrame(buffer, offset, isLast) {
  try {
    return zlib.zstdDecompressSync(buffer.subarray(offset));
  } catch (error) {
    if (!isLast) return undefined;
    try {
      return zlib.zstdDecompressSync(buffer.subarray(offset), {
        finishFlush: zlib.constants.ZSTD_e_flush,
      });
    } catch {
      return undefined;
    }
  }
}

/**
 * Decode a concatenated-frame log into its raw text.
 * @param {Buffer} buffer the whole file.
 * @param {() => Promise<void>} yieldTo loop-yield hook for long logs.
 * @returns {Promise<string>} the concatenated plaintext.
 */
async function decodeLog(buffer, yieldTo) {
  const offsets = [];
  for (let i = buffer.indexOf(ZSTD_MAGIC, 0); i !== -1; i = buffer.indexOf(ZSTD_MAGIC, i + 4)) {
    offsets.push(i);
  }
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const chunk = decodeFrame(buffer, offsets[k], k === offsets.length - 1);
    if (chunk !== undefined) parts.push(chunk);
    if ((k & 63) === 63) await yieldTo();
  }
  return Buffer.concat(parts).toString('utf8');
}

/**
 * Parse a log's text into events, ignoring a torn trailing record.
 * @param {string} text decoded plaintext JSONL.
 * @returns {object[]}
 */
function parseEvents(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* Torn trailing record: the next scan sees it once the batch completes. */
    }
  }
  return events;
}

/**
 * Read and decode one session log.
 * @returns {Promise<{ events: object[], bytes: number } | undefined>}
 */
async function readSessionLog(file, yieldTo) {
  let buffer;
  try {
    buffer = await fs.promises.readFile(file);
  } catch {
    return undefined;
  }
  const text = await decodeLog(buffer, yieldTo);
  return { events: parseEvents(text), bytes: buffer.length };
}

/**
 * Attribute one usage sample to the provider/model that produced it.
 * @param {Map<string, object>} routes
 * @param {{ provider?: string, model?: string }} route
 * @param {object} usage
 * @param {string} sessionId
 */
function addRoute(routes, route, usage, sessionId) {
  const provider = route.provider ?? '未知';
  const model = route.model ?? '未知';
  const key = `${provider}\u0000${model}`;
  let entry = routes.get(key);
  if (entry === undefined) {
    entry = { provider, model, usage: emptyUsage(), messages: 0, sessions: new Set() };
    routes.set(key, entry);
  }
  addUsage(entry.usage, usage);
  entry.messages += 1;
  entry.sessions.add(sessionId);
}

/**
 * Fold one session's events into the per-day and per-session accumulators.
 *
 * Usage is counted from `assistant/message` events only: that is the final
 * sample for an attempt, and the Harness replaces a streamed sample with it, so
 * counting the intermediate `stream[].chunk.usage` samples as well would double
 * count. A retried attempt produces its own `assistant/message`, which is
 * exactly how the Harness bills it.
 *
 * @param {object[]} events
 * @param {Map<string, object>} days
 * @param {object} session the session accumulator to update.
 * @param {Map<string, object>} routes per provider/model accumulators to update.
 */
function foldSession(events, days, session, routes) {
  const header = events[0]?.type === 'session' ? events[0] : undefined;
  session.cwd = header?.cwd ?? session.cwd;
  session.startedAt = typeof header?.createdAt === 'number' ? header.createdAt : null;
  session.delegationDepth = typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0;
  // A forked session replays the parent's events; they carry the parent's
  // timestamps and would otherwise be counted a second time.
  const inherited = typeof header?.inheritedEventCount === 'number' ? header.inheritedEventCount : 0;

  /** The route in effect; `request/header` events update it as they appear. */
  let route = { provider: undefined, model: undefined };

  for (let i = inherited; i < events.length; i++) {
    const event = events[i];
    if (event.type === 'session/title' && typeof event.data?.title === 'string') {
      session.title = event.data.title;
      continue;
    }
    if (event.type === 'request/header') {
      const config = event.data?.header?.config;
      if (typeof config?.model === 'string') session.models.add(config.model);
      if (typeof config?.provider === 'string') session.providers.add(config.provider);
      // A header is written when the route changes, so it stays in effect for
      // every following request until the next header arrives.
      route = {
        provider: typeof config?.provider === 'string' ? config.provider : route.provider,
        model: typeof config?.model === 'string' ? config.model : route.model,
      };
      continue;
    }
    if (event.type !== 'assistant/message') continue;
    const usage = event.data?.usage;
    if (usage === null || typeof usage !== 'object') continue;
    const at = typeof event.time === 'number' ? event.time : undefined;
    if (at === undefined) continue;

    addUsage(session.usage, usage);
    addRoute(routes, route, usage, session.id);
    session.messages += 1;
    if (session.lastAt === null || at > session.lastAt) session.lastAt = at;
    if (session.startedAt === null || at < session.startedAt) session.startedAt = at;

    const key = dayKey(at);
    let bucket = days.get(key);
    if (bucket === undefined) {
      bucket = { date: key, usage: emptyUsage(), messages: 0, sessions: new Set() };
      days.set(key, bucket);
    }
    addUsage(bucket.usage, usage);
    bucket.messages += 1;
    bucket.sessions.add(session.id);
  }
}

/**
 * Sum the already-mapped day rows from `fromKey` onward (`null` = all of them).
 * @param {object[]} dayList entries of the report's `days` array.
 * @param {string|null} fromKey inclusive `YYYY-MM-DD` lower bound.
 */
function sumDays(dayList, fromKey) {
  const total = emptyUsage();
  let messages = 0;
  for (const day of dayList) {
    if (fromKey !== null && day.date < fromKey) continue;
    total.input += day.input;
    total.output += day.output;
    total.cacheRead += day.cacheRead;
    messages += day.messages;
  }
  return { usage: total, messages };
}

/** Attach the derived `total` used everywhere in the UI. */
function withTotal(usage) {
  return { ...usage, total: usage.input + usage.output + usage.cacheRead };
}

/**
 * Scan every session log and aggregate token usage by day.
 *
 * @param {object} [options]
 * @param {string} [options.home] the Harness home to scan (defaults to `DSH_HOME`).
 * @param {number} [options.now] the reference time for "today/week/month".
 * @param {(done: number, total: number) => void} [options.onProgress]
 * @returns {Promise<object>} the usage report.
 */
async function collectUsage(options = {}) {
  const startedAt = Date.now();
  const home = options.home ?? dshHome();
  const now = options.now ?? Date.now();
  const onProgress = options.onProgress;
  const sessionsRoot = path.join(home, 'sessions');
  const logs = listSessionLogs(sessionsRoot);

  /** @type {Map<string, object>} */
  const days = new Map();
  /** @type {Map<string, object>} */
  const routes = new Map();
  const sessions = [];
  const warnings = [];
  let bytes = 0;

  const yieldTo = () => new Promise((resolve) => setImmediate(resolve));

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    const session = {
      id: log.id,
      cwd: undefined,
      title: undefined,
      startedAt: null,
      lastAt: null,
      delegationDepth: 0,
      messages: 0,
      usage: emptyUsage(),
      models: new Set(),
      providers: new Set(),
    };
    try {
      const read = await readSessionLog(log.file, yieldTo);
      if (read !== undefined) {
        bytes += read.bytes;
        foldSession(read.events, days, session, routes);
      }
    } catch (error) {
      warnings.push(`${log.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    sessions.push(session);
    if (onProgress !== undefined) onProgress(i + 1, logs.length);
    await yieldTo();
  }

  const dayList = [...days.values()]
    .map((day) => ({
      date: day.date,
      ...withTotal(day.usage),
      messages: day.messages,
      sessions: day.sessions.size,
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const todayKey = dayKey(now);
  const weekKey = dayKey(weekStartMs(now));
  const monthKey = dayKey(monthStartMs(now));

  return {
    home,
    sessionsRoot,
    generatedAt: now,
    scanned: {
      files: logs.length,
      bytes,
      ms: Date.now() - startedAt,
      days: dayList.length,
      activeSessions: sessions.filter((s) => s.messages > 0).length,
    },
    days: dayList,
    subtotals: {
      today: { label: '今日', from: todayKey, ...sumDays(dayList, todayKey) },
      week: { label: '本周', from: weekKey, ...sumDays(dayList, weekKey) },
      month: { label: '本月', from: monthKey, ...sumDays(dayList, monthKey) },
      all: { label: '合计', from: null, ...sumDays(dayList, null) },
    },
    routes: [...routes.values()]
      .map((entry) => ({
        provider: entry.provider,
        model: entry.model,
        ...withTotal(entry.usage),
        messages: entry.messages,
        sessions: entry.sessions.size,
      }))
      .sort((a, b) => b.total - a.total),
    sessions: sessions
      .map((session) => ({
        id: session.id,
        cwd: session.cwd,
        title: session.title,
        startedAt: session.startedAt,
        lastAt: session.lastAt,
        delegationDepth: session.delegationDepth,
        messages: session.messages,
        models: [...session.models],
        providers: [...session.providers],
        ...withTotal(session.usage),
      }))
      .sort((a, b) => (b.lastAt ?? 0) - (a.lastAt ?? 0)),
    warnings,
  };
}

/** `1234567` -> `1,234,567`. */
function withThousands(value) {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/**
 * Render the provider/model breakdown.
 *
 * A route is in effect from the `request/header` that names it until the next
 * one, which is how the Harness itself records a change of provider or model.
 *
 * @param {object} report a {@link collectUsage} result.
 * @returns {string}
 */
function formatRoutes(report) {
  if (report.routes.length === 0) return '（没有用量记录）';
  const columns = [14, 24, 13, 13, 11, 13, 6, 6];
  const header = ['提供方', '模型', '输入(未缓存)', '缓存读取', '输出', '合计', '会话', '消息'];
  const lines = [header.map((h, i) => pad(h, columns[i], i < 2 ? 'left' : 'right')).join('  ')];
  lines.push(columns.map((w) => '─'.repeat(w)).join('  '));
  for (const route of report.routes) {
    lines.push([
      pad(route.provider, columns[0]),
      pad(route.model, columns[1]),
      pad(withThousands(route.input), columns[2], 'right'),
      pad(withThousands(route.cacheRead), columns[3], 'right'),
      pad(withThousands(route.output), columns[4], 'right'),
      pad(withThousands(route.total), columns[5], 'right'),
      pad(route.sessions, columns[6], 'right'),
      pad(route.messages, columns[7], 'right'),
    ].join('  '));
  }
  return lines.join('\n');
}

/** `1234567` -> `1.2M`, for compact columns. */
function compact(value) {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Pad to a display width, accounting for wide CJK glyphs. */
function pad(text, width, align = 'left') {
  const wide = [...String(text)].reduce((n, ch) => n + (ch.codePointAt(0) > 0x2e7f ? 2 : 1), 0);
  const space = ' '.repeat(Math.max(0, width - wide));
  return align === 'right' ? space + text : text + space;
}

/**
 * Render a report as an aligned plain-text table (used by the CLI).
 * @param {object} report a {@link collectUsage} result.
 * @returns {string}
 */
function formatReport(report) {
  const columns = [10, 14, 14, 12, 14, 8, 8];
  const header = ['日期', '输入(未缓存)', '缓存读取', '输出', '合计', '会话', '消息'];
  const lines = [];
  lines.push(`DeepSeek Harness — token 用量（按天，本地时区 ${dayKey(report.generatedAt)}）`);
  lines.push('');
  lines.push(header.map((h, i) => pad(h, columns[i], i === 0 ? 'left' : 'right')).join('  '));
  lines.push(columns.map((w) => '─'.repeat(w)).join('  '));

  const row = (label, entry, extra) => [
    pad(label, columns[0]),
    pad(withThousands(entry.input), columns[1], 'right'),
    pad(withThousands(entry.cacheRead), columns[2], 'right'),
    pad(withThousands(entry.output), columns[3], 'right'),
    pad(withThousands(entry.total), columns[4], 'right'),
    pad(extra?.sessions ?? '', columns[5], 'right'),
    pad(extra?.messages ?? '', columns[6], 'right'),
  ].join('  ');

  for (const day of report.days) {
    lines.push(row(day.date, day, { sessions: day.sessions, messages: day.messages }));
  }
  if (report.days.length === 0) lines.push('（还没有任何用量记录）');

  lines.push(columns.map((w) => '─'.repeat(w)).join('  '));
  for (const key of ['today', 'week', 'month', 'all']) {
    const bucket = report.subtotals[key];
    lines.push(row(bucket.label, withTotal(bucket.usage), { messages: bucket.messages }));
  }

  lines.push('');
  lines.push(formatRoutes(report));

  lines.push('');
  const s = report.scanned;
  lines.push(
    `扫描 ${s.files} 个会话日志（${compact(s.bytes)}B，用时 ${s.ms}ms），`
    + `其中有用量 ${s.activeSessions} 个，共 ${s.days} 天。`,
  );
  lines.push(`数据源：${report.sessionsRoot}`);
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`有 ${report.warnings.length} 个日志读取失败：`);
    for (const warning of report.warnings.slice(0, 5)) lines.push(`  ${warning}`);
  }
  return lines.join('\n');
}

/** `YYYY-MM-DD HH:mm` in local time. */
function stamp(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${dayKey(ms)} ${hh}:${mm}`;
}

/**
 * Render the per-session breakdown (used by `npm run usage --sessions`).
 * @param {object} report a {@link collectUsage} result.
 * @param {number} [limit] how many sessions to show, newest first.
 * @returns {string}
 */
function formatSessions(report, limit = 20) {
  const rows = report.sessions.filter((session) => session.messages > 0).slice(0, limit);
  if (rows.length === 0) return '（没有会话记录）';
  const columns = [38, 6, 13, 13, 10, 13, 17];
  const header = ['会话', '消息', '输入(未缓存)', '缓存读取', '输出', '合计', '最后活动'];
  const lines = [header.map((h, i) => pad(h, columns[i], i === 0 ? 'left' : 'right')).join('  ')];
  lines.push(columns.map((w) => '─'.repeat(w)).join('  '));
  for (const session of rows) {
    const label = session.title ?? session.cwd ?? session.id;
    lines.push([
      pad(String(label).slice(0, 36), columns[0]),
      pad(session.messages, columns[1], 'right'),
      pad(withThousands(session.input), columns[2], 'right'),
      pad(withThousands(session.cacheRead), columns[3], 'right'),
      pad(withThousands(session.output), columns[4], 'right'),
      pad(withThousands(session.total), columns[5], 'right'),
      pad(stamp(session.lastAt), columns[6], 'right'),
    ].join('  '));
  }
  if (report.sessions.filter((s) => s.messages > 0).length > rows.length) {
    lines.push(`… 另有 ${report.sessions.filter((s) => s.messages > 0).length - rows.length} 个会话未显示`);
  }
  return lines.join('\n');
}

module.exports = {
  collectUsage,
  formatReport,
  formatRoutes,
  formatSessions,
  dshHome,
  dayKey,
  stamp,
  weekStartMs,
  monthStartMs,
  listSessionLogs,
  withTotal,
  withThousands,
  compact,
};
