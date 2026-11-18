#!/usr/bin/env node
/**
 * 把一篇公众号 / 聚合站文章变成 curated.json 的**草稿**条目。
 *
 * 为什么需要：赛事信息大量流在公众号里（「【11月比赛合集】40 场」「玻尔周赛第四期」这类），
 * 而雷达抓不到这些平台。人工从文章里抄进 curated.json 又慢又容易抄错日期。
 *
 * 这个工具只做「脏活」：抓正文 → 切块 → 抠日期/奖金/链接 → 逐个去官网核一次 → 出草稿。
 * **不做判断**：哪些该收、哪些是广告、日期指的是报名还是提交，仍然由人确认。
 *
 * 用法：
 *   node tools/ingest-article.mjs <url|本地html路径>
 *   node tools/ingest-article.mjs <url> --no-verify      # 不逐个抓官网（快，但全是「未核实」）
 *   node tools/ingest-article.mjs <url> --out my.json    # 指定草稿文件名
 *   node tools/ingest-article.mjs --accept               # 把 curated.draft.json 合并进 curated.json
 *   node tools/ingest-article.mjs --accept --accept-unverified   # 连「未核实」的一起合并
 *
 * 三步流程对应 README 第九节：
 *   1. 抓正文（浏览器 UA + referer 能绕过验证页）
 *   2. 抽文本 + 外链
 *   3. 逐条去官网核实 → 决定进 curated.json 还是只留档
 *
 * 产物：
 *   notes/<日期>-<标题前20字>.txt   正文留档（可复查、可 diff）
 *   curated.draft.json              待人工 accept 的条目
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDate, ymd } from '../lib/util.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTES = path.join(ROOT, 'notes');
const CURATED = path.join(ROOT, 'curated.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ args */

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const TARGET = argv.find((a) => !a.startsWith('--') && a !== opt('out'));
const NO_VERIFY = flag('no-verify');
const ACCEPT = flag('accept');
const ACCEPT_UNVERIFIED = flag('accept-unverified');
const DRAFT = path.join(ROOT, opt('out', 'curated.draft.json'));

const log = (...a) => console.log(...a);

/* ------------------------------------------------------------------ 1. 抓正文 */

function decodeEntities(s) {
  return String(s)
    .replace(/\\x0a/gi, '\n') // 微信把 og:description 里的换行转义成字面量 \x0a
    .replace(/\\n/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

/** 从 HTML 里切出正文（微信的 js_content，其他站点退化为 body） */
function bodyOf(html) {
  let body = html;
  const start = html.indexOf('id="js_content"');
  if (start >= 0) {
    body = html.slice(start);
    for (const m of ['id="js_article_bottom_bar"', 'id="js_tags_preview"', 'id="js_pc_qr_code"', 'rich_media_area_extra']) {
      const i = body.indexOf(m);
      if (i > 0) body = body.slice(0, i);
    }
  } else {
    const b = html.indexOf('<body');
    if (b >= 0) body = html.slice(b);
  }
  return body;
}

function textOf(body) {
  return decodeEntities(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<img[^>]*>/gi, '\n')
      .replace(/<\/(p|section|div|li|h[1-6]|tr|br)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

function linksOf(body) {
  const out = [];
  body.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, txt) => {
    const t = decodeEntities(txt.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
    if (/^https?:/i.test(href) && !/mp\.weixin\.qq\.com/.test(href)) out.push({ url: href, text: t });
    return '';
  });
  return out;
}

async function loadArticle(target) {
  if (fs.existsSync(target)) {
    const html = fs.readFileSync(target, 'utf8');
    return { html, finalUrl: `file://${target}`, fromFile: true };
  }
  const res = await fetch(target, {
    headers: {
      'user-agent': UA,
      referer: 'https://mp.weixin.qq.com/',
      'accept-language': 'zh-CN,zh;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  const html = await res.text();
  if (/wappoc_appmsgcaptcha|环境异常/.test(html) && html.length < 20000) {
    throw new Error('拿到的是微信验证页。用浏览器打开文章 → 另存为 HTML → 把文件路径传给本工具');
  }
  return { html, finalUrl: res.url, fromFile: false };
}

/* ------------------------------------------------------- 2. 从正文里抠条目 */

const DATE_RE = /20\d{2}\s*[-./年]\s*\d{1,2}\s*[-./月]\s*\d{1,2}\s*日?/;
// 公众号里大量日期不写年份（「11月18日21:00—11月25日21:00」），单独认一遍
const DATE_NOYEAR_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const PRIZE_RE = /([¥￥]\s?[\d,]{3,}(?:\.\d+)?\s*[万kK]?|[\d,]+\s*(?:万)?\s*(?:元|美元|USD|usd)|[¥￥]\s?\d+\s*万|\$\s?[\d,]{3,})/;
const NOISE = /^(报名|截止|时间|地点|奖金|主办|承办|协办|参赛|扫码|关注|点击|阅读|原文|往期|推荐|广告|文末|⬇|👇)/;

/** 一行像不像赛事名：有内容、不太长、不是日期/奖金/噪声明 */
function looksLikeTitle(line) {
  if (!line) return false;
  const t = line.replace(/^[#\d.、）)\s①②③④⑤⑥⑦⑧⑨⑩\-—*•·]+/, '').trim();
  if (t.length < 4 || t.length > 80) return false;
  if (DATE_RE.test(t)) return false;
  // 「11月18日21:00—11月25日21:00（北京时间）」这种整行是日期区间的，不能当赛事名
  if (DATE_NOYEAR_RE.test(t)) return false;
  if (/^[¥￥$]/.test(t)) return false;
  if (NOISE.test(t)) return false;
  if (/^\[图\]$/.test(t)) return false;
  return /[\u4e00-\u9fff]/.test(t) || /[A-Za-z]{3,}/.test(t);
}

function prizeIn(text) {
  const m = text.match(PRIZE_RE);
  return m ? m[1].replace(/\s+/g, '') : '';
}

/** 从一行里取日期；支持「2026年11月25日」和「11月25日」（无年份时按最近一次推断）。
 *  一行里出现区间（「11月18日21:00—11月25日21:00」）时取**最后一个** —— 那才是截止日。 */
function dateFromLine(line) {
  const hits = [];
  for (const m of line.matchAll(new RegExp(DATE_RE.source, 'g'))) {
    const d = parseDate(m[0].replace(/\s/g, ''));
    if (d) hits.push({ at: m.index, date: d });
  }
  if (!hits.length) {
    for (const m of line.matchAll(new RegExp(DATE_NOYEAR_RE.source, 'g'))) {
      const now = new Date();
      const mm = Number(m[1]);
      const dd = Number(m[2]);
      if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) continue;
      const mk = (y) => `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      let d = mk(now.getFullYear());
      // 已经过去 90 天以上的，当成明年的（12 月的文章里写「1 月 5 日」是明年）
      if (Date.parse(d) < Date.now() - 90 * 86400000) d = mk(now.getFullYear() + 1);
      hits.push({ at: m.index, date: d });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => a.at - b.at);
  return hits[hits.length - 1].date;
}

/**
 * 以「日期」为锚点切块：每个日期往前找最近的标题行，往后取 2 行作上下文。
 * 这样比按空行切块稳 —— 公众号排版里一个赛事常常跨好几个 <section>，空行靠不住。
 */
function extractEntries(text, links) {
  const lines = text.split('\n');
  const seen = new Set();
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const deadline = dateFromLine(lines[i]);
    if (!deadline) continue;

    // 往前找标题（最多回看 5 行）
    let name = '';
    for (let k = i; k >= Math.max(0, i - 5); k--) {
      if (looksLikeTitle(lines[k])) {
        name = lines[k].replace(/^[#\d.、）)\s①②③④⑤⑥⑦⑧⑨⑩\-—*•·]+/, '').trim();
        break;
      }
    }
    if (!name) continue;

    const ctx = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 3)).join(' · ');

    // 链接：优先取上下文里出现的，退化为全文里文本与 name 相关的
    const linkInCtx = ctx.match(/https?:\/\/[^\s"'）)]+/);
    const linkNearName = links.find((l) => l.text && (l.text.includes(name.slice(0, 6)) || name.includes(l.text.slice(0, 6))));
    const url = (linkInCtx && linkInCtx[0]) || linkNearName?.url || '';

    const key = `${name}@@${deadline}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ name, deadline, prize: prizeIn(ctx), url, raw: ctx.slice(0, 300) });
  }
  return out;
}

/* ------------------------------------------------------------- 3. 官网核实 */

function metaOf(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
  return decodeEntities((html.match(re) || html.match(re2) || [])[1] || '');
}

async function verify(entry) {
  if (!entry.url) {
    return { ...entry, confidence: '未核实（文章里没有官网链接）', verifyNote: '无链接可核' };
  }
  try {
    const res = await fetch(entry.url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const html = await res.text();
    const title = metaOf(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const desc = metaOf(html, 'og:description') || metaOf(html, 'description');
    const dates = [...new Set((html.match(/20\d{2}[-./年]\s?\d{1,2}[-./月]\s?\d{1,2}/g) || []).map((s) => s.replace(/\s/g, '')))].slice(0, 6);
    const prize = prizeIn(html.slice(0, 20000));

    // 页面标题和文章里的名字至少有一个共同片段，才算「同一场比赛」
    const overlap =
      (title && (title.includes(entry.name.slice(0, 6)) || entry.name.includes(title.slice(0, 6)))) ||
      (desc && desc.includes(entry.name.slice(0, 6)));

    const note = [
      `HTTP ${res.status}`,
      `title=${title.slice(0, 60) || '(空)'}`,
      dates.length ? `页面日期=${dates.join('/')}` : '页面无日期',
      prize ? `页面奖金=${prize}` : '页面无奖金',
    ].join('；');

    if (overlap && html.length > 5000) {
      return { ...entry, pageTitle: title, confidence: '部分核实（官网页面可读，截止日/奖金以文章为准）', verifyNote: note };
    }
    return { ...entry, pageTitle: title, confidence: '未核实（官网页面读不到正文，疑似前端渲染）', verifyNote: note };
  } catch (e) {
    return { ...entry, confidence: '未核实（官网抓取失败）', verifyNote: String(e.message).slice(0, 120) };
  }
}

/* ------------------------------------------------------------ 4. 出草稿 */

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

function toCurated(e, articleUrl) {
  return {
    id: `curated:${slug(e.name)}`,
    name: e.name,
    organizer: '',
    domain: '',
    prize: e.prize || '',
    deadline: e.deadline,
    status: 'open',
    url: e.url || articleUrl,
    region: /[\u4e00-\u9fff]/.test(e.name) ? 'cn' : 'intl',
    tags: [],
    evidence: `${e.raw}${e.verifyNote ? `｜核实：${e.verifyNote}` : ''}`,
    verifiedAt: ymd(new Date()),
    confidence: e.confidence,
    sourceUrl: articleUrl,
  };
}

async function main() {
  /* --accept 模式：只做合并 */
  if (ACCEPT) {
    if (!fs.existsSync(DRAFT)) {
      console.error(`没有草稿：${DRAFT}\n先跑一次：node tools/ingest-article.mjs <url>`);
      process.exit(1);
    }
    const draft = JSON.parse(fs.readFileSync(DRAFT, 'utf8'));
    const curated = JSON.parse(fs.readFileSync(CURATED, 'utf8'));
    // 名字比对要去掉空格/标点：手写的「玻尔 AI 产品周赛 · 第四期」和文章里的
    // 「玻尔AI产品周赛第四期」是同一场比赛，精确比对会重复收录。
    const normName = (s) => String(s || '').toLowerCase().replace(/[\s·・,，。.!！?？|｜:：()（）\[\]【】\-—_/\\]+/g, '');
    const ids = new Set(curated.map((c) => c.id));
    const names = new Set(curated.map((c) => normName(c.name)));

    let added = 0;
    let skipped = 0;
    for (const e of draft.entries || []) {
      if (!e.id || ids.has(e.id) || names.has(normName(e.name))) {
        skipped++;
        continue;
      }
      if (!ACCEPT_UNVERIFIED && !/^部分核实/.test(e.confidence || '')) {
        skipped++;
        continue;
      }
      curated.push(e);
      ids.add(e.id);
      names.add(normName(e.name));
      added++;
      log(`  + ${e.name}  (${e.deadline}, ${e.confidence})`);
    }
    fs.writeFileSync(CURATED, JSON.stringify(curated, null, 2) + '\n', 'utf8');
    log(`\n合并完成：新增 ${added} 条，跳过 ${skipped} 条（已存在 / 未核实）。curated.json 现在 ${curated.length} 条。`);
    if (added) log('下一步：node radar.mjs   # 让新条目进台账与提醒阶梯');
    return;
  }

  if (!TARGET) {
    console.error('用法：node tools/ingest-article.mjs <url|本地html路径> [--no-verify] [--out 文件]');
    process.exit(1);
  }

  log(`① 抓正文：${TARGET}`);
  const { html, finalUrl } = await loadArticle(TARGET);
  const body = bodyOf(html);
  let text = textOf(body);
  const links = linksOf(body);
  const title = metaOf(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/) || [])[1] || 'untitled';

  // 微信现在对任何 UA 都返回 JS 壳（2026-11-18 实测：body 里没有 js_content，
  // 4 种 UA 包括 MicroMessenger / Baiduspider 全一样）。唯一稳定可读的是 og:description，
  // 它通常带日期、奖金，甚至参赛链接 —— 拿它兜底，并在产物里如实标注来源。
  let contentSource = 'body';
  if (text.length < 300) {
    const desc = metaOf(html, 'og:description');
    if (desc.length > 30) {
      text = decodeEntities(desc);
      contentSource = 'og:description';
      for (const m of text.matchAll(/https?:\/\/[^\s"'）)]+/g)) links.push({ url: m[0], text: '' });
    }
  }

  fs.mkdirSync(NOTES, { recursive: true });
  const noteFile = path.join(NOTES, `${ymd(new Date())}-${slug(title).slice(0, 20)}.txt`);
  fs.writeFileSync(
    noteFile,
    `# ${title}\n# ${finalUrl}\n# 抓取于 ${new Date().toISOString()}\n# 正文来源：${contentSource}\n\n${text}\n\n## 外链\n${links.map((l) => `${l.text}  ->  ${l.url}`).join('\n')}\n`,
    'utf8',
  );
  log(`   正文 ${text.length} 字（来源 ${contentSource}），外链 ${links.length} 条 → 留档 ${path.relative(ROOT, noteFile)}`);

  log('② 抠条目（以日期为锚点，往前找标题）');
  let entries = extractEntries(text, links);

  // 兜底 A：正文只有 og:description（微信 JS 壳）时，那几行是「宣传语 + 奖金 + 日期」，
  // 没有「赛事名 + 日期」的结构 —— 硬抠会把奖金那行当成赛事名。这种情况直接用文章标题当名字。
  if (contentSource === 'og:description') {
    const deadline = dateFromLine(text);
    if (deadline) {
      entries = [
        {
          name: title.replace(/\s*[｜|].*$/, '').replace(/[！!？?]+$/, '').trim(),
          deadline,
          prize: prizeIn(text),
          url: links[0]?.url || '',
          raw: text.slice(0, 300),
        },
      ];
      log('   正文来自 og:description → 按「单赛事文章」抠 1 条（名字取文章标题）');
    }
  }

  // 兜底 B：正文完整但没抠出条目时，整篇只讲一场比赛的，同样用标题兜一下
  if (!entries.length) {
    const deadline = dateFromLine(text);
    if (deadline) {
      entries = [
        {
          name: title.replace(/\s*[｜|].*$/, '').replace(/[！!？?]+$/, '').trim(),
          deadline,
          prize: prizeIn(text),
          url: links[0]?.url || '',
          raw: text.slice(0, 300),
        },
      ];
      log('   正文没有条目结构 → 按「单赛事文章」抠出 1 条（名字取文章标题）');
    }
  }
  log(`   候选 ${entries.length} 条`);
  if (!entries.length) {
    log('   没抠出条目。可能是：文章里没有可识别的日期，或日期写成了「下周三」这种相对说法。');
    log('   → 打开留档文件人工看一遍，必要时直接手写 curated.json。');
  }

  if (!NO_VERIFY && entries.length) {
    log('③ 逐个去官网核实（每条最多 20s）');
    const verified = [];
    for (const e of entries) {
      const v = await verify(e);
      verified.push(v);
      const mark = /^部分核实/.test(v.confidence) ? '✓' : '·';
      log(`   ${mark} ${v.name.slice(0, 34).padEnd(34)} ${v.deadline}  ${v.confidence}`);
    }
    entries = verified;
  } else if (entries.length) {
    entries = entries.map((e) => ({ ...e, confidence: '未核实（本次跳过了官网核实）' }));
  }

  const draft = {
    generatedAt: new Date().toISOString(),
    article: { title, url: finalUrl, noteFile: path.relative(ROOT, noteFile) },
    entries: entries.map((e) => toCurated(e, finalUrl)),
  };
  fs.writeFileSync(DRAFT, JSON.stringify(draft, null, 2) + '\n', 'utf8');
  log(`\n草稿：${path.relative(ROOT, DRAFT)}（${draft.entries.length} 条）`);
  log('下一步：人工过一遍这个文件，删掉广告/重复/不是赛事的，然后');
  log('  node tools/ingest-article.mjs --accept                 # 只合并「部分核实」的');
  log('  node tools/ingest-article.mjs --accept --accept-unverified   # 连未核实的一起合并');
}

main().catch((e) => {
  console.error(`失败：${e.message}`);
  process.exit(1);
});
