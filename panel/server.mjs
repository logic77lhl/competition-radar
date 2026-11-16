#!/usr/bin/env node
/**
 * competition-radar 看板服务。
 *
 * 只读 state/ 目录，把「今天的摘要」变成能筛选、能搜索、能点开看细节的页面。
 * 它不采集、不改台账 —— 采集仍然由 radar.mjs / 计划任务负责，看板只是另一扇窗。
 *
 * 数据来源优先级：
 *   1. state/out/latest.json      radar.mjs 每次运行写的结构化导出（最准）
 *   2. state/snapshots/<日期>.json + state/registry.json   导出还没有时的兜底
 * 两者都缺就返回 503，页面会提示「先跑一次采集」，而不是假装没有赛事。
 *
 * 用法：
 *   node panel/server.mjs                # 默认 http://127.0.0.1:7865
 *   set PORT=7866 && node panel/server.mjs
 *   NO_OPEN=1 时不自动打开浏览器（隐藏启动用）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ymd, dayDiff, CATEGORY_LABEL, prizeMagnitude } from '../lib/util.mjs';

const PANEL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PANEL_DIR, '..');
const STATE = path.join(ROOT, 'state');
const OUT = path.join(STATE, 'out');
const SNAP = path.join(STATE, 'snapshots');
const REGISTRY = path.join(STATE, 'registry.json');
const HISTORY = path.join(STATE, 'history.jsonl');
const LOGDIR = path.join(STATE, 'log');
const CONFIG = path.join(ROOT, 'config.json');

const PORT = Number(process.env.PORT || 7865);
const HOST = '127.0.0.1';

/* ------------------------------------------------------------------ 小工具 */

function readJson(file, dflt) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function sourceLabels() {
  const cfg = readJson(CONFIG, { sources: {} });
  const map = {};
  for (const [id, s] of Object.entries(cfg.sources || {})) map[id] = s.label || id;
  map.curated = '人工维护清单';
  return map;
}

function settings() {
  const cfg = readJson(CONFIG, {});
  return {
    evergreenDays: cfg.settings?.evergreenDays ?? 365,
    ladder: cfg.settings?.reminderLadder ?? [30, 14, 7, 3, 1, 0],
    watchlist: cfg.watchlist || [],
  };
}

function readHistory() {
  const lines = readText(HISTORY).split(/\r?\n/).filter(Boolean);
  const byDate = new Map();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (isDate(row.date)) byDate.set(row.date, row); // 同一天跑了两次（手动 + 定时）只留最后一次
    } catch { /* 半行 / 手改坏了就跳过，不让一行坏数据拖垮整个看板 */ }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

function latestSnapshot() {
  let names = [];
  try {
    names = fs.readdirSync(SNAP).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return null;
  }
  if (!names.length) return null;
  names.sort();
  const file = path.join(SNAP, names[names.length - 1]);
  const data = readJson(file, null);
  if (!data) return null;
  return { file, data };
}

/* -------------------------------------------------------------- 归一化条目 */

/**
 * 把「快照里的薄条目」和「台账里的厚条目」合并成看板用的一条。
 * 快照只存了摘要需要的字段，url / 主办方 / firstSeen / 已提醒档位只在台账里有。
 */
function normalise(raw, reg, today, labels) {
  const id = raw.id || raw.key;
  const r = reg || {};
  const deadline = raw.effectiveDeadline ?? raw.deadline ?? r.effectiveDeadline ?? null;
  const submission = raw.submissionDeadline ?? raw.deadline ?? r.deadline ?? null;
  const regDeadline = raw.regDeadline ?? r.regDeadline ?? null;
  const daysLeft = deadline ? dayDiff(today, deadline) : null;

  const reminded = [];
  const bucket = r.reminded || {};
  for (const [d, arr] of Object.entries(bucket)) {
    if (Array.isArray(arr)) for (const th of arr) if (typeof th === 'number') reminded.push({ deadline: d, threshold: th });
  }
  reminded.sort((a, b) => b.threshold - a.threshold);

  const source = raw.source || r.source || '';
  return {
    id,
    name: raw.name || r.name || '(未命名)',
    url: raw.url || r.url || '',
    organizer: raw.organizer || r.organizer || '',
    source,
    sourceLabel: labels[source] || source,
    category: raw.category || r.category || 'general',
    categoryLabel: CATEGORY_LABEL[raw.category || r.category] || '综合',
    region: raw.region || r.region || '',
    prize: raw.prize || r.prize || '',
    prizeRank: prizeMagnitude(raw.prize || r.prize || ''),
    deadline,
    submissionDeadline: submission && submission !== deadline ? submission : null,
    regDeadline,
    deadlineIsReg: Boolean(raw.deadlineIsReg ?? r.deadlineIsReg),
    daysLeft,
    status: raw.status || r.status || '',
    confidence: raw.confidence || r.confidence || '',
    tags: Array.isArray(raw.tags) && raw.tags.length ? raw.tags : r.tags || [],
    firstSeen: r.firstSeen || '',
    alsoOn: Array.isArray(raw.alsoOn) ? raw.alsoOn : [],
    reminded,
    threshold: raw.threshold ?? null,
    wasDeadline: raw.wasDeadline || null,
  };
}

const byDeadline = (a, b) => {
  if (!a.deadline && !b.deadline) return 0;
  if (!a.deadline) return 1;
  if (!b.deadline) return -1;
  return a.deadline < b.deadline ? -1 : a.deadline > b.deadline ? 1 : 0;
};

/* ------------------------------------------------------------- 组装看板数据 */

function buildState() {
  const today = ymd(new Date());
  const labels = sourceLabels();
  const st = settings();
  const registry = readJson(REGISTRY, { items: {} });
  const regItems = registry.items || {};
  const history = readHistory();
  const snap = latestSnapshot();
  const exported = readJson(path.join(OUT, 'latest.json'), null);

  let date = null;
  let generatedAt = null;
  let durationMs = null;
  let dedupCount = null;
  let counts = null;
  let health = [];
  let watchlist = st.watchlist;
  let dataSource = 'none';
  let hasExport = false;
  const reminderThreshold = new Map();
  let buckets = { reminders: [], newItems: [], deadlineChanges: [], reopened: [], justClosed: [], open: [], noDeadline: [], evergreen: [] };
  let notes = [];

  if (exported && isDate(exported.date)) {
    dataSource = 'export';
    hasExport = true;
    date = exported.date;
    generatedAt = exported.generatedAt || null;
    durationMs = exported.durationMs ?? null;
    dedupCount = exported.dedupCount ?? null;
    counts = exported.counts || null;
    health = exported.health || [];
    watchlist = exported.watchlist?.length ? exported.watchlist : st.watchlist;
    for (const k of Object.keys(buckets)) {
      buckets[k] = (exported[k] || []).map((x) => normalise(x, regItems[x.id], today, labels));
    }
    // 导出里的 reminders 只是「本次新触发的阶梯档」，不是「30 天内到期的全部」。
    // 看板要的是后者，所以只把档位记下来，列表统一从 open 重算。
    for (const r of exported.reminders || []) if (r?.id) reminderThreshold.set(r.id, r.threshold ?? null);
  } else if (snap) {
    dataSource = 'snapshot';
    const d = snap.data;
    date = d.date;
    counts = d.counts || null;
    // 快照里没有生成时间，用文件写入时间兜底 —— 「数据多旧」这件事不能显示成「未知」
    try { generatedAt = fs.statSync(snap.file).mtime.toISOString().replace('T', ' ').slice(0, 19) + 'Z'; } catch { /* 保持 null */ }
    notes.push('当前是快照兜底数据（还没有结构化导出）：截止日变更 / 重新开放要等下一次采集写入 latest.json 后才有精确记录。');

    buckets.open = (d.open || []).map((x) => normalise(x, regItems[x.id], today, labels));
    buckets.noDeadline = (d.noDeadline || []).map((x) => normalise(x, regItems[x.id], today, labels));

    // 常设练习赛：台账里截止日超过 evergreenDays 的
    // 注意不能按 status 过滤 —— radar 分桶时 evergreen 优先于 closed，
    // 所以一个「平台状态 closed 但截止日挂在 2030 年」的练习赛会同时带这两张脸。
    buckets.evergreen = Object.values(regItems)
      .filter((r) => r.effectiveDeadline && dayDiff(today, r.effectiveDeadline) > st.evergreenDays)
      .map((r) => normalise(r, r, today, labels));

    // 新增 / 临近截止 / 最近截止 都在下面统一重算

    const lastHist = history.length ? history[history.length - 1] : null;
    const cfg = readJson(CONFIG, { sources: {} });
    health = (lastHist?.health || []).map((h) => ({
      id: h.id,
      label: labels[h.id] || h.id,
      ok: Boolean(h.ok),
      count: h.count ?? 0,
      ms: null,
      note: cfg.sources?.[h.id]?.note || '',
    }));
  }

  if (!date) {
    return {
      ok: false,
      error: '还没有任何采集结果：state/out/latest.json 与 state/snapshots/ 都不存在。',
      hint: '先跑一次：pwsh -NoProfile -File .\\run-daily.ps1 -NoToast',
      root: ROOT,
      running: runState.running,
    };
  }

  // 「新增」= 台账里 firstSeen 就是这次采集日期的条目。
  // 刻意不从「本次运行发现的 newItems」取：同一天重跑一次，那些条目已经进台账，
  // 本次运行就会报 0 条新增 —— 但「今天有哪些是新的」是当天的事实，不该被重跑改写。
  buckets.newItems = Object.values(regItems)
    .filter((r) => r.firstSeen === date && r.status !== 'closed')
    .map((r) => normalise(r, r, today, labels));

  // 「最近截止」= 台账里已关闭、且截止日落在最近 7 天的条目。
  // 同样按日期算，不按「本次运行」算 —— 否则同一天重跑一次这块就空了。
  // （精确的「本次确认关闭」需要上一次的 closedReported，只有导出里带。）
  buckets.justClosed = Object.values(regItems)
    .filter((r) => r.status === 'closed' && r.effectiveDeadline && dayDiff(today, r.effectiveDeadline) >= -7 && dayDiff(today, r.effectiveDeadline) <= 0)
    .map((r) => normalise(r, r, today, labels))
    .sort((a, b) => (a.deadline < b.deadline ? 1 : -1))
    .slice(0, 40);

  // 「临近截止」= 看板当天算起 N 天内到期的全部条目。
  // 注意这跟摘要里的「本次提醒」不是一回事：摘要只报**新触发**的阶梯档，
  // 看板要把所有快到的都列出来，否则重跑一次就全空了。
  buckets.reminders = buckets.open
    .filter((x) => x.daysLeft !== null && x.daysLeft >= 0 && x.daysLeft <= st.ladder[0])
    .map((x) => ({ ...x, threshold: reminderThreshold.get(x.id) ?? null }));

  // 过期但还留在在办列表里的（采集之后又过了几天）
  const expired = [];
  buckets.open = buckets.open.filter((x) => {
    if (x.daysLeft !== null && x.daysLeft < 0) {
      expired.push(x);
      return false;
    }
    return true;
  });
  buckets.reminders = buckets.reminders.filter((x) => x.daysLeft === null || x.daysLeft >= 0);

  buckets.open.sort(byDeadline);
  buckets.newItems.sort(byDeadline);
  buckets.reminders.sort(byDeadline);
  buckets.noDeadline.sort((a, b) => (a.sourceLabel < b.sourceLabel ? -1 : a.sourceLabel > b.sourceLabel ? 1 : 0));
  buckets.evergreen.sort(byDeadline);

  const healthOk = health.filter((h) => h.ok).length;

  // 截止压力分布（用看板当天算，不用采集那天 —— 不然「剩余天数」会一直是旧的）
  const bands = [
    { key: 't3', label: '3 天内', max: 3, count: 0 },
    { key: 't7', label: '4–7 天', max: 7, count: 0 },
    { key: 't14', label: '8–14 天', max: 14, count: 0 },
    { key: 't30', label: '15–30 天', max: 30, count: 0 },
    { key: 'far', label: '30 天以上', max: Infinity, count: 0 },
  ];
  for (const x of buckets.open) {
    if (x.daysLeft === null) continue;
    const b = bands.find((b) => x.daysLeft <= b.max);
    if (b) b.count++;
  }

  const byCategory = {};
  for (const x of buckets.open) byCategory[x.category] = (byCategory[x.category] || 0) + 1;

  const ageMs = generatedAt ? Date.now() - Date.parse(generatedAt.replace(' ', 'T')) : null;

  return {
    ok: true,
    root: ROOT,
    date,
    today,
    generatedAt,
    ageHours: ageMs !== null && Number.isFinite(ageMs) ? +(ageMs / 3600e3).toFixed(1) : null,
    durationMs,
    dedupCount,
    dataSource,
    hasExport,
    notes,
    counts: counts || {
      openWithDeadline: buckets.open.length,
      newItems: buckets.newItems.length,
      reminders: buckets.reminders.length,
    },
    bands,
    byCategory,
    categories: Object.entries(CATEGORY_LABEL).map(([key, label]) => ({ key, label, count: byCategory[key] || 0 })),
    ladder: st.ladder,
    evergreenDays: st.evergreenDays,
    health,
    healthOk,
    healthTotal: health.length,
    watchlist,
    history: history.slice(-30),
    expired,
    items: buckets,
    running: runState.running,
    lastRun: runState.lastRun,
  };
}

/* ------------------------------------------------------------------ 日报 */

/**
 * 日报是「总览」的另一种读法：总览回答「现在有什么」，日报回答
 * 「这一天发生了什么、先做哪几件」。它不采集、不改台账，只把已有产物重新排一遍。
 *
 * 三种数据精度必须说清楚（缺数据 ≠ 0）：
 *   export    state/out/<日期>.json       新增 / 变更 / 来源耗时都在
 *   snapshot  state/snapshots/<日期>.json 只有在办与未标截止
 *   history   state/history.jsonl         只有计数，连条目明细都没有
 *
 * 「剩余天数」一律按日报当天算（asOf = 日报日期），不按今天算 ——
 * 否则翻看三天前的日报时，所有条目都会凭空少三天。
 */
const KIND_LABEL = { export: '结构化导出', snapshot: '快照兜底', history: '只有计数' };
const ACTION_DAYS = 3; // 「今天要做」只看 3 天内，和截止压力条第一档对齐

function reportIndex() {
  const rows = new Map();
  const touch = (date) => {
    if (!rows.has(date)) rows.set(date, { date, hasExport: false, hasSnapshot: false, hasDigest: false });
    return rows.get(date);
  };
  try {
    for (const f of fs.readdirSync(OUT)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.(json|md|html)$/.exec(f);
      if (!m) continue;
      const e = touch(m[1]);
      if (m[2] === 'json') e.hasExport = true;
      if (m[2] === 'md') e.hasDigest = true;
    }
  } catch { /* 还没跑过采集 */ }
  try {
    for (const f of fs.readdirSync(SNAP)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(f);
      if (m) touch(m[1]).hasSnapshot = true;
    }
  } catch { /* 同上 */ }

  const hist = new Map(readHistory().map((r) => [r.date, r]));
  const out = [];
  for (const e of rows.values()) {
    const h = hist.get(e.date);
    const health = h?.health || [];
    out.push({
      date: e.date,
      kind: e.hasExport ? 'export' : e.hasSnapshot ? 'snapshot' : 'history',
      hasDigest: e.hasDigest,
      counts: h?.counts || null,
      healthOk: health.filter((x) => x.ok).length,
      healthTotal: health.length,
    });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : -1));
}

function daysText(d) {
  if (d === null || d === undefined) return '无截止';
  if (d < 0) return `已过期 ${-d} 天`;
  if (d === 0) return '今天截止';
  return `${d} 天后`;
}

function reportMarkdown(r) {
  const L = [];
  L.push(`# 参赛雷达日报 · ${r.date}`);
  L.push('');
  L.push(`**一句话**：${r.headline}`);
  L.push('');
  L.push(`> ${r.metaLine}`);
  for (const k of r.risks) L.push(`> ${k.level === 'bad' ? '❌' : '⚠️'} ${k.text}`);
  L.push('');

  L.push(`## 今天要做（${r.actions.length}）`);
  L.push('');
  if (r.actions.length) {
    for (const x of r.actions) {
      L.push(`- [ ] ${x.deadline}（${daysText(x.daysLeft)}）${x.name}${x.organizer ? ` — ${x.organizer}` : ''}`);
    }
  } else {
    L.push(`${ACTION_DAYS} 天内没有截止的赛事。`);
  }
  L.push('');

  L.push(`## 新出现（${r.freshKnown ? r.fresh.length : '未记录'}）`);
  L.push('');
  if (!r.freshKnown) L.push('这一天的数据没有记录新增（快照 / 历史计数），空白不代表当天没有新赛事。');
  else if (!r.fresh.length) L.push('没有发现此前没见过的赛事。');
  else for (const x of r.fresh) L.push(`- ${x.deadline || '无截止'}（${daysText(x.daysLeft)}）${x.name} — ${x.sourceLabel}`);
  L.push('');

  L.push('## 变化');
  L.push('');
  if (!r.changesKnown) {
    L.push('这一天的数据没有记录变更（快照 / 历史计数）。');
  } else {
    const { deadlineChanges, reopened, justClosed } = r.changes;
    if (!deadlineChanges.length && !reopened.length && !justClosed.length) L.push('没有改期、重新开放或刚刚截止。');
    for (const x of justClosed) L.push(`- 刚刚截止：${x.name}（${x.deadline || '—'}）`);
    for (const x of deadlineChanges) L.push(`- 改期：${x.name} ${x.wasDeadline || '—'} → ${x.deadline || '—'}`);
    for (const x of reopened) L.push(`- 重新开放：${x.name}（${x.deadline || '无截止'}）`);
  }
  L.push('');

  L.push('## 其他');
  L.push('');
  L.push(`- 在办且未标截止 ${r.noDeadlineCount} 条 —— 平台不展示截止日，不等于能报名。`);
  L.push(`- 常设 / 长期开放练习赛 ${r.evergreenCount} 条，不算真实竞赛。`);
  L.push('');
  L.push('---');
  L.push('');
  L.push('本日报只列要点；完整清单见 `state/out/' + r.date + '.md`。报名前请点开原链接核对。');
  L.push('');
  return L.join('\n');
}

function buildReport(wantDate) {
  const index = reportIndex();
  const latest = index[0]?.date || null;
  const date = isDate(wantDate) ? wantDate : latest;
  if (!date) {
    return {
      ok: false,
      error: '还没有任何日报：state/out 与 state/snapshots 都是空的。',
      hint: '先跑一次采集：pwsh -NoProfile -File .\\run-daily.ps1 -NoToast',
    };
  }

  const row = index.find((r) => r.date === date);
  if (!row) {
    return {
      ok: false,
      date,
      latest,
      error: `没有 ${date} 的记录：state/out 与 state/snapshots 里都没有这一天。`,
      hint: '从左侧日期里挑一个有记录的，或先跑一次采集。',
      index: index.slice(0, 40),
    };
  }
  const kind = row.kind;
  const labels = sourceLabels();
  const st = settings();
  const today = ymd(new Date());
  const regItems = readJson(REGISTRY, { items: {} }).items || {};
  const history = readHistory();
  const prev = [...history].reverse().find((r) => r.date < date) || null;

  const exported = kind === 'export' ? readJson(path.join(OUT, `${date}.json`), null) : null;
  const snapshot = exported ? null : readJson(path.join(SNAP, `${date}.json`), null);
  const histRow = history.find((r) => r.date === date) || null;

  const counts = exported?.counts || snapshot?.counts || histRow?.counts || null;
  const healthRaw = exported?.health || histRow?.health || [];

  // 明细：导出和快照有；只有历史计数时是「没记录」，不能当成「没有」
  const itemsOf = (arr) => (arr || []).map((x) => normalise(x, regItems[x.id || x.key], date, labels));
  const open = itemsOf(exported?.open || snapshot?.open).sort(byDeadline);
  const noDeadline = itemsOf(exported?.noDeadline || snapshot?.noDeadline);
  const evergreen = itemsOf(exported?.evergreen);
  const freshKnown = Boolean(exported);
  const fresh = freshKnown ? itemsOf(exported.newItems).sort(byDeadline) : null;
  const changesKnown = Boolean(exported);
  const changes = changesKnown
    ? {
        deadlineChanges: itemsOf(exported.deadlineChanges),
        reopened: itemsOf(exported.reopened),
        justClosed: itemsOf(exported.justClosed).sort((a, b) => (a.deadline < b.deadline ? 1 : -1)),
      }
    : null;

  const soon = open.filter((x) => x.daysLeft !== null && x.daysLeft >= 0 && x.daysLeft <= st.ladder[0]);
  const actions = open.filter((x) => x.daysLeft !== null && x.daysLeft >= 0 && x.daysLeft <= ACTION_DAYS);

  const c = counts || {
    total: null,
    openWithDeadline: open.length,
    openNoDeadline: noDeadline.length,
    evergreen: evergreen.length,
    closed: null,
    newItems: fresh ? fresh.length : null,
    reminders: soon.length,
    justClosed: changes ? changes.justClosed.length : null,
  };

  let generatedAt = exported?.generatedAt || null;
  if (!generatedAt && histRow?.at) generatedAt = String(histRow.at).replace('T', ' ').replace(/\.\d+Z$/, 'Z');
  if (!generatedAt) {
    try {
      generatedAt = fs.statSync(path.join(SNAP, `${date}.json`)).mtime.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
    } catch { /* 保持 null */ }
  }
  const ageMs = generatedAt ? Date.now() - Date.parse(generatedAt.replace(' ', 'T')) : null;
  const ageHours = ageMs !== null && Number.isFinite(ageMs) ? +(ageMs / 3600e3).toFixed(1) : null;

  const healthOk = healthRaw.filter((h) => h.ok).length;
  const failed = healthRaw.filter((h) => !h.ok).map((h) => ({ id: h.id, label: labels[h.id] || h.id, error: h.error || '' }));

  const unverified = open.filter((x) => x.confidence && !/^已核实/.test(x.confidence)).length;

  const risks = [];
  if (kind === 'snapshot') {
    risks.push({ level: 'warn', text: '这一天只有快照：新增赛事 / 截止日变更 / 重新开放没有记录，显示为空不代表当天没发生。' });
  } else if (kind === 'history') {
    risks.push({ level: 'warn', text: '这一天只有计数记录：没有条目明细，「今天要做」和「新出现」都不完整。' });
  }
  if (failed.length) {
    risks.push({ level: 'bad', text: `来源失败 ${failed.length} 个：${failed.map((f) => f.label).join('、')} —— 这一天的数据不完整。` });
  }
  if (date === latest && ageHours !== null && ageHours > 36) {
    risks.push({ level: 'warn', text: `这份数据已经 ${Math.round(ageHours)} 小时没更新，先确认计划任务是否还在跑。` });
  }
  if (unverified) {
    risks.push({ level: 'warn', text: `在办条目里有 ${unverified} 条来自第三方转述（⚠️），报名前必须去官网核对。` });
  }

  const head = [];
  head.push(freshKnown ? (fresh.length ? `发现 ${fresh.length} 个新赛事` : '没有发现新赛事') : '新增赛事没有记录');
  if (soon.length) {
    const near = actions.length ? `，其中 ${actions.length} 个在 ${ACTION_DAYS} 天内` : '';
    head.push(`${soon.length} 个截止日在 ${st.ladder[0]} 天内${near}，最近一个是「${soon[0].name}」`);
  } else {
    head.push(`${st.ladder[0]} 天内没有临近截止`);
  }
  const headline = head.join('；') + '。';

  const metaParts = [];
  if (c.total != null) metaParts.push(`本次 ${c.total} 条记录`);
  metaParts.push(`在办 ${c.openWithDeadline ?? '—'}`);
  if (c.openNoDeadline != null) metaParts.push(`未标截止 ${c.openNoDeadline}`);
  if (healthRaw.length) {
    metaParts.push(`来源 ${healthOk}/${healthRaw.length} 正常${failed.length ? `（${failed.length} 个失败）` : ''}`);
  }
  if (generatedAt) metaParts.push(`生成于 ${generatedAt}`);
  const metaLine = metaParts.join(' · ');

  const bands = [
    { key: 't3', label: '3 天内', max: 3, count: 0 },
    { key: 't7', label: '4–7 天', max: 7, count: 0 },
    { key: 't14', label: '8–14 天', max: 14, count: 0 },
    { key: 't30', label: '15–30 天', max: 30, count: 0 },
    { key: 'far', label: '30 天以上', max: Infinity, count: 0 },
  ];
  for (const x of open) {
    if (x.daysLeft === null || x.daysLeft < 0) continue;
    const b = bands.find((b) => x.daysLeft <= b.max);
    if (b) b.count++;
  }

  const catCount = {};
  for (const x of open) catCount[x.category] = (catCount[x.category] || 0) + 1;
  const byCategory = Object.entries(CATEGORY_LABEL)
    .map(([key, label]) => ({ key, label, count: catCount[key] || 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  const pc = prev?.counts || null;
  const diff = (a, b) => (a == null || b == null ? null : a - b);
  const delta = pc ? {
    open: diff(c.openWithDeadline, pc.openWithDeadline),
    total: diff(c.total, pc.total),
    closed: diff(c.closed, pc.closed),
    prevDate: prev.date,
  } : null;

  const report = {
    ok: true,
    date,
    today,
    latest,
    kind,
    kindLabel: KIND_LABEL[kind],
    generatedAt,
    ageHours,
    counts: c,
    soonCount: soon.length,
    actionDays: ACTION_DAYS,
    actions,
    fresh,
    freshKnown,
    changes,
    changesKnown,
    bands,
    byCategory,
    health: { ok: healthOk, total: healthRaw.length, failed },
    noDeadlineCount: c.openNoDeadline ?? noDeadline.length,
    evergreenCount: c.evergreen ?? evergreen.length,
    unverified,
    delta,
    risks,
    headline,
    metaLine,
    hasDigest: row.hasDigest,
    digestUrl: row.hasDigest ? `/api/raw?f=md&date=${date}` : '',
    index: index.slice(0, 40),
  };
  report.markdown = reportMarkdown(report);
  return report;
}

/* ---------------------------------------------------------------- 采集触发器 */

const runState = { running: false, startedAt: null, lastRun: null, output: [] };

function tailLog(n = 12) {
  let files = [];
  try {
    files = fs
      .readdirSync(LOGDIR)
      .filter((f) => f.startsWith('run-') && f.endsWith('.log'))
      .sort();
  } catch {
    return [];
  }
  if (!files.length) return [];
  const text = readText(path.join(LOGDIR, files[files.length - 1]));
  return text.split(/\r?\n/).filter(Boolean).slice(-n);
}

function startRun() {
  if (runState.running) return { ok: false, error: '已经在跑了' };
  const script = path.join(ROOT, 'run-daily.ps1');
  if (!fs.existsSync(script)) return { ok: false, error: `找不到 ${script}` };

  runState.running = true;
  runState.startedAt = new Date().toISOString();
  runState.output = [];

  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-NoToast', '-Quiet'];
  const child = spawn('pwsh', args, { cwd: ROOT, windowsHide: true });
  const push = (s) => {
    for (const line of String(s).split(/\r?\n/)) if (line.trim()) runState.output.push(line.trimEnd());
    if (runState.output.length > 200) runState.output.splice(0, runState.output.length - 200);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (err) => {
    runState.running = false;
    runState.lastRun = { at: new Date().toISOString(), code: -1, error: err.message };
  });
  child.on('close', (code) => {
    runState.running = false;
    runState.lastRun = { at: new Date().toISOString(), code };
  });
  return { ok: true, startedAt: runState.startedAt };
}

/* ------------------------------------------------------------------- HTTP */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const json = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    const p = url.pathname;

    if (p === '/api/state') {
      const state = buildState();
      return json(res, state.ok ? 200 : 503, state);
    }

    if (p === '/api/report') {
      const r = buildReport(url.searchParams.get('date'));
      return json(res, r.ok ? 200 : 404, r);
    }

    if (p === '/api/log') {
      return json(res, 200, { lines: runState.output.length ? runState.output.slice(-60) : tailLog(20) });
    }

    if (p === '/api/run' && req.method === 'POST') {
      const r = startRun();
      return json(res, r.ok ? 202 : 409, r);
    }

    if (p === '/api/raw' ) {
      // 给「导出 Markdown / 打开完整摘要」用；带 date 就取那一天的归档
      const what = url.searchParams.get('f');
      const day = url.searchParams.get('date');
      if (what === 'md' || what === 'html') {
        const name = isDate(day) ? `${day}.${what}` : `latest.${what}`;
        const body = readText(path.join(OUT, name));
        if (!body) return json(res, 404, { error: `没有 ${name}` });
        res.writeHead(200, {
          'content-type': what === 'md' ? 'text/plain; charset=utf-8' : 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        return res.end(body);
      }
      return json(res, 404, { error: 'unknown' });
    }

    // 静态文件（只有面板自己的 index.html / app.js，不暴露 state 目录）
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const file = path.join(PANEL_DIR, rel);
    if (file.startsWith(PANEL_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }

    if (p === '/favicon.ico') { res.writeHead(204); return res.end(); }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (err) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(String((err && err.stack) || err));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`端口 ${PORT} 已被占用（看板可能已经在运行），本次启动退出。`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}/`;
  console.log(`参赛雷达看板已启动: ${url}`);
  console.log(`数据目录: ${STATE}`);
  if (process.platform === 'win32' && !process.env.NO_OPEN) exec(`start "" "${url}"`, { windowsHide: true });
});
