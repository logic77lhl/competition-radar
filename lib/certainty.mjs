/**
 * 确定性评分（certainty）—— 回答「这场比赛值不值得花时间去捡」
 *
 * 为什么需要这一层：现有的唯一排序轴是「截止日」，它只回答「还有多久」，
 * 不回答「值不值」。讯飞那种「十几场 ¥10,000、每场几十队」和
 * 「一场 $400,000、3 个奖、5000 队」在截止日视图里长得一模一样，
 * 但「拿到钱的概率」差一个量级。
 *
 * 核心口径（只有一种，绝不混用）：
 *
 *   perSlot = 单个名额能拿到的钱
 *
 *   三种推导，优先级从高到低：
 *   1. basis='unit'    文本写了「前 200 名各获 ¥5000」→ perSlot 直接就是 ¥5000，最准
 *   2. basis='slot'    有名额、有总奖金          → perSlot = 总奖金 / 名额数
 *   3. basis='none'    缺名额（或什么都没有）      → 不评分，只回填能确定的字段
 *
 * 为什么不用「总奖金 ÷ 队伍数」当主指标：那个数假设奖金平均分给所有队伍，
 * 对「前 3 名拿走全部、其余 4997 队为 0」的比赛会高估两个数量级。
 * 队伍数只在有名额时用来打折（名额占比极低 → 降一档），不单独当分母。
 *
 * 宁缺毋滥：名额不明就返回 tier='—'，而不是按奖金规模猜一个名额数。
 * 猜出来的名额会让「本周可捡」变成噪声，也让「名额信息值钱」这件事失去动力。
 */

/* 汇率只用于把不同币种放到同一把尺子上比较；数量级够用即可，不做精确换算 */
const FX = { CNY: 1, USD: 7.2, EUR: 7.8, GBP: 9.1, JPY: 0.048 };

const TIER_ORDER = ['S', 'A', 'B', 'C', '—'];

/** 数字片段 → 数值。支持 10,000 / 1.5万 / 2M / 50k */
function numOf(s) {
  if (!s) return null;
  // 币种符号可能被一起捕获进来（"各获 ¥5,000"），先剔掉再 parseFloat
  let t = String(s).replace(/[¥￥$€£\s,，]/g, '');
  let mult = 1;
  if (/万$/.test(t)) {
    mult = 1e4;
    t = t.slice(0, -1);
  } else if (/[kK]$/.test(t)) {
    mult = 1e3;
    t = t.slice(0, -1);
  } else if (/[mM]$/.test(t)) {
    mult = 1e6;
    t = t.slice(0, -1);
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? n * mult : null;
}

function currencyOf(sym, fallbackText) {
  const s = String(sym || '').toUpperCase();
  if (/\$|USD|美元/.test(s)) return 'USD';
  if (/€|EUR|欧元/.test(s)) return 'EUR';
  if (/£|GBP/.test(s)) return 'GBP';
  if (/¥|￥|CNY|RMB|元|人民币/.test(s)) return 'CNY';
  // 没有币种标记：中文语境按人民币，纯英文按美元
  return /[\u4e00-\u9fff]/.test(String(fallbackText || '')) ? 'CNY' : 'USD';
}

/**
 * 解析「单个名额的金额」——「前 200 名各获价值 5000 元」里的那个 5000。
 * 命中说明文本明确说了「各 / 每」+ 金额，这是最可靠的形态。
 */
export function parsePerUnitCny(raw) {
  const text = String(raw || '');
  if (!text.trim()) return null;
  // 「各获价值 5000 元」里 各→获→价值 是三个连续的词，所以动词位要允许重复（*），
  // 早期写成 ? 只吃一个词，结果整句匹配不上，退化成「把 5000 当成总奖金」。
  const m = text.match(/(?:各|每\s*(?:人|名|位|队|个)|分别)\s*(?:获|得|奖励?|赠|价值|为|是|有)*\s*([¥￥$€£]?\s*[0-9][0-9,，.]*\s*[万kKmM]?)\s*(元|人民币|美元|欧元|CNY|RMB|USD|EUR|GBP)?/);
  if (!m) return null;
  const amount = numOf(m[1]);
  if (amount === null || amount <= 0) return null;
  const currency = currencyOf(`${m[1]} ${m[2] || ''}`, text);
  return { cny: Math.round(amount * (FX[currency] ?? 1)), amount, currency };
}

/**
 * 解析总奖金，折成人民币。
 * 注意排除「200 名」里的 200：后面紧跟 名/位/个/支/队 的数字不算金额。
 */
export function parsePrizeCny(raw) {
  const text = String(raw || '');
  const out = { cny: null, amount: null, currency: null, raw: text };
  if (!text.trim()) return out;

  // 先去掉「前 200 名」这类名额片段，避免把名额数当奖金
  const cleaned = text.replace(/([0-9]{1,4})\s*(?:名|位|个|支|队)/g, ' ');

  const re = /([¥￥$€£]|CNY|RMB|USD|EUR|GBP|元|人民币|美元|欧元)?\s*([0-9][0-9,，.]*\s*[万kKmM]?)\s*(元|人民币|美元|欧元|CNY|RMB|USD|EUR|GBP)?/g;
  let best = null;
  for (const m of cleaned.matchAll(re)) {
    const amount = numOf(m[2]);
    if (amount === null || amount <= 0) continue;
    // 有币种标记的优先，其次取数值最大的
    const marked = Boolean((m[1] || '').trim() || (m[3] || '').trim());
    const cand = { amount, marked, sym: `${m[1] || ''}${m[3] || ''}` };
    if (!best || (cand.marked && !best.marked) || (cand.marked === best.marked && cand.amount > best.amount)) best = cand;
  }
  if (!best) return out;

  const currency = currencyOf(best.sym, text);
  out.amount = best.amount;
  out.currency = currency;
  out.cny = Math.round(best.amount * (FX[currency] ?? 1));
  return out;
}

/**
 * 解析「能拿钱的名额数」。
 * 只认明确写出来的：前 200 名 / top 3 / 3 个奖项 / 16 awards / 名额 20。
 */
export function parseSlots(raw) {
  const text = String(raw || '');
  const pats = [
    /前\s*([0-9]{1,4})\s*(?:名|位|个)/,
    /top\s*([0-9]{1,4})/i,
    /([0-9]{1,4})\s*(?:个|项)\s*(?:奖项|奖金|名额|获奖)/,
    /([0-9]{1,4})\s*(?:awards?|winners?|prizes?)/i,
    /名额\s*([0-9]{1,4})/,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0 && n <= 5000) return n;
    }
  }
  return null;
}

/** 解析参赛队数。只认「120 支队伍 / 5471 teams」这种明确写法。 */
export function parseTeams(raw) {
  const text = String(raw || '');
  const m = text.match(/([0-9][0-9,]*)\s*(?:支\s*)?(?:队伍|团队|参赛队|teams?|participants?)/i);
  if (!m) return null;
  const n = Number.parseInt(m[1].replace(/[,，]/g, ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** 单份奖金 → 档位。阈值按「一份奖金够不够覆盖一两周投入」定的，不是按总额。 */
function tierOf(perSlot) {
  if (perSlot >= 5000) return 'S';
  if (perSlot >= 2000) return 'A';
  if (perSlot >= 500) return 'B';
  return 'C';
}

const demote = (tier) => {
  const i = TIER_ORDER.indexOf(tier);
  return i >= 0 && i < 3 ? TIER_ORDER[i + 1] : tier;
};

/**
 * 计算一条赛事的确定性。
 * @param {object} rec { prize, name?, evidence?, description?, daysLeft? }
 */
export function computeCertainty(rec = {}) {
  const haystack = [rec.prize, rec.name, rec.evidence, rec.description].filter(Boolean).join(' · ');
  // 结构化字段优先：curated.json 里手写的 slots / perSlotCny / teams 比从散文里解析可靠得多。
  const slots = rec.slots ?? parseSlots(haystack);
  const teams = rec.teams ?? parseTeams(haystack);
  const perUnitCny = rec.perSlotCny ?? (parsePerUnitCny(rec.prize) || parsePerUnitCny(haystack))?.cny ?? null;
  const total = parsePrizeCny(rec.prize);

  const daysLeft = rec.daysLeft ?? null;
  const urgent = daysLeft !== null && daysLeft >= 0 && daysLeft <= 7;

  const base = { tier: '—', basis: 'none', prizeCny: total.cny, perSlot: null, slots, teams, urgent, ratio: null, note: '' };

  // 1) 「各获 ¥5000」（或 curated 里手写的 perSlotCny）——最准，不需要名额也能算单份
  if (perUnitCny) {
    const perSlot = perUnitCny;
    let tier = tierOf(perSlot);
    let note = `单份奖金 ¥${perSlot.toLocaleString('zh-CN')}${slots ? ` × ${slots} 个名额` : ''}`;
    let ratio = null;
    if (slots && teams) {
      ratio = slots / teams;
      if (ratio < 0.02) {
        tier = demote(tier);
        note += `；名额仅占 ${(ratio * 100).toFixed(1)}% 队伍`;
      }
    }
    return { ...base, tier, basis: 'unit', perSlot, prizeCny: slots ? perSlot * slots : total.cny, ratio, note };
  }

  // 2) 有名额 + 有总奖金
  if (slots && total.cny) {
    const perSlot = Math.round(total.cny / slots);
    let tier = tierOf(perSlot);
    let note = `¥${total.cny.toLocaleString('zh-CN')} ÷ ${slots} 个名额 = ¥${perSlot.toLocaleString('zh-CN')}/名额`;
    let ratio = null;
    if (teams) {
      ratio = slots / teams;
      if (ratio < 0.02) {
        tier = demote(tier);
        note += `；名额仅占 ${(ratio * 100).toFixed(1)}% 队伍`;
      }
    }
    return { ...base, tier, basis: 'slot', perSlot, ratio, note };
  }

  // 3) 缺名额 —— 不评分，但把能确定的都带出去（看板仍可显示金额）
  let note = '缺名额信息，不评分';
  if (total.cny && teams) {
    note = `缺名额信息；总奖金 ÷ ${teams} 队 ≈ ¥${Math.round(total.cny / teams).toLocaleString('zh-CN')}/队（仅供参考，不代表能拿到的钱）`;
  } else if (total.cny) {
    note = `有总奖金 ¥${total.cny.toLocaleString('zh-CN')}，但缺名额与队伍数`;
  } else {
    note = '奖金未标或无法解析';
  }
  return { ...base, note };
}

/** 排序：先档位，再单份奖金（越大越好），最后按剩余天数（越少越急） */
export function compareCertainty(a, b) {
  const ca = a.certainty || {};
  const cb = b.certainty || {};
  const ta = TIER_ORDER.indexOf(ca.tier || '—');
  const tb = TIER_ORDER.indexOf(cb.tier || '—');
  if (ta !== tb) return ta - tb;
  const va = ca.perSlot ?? -1;
  const vb = cb.perSlot ?? -1;
  if (va !== vb) return vb - va;
  return (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999);
}

export { TIER_ORDER };
