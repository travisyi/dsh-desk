'use strict';

/**
 * `npm run usage` — DeepSeek Harness token usage, aggregated by calendar day.
 *
 * Reads the session logs under the Harness home and prints the same numbers the
 * usage window shows. Runs under a plain `node`; no Electron involved.
 *
 *   node scripts/usage.js              table with today/week/month/all subtotals
 *   node scripts/usage.js --sessions   add a per-session breakdown
 *   node scripts/usage.js --json       the raw report, for scripting
 */

const { collectUsage, formatReport, formatSessions } = require('../src/usage-stats');

const HELP = `DeepSeek Harness — token 用量统计

用法：
  node scripts/usage.js [选项]

选项：
  -s, --sessions   额外打印按会话的明细
      --json       输出 JSON（便于脚本处理）
  -h, --help       显示这段帮助

数据源：<DSH_HOME>/sessions 下的会话日志（默认 ~/.dsh）。
按本地时区把每个 assistant/message 的用量归到它发生的那一天。
`;

async function main() {
  const flags = new Set(process.argv.slice(2));
  if (flags.has('--help') || flags.has('-h')) {
    process.stdout.write(HELP);
    return;
  }
  const asJson = flags.has('--json');
  const showSessions = flags.has('--sessions') || flags.has('-s');
  const interactive = process.stdout.isTTY === true && !asJson;

  const report = await collectUsage({
    onProgress: interactive
      ? (done, total) => process.stdout.write(`\r扫描会话日志 ${done}/${total} …`)
      : undefined,
  });
  if (interactive) process.stdout.write(`\r${' '.repeat(32)}\r`);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${formatReport(report)}\n`);
  if (showSessions) {
    process.stdout.write('\n按会话（最近 20 个）\n\n');
    process.stdout.write(`${formatSessions(report)}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`用量统计失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
