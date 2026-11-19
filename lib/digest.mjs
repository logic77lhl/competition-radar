/** Render the daily digest as markdown + a self-contained HTML page. */
import { CATEGORY_LABEL } from './util.mjs';

const CAT_ORDER = ['ai4s', 'medical', 'llm-agent', 'cv', 'rl-robotics', 'security', 'general'];

function esc(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function link(item) {
  return item.url ? `[${esc(mark(item) + item.name)}](${item.url})` : esc(mark(item) + item.name);
}

/** 人工条目若没标「已核实」，在表格里挂一个 ⚠️，避免把转述当事实。 */
function mark(item) {
  const c = item.confidence || '';
  return c && !/^已核实/.test(c) ? '⚠️ ' : '';
}

function dleft(item) {
  if (item.daysLeft === null || item.daysLeft === undefined) return '—';
  if (item.daysLeft < 0) return `已过期 ${-item.daysLeft} 天`;
  if (item.daysLeft === 0) return '**今天**';
  return `${item.daysLeft} 天`;
}

function table(rows, cols) {
  const head = `| ${cols.map((c) => c.title).join(' | ')} |\n|${cols.map(() => '---').join('|')}|\n`;
  const body = rows.map((r) => `| ${cols.map((c) => c.get(r)).join(' | ')} |`).join('\n');
  return head + body;
}

/**
 * 在办赛事的列。截止日默认取「报名截止 / 提交截止里更早的那个」——
 * 错过报名就完全没机会，所以那才是真正卡人的日期。
 * 只有当表里确实存在两个日期不同的条目时，才多出一列「提交截止」。
 */
function openCols(rows) {
  const hasSplit = rows.some((r) => r.deadlineIsReg && r.deadline && r.deadline !== r.effectiveDeadline);
  const cols = [
    { title: '截止', get: (i) => esc(i.effectiveDeadline || '—') + (i.deadlineIsReg ? ' (报名)' : '') },
  ];
  if (hasSplit) {
    cols.push({ title: '提交截止', get: (i) => esc(i.deadlineIsReg ? i.deadline || '—' : '—') });
  }
  cols.push(
    { title: '剩余', get: (i) => dleft(i) },
    { title: '赛事', get: (i) => link(i) },
    { title: '方向', get: (i) => CATEGORY_LABEL[i.category] || i.category },
    { title: '奖金', get: (i) => esc(i.prize || '—') },
    { title: '主办 / 来源', get: (i) => esc(i.organizer || i.source) },
  );
  return cols;
}

export function render(view) {
  const L = [];
  const { date, health, counts } = view;

  L.push(`# 参赛机会雷达 · ${date}`);
  L.push('');
  L.push(
    `> 采集时间 ${view.generatedAt}，耗时 ${(view.durationMs / 1000).toFixed(1)}s。` +
      `本次共 ${counts.total} 条记录，其中在办且有截止日 ${counts.openWithDeadline} 条、` +
      `新增 ${counts.newItems} 条、临近截止提醒 ${counts.reminders} 条。`,
  );
  L.push('');
  L.push(
    `**一句话**：` +
      (counts.newItems > 0
        ? `发现 ${counts.newItems} 个此前没见过的赛事`
        : '没有发现新赛事') +
      (counts.reminders > 0 ? `；有 ${counts.reminders} 个截止日在 30 天内` : '；30 天内没有临近截止') +
      '。',
  );
  L.push('');

  if (view.isFirstRun) {
    L.push('> ⚠️ **这是首次运行**：已建立基线快照，因此本次不列「新增」。从明天起，「新增」只包含真正第一次出现的赛事。');
    L.push('');
  }
  if (view.dedupCount) {
    L.push(`> 已合并 ${view.dedupCount} 条跨来源重复记录（同一赛事同时出现在多个平台）。`);
    L.push('');
  }

  const shown = [...view.reminders, ...view.newItems, ...view.openWithDeadline, ...view.openNoDeadline, ...view.reopened];
  const hasUnverified = shown.some((i) => i.confidence && !/^已核实/.test(i.confidence));
  L.push(
    '> 日期一律是**北京时间**。「截止」列取「报名截止 / 提交截止」里**更早的那个** —— ' +
      '标 `(报名)` 表示真正卡人的是报名截止，错过后面的提交截止就没意义了。',
  );
  L.push('');
  if (hasUnverified) {
    L.push('> 带 **⚠️** 的条目来自第三方转述（公众号/聚合站），**尚未在官网核实**，报名前请自行确认。');
    L.push('');
  }

  // 「可捡清单」放在最前面：它回答的是「值不值得去」，比「还有多久」更前置。
  // 只收「能算出单份奖金」的条目 —— 缺名额信息的不评分（取舍见 lib/certainty.mjs）。
  // 缺名额的单独列一区：不给分，但不能让它们在摘要里彻底消失（否则会以为漏采了）。
  const prizeOnly = (view.openWithDeadline || [])
    .filter((i) => i.certainty && i.certainty.basis === 'none' && i.certainty.prizeCny > 0)
    .sort((a, b) => b.certainty.prizeCny - a.certainty.prizeCny)
    .slice(0, 20);

  if (view.picks?.length || prizeOnly.length) {
    L.push('## ★ 可捡清单（按确定性排序）');
    L.push('');
    L.push(
      '> 只看「能算出单份奖金」的在办赛事。`单份` = 一个名额能拿到的钱：' +
        '写了「前 200 名各获 ¥5000」就直接取 5000；只给总奖金的按 `总奖金 ÷ 名额数` 摊。',
    );
    L.push('> 缺名额信息的**不评分**（宁缺毋滥），它们在下面单列一区。剩余天数按紧迫度排序。');
    L.push('');
    if (view.picks?.length) {
      L.push(
        table(view.picks, [
          { title: '档', get: (i) => i.certainty?.tier || '—' },
          { title: '赛事', get: (i) => link(i) },
          { title: '单份奖金', get: (i) => (i.certainty?.perSlot ? `¥${i.certainty.perSlot.toLocaleString('zh-CN')}` : '—') },
          { title: '名额', get: (i) => (i.certainty?.slots ? String(i.certainty.slots) : '—') },
          { title: '剩余', get: (i) => dleft(i) },
          { title: '依据', get: (i) => esc(i.certainty?.note || '') },
        ]),
      );
    } else {
      L.push('_目前没有能算出单份奖金的赛事。_');
    }
    L.push('');
    if (prizeOnly.length) {
      L.push('### 有奖金，但缺名额信息（不评分）');
      L.push('');
      L.push(
        table(prizeOnly, [
          { title: '总奖金', get: (i) => `¥${i.certainty.prizeCny.toLocaleString('zh-CN')}` },
          { title: '赛事', get: (i) => link(i) },
          { title: '剩余', get: (i) => dleft(i) },
          { title: '来源', get: (i) => esc(i.source || '') },
        ]),
      );
      L.push('');
    }
  }

  if (view.reminders.length) {
    L.push('## 一、临近截止（该动手了）');
    L.push('');
    L.push(table(view.reminders, openCols(view.reminders)));
    L.push('');
  }

  if (view.newItems.length) {
    L.push(`## ${view.reminders.length ? '二' : '一'}、新增赛事（首次出现在雷达里）`);
    L.push('');
    L.push(table(view.newItems, openCols(view.newItems)));
    L.push('');
    const withEvidence = view.newItems.filter((i) => i.evidence);
    if (withEvidence.length) {
      L.push('<details><summary>新增条目的取证线索</summary>');
      L.push('');
      for (const i of withEvidence) L.push(`- **${esc(i.name)}**（${i.source}）：${esc(i.evidence)}`);
      L.push('');
      L.push('</details>');
      L.push('');
    }
  }

  const n = view.reminders.length ? 1 : 0;
  if (view.deadlineChanges.length || view.reopened.length || view.justClosed.length) {
    L.push(`## ${['一', '二', '三'][n + (view.newItems.length ? 1 : 0)] || '变更'}、变更与状态切换`);
    L.push('');
    if (view.deadlineChanges.length) {
      L.push('**截止日变更**');
      L.push('');
      L.push(table(view.deadlineChanges, [
        { title: '赛事', get: (i) => link(i) },
        { title: '原截止', get: (i) => esc(i.wasDeadline || '—') },
        { title: '现截止', get: (i) => esc(i.effectiveDeadline || '—') },
      ]));
      L.push('');
    }
    if (view.reopened.length) {
      L.push('**重新开放 / 重新出现**');
      L.push('');
      L.push(table(view.reopened, openCols(view.reopened)));
      L.push('');
    }
    if (view.justClosed.length) {
      L.push('**刚刚截止（不再可报名）**');
      L.push('');
      L.push(table(view.justClosed, [
        { title: '截止', get: (i) => esc(i.deadline || '—') },
        { title: '赛事', get: (i) => link(i) },
        { title: '来源', get: (i) => esc(i.source) },
      ]));
      L.push('');
    }
  }

  L.push('## 在办赛事总表（按截止日升序）');
  L.push('');
  const byCat = new Map();
  for (const i of view.openWithDeadline) {
    if (!byCat.has(i.category)) byCat.set(i.category, []);
    byCat.get(i.category).push(i);
  }
  for (const cat of CAT_ORDER) {
    const items = byCat.get(cat);
    if (!items?.length) continue;
    L.push(`### ${CATEGORY_LABEL[cat]}（${items.length}）`);
    L.push('');
    L.push(table(items, openCols(items)));
    L.push('');
  }

  if (view.openNoDeadline.length) {
    L.push('### 在列表页出现、但来源未提供截止日');
    L.push('');
    L.push(
      '> 这些条目来自不展示截止日的平台，**不能据此认为一定能报名**，需要点进去确认。' +
        '为避免灌水，每个来源最多列 6 条。',
    );
    L.push('');
    const bySource = new Map();
    for (const i of view.openNoDeadline) {
      if (!bySource.has(i.source)) bySource.set(i.source, []);
      bySource.get(i.source).push(i);
    }
    for (const [src, items] of [...bySource.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const shown = items.slice(0, 6);
      L.push(
        `**${esc(src)}**：共 ${items.length} 条` +
          (items.length > shown.length ? `，下表只列前 ${shown.length} 条` : ''),
      );
      L.push('');
      L.push(table(shown, [
        { title: '赛事', get: (i) => link(i) },
        { title: '方向', get: (i) => CATEGORY_LABEL[i.category] || i.category },
        { title: '线索', get: (i) => esc(i.evidence || '—') },
      ]));
      L.push('');
    }
  }

  if (view.evergreen.length) {
    L.push(`<details><summary>常设 / 长期开放的练习赛（${view.evergreen.length} 条，非真实竞赛）</summary>`);
    L.push('');
    L.push(table(view.evergreen, openCols(view.evergreen)));
    L.push('');
    L.push('</details>');
    L.push('');
  }

  L.push('## 来源健康');
  L.push('');
  L.push(table(health, [
    { title: '来源', get: (h) => esc(h.label) },
    { title: '状态', get: (h) => (h.ok ? '✅ 正常' : `❌ 失败`) },
    { title: '条数', get: (h) => String(h.count) },
    { title: '耗时', get: (h) => `${h.ms} ms` },
    { title: '说明', get: (h) => esc(h.error || h.note || '') },
  ]));
  L.push('');
  L.push('> 任何一个来源连续失败都要当成真问题处理：**不要以为「没新赛事」**，先看这张表。');
  L.push('');

  if (view.watchlist.length) {
    L.push('## 需人工查看的入口（脚本抓不到正文）');
    L.push('');
    L.push(table(view.watchlist, [
      { title: '站点', get: (w) => `[${esc(w.name)}](${w.url})` },
      { title: '为什么抓不到', get: (w) => esc(w.note) },
    ]));
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push(
    '本文件由 `competition-radar` 每日自动生成。赛事信息以来源页面为准，' +
      '**报名前请务必点开原链接核对截止日与资格**；本雷达只负责「帮你发现有新的」。',
  );
  L.push('');

  const md = L.join('\n');
  return { md, html: toHtml(view, md) };
}

function toHtml(view, md) {
  const { date, health, counts } = view;

  const catRows = (items, cols) =>
    `<table><thead><tr>${cols.map((c) => `<th>${escHtml(c.title)}</th>`).join('')}</tr></thead><tbody>` +
    items
      .map(
        (i) =>
          `<tr>${cols
            .map((c) => `<td>${c.html ? c.html(i) : escHtml(typeof c.get(i) === 'string' ? c.get(i) : '')}</td>`)
            .join('')}</tr>`,
      )
      .join('') +
    '</tbody></table>';

  const markHtml = (i) => {
    const c = i.confidence || '';
    return c && !/^已核实/.test(c) ? `<span title="${escHtml(c)}">⚠️ </span>` : '';
  };
  const nameCell = {
    title: '赛事',
    html: (i) =>
      (i.url
        ? `<a href="${escHtml(i.url)}" target="_blank" rel="noreferrer">${escHtml(i.name)}</a>`
        : escHtml(i.name)) + markHtml(i),
  };
  const catCell = { title: '方向', get: (i) => CATEGORY_LABEL[i.category] || i.category };
  const dlCell = { title: '截止', html: (i) => escHtml(i.effectiveDeadline || '—') + (i.deadlineIsReg ? ' <small>(报名)</small>' : '') };
  const subCell = { title: '提交截止', get: (i) => (i.deadlineIsReg ? i.deadline || '—' : '—') };
  const leftCell = { title: '剩余', html: (i) => (i.daysLeft === null || i.daysLeft === undefined ? '—' : i.daysLeft < 0 ? `过期 ${-i.daysLeft} 天` : i.daysLeft === 0 ? '<b>今天</b>' : `${i.daysLeft} 天`) };
  const prizeCell = { title: '奖金', get: (i) => i.prize || '—' };
  const orgCell = { title: '主办 / 来源', get: (i) => i.organizer || i.source };

  const section = (title, inner) => (inner ? `<section><h2>${escHtml(title)}</h2>${inner}</section>` : '');

  const openTable = (items) => {
    const hasSplit = items.some((i) => i.deadlineIsReg && i.deadline && i.deadline !== i.effectiveDeadline);
    return catRows(items, [dlCell, ...(hasSplit ? [subCell] : []), leftCell, nameCell, catCell, prizeCell, orgCell]);
  };

  const byCat = new Map();
  for (const i of view.openWithDeadline) {
    if (!byCat.has(i.category)) byCat.set(i.category, []);
    byCat.get(i.category).push(i);
  }
  let openHtml = '';
  for (const cat of CAT_ORDER) {
    const items = byCat.get(cat);
    if (!items?.length) continue;
    openHtml += `<h3>${escHtml(CATEGORY_LABEL[cat])}（${items.length}）</h3>${openTable(items)}`;
  }

  const healthHtml = catRows(health, [
    { title: '来源', get: (h) => h.label },
    { title: '状态', html: (h) => (h.ok ? '<span class="ok">✅ 正常</span>' : '<span class="bad">❌ 失败</span>') },
    { title: '条数', get: (h) => String(h.count) },
    { title: '耗时', get: (h) => `${h.ms} ms` },
    { title: '说明', get: (h) => h.error || h.note || '' },
  ]);

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>参赛机会雷达 · ${escHtml(date)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 1180px; margin: 0 auto; padding: 28px 20px 80px; }
  h1 { font-size: 26px; margin-bottom: 4px; }
  h2 { margin-top: 34px; border-bottom: 1px solid #8884; padding-bottom: 6px; font-size: 20px; }
  h3 { margin-top: 24px; font-size: 16px; color: #6b7280; }
  table { border-collapse: collapse; width: 100%; margin: 10px 0 20px; font-size: 14px; }
  th, td { border: 1px solid #8883; padding: 6px 9px; text-align: left; vertical-align: top; }
  th { background: #8881; font-weight: 600; }
  tr:nth-child(even) td { background: #8880; }
  .lead { background: #0af1; border-left: 3px solid #0af; padding: 10px 14px; border-radius: 4px; }
  .ok { color: #0a0; } .bad { color: #c00; font-weight: 600; }
  a { color: #0a7ea4; }
  footer { margin-top: 40px; color: #6b7280; font-size: 13px; border-top: 1px solid #8884; padding-top: 12px; }
</style></head><body>
<h1>参赛机会雷达 · ${escHtml(date)}</h1>
<p class="lead">采集时间 ${escHtml(view.generatedAt)}，耗时 ${(view.durationMs / 1000).toFixed(1)}s。共 ${counts.total} 条记录：在办且有截止日 <b>${counts.openWithDeadline}</b> 条，新增 <b>${counts.newItems}</b> 条，30 天内临近截止 <b>${counts.reminders}</b> 条。${view.dedupCount ? `已合并 ${view.dedupCount} 条跨来源重复。` : ''}</p>
${view.isFirstRun ? '<p class="lead">⚠️ <b>这是首次运行</b>：已建立基线快照，因此本次不列「新增」。从明天起，「新增」只包含真正第一次出现的赛事。</p>' : ''}
<p class="lead">日期一律是<b>北京时间</b>。「截止」列取「报名截止 / 提交截止」里<b>更早的那个</b>，标 <code>(报名)</code> 表示真正卡人的是报名截止。${[...view.reminders, ...view.newItems, ...view.openWithDeadline, ...view.openNoDeadline].some((i) => i.confidence && !/^已核实/.test(i.confidence)) ? '带 <b>⚠️</b> 的条目来自第三方转述，尚未在官网核实。' : ''}</p>
${section('临近截止', view.reminders.length ? openTable(view.reminders) : '')}
${section('新增赛事', view.newItems.length ? openTable(view.newItems) : '')}
${view.deadlineChanges.length ? section('截止日变更', catRows(view.deadlineChanges, [{ title: '赛事', html: nameCell.html }, { title: '原截止', get: (i) => i.wasDeadline || '—' }, { title: '现截止', get: (i) => i.effectiveDeadline || '—' }])) : ''}
${section('在办赛事总表', openHtml)}
${section('来源健康', healthHtml)}
<footer>本页面由 <code>competition-radar</code> 自动生成。报名前请点开原链接核对截止日与资格。</footer>
</body></html>`;
}
