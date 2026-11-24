#!/usr/bin/env node
/**
 * 质量门禁回放：只读，不改任何状态。
 *
 * 用 state/history.jsonl（或 --index 用 docs/data/index.json）回放最近 N 天，
 * 按 lib/quality.mjs 的规则列出「会被拦截的日子 / 不会拦截的日子」，
 * 用来在把阈值写进 radar.mjs 之前确认：
 *   - 异常日（2/12 源、22 条）会被拦；
 *   - 正常日不会被误杀。
 *
 * 用法：
 *   node tools/replay-quality.mjs                    # 默认读 history.jsonl，最近 90 天
 *   node tools/replay-quality.mjs --days 30
 *   node tools/replay-quality.mjs --index            # 用 docs/data/index.json 回放
 *   node tools/replay-quality.mjs --json             # 机器可读
 *
 * 退出码：0 回放完成（无论是否有拦截日）；1 输入文件读不到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeQuality, DEFAULT_QUALITY_CONFIG } from '../lib/quality.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : argv.includes(`--${name}`) ? true : dflt;
};
const DAYS = Number(arg('days', 90));
const JSON_OUT = argv.includes('--json');
const USE_INDEX = argv.includes('--index');

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

function readHistory(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return null; }
}

// 配置：实时读 config.settings.quality；没配就用默认。
const config = readJson(path.join(ROOT, 'config.json'), {});
const cfg = { ...DEFAULT_QUALITY_CONFIG, ...(config?.settings?.quality || {}) };

let rows;
let sourceLabel;
if (USE_INDEX) {
  rows = readJson(path.join(ROOT, 'docs', 'data', 'index.json'), []);
  sourceLabel = 'docs/data/index.json';
} else {
  rows = readHistory(path.join(ROOT, 'state', 'history.jsonl'));
  sourceLabel = 'state/history.jsonl';
}
if (!Array.isArray(rows)) {
  console.error(`读不到 ${sourceLabel}`);
  process.exit(1);
}

// 同日多行只取最后一条；按日期升序。
const byDate = new Map();
for (const row of rows) {
  if (row && typeof row.date === 'string') byDate.set(row.date, row);
}
const allDates = [...byDate.keys()].sort();
const dates = allDates.slice(-Math.max(1, DAYS));

function healthOf(row) {
  if (Array.isArray(row.health)) {
    return row.health.map((h) => ({ id: h.id, ok: Boolean(h.ok) }));
  }
  if (typeof row.healthOk === 'number' && typeof row.healthTotal === 'number') {
    // index.json 只有 ok 总数；造出等比例的数组，够门禁判定用。
    return [
      ...Array.from({ length: row.healthOk }, (_, i) => ({ id: `ok${i}`, ok: true })),
      ...Array.from({ length: Math.max(0, row.healthTotal - row.healthOk) }, (_, i) => ({ id: `bad${i}`, ok: false })),
    ];
  }
  return [];
}
function totalOf(row) {
  return row?.counts?.total ?? 0;
}

const results = dates.map((date) => {
  const stats = { date, total: totalOf(byDate.get(date)), health: healthOf(byDate.get(date)) };
  const q = computeQuality(stats, rows, { config: cfg });
  return { date, total: stats.total, ok: q.ok, blockedTotal: q.blockedTotal, okRatio: q.okRatio, baselineMedian: q.baselineMedian, baselineThreshold: q.baselineThreshold, passed: q.passed, reasons: q.reasons };
});

const blocked = results.filter((r) => !r.passed);
const passed = results.filter((r) => r.passed);

if (JSON_OUT) {
  console.log(JSON.stringify({ source: sourceLabel, days: dates.length, config: cfg, summary: { blocked: blocked.length, passed: passed.length }, results }, null, 2));
  process.exit(0);
}

console.log(`质量门禁回放 · ${sourceLabel} · 最近 ${dates.length} 天（${dates[0] ?? '-'} ~ ${dates[dates.length - 1] ?? '-'}）`);
console.log(`规则：ok/total < ${(cfg.minOkRatio * 100).toFixed(0)}% 或 records < 前 ${cfg.baselineDays} 天中位数 × ${cfg.minRecordsRatio}；分母 < ${cfg.minTotalForRatio} 不判比例；中位数缺失只走比例。`);
console.log('');
console.log(`被拦截 ${blocked.length} 天：`);
if (blocked.length) {
  console.log('  日期        记录   来源健康    基线中位数  原因');
  for (const r of blocked) {
    const ratio = r.okRatio === null ? '-' : `${(r.okRatio * 100).toFixed(0)}%`;
    console.log(`  ${r.date}  ${String(r.total).padStart(5)}  ${String(r.ok + '/' + r.blockedTotal).padStart(8)}  ${String(r.baselineMedian ?? '-').padStart(10)}  ${r.reasons.join('；')}`);
  }
} else {
  console.log('  （无）');
}
console.log('');
console.log(`通过 ${passed.length} 天（列出总量最低的 5 天，用于确认没有误杀）：`);
const lowest = [...passed].sort((a, b) => a.total - b.total).slice(0, 5);
for (const r of lowest) {
  const ratio = r.okRatio === null ? '-' : `${(r.okRatio * 100).toFixed(0)}%`;
  console.log(`  ${r.date}  记录=${String(r.total).padStart(5)}  来源=${String(r.ok + '/' + r.blockedTotal).padStart(8)} (${ratio})  基线=${r.baselineMedian ?? '-'}`);
}
process.exit(0);
