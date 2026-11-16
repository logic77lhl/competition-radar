#!/usr/bin/env node
/**
 * competition-radar — 每日采集在办 AI / AI4S 竞赛，与昨日快照做 diff，
 * 产出「新增 / 临近截止 / 变更 / 在办总表 / 来源健康」五段式摘要。
 *
 * 用法：
 *   node radar.mjs                        # 正常跑当天
 *   node radar.mjs --date 2026-10-16      # 指定日期（补跑/测试）
 *   node radar.mjs --only kaggle,mlcontests
 *   node radar.mjs --dry-run              # 不写任何状态，摘要另存 .dryrun 后缀
 *   node radar.mjs --quiet
 *
 * 退出码：0 正常；2 所有启用的来源都失败（这是真故障，不能当成「没有新赛事」）；1 未预期异常。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ymd, dayDiff, categorise } from './lib/util.mjs';
import { runSource, SOURCE_PRIORITY, cleanUrl } from './lib/sources.mjs';
import { render } from './lib/digest.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.join(ROOT, 'state');
const OUT = path.join(STATE, 'out');
const SNAP = path.join(STATE, 'snapshots');
const LOG = path.join(STATE, 'log');
const REGISTRY = path.join(STATE, 'registry.json');

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : argv.includes(`--${name}`) ? true : dflt;
};
const DATE = typeof arg('date') === 'string' ? arg('date') : ymd(new Date());
const ONLY = typeof arg('only') === 'string' ? arg('only').split(',').map((s) => s.trim()) : null;
const DRY = argv.includes('--dry-run');
const QUIET = argv.includes('--quiet');

/* ------------------------------------------------------------------ utils */

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------- main */

const t0 = Date.now();
const config = readJson(path.join(ROOT, 'config.json'), null);
if (!config) {
  console.error('缺少 config.json');
  process.exit(1);
}
const settings = config.settings;
const curated = readJson(path.join(ROOT, 'curated.json'), []);
const registry = readJson(REGISTRY, { version: 1, updatedAt: null, items: {} });
const isFirstRun = Object.keys(registry.items || {}).length === 0;

// 来源自己的水位线（例如 DataFountain 的 ID 递进发现探到哪了）
const SOURCE_STATE = path.join(STATE, 'source-state.json');
const sourceState = readJson(SOURCE_STATE, {});
const runSettings = { ...settings, dfWatermark: sourceState.dfMaxId || 0 };

const sourceIds = Object.entries(config.sources)
  .filter(([id, s]) => s.enabled && (!ONLY || ONLY.includes(id)))
  .map(([id]) => id);

// 1) 采集（并发 6：12 个源分散在不同主机上，6 路并行不会打疼谁；
//    实测 3 → 4 → 6 的墙钟是 18s → 14s → 9s 这个量级）
const results = await mapLimit(sourceIds, 6, (id) => runSource(id, { ...config.sources[id] }, runSettings));
// 2) 归一
const records = [];
for (const r of results) {
  if (r.ok) records.push(...r.records);
  else if (!QUIET) console.error(`[来源失败] ${r.id}: ${r.error}`);
}
for (const c of curated) {
  records.push({
    source: 'curated',
    key: c.id,
    name: c.name,
    url: c.url,
    organizer: c.organizer || '',
    prize: c.prize || '',
    prizeRank: 0,
    deadline: c.deadline || null,
    regDeadline: c.regDeadline || null,
    deadlineRaw: c.deadline || '',
    startDate: null,
    endDate: null,
    status: c.status || 'open',
    region: c.region || 'cn',
    tags: c.tags || [],
    category: (c.tags || []).includes('ai4s') ? 'ai4s' : undefined,
    description: c.domain || '',
    evidence: c.evidence || '',
    // 置信度只对人工条目有意义；自动来源的数据本身就是从官方接口/页面读的
    confidence: c.confidence || '',
    sourceUrl: c.sourceUrl || '',
  });
}
// curated 条目的分类用手写 domain 重新算一次（更准）
for (const rec of records) {
  if (rec.source !== 'curated') continue;
  const c = curated.find((x) => x.id === rec.key);
  if (c) rec.category = categorise(c.name, c.domain, (c.tags || []).join(' '), c.organizer);
}

// 2.5) 跨来源去重
// 同一场比赛经常同时出现在 Kaggle 与 mlcontests（后者还带 ?ref= 参数），
// 不去重会让「临近截止」和「新增」都被灌水。按来源优先级保留信息最好的那条。
const normTitle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
const normUrl = (u) => cleanUrl(u).replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
const byUrl = new Map();
const byTitle = new Map();
const deduped = [];
let dedupCount = 0;
const priority = (s) => SOURCE_PRIORITY[s] ?? 10;
for (const rec of [...records].sort((a, b) => priority(b.source) - priority(a.source))) {
  const u = normUrl(rec.url);
  const t = normTitle(rec.name);
  const kept = (u && byUrl.get(u)) || (t.length >= 12 && byTitle.get(t)) || null;
  if (kept) {
    // 把被丢弃条目里更有价值的信息并进来，别因为去重丢数据
    if (!kept.prize && rec.prize) kept.prize = rec.prize;
    if (!kept.organizer && rec.organizer) kept.organizer = rec.organizer;
    if (!kept.deadline && rec.deadline) kept.deadline = rec.deadline;
    kept.alsoOn = [...(kept.alsoOn || []), rec.source];
    dedupCount++;
    continue;
  }
  deduped.push(rec);
  if (u) byUrl.set(u, rec);
  if (t.length >= 12) byTitle.set(t, rec);
}
records.length = 0;
records.push(...deduped);

// 3) 分桶
const evergreenCut = settings.evergreenDays;
const bucket = { openWithDeadline: [], openNoDeadline: [], evergreen: [], closed: [] };
const seenIds = new Set();

for (const rec of records) {
  if (seenIds.has(rec.key)) continue; // 同一 id 只保留第一条
  seenIds.add(rec.key);

  // 真正卡人的日期是「报名截止」与「提交截止」里更早的那个：
  // 错过报名就完全没机会，而提交截止通常还要晚几天。
  const eff = rec.regDeadline && (!rec.deadline || rec.regDeadline < rec.deadline) ? rec.regDeadline : rec.deadline;
  rec.effectiveDeadline = eff || null;
  rec.deadlineIsReg = Boolean(rec.regDeadline && eff === rec.regDeadline && rec.deadline !== rec.regDeadline);

  const left = eff ? dayDiff(DATE, eff) : null;
  rec.daysLeft = left;

  const isEvergreen = left !== null && left > evergreenCut;
  const isClosedByDate = left !== null && left < 0;
  const isClosedByStatus = rec.status === 'closed';

  if (isEvergreen) {
    bucket.evergreen.push(rec);
  } else if (isClosedByDate || isClosedByStatus) {
    bucket.closed.push(rec);
  } else if (left === null) {
    bucket.openNoDeadline.push(rec);
  } else {
    bucket.openWithDeadline.push(rec);
  }
}

bucket.openWithDeadline.sort((a, b) => (a.effectiveDeadline < b.effectiveDeadline ? -1 : a.effectiveDeadline > b.effectiveDeadline ? 1 : 0));
bucket.openNoDeadline.sort((a, b) => (a.source < b.source ? -1 : 1));

// 4) diff + 提醒阶梯
const items = registry.items || {};
const newItems = [];
const deadlineChanges = [];
const reopened = [];
const justClosed = [];
const reminders = [];
const ladder = [...settings.reminderLadder].sort((a, b) => b - a);

for (const rec of [...bucket.openWithDeadline, ...bucket.openNoDeadline]) {
  const prev = items[rec.key];
  if (!prev) {
    newItems.push(rec);
  } else {
    if (prev.effectiveDeadline && rec.effectiveDeadline && prev.effectiveDeadline !== rec.effectiveDeadline) {
      deadlineChanges.push({ ...rec, wasDeadline: prev.effectiveDeadline });
    }
    if (prev.status === 'closed' && (rec.status === 'open' || rec.status === 'listed')) {
      reopened.push(rec);
    }
  }

  if (rec.daysLeft !== null) {
    const fired = (prev?.reminded?.[rec.effectiveDeadline] || []).filter((x) => typeof x === 'number');
    // 触发「已进入的最小阶梯」：daysLeft <= threshold 且该 threshold 还没报过
    const due = ladder.filter((th) => rec.daysLeft <= th && !fired.includes(th));
    if (due.length) {
      const th = Math.min(...due);
      reminders.push({ ...rec, threshold: th });
    }
  }
}

for (const rec of bucket.closed) {
  const prev = items[rec.key];
  if (prev && !prev.closedReported && prev.firstSeen !== DATE) {
    justClosed.push(rec);
  }
}

reminders.sort((a, b) => a.daysLeft - b.daysLeft);

// 5) 更新 registry
const nextItems = { ...items };
const pruneBefore = new Date(Date.parse(`${DATE}T00:00:00Z`) - 180 * 86400000).toISOString().slice(0, 10);

function upsert(rec, { closed = false } = {}) {
  const prev = nextItems[rec.key] || {};
  const entry = {
    id: rec.key,
    source: rec.source,
    name: rec.name,
    url: rec.url,
    organizer: rec.organizer,
    firstSeen: prev.firstSeen || DATE,
    lastSeen: DATE,
    deadline: rec.deadline ?? prev.deadline ?? null,
    regDeadline: rec.regDeadline ?? prev.regDeadline ?? null,
    effectiveDeadline: rec.effectiveDeadline ?? prev.effectiveDeadline ?? null,
    deadlineIsReg: Boolean(rec.deadlineIsReg),
    prize: rec.prize || prev.prize || '',
    status: closed ? 'closed' : rec.status,
    category: rec.category || prev.category,
    region: rec.region || prev.region,
    confidence: rec.confidence || prev.confidence || '',
    tags: rec.tags?.length ? rec.tags : prev.tags || [],
    reminded: { ...(prev.reminded || {}) },
    closedReported: closed ? true : prev.status === 'closed' && !closed ? false : prev.closedReported || false,
  };
  if (!closed && rec.daysLeft !== null) {
    const key = rec.effectiveDeadline;
    const fired = new Set(entry.reminded[key] || []);
    for (const r of reminders) if (r.key === rec.key) fired.add(r.threshold);
    // 只保留当前截止日的提醒记录，避免无限增长
    entry.reminded = { [key]: [...fired].sort((a, b) => b - a) };
  }
  nextItems[rec.key] = entry;
}

for (const rec of [...bucket.openWithDeadline, ...bucket.openNoDeadline, ...bucket.evergreen]) upsert(rec);
for (const rec of bucket.closed) upsert(rec, { closed: true });

for (const [id, entry] of Object.entries(nextItems)) {
  if (entry.lastSeen < pruneBefore) delete nextItems[id];
}

const allRecords = [...bucket.openWithDeadline, ...bucket.openNoDeadline, ...bucket.evergreen, ...bucket.closed];
const health = results.map((r) => ({
  id: r.id,
  label: config.sources[r.id]?.label || r.id,
  ok: r.ok,
  count: r.records.length,
  ms: r.ms,
  note: r.note,
  error: r.error || r.walkError,
}));
health.push({
  id: 'curated',
  label: '人工维护清单',
  ok: true,
  count: curated.length,
  ms: 0,
  note: `curated.json ${curated.length} 条（其中 ${curated.filter((c) => c.confidence && !/^已核实/.test(c.confidence)).length} 条是第三方转述，摘要里标 ⚠️）`,
});

// 6) 渲染
const counts = {
  total: allRecords.length,
  openWithDeadline: bucket.openWithDeadline.length,
  openNoDeadline: bucket.openNoDeadline.length,
  evergreen: bucket.evergreen.length,
  closed: bucket.closed.length,
  newItems: isFirstRun ? 0 : newItems.length,
  reminders: reminders.length,
  deadlineChanges: deadlineChanges.length,
  reopened: reopened.length,
  justClosed: justClosed.length,
};

const view = {
  date: DATE,
  generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z',
  durationMs: Date.now() - t0,
  isFirstRun,
  dedupCount,
  reminders,
  newItems: isFirstRun ? [] : newItems,
  deadlineChanges,
  reopened,
  justClosed,
  openWithDeadline: bucket.openWithDeadline,
  openNoDeadline: bucket.openNoDeadline,
  evergreen: bucket.evergreen,
  health,
  watchlist: config.watchlist || [],
  counts,
};

// 看板用的结构化导出。摘要是给人读的，这份是给 panel/ 读的 ——
// 同一次运行、同一份 view，不重新计算，避免看板和摘要对不上。
const slimRecord = (r) => ({
  id: r.key,
  name: r.name,
  url: r.url,
  organizer: r.organizer || '',
  source: r.source,
  category: r.category || 'general',
  region: r.region || '',
  prize: r.prize || '',
  prizeRank: r.prizeRank || 0,
  deadline: r.deadline || null,
  regDeadline: r.regDeadline || null,
  effectiveDeadline: r.effectiveDeadline || null,
  deadlineIsReg: Boolean(r.deadlineIsReg),
  daysLeft: r.daysLeft ?? null,
  status: r.status || '',
  confidence: r.confidence || '',
  tags: r.tags || [],
  alsoOn: r.alsoOn || [],
  threshold: r.threshold ?? null,
  wasDeadline: r.wasDeadline || null,
});

const exportView = {
  date: DATE,
  generatedAt: view.generatedAt,
  durationMs: view.durationMs,
  isFirstRun,
  dedupCount,
  counts,
  reminders: reminders.map(slimRecord),
  newItems: view.newItems.map(slimRecord),
  deadlineChanges: deadlineChanges.map(slimRecord),
  reopened: reopened.map(slimRecord),
  justClosed: justClosed.map(slimRecord),
  open: bucket.openWithDeadline.map(slimRecord),
  noDeadline: bucket.openNoDeadline.map(slimRecord),
  evergreen: bucket.evergreen.map(slimRecord),
  health,
  watchlist: view.watchlist,
};

const { md, html } = render(view);

const suffix = DRY ? '.dryrun' : '';
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(LOG, { recursive: true });

const finalMd = md;
fs.writeFileSync(path.join(OUT, `${DATE}${suffix}.md`), finalMd, 'utf8');
fs.writeFileSync(path.join(OUT, `${DATE}${suffix}.html`), html, 'utf8');
if (!DRY) {
  fs.writeFileSync(path.join(OUT, 'latest.md'), finalMd, 'utf8');
  fs.writeFileSync(path.join(OUT, 'latest.html'), html, 'utf8');
  writeJson(path.join(OUT, 'latest.json'), exportView);
  writeJson(path.join(OUT, `${DATE}.json`), exportView);
  fs.mkdirSync(SNAP, { recursive: true });
  writeJson(path.join(SNAP, `${DATE}.json`), {
    date: DATE,
    counts,
    open: bucket.openWithDeadline.map((r) => ({
      id: r.key,
      name: r.name,
      deadline: r.effectiveDeadline,
      submissionDeadline: r.deadline,
      regDeadline: r.regDeadline || null,
      deadlineIsReg: Boolean(r.deadlineIsReg),
      category: r.category,
      source: r.source,
      prize: r.prize,
      confidence: r.confidence || '',
    })),
    noDeadline: bucket.openNoDeadline.map((r) => ({ id: r.key, name: r.name, source: r.source })),
  });
  writeJson(REGISTRY, { version: 1, updatedAt: new Date().toISOString(), items: nextItems });
  // 来源水位线：只增不减，避免重复探测已确认不存在的 ID
  const nextSourceState = { ...sourceState };
  for (const r of results) {
    if (r.meta?.dfMaxId && r.meta.dfMaxId > (nextSourceState.dfMaxId || 0)) {
      nextSourceState.dfMaxId = r.meta.dfMaxId;
    }
  }
  writeJson(SOURCE_STATE, nextSourceState);
  fs.appendFileSync(
    path.join(STATE, 'history.jsonl'),
    JSON.stringify({ date: DATE, at: new Date().toISOString(), counts, health: health.map((h) => ({ id: h.id, ok: h.ok, count: h.count })) }) + '\n',
    'utf8',
  );
}

const logLine = `[${new Date().toISOString()}] date=${DATE} dry=${DRY} total=${counts.total} open=${counts.openWithDeadline} new=${counts.newItems} reminders=${counts.reminders} sources_ok=${health.filter((h) => h.ok).length}/${health.length} ms=${Date.now() - t0}`;
fs.appendFileSync(path.join(LOG, `${DATE.slice(0, 7)}.log`), logLine + '\n', 'utf8');
if (!QUIET) console.log(logLine);
if (!QUIET) console.log(`摘要：${path.join(OUT, `${DATE}${suffix}.md`)}`);

const enabledFailed = health.filter((h) => h.id !== 'curated' && !h.ok).length;
if (enabledFailed === health.length - 1) {
  console.error('所有启用的来源都失败了——这是真故障，不是「没有新赛事」。');
  process.exit(2);
}
process.exit(0);
