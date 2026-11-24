/**
 * 采集质量门禁（纯函数，无 IO、无副作用）。
 *
 * 背景：radar.mjs 原来只在「所有启用来源都失败」时才返回非 0。
 * 于是 2/12 源、22 条记录这种「事实上等于全挂」的日子照样发布日报，
 * 违背了项目自己的原则 —— 不能把「数据没抓到」当成「今天没有新赛事」。
 *
 * 本模块把判定逻辑抽出来，方便 replay 脚本回放历史、单测钉死边界。
 * 判定分两层：
 *
 *   1) 来源健康：enabled 来源里 ok 的比例 < minOkRatio 拦截。
 *   2) 记录规模：records < minRecordsRatio × 前 7 天中位数 拦截。
 *
 * 保护规则（防止规则自己制造误杀）：
 *   - total 很小时不看比例（一个源时 1/2 = 50% 会被冤枉）；用 minTotalForRatio。
 *   - 前 7 天中位数缺失 / 为 0 时，只走比例判断，跳过规模判断。
 *   - 比例阈值是「严格小于」：0.6 恰好通过。
 *
 * 约定：health 数组里的 curated 是人工清单（不是会挂的采集源），
 * 是否计入分母由调用方通过 opts.curatedId 控制，默认计入以和看板一致。
 */

/** 默认阈值；config.settings.quality 可覆盖其中任意字段。 */
export const DEFAULT_QUALITY_CONFIG = {
  enabled: true,
  minOkRatio: 0.6,
  minRecordsRatio: 0.5,
  minTotalForRatio: 3,
  baselineDays: 7,
};

const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

/**
 * 取「当天之前」最近 N 个有记录的 total，返回中位数。
 * - 只看 date < targetDate，避免把当天自己的失败数据算进基线；
 * - 同一天重复运行只取最后一条（history.jsonl 一天可能多行）；
 * - 没有样本返回 null。
 *
 * @param {Array<{date:string, counts?:{total?:number}}>} history
 * @param {string} targetDate YYYY-MM-DD
 * @param {number} days 窗口天数
 */
export function medianPriorTotal(history, targetDate, days = 7) {
  const byDate = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    if (!row || typeof row.date !== 'string' || row.date >= targetDate) continue;
    const t = row?.counts?.total;
    if (typeof t === 'number' && Number.isFinite(t)) byDate.set(row.date, t); // 同日后者覆盖前者
  }
  const values = [...byDate.values()].sort((a, b) => a - b).slice(-Math.max(1, num(days, 7)));
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * 计算质量门禁结论。
 *
 * @param {object} stats 当天统计
 * @param {number} stats.total          当天总记录数
 * @param {Array<{id:string, ok:boolean}>} stats.health  来源健康数组
 * @param {Array} history history.jsonl 解析后的历史行
 * @param {string} stats.date           当天日期（算基线用）
 * @param {object} opts                 { config, curatedId }
 * @returns {{passed:boolean, reasons:string[], okRatio:number|null, ok:number,
 *            total:number, blockedTotal:number, baselineMedian:number|null,
 *            baselineThreshold:number|null, checks:object, config:object}}
 */
export function computeQuality(stats, history = [], opts = {}) {
  const cfg = { ...DEFAULT_QUALITY_CONFIG, ...(opts.config || {}) };
  const curatedId = opts.curatedId ?? 'curated';
  const health = Array.isArray(stats?.health) ? stats.health : [];
  const total = num(stats?.total, 0);
  const date = typeof stats?.date === 'string' ? stats.date : '';

  // curated 是人工清单（不会「挂」）。比例只按真实来源算，和看板来源健康页一致；
  // 但 ok/blockedTotal 仍按全量展示，所以下面会同时给出「比例分母 = blockedTotal - 1」。
  const counted = health.filter((h) => h && h.id !== curatedId);
  const blockedTotal = health.length;
  const ok = health.filter((h) => h && h.ok).length;
  const denominator = counted.length;
  const okCounted = counted.filter((h) => h.ok).length;
  const okRatio = denominator ? okCounted / denominator : null;

  const baselineMedian = date ? medianPriorTotal(history, date, cfg.baselineDays) : null;
  const baselineThreshold = baselineMedian === null ? null : baselineMedian * cfg.minRecordsRatio;

  const checks = {
    enabled: { active: cfg.enabled !== false },
    sources: {
      active: denominator >= num(cfg.minTotalForRatio, 3),
      ok,
      denominator,
      ratio: okRatio,
      threshold: cfg.minOkRatio,
      passed: denominator >= num(cfg.minTotalForRatio, 3)
        ? okRatio !== null && okRatio >= cfg.minOkRatio
        : true, // 分母太小，不判比例
    },
    volume: {
      active: baselineThreshold !== null,
      total,
      baselineMedian,
      threshold: baselineThreshold,
      passed: baselineThreshold === null ? true : total >= baselineThreshold,
    },
    // 旧规则：所有启用来源全失败。保留为最硬的兜底，任何配置都不能关掉。
    allFailed: {
      active: true,
      passed: !(denominator > 0 && okCounted === 0),
    },
  };

  const reasons = [];
  if (cfg.enabled === false) {
    // 门禁关闭时只保留「全失败」兜底，但仍把观测值算出来供排查。
  } else {
    if (!checks.sources.passed && denominator > 0 && okRatio !== null) {
      reasons.push(
        `来源健康度过低：${okCounted}/${denominator} = ${(okRatio * 100).toFixed(1)}% < ${(cfg.minOkRatio * 100).toFixed(0)}%`,
      );
    }
    if (!checks.volume.passed) {
      reasons.push(
        `记录数过少：${total} < 前 ${cfg.baselineDays} 天中位数 ${baselineMedian} × ${cfg.minRecordsRatio} = ${baselineThreshold}`,
      );
    }
  }
  if (!checks.allFailed.passed) {
    reasons.push('所有启用来源都失败（硬闸门）');
  }

  return {
    passed: reasons.length === 0,
    reasons,
    okRatio,
    ok,
    total,
    blockedTotal,
    baselineMedian,
    baselineThreshold,
    checks,
    config: cfg,
  };
}
