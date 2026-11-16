#!/usr/bin/env node
/**
 * 把本地看板导出成可以挂 GitHub Pages 的纯静态站点（docs/）。
 *
 * 为什么这样做：panel/server.mjs 是唯一一份「把 state/ 变成看板数据」的逻辑，
 * 复制一遍迟早会漂移。所以这里不改任何计算，只把服务拉起来、把 HTTP 响应落盘：
 *
 *   /api/state                  → docs/data/state.json
 *   /api/report?date=YYYY-MM-DD → docs/data/reports/YYYY-MM-DD.json
 *   /api/report                 → docs/data/reports/latest.json
 *   /api/raw?f=md&date=…        → docs/data/raw/YYYY-MM-DD.md
 *   panel/index.html            → docs/index.html（注入 fetch 垫片，指向静态文件）
 *
 * 历史日报只增不删：某天云端只跑出当天一份时，docs/data/reports 里旧的照旧保留，
 * 日期列表由 docs/data/index.json 累积维护（垫片会把它塞回 report.index）。
 *
 * 用法：
 *   node tools/export-static.mjs
 *   EXPORT_PORT=7999 node tools/export-static.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PANEL = path.join(ROOT, 'panel');
const STATE = path.join(ROOT, 'state');
const OUT = path.join(STATE, 'out');
const DOCS = path.join(ROOT, 'docs');
const DATA = path.join(DOCS, 'data');
const REPORTS = path.join(DATA, 'reports');
const RAW = path.join(DATA, 'raw');

const PORT = Number(process.env.EXPORT_PORT || 7999);
const BASE = `http://127.0.0.1:${PORT}`;

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
}

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

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(`${BASE}/api/state`, { cache: 'no-store' });
      if (res.status === 200 || res.status === 503) return;
    } catch { /* 还没起来，继续等 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('面板服务 30 秒内没有启动，导出中止');
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  const body = await res.json();
  return { status: res.status, body };
}

/* ------------------------------------------------------------------ 主流程 */

const child = spawn(process.execPath, [path.join(PANEL, 'server.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d; });
child.stderr.on('data', (d) => { serverLog += d; });

const stop = () => {
  try { child.kill(); } catch { /* 已经退了 */ }
};
process.on('exit', stop);

try {
  await waitForServer();

  const state = (await getJson(`${BASE}/api/state`)).body;
  if (!state.ok) {
    console.error(`导出失败：${state.error || '看板没有数据'}`);
    console.error(`先跑一次采集：pwsh -NoProfile -File .\\run-daily.ps1 -NoToast`);
    process.exit(1);
  }

  // 本地绝对路径不该出现在公开站点上
  const clean = { ...state };
  delete clean.root;
  delete clean.hint;
  writeJson(path.join(DATA, 'state.json'), clean);
  console.log(`state.json  ${state.date}  在办 ${state.items?.open?.length ?? 0}`);

  // ---- 日报：当前可算的全部日期 ----
  const latest = (await getJson(`${BASE}/api/report`)).body;
  const dates = new Set((latest.index || []).map((x) => x.date).filter(isDate));
  if (isDate(state.date)) dates.add(state.date);

  const indexEntries = [];
  let written = 0;
  for (const date of [...dates].sort()) {
    const { body: r } = await getJson(`${BASE}/api/report?date=${encodeURIComponent(date)}`);
    if (!r.ok) {
      console.warn(`  ${date}: 跳过（${r.error}）`);
      continue;
    }

    // 摘要导出：有归档才给链接，避免指向不存在的文件
    const mdFile = path.join(OUT, `${date}.md`);
    const hasMd = fs.existsSync(mdFile);
    r.digestUrl = hasMd ? `data/raw/${date}.md` : '';
    r.hasDigest = hasMd;
    delete r.hint;

    writeJson(path.join(REPORTS, `${date}.json`), r);
    if (hasMd) {
      fs.mkdirSync(RAW, { recursive: true });
      fs.writeFileSync(path.join(RAW, `${date}.md`), readText(mdFile), 'utf8');
    }
    indexEntries.push({
      date,
      kind: r.kind,
      hasDigest: hasMd,
      counts: r.counts || null,
      healthOk: r.health?.ok ?? 0,
      healthTotal: r.health?.total ?? 0,
    });
    written++;
  }

  // latest.json = 最新那天的同一份内容
  const newest = indexEntries.map((x) => x.date).sort().pop();
  if (newest) {
    writeJson(path.join(REPORTS, 'latest.json'), readJson(path.join(REPORTS, `${newest}.json`)));
  }
  console.log(`reports     ${written} 天（最新 ${newest || '无'}）`);

  // ---- 日期轨：累积，旧的别丢 ----
  const keep = 400;
  const merged = new Map();
  for (const e of readJson(path.join(DATA, 'index.json'), []) || []) {
    if (e && isDate(e.date)) merged.set(e.date, e);
  }
  for (const e of indexEntries) merged.set(e.date, { ...(merged.get(e.date) || {}), ...e });
  const index = [...merged.values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, keep);
  writeJson(path.join(DATA, 'index.json'), index);

  // latest.md 给「打开完整摘要」用
  const latestMd = readText(path.join(OUT, 'latest.md'));
  if (latestMd) {
    fs.mkdirSync(RAW, { recursive: true });
    fs.writeFileSync(path.join(RAW, 'latest.md'), latestMd, 'utf8');
  }

  // ---- 页面 ----
  const html = readText(path.join(PANEL, 'index.html'));
  if (!html) throw new Error('读不到 panel/index.html');

  const shim = `<script>
/* 静态站点垫片：把 /api/* 映射到随仓库发布的 JSON。由 tools/export-static.mjs 注入。 */
(function () {
  window.__RADAR_STATIC__ = true;
  var of = window.fetch.bind(window);
  var idxP = of('data/index.json', { cache: 'force-cache' })
    .then(function (r) { return r.ok ? r.json() : []; })
    .catch(function () { return []; });
  window.fetch = function (input, init) {
    var raw = typeof input === 'string' ? input : (input && input.url) || '';
    var url = new URL(raw, location.href);
    if (url.pathname === '/api/state') return of('data/state.json', { cache: 'no-store' });
    if (url.pathname === '/api/report') {
      var d = url.searchParams.get('date') || 'latest';
      return of('data/reports/' + encodeURIComponent(d) + '.json', { cache: 'no-store' })
        .then(function (res) {
          if (!res.ok) return res;
          return res.json().then(function (j) {
            return idxP.then(function (idx) {
              if (Array.isArray(idx) && idx.length) j.index = idx;
              return new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } });
            });
          });
        });
    }
    if (url.pathname === '/api/run') {
      return Promise.resolve(new Response(JSON.stringify({ ok: false, error: '这是静态站点，采集由云端每天自动跑' }), {
        status: 409, headers: { 'content-type': 'application/json' },
      }));
    }
    return of(input, init);
  };
})();
</script>
`;

  let out = html.replace('</head>', `${shim}</head>`);
  // 静态站点没有服务端，摘要链接直接指向文件
  out = out.replace("window.open('/api/raw?f=md', '_blank')", "window.open('data/raw/latest.md', '_blank')");
  // 「立即采集」按钮换成说明，别留一个按不出东西的按钮
  out = out.replace(
    ": `<button class=\"primary\" id=\"btnRun\">立即采集</button>`;",
    ': `<div class="runbar" style="background:transparent;border-color:transparent;color:var(--ink-3)">云端每天 09:00 自动采集</div>`;',
  );
  out = out.replace(
    'async function startRun() {',
    "async function startRun() {\n  if (window.__RADAR_STATIC__) { toast('这是 GitHub 静态站点：采集由云端每天 09:00 自动跑'); return; }",
  );
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(path.join(DOCS, 'index.html'), out, 'utf8');
  fs.writeFileSync(path.join(DOCS, '.nojekyll'), '', 'utf8');

  console.log(`index.html  已生成 → ${path.join(DOCS, 'index.html')}`);
  console.log('导出完成。');
} catch (err) {
  console.error(String((err && err.stack) || err));
  if (serverLog.trim()) console.error(serverLog.trim().slice(-2000));
  process.exitCode = 1;
} finally {
  stop();
}
