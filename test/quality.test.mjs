/** 质量门禁单测：零依赖，node --test。每个边界 3–5 个断言。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeQuality, medianPriorTotal, DEFAULT_QUALITY_CONFIG } from '../lib/quality.mjs';

const h = (entries) => entries.map(([id, ok]) => ({ id, ok }));

function run(health, total, history = [], cfg = {}) {
  return computeQuality({ date: '2026-11-20', total, health }, history, {
    config: { ...DEFAULT_QUALITY_CONFIG, ...cfg },
  });
}

test('默认配置：阈值是 0.6 / 0.5 / 分母 3 / 窗口 7', () => {
  assert.equal(DEFAULT_QUALITY_CONFIG.minOkRatio, 0.6);
  assert.equal(DEFAULT_QUALITY_CONFIG.minRecordsRatio, 0.5);
  assert.equal(DEFAULT_QUALITY_CONFIG.minTotalForRatio, 3);
  assert.equal(DEFAULT_QUALITY_CONFIG.baselineDays, 7);
});

test('来源健康：0.6 是「严格小于」才拦，等于通过', () => {
  // 6/10 = 0.6，恰好通过；0.5 会拦。curated 不计入比例。
  const pass = run(h([...Array.from({ length: 6 }, () => ['s', true]), ...Array.from({ length: 4 }, () => ['s', false]), ['curated', true]]), 1000);
  assert.equal(pass.passed, true);
  assert.equal(pass.checks.sources.ratio, 0.6);

  const fail = run(h([...Array.from({ length: 5 }, () => ['s', true]), ...Array.from({ length: 5 }, () => ['s', false]), ['curated', true]]), 1000);
  assert.equal(fail.passed, false);
  assert.match(fail.reasons.join(''), /来源健康度过低/);
});

test('来源健康：分母 < 3 时不按比例判（1/2 不冤枉）', () => {
  const q = run(h([['a', true], ['b', false]]), 1000);
  assert.equal(q.checks.sources.active, false);
  assert.equal(q.checks.sources.passed, true);
  assert.equal(q.passed, true);
});

test('硬闸门：所有启用来源全失败，任何配置都拦', () => {
  const off = run(h([['a', false], ['b', false], ['c', false], ['curated', true]]), 1000, [], { enabled: false });
  assert.equal(off.passed, false);
  assert.match(off.reasons.join(''), /所有启用来源都失败/);
});

test('规模保护：中位数缺失时只走比例，且正常日通过', () => {
  const q = run([...h(Array.from({ length: 10 }, () => ['s', true]))], 5, []);
  assert.equal(q.baselineMedian, null);
  assert.equal(q.checks.volume.active, false);
  assert.equal(q.passed, true);
});

test('规模保护：记录数 < 前 7 天中位数 × 0.5 拦截', () => {
  const history = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-11-${String(10 + i).padStart(2, '0')}`,
    counts: { total: 1800 },
  }));
  const fail = run([...h(Array.from({ length: 10 }, () => ['s', true]))], 22, history);
  assert.equal(fail.baselineMedian, 1800);
  assert.equal(fail.baselineThreshold, 900);
  assert.equal(fail.passed, false);
  assert.match(fail.reasons.join(''), /记录数过少/);

  const pass = run([...h(Array.from({ length: 10 }, () => ['s', true]))], 901, history);
  assert.equal(pass.passed, true);
});

test('medianPriorTotal：只看当天之前，同日多行取最后', () => {
  const rows = [
    { date: '2026-11-19', counts: { total: 100 } },
    { date: '2026-11-19', counts: { total: 200 } }, // 同日覆盖
    { date: '2026-11-18', counts: { total: 300 } },
    { date: '2026-11-20', counts: { total: 999 } }, // 当天，排除
  ];
  assert.equal(medianPriorTotal(rows, '2026-11-20', 7), 250); // (200+300)/2
});

test('回放校准：history.jsonl 里 2/12 源、22 条的三天会被拦', () => {
  // 用最小构造复刻 11-14 的情形：1 个真源 ok + curated，基线 1821。
  const history = Array.from({ length: 7 }, () => ({ date: '2026-11-13', counts: { total: 1821 } }))
    .map((r, i) => ({ ...r, date: `2026-11-${String(7 + i).padStart(2, '0')}` }));
  const q = run(h([['kaggle', true], ['x', false], ...Array.from({ length: 10 }, () => ['s', false]), ['curated', true]]), 22, history);
  assert.equal(q.ok, 2);
  assert.equal(q.blockedTotal, 13);
  assert.equal(q.checks.sources.denominator, 12);
  assert.equal(q.passed, false);
  assert.equal(q.reasons.length, 2); // 比例 + 规模同时拦
});
