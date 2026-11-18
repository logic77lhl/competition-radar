#!/usr/bin/env node
/**
 * 为什么「可捡清单」是空的 —— 把每条在办赛事**缺什么**列出来，变成一份可执行的工作清单。
 *
 * 背景：可捡清单只收「能算出单份奖金」的赛事（见 lib/certainty.mjs）。
 * 采集回来的记录大多只写了总奖金，没有名额数，所以评分是 '—'。
 * 这不是 bug，是**数据缺字段** —— 这个脚本就是告诉你缺哪一条、去哪补。
 *
 * 用法：
 *   node tools/why-no-picks.mjs                 # 读 state/out/latest.json
 *   node tools/why-no-picks.mjs --all           # 连「有分」的也列出来（看分布）
 *   node tools/why-no-picks.mjs --json          # 机器可读
 *
 * 补法（按可靠性排）：
 *   1. 在 curated.json 里手写 slots / perSlotCny —— 最准，一次写死长期有效
 *   2. 让来源适配器把「名额/奖项数」抓进 evidence —— 改 lib/sources.mjs
 *   3. 在 prize 文本里写清「前 N 名各获 ¥X」 —— 解析器能认（parsePerUnitCny）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LATEST = path.join(ROOT, 'state', 'out', 'latest.json');

const argv = process.argv.slice(2);
const ALL = argv.includes('--all');
const JSON_OUT = argv.includes('--json');

let data;
try {
  data = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
} catch {
  console.error(`读不到 ${LATEST}\n先跑一次采集：node radar.mjs`);
  process.exit(1);
}

const open = data.open || [];
const scored = open.filter((x) => x.certainty && x.certainty.basis !== 'none');
const unscored = open.filter((x) => !x.certainty || x.certainty.basis === 'none');

/** 把 note 归成「缺什么」，方便分组统计 */
function reasonOf(x) {
  const c = x.certainty || {};
  const note = c.note || '';
  if (!c.prizeCny && /无法解析|未标/.test(note)) return '奖金未标或无法解析';
  if (/缺名额/.test(note) && c.teams) return '有名额缺口径：只有队伍数，没名额数';
  if (/缺名额/.test(note)) return '缺名额数（只给了总奖金）';
  return note || '未知';
}

const groups = new Map();
for (const x of unscored) {
  const r = reasonOf(x);
  if (!groups.has(r)) groups.set(r, []);
  groups.get(r).push(x);
}

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        date: data.date,
        open: open.length,
        scored: scored.length,
        unscored: unscored.length,
        groups: [...groups].map(([reason, items]) => ({
          reason,
          count: items.length,
          items: items.map((x) => ({ id: x.id, name: x.name, prize: x.prize, source: x.source, url: x.url })),
        })),
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`# ${data.date} · 在办 ${open.length} 条：有评分 ${scored.length} 条，未评分 ${unscored.length} 条\n`);

if (scored.length) {
  console.log('## 已进入可捡清单');
  for (const x of scored) {
    const c = x.certainty;
    console.log(`  ${c.tier}  ¥${(c.perSlot ?? 0).toLocaleString('zh-CN')}/名额  ${x.name}  （${c.note}）`);
  }
  console.log('');
}

if (!unscored.length) {
  console.log('全部条目都有评分，没有要补的。');
  process.exit(0);
}

console.log('## 未评分：按「缺什么」分组');
for (const [reason, items] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n### ${reason} —— ${items.length} 条`);
  for (const x of items) {
    const prize = x.prize ? `奖金=${x.prize}` : '奖金=空';
    console.log(`  - ${x.name}`);
    console.log(`    ${prize} · 来源=${x.source} · ${x.url || '(无链接)'}`);
  }
}

console.log('\n## 怎么补');
console.log('  1. curated.json 里加 "slots": N（名额数）或 "perSlotCny": N（单份奖金，人民币）—— 最准');
console.log('  2. 改 lib/sources.mjs 的适配器，把奖项数抓进 evidence');
console.log('  3. prize 文本写成「前 200 名各获 ¥5000」这种，parsePerUnitCny 能直接认');
