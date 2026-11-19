/**
 * Source adapters. Every adapter returns { records, note } and never throws:
 * failures are reported as { records: [], error } so the digest can show source
 * health instead of silently dropping a source.
 */
import { http, parseDate, beijingDate, decodeEntities, stripTags, categorise, prizeMagnitude, sleep } from './util.mjs';

const KAGGLE_LIST = 'https://www.kaggle.com/api/i/competitions.CompetitionService/ListCompetitions';

/** Source precedence when the same competition shows up in several places. */
export const SOURCE_PRIORITY = {
  curated: 100,
  kaggle: 90,
  datafountain: 80,
  grandchallenge: 70,
  drivendata: 60,
  mlcontests: 50,
  evalai: 45,
  aicrowd: 40,
  codalab: 30,
  devfolio: 26,
  taikai: 25,
  lablab: 24,
  aibetas: 35,
  ctftime: 20,
};

/** Drop tracking parameters so the same competition dedupes across sources. */
export function cleanUrl(u) {
  if (!u) return '';
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) {
      if (/^(ref|utm_|fbclid|gclid|source)/i.test(k)) url.searchParams.delete(k);
    }
    url.hash = '';
    let s = url.toString();
    if (s.endsWith('/') && url.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return String(u);
  }
}

function mk(o) {
  return {
    source: o.source,
    key: o.key,
    name: o.name?.trim() || '(无标题)',
    url: o.url || '',
    organizer: o.organizer || '',
    prize: o.prize || '',
    prizeRank: prizeMagnitude(o.prize),
    deadline: o.deadline || null,
    regDeadline: o.regDeadline || null,
    deadlineRaw: o.deadlineRaw || '',
    startDate: o.startDate || null,
    endDate: o.endDate || null,
    status: o.status || 'unknown',
    region: o.region || 'intl',
    tags: o.tags || [],
    category: categorise(o.name, o.organizer, (o.tags || []).join(' '), o.description),
    description: (o.description || '').slice(0, 300),
    evidence: o.evidence || '',
    // 只有「聚合站/第三方转述」的来源才需要标置信度；官方接口/官方页面读到的留空
    confidence: o.confidence || '',
  };
}

/* ------------------------------------------------------------------ Kaggle */

async function kaggle(cfg, settings) {
  const now = Date.now();
  let token = null;
  const records = [];
  let scanned = 0;
  // 一次要 500 条：762 项从 8 页降到 2 页，实测单页 1.6s（100 条时 2.2s）。
  // 万一哪天服务端不认大页，退回 100 再跑一次同一页，别让整个来源挂掉。
  let pageSize = 500;
  let fellBack = false;
  for (let page = 0; page < settings.kaggleMaxPages; page++) {
    const body = { selector: { sortBy: 'RECENTLY_CREATED' }, pageSize };
    if (token) body.pageToken = token;
    let res;
    try {
      res = await http(KAGGLE_LIST, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        accept: 'application/json',
        timeoutMs: settings.timeoutMs,
        retries: settings.retries,
        userAgent: settings.userAgent,
      });
    } catch (e) {
      if (pageSize !== 100 && !fellBack) { pageSize = 100; fellBack = true; page--; continue; }
      throw e;
    }
    if (res.status !== 200) {
      if (pageSize !== 100 && !fellBack) { pageSize = 100; fellBack = true; page--; continue; }
      throw new Error(`Kaggle list HTTP ${res.status}`);
    }
    const j = JSON.parse(res.text);
    const list = j.competitions || [];
    scanned += list.length;
    for (const c of list) {
      const dl = c.deadline ? beijingDate(c.deadline) : null;
      const ends = c.deadline ? Date.parse(c.deadline) : NaN;
      const open = !Number.isNaN(ends) && ends > now;
      // Kaggle 网页上的「报名截止」= 禁止新参赛者的时间点，比提交截止更早，
      // 也才是真正卡人的那个日期（错过就完全没机会）。
      const regRaw = c.prohibitNewEntrantsExplicitDeadline || c.teamMergerExplicitDeadline || null;
      const reg = regRaw ? beijingDate(regRaw) : null;
      const reward = c.reward || {};
      const money = reward.id && !['KNOWLEDGE', 'SWAG', 'OTHER'].includes(reward.id);
      const prizeText = money
        ? `${reward.id} ${Number(reward.quantity || 0).toLocaleString('en-US')}`
        : reward.id === 'SWAG'
          ? '实物奖品 (SWAG)'
          : '无奖金（练习赛）';
      records.push(
        mk({
          source: 'kaggle',
          key: `kaggle:${c.competitionName || c.id}`,
          name: c.title,
          url: `https://www.kaggle.com/competitions/${c.competitionName}`,
          organizer: c.organization?.name || c.hostName || 'Kaggle',
          prize: prizeText,
          deadline: dl,
          regDeadline: reg && reg !== dl ? reg : null,
          deadlineRaw: c.deadline || '',
          startDate: beijingDate(c.dateEnabled || c.dateCreated),
          status: open ? 'open' : 'closed',
          region: 'intl',
          tags: (c.categories || []).map((x) => x.name),
          description: c.briefDescription,
          evidence: `${c.totalTeams ?? '?'} 支队伍 · ${(c.categories || []).map((x) => x.name).join('/')}`,
        }),
      );
    }
    token = j.nextPageToken;
    if (!token) break;
  }
  return { records, note: `扫描 ${scanned} 项` };
}

/* -------------------------------------------------------------- ML Contests */

async function mlcontests(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const m = res.text.match(/data-competitions="([^"]+)"/s);
  if (!m) throw new Error('页面结构变化：未找到 data-competitions 内嵌数据');
  const arr = JSON.parse(decodeEntities(m[1]));
  const records = arr.map((c) =>
    mk({
      source: 'mlcontests',
      key: `mlcontests:${cleanUrl(c.url) || c.name}`,
      name: c.name,
      url: cleanUrl(c.url),
      organizer: [c.sponsor, c.platform].filter(Boolean).join(' / '),
      prize: c.prize || '',
      deadline: parseDate(c.deadline),
      deadlineRaw: c.deadline || '',
      startDate: parseDate(c.launched),
      status: 'listed',
      region: 'intl',
      tags: c.tags || [],
      description: c.notes || '',
      evidence: `收录于 ${c.added || '?'}${c.conference ? ` · ${c.conference} ${c['conference-year'] || ''}` : ''}`,
    }),
  );
  return { records, note: `${arr.length} 项（含已截止，按截止日过滤）` };
}

/* ---------------------------------------------------------- Grand Challenge */

async function grandchallenge(cfg, settings) {
  const all = [];
  let url = 'https://grand-challenge.org/api/v1/challenges/?limit=100';
  for (let i = 0; i < 5 && url; i++) {
    const res = await http(url, { accept: 'application/json', timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const j = JSON.parse(res.text);
    all.push(...(j.results || []));
    url = j.next;
  }
  const records = all.map((c) =>
    mk({
      source: 'grandchallenge',
      key: `grandchallenge:${c.slug}`,
      name: c.title || c.slug,
      url: c.url || `https://grand-challenge.org/challenges/${c.slug}/`,
      organizer: 'Grand Challenge / MICCAI 社区',
      prize: (c.incentives || []).join(', ') || '',
      deadline: parseDate(c.end_date),
      deadlineRaw: c.end_date || '',
      startDate: parseDate(c.start_date),
      status: /^OPEN/i.test(c.status || '') ? 'open' : (c.status || '').toLowerCase() === 'closed' ? 'closed' : 'unknown',
      region: 'intl',
      tags: ['medical-imaging', ...(c.incentives || [])],
      description: c.description,
      evidence: `平台状态 ${c.status}`,
    }),
  );
  return { records, note: `API 返回 ${all.length} 项` };
}

/* ----------------------------------------------------------------- AIcrowd */

async function aicrowd(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const seen = new Map();
  const re = /<a[^>]+href="(\/challenges\/[a-z0-9][^"#?]*)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
  for (const m of res.text.matchAll(re)) {
    const slug = m[1];
    if (seen.has(slug)) continue;
    const text = stripTags(m[2]);
    seen.set(slug, text);
  }
  const records = [...seen.entries()].map(([slug, text]) => {
    // The list page mixes past editions in; the slug usually carries the year.
    const yearM = slug.match(/-(20\d{2})(?:-|$)/);
    const year = yearM ? Number(yearM[1]) : null;
    const thisYear = new Date().getFullYear();
    return mk({
      source: 'aicrowd',
      key: `aicrowd:${slug}`,
      name: text && text.length > 3 ? text : slug.replace(/^\/challenges\//, '').replace(/-/g, ' '),
      url: `https://www.aicrowd.com${slug}`,
      organizer: 'AIcrowd',
      prize: '',
      deadline: null,
      status: year && year < thisYear ? 'closed' : 'listed',
      region: 'intl',
      tags: [],
      evidence: year
        ? `列表页出现；slug 年份 ${year}${year < thisYear ? '（按往届处理）' : ''}（该站不展示截止日）`
        : '列表页出现（该站不展示截止日）',
    });
  });
  return { records, note: `列表页解析 ${records.length} 条` };
}

/* --------------------------------------------------------------- CodaLab */

async function codalab(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  // Cards look like: <a href="/competitions/ID"><div class="competition-tile">
  //   ... <h3>Title</h3> <p class="organizer">Organized by X</p> <p>Blurb</p>
  const seen = new Map();
  for (const part of res.text.split('<a href="/competitions/').slice(1)) {
    const idm = part.match(/^(\d+)"/);
    if (!idm || seen.has(idm[1])) continue;
    const h3 = part.match(/<h3>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const org = part.match(/<p class="organizer">([\s\S]*?)<\/p>/);
    const desc = part.match(/<p>([\s\S]*?)<\/p>/);
    seen.set(idm[1], {
      id: idm[1],
      name: stripTags(h3[1]).slice(0, 160),
      organizer: stripTags(org?.[1] || '') || 'CodaLab',
      description: stripTags(desc?.[1] || '').slice(0, 200),
    });
  }
  const records = [...seen.values()].map((v) =>
    mk({
      source: 'codalab',
      key: `codalab:${v.id}`,
      name: v.name,
      url: `https://codalab.lisn.upsaclay.fr/competitions/${v.id}`,
      organizer: v.organizer,
      deadline: null,
      status: 'listed',
      region: 'intl',
      description: v.description,
      evidence: '列表页出现（该站不展示截止日）',
    }),
  );
  return { records, note: `列表页解析 ${records.length} 条` };
}

/* ------------------------------------------------------------- DrivenData */

async function drivendata(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const html = res.text;
  const records = [];
  const re = /<a[^>]+href="(\/competitions\/(\d+)\/[^"]*)"[^>]*>([\s\S]{0,200}?)<\/a>/gi;
  const seen = new Set();
  for (const m of html.matchAll(re)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    const before = html.slice(0, m.index);
    const headings = [...before.matchAll(/<h[123][^>]*>([\s\S]{0,120}?)<\/h[123]>/gi)].map((h) => stripTags(h[1]));
    const section = headings.length ? headings[headings.length - 1] : '';
    const closed = /past|closed|finished|archive|completed/i.test(section);
    records.push(
      mk({
        source: 'drivendata',
        key: `drivendata:${m[2]}`,
        name: stripTags(m[3]),
        url: `https://www.drivendata.org${m[1]}`,
        organizer: 'DrivenData',
        deadline: null,
        status: closed ? 'closed' : 'listed',
        region: 'intl',
        tags: ['social-good'],
        evidence: section ? `列表页分区：${section}` : '列表页出现',
      }),
    );
  }
  return { records, note: `列表页解析 ${records.length} 条` };
}

/* ------------------------------------------------------------ DataFountain */

async function datafountain(cfg, settings) {
  const records = [];
  let listErr = null;
  let listCount = 0;

  // 列表页只渲染 30 条，且被限流时会直接 500 —— 所以它失败不该拖垮整个来源。
  try {
    const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
    if (res.status !== 200) throw new Error(`列表页 HTTP ${res.status}`);
    const chunks = res.text.split(/<div class="compt-item/).slice(1);
    for (const c of chunks) {
      const idm = c.match(/href="\/competitions\/(\d+)"/);
      if (!idm) continue;
      const stateM = c.match(/class="state-join\s*([a-z-]*)"/);
      const titleM = c.match(/class="compt__title">\s*([\s\S]*?)\s*<\/a>/);
      const typeM = c.match(/class="compt__cmpt-type">\s*([\s\S]*?)\s*<\/span>/);
      const sponsorM = c.match(/compt__sponsor-name">[\s\S]*?<\/i>\s*([\s\S]*?)<\/span>\s*<span>\s*([\s\S]*?)\s*<\/span>/);
      const dateM = c.match(/class="cmp-date">[\s\S]*?<\/i>\s*([\s\S]*?)<\/span>\s*<span>([\s\S]*?)<\/span>\s*<span>\s*-\s*<\/span>\s*<span>([\s\S]*?)<\/span>/);
      const prizeM = c.match(/class="oview__content">\s*<span>\s*([\s\S]*?)\s*<\/span>/);
      const canJoin = /can-join/.test(stateM?.[1] || '');
      records.push(
        mk({
          source: 'datafountain',
          key: `datafountain:${idm[1]}`,
          name: stripTags(titleM?.[1] || `DataFountain ${idm[1]}`),
          url: `https://www.datafountain.cn/competitions/${idm[1]}`,
          organizer: stripTags(sponsorM?.[2] || ''),
          prize: stripTags(prizeM?.[1] || ''),
          deadline: parseDate(stripTags(dateM?.[3] || '')),
          deadlineRaw: stripTags(dateM?.[3] || ''),
          startDate: parseDate(stripTags(dateM?.[2] || '')),
          status: canJoin ? 'open' : 'closed',
          region: 'cn',
          tags: [stripTags(typeM?.[1] || '')].filter(Boolean),
          evidence: `列表页状态：${canJoin ? '可报名' : '不可报名'}`,
        }),
      );
    }
    listCount = records.length;
  } catch (e) {
    listErr = String(e.message || e);
  }

  // 列表页渲染不全，新赛事（ID 更大的）根本不在里面 —— 2026-10 的
  // 6G/B6G 多用户 MIMO（1176）就是这么被漏掉的。详情页是服务端渲染的，
  // 所以按 ID 递进补采：水位线以上探一个窗口，不存在的 ID 返回 HTTP 500。
  const listIds = records.map((r) => Number(String(r.key).split(':')[1])).filter((n) => Number.isFinite(n));
  const listMax = listIds.length ? Math.max(...listIds) : 0;
  const watermark = Number(settings.dfWatermark || 0);
  const base = watermark || listMax;
  const windowSize = watermark ? 8 : 20; // 首次多探一点，之后每天只探一小段
  const candidates = [];
  for (let id = base + 1; id <= base + windowSize; id++) candidates.push(id);

  const existing = new Set(listIds);
  let maxFound = base;
  let probed = 0;
  let walkErr = null;
  const walk = async (id) => {
    try {
      const r = await http(`https://www.datafountain.cn/competitions/${id}`, {
        timeoutMs: settings.timeoutMs,
        retries: 1,
        userAgent: settings.userAgent,
      });
      const titleRaw = (r.text.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
      if (r.status !== 200 || /Request failed|status code 500/i.test(titleRaw)) return null;
      const name = decodeEntities(titleRaw).replace(/\s*竞赛\s*-\s*DataFountain\s*$/, '').trim();
      if (!name || name.length < 3) return null;
      // DataFountain 的 ID 段里混着运营用的测试赛题（1171–1175 全是 ￥1 的「运营测试」），
      // 不滤掉会把「新增」灌满垃圾。
      if (/(运营测试|测试赛题|赛题\d*测试|^测试|测试\d*$|dummy|样例|demo)/i.test(name)) return null;
      const rewardRaw = (r.text.match(/reward--bonus"><span>([^<]*)<\/span>/) || [])[1] || '';
      const rewardNum = Number(String(rewardRaw).replace(/[^\d.]/g, ''));
      if (Number.isFinite(rewardNum) && rewardNum > 0 && rewardNum <= 1) return null; // ￥1 的占位奖池
      const ends = [...r.text.matchAll(/endTime:"([^"]+)"/g)].map((m) => m[1]);
      const starts = [...r.text.matchAll(/startTime:"([^"]+)"/g)].map((m) => m[1]);
      const end = ends.length ? beijingDate(ends.map((x) => Date.parse(x)).filter(Number.isFinite).sort((a, b) => b - a)[0]) : null;
      const start = starts.length ? beijingDate(starts.map((x) => Date.parse(x)).filter(Number.isFinite).sort((a, b) => a - b)[0]) : null;
      const teams = (r.text.match(/competition__teams"><b>([^<]*)<\/b>/) || [])[1] || '';
      const closed = end ? Date.parse(`${end}T23:59:59+08:00`) < Date.now() : false;
      return mk({
        source: 'datafountain',
        key: `datafountain:${id}`,
        name,
        url: `https://www.datafountain.cn/competitions/${id}`,
        organizer: '',
        prize: stripTags(rewardRaw),
        deadline: end,
        deadlineRaw: end || '',
        startDate: start,
        status: closed ? 'closed' : 'open',
        region: 'cn',
        tags: ['详情页补采'],
        evidence: `列表页没有这条，靠 ID 递进从详情页补采${teams ? ` · 队伍 ${stripTags(teams)}` : ''}`,
      });
    } catch (e) {
      walkErr = String(e.message || e);
      return null;
    }
  };

  const walkResults = [];
  for (let i = 0; i < candidates.length; i += 3) {
    const batch = candidates.slice(i, i + 3);
    const got = await Promise.all(batch.map(walk));
    probed += batch.length;
    for (const g of got) {
      if (!g) continue;
      walkResults.push(g);
      const id = Number(String(g.key).split(':')[1]);
      if (id > maxFound) maxFound = id;
      if (!existing.has(id)) records.push(g);
    }
    await sleep(350); // 别把对方打限流
  }

  const note =
    `列表页 ${listCount} 条${listErr ? `（失败：${listErr}）` : ''} + ID 递进探 ${probed} 个` +
    `（${base + 1}–${base + windowSize}）补到 ${walkResults.length} 条`;
  return { records, note, meta: { dfMaxId: maxFound }, walkError: walkErr };
}

/* ----------------------------------------------------------------- CTFtime */

async function ctftime(cfg, settings) {
  const now = Math.floor(Date.now() / 1000);
  const url = `https://ctftime.org/api/v1/events/?limit=100&start=${now}&finish=${now + 120 * 86400}`;
  const res = await http(url, { accept: 'application/json', timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const arr = JSON.parse(res.text);
  const records = arr.map((e) =>
    mk({
      source: 'ctftime',
      key: `ctftime:${e.id}`,
      name: e.title,
      url: e.ctftime_url || `https://ctftime.org/event/${e.id}/`,
      organizer: (e.organizers || []).map((o) => o.name).join(', '),
      deadline: parseDate(e.start),
      startDate: parseDate(e.start),
      endDate: parseDate(e.finish),
      status: 'open',
      region: 'intl',
      tags: ['ctf', e.format || '', e.location || ''].filter(Boolean),
      description: e.description,
      evidence: `权重 ${e.weight} · ${e.participants} 人参赛`,
    }),
  );
  return { records, note: `赛历 ${records.length} 场` };
}

/* ---------------------------------------------- 黑客松来源的 AI 相关性过滤 */

// Devfolio / TAIKAI 上什么比赛都有（Web3、电商、校园活动）。全量收进来会把
// 「在办总表」灌成噪声，所以按关键词过一道。规则可写在 config.settings.aiHint，
// 命中不了的不入库 —— 但 note 里必须报出「扫到 N 场，AI 相关 k 场」，
// 否则「被过滤掉了」和「平台今天没比赛」就混成一件事了。
const DEFAULT_AI_HINT =
  '\\b(ai|a\\.i|ml|llm|llms|gpt|genai|agent|agents|agentic|machine[\\s-]?learning|deep[\\s-]?learning|neural|nlp|computer[\\s-]?vision|vision[\\s-]?language|multimodal|diffusion|rag|retrieval|transformer|inference|fine[\\s-]?tun\\w*|embeddings?|robotic\\w*|autonomous|data[\\s-]?science|predictive|classification|segmentation|speech|asr|tts|quantum|protein|molecul\\w*|genom\\w*|benchmark)\\b';

function hintRe(settings) {
  try {
    return new RegExp(settings.aiHint || DEFAULT_AI_HINT, 'i');
  } catch {
    return new RegExp(DEFAULT_AI_HINT, 'i');
  }
}

const isAI = (re, ...parts) => re.test(parts.filter(Boolean).join(' '));

/* --------------------------------------------------------------- Devfolio */

async function devfolio(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const m = res.text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('页面结构变化：未找到 __NEXT_DATA__');
  let j;
  try { j = JSON.parse(m[1]); } catch (e) { throw new Error(`__NEXT_DATA__ 不是合法 JSON：${e.message}`); }

  // react-query 的缓存里放着 open/past/upcoming/featured 四个数组。
  // 不写死 queries[0] —— 换个 query 顺序就会全空。
  const queries = j?.props?.pageProps?.dehydratedState?.queries || [];
  const data = queries
    .map((q) => q?.state?.data)
    .find((d) => d && (Array.isArray(d.open_hackathons) || Array.isArray(d.past_hackathons)));
  if (!data) throw new Error('页面结构变化：未找到 dehydratedState 里的 hackathon 列表');

  const now = Date.now();
  const pastCut = now - 60 * 86400000; // 往届只留最近 60 天，别把台账灌满
  const re = hintRe(settings);
  const buckets = [
    ['open_hackathons', 'open'],
    ['upcoming_hackathons', 'open'],
    ['featured_hackathons', 'open'],
    ['past_hackathons', 'closed'],
  ];
  const seen = new Set();
  const records = [];
  let scanned = 0;
  let filtered = 0;

  for (const [field, bucketStatus] of buckets) {
    const list = Array.isArray(data[field]) ? data[field] : [];
    for (const h of list) {
      if (!h?.slug || seen.has(h.slug)) continue;
      seen.add(h.slug);
      scanned++;
      const endIso = h.ends_at || null;
      const endsMs = endIso ? Date.parse(endIso) : NaN;
      if (bucketStatus === 'closed' && !(Number.isFinite(endsMs) && endsMs >= pastCut)) continue;
      // 主题在 h.themes[].theme.name 里（不是 h.tags）。Devfolio 上 8 成场次是
      // "No Restrictions" 的通用黑客松，只靠名称关键词会漏掉带 AI 主题的，
      // 只靠主题又会漏掉名字里写着 AI 的 —— 两边都看。
      const themes = (h.themes || []).map((t) => t?.theme?.name).filter(Boolean);
      const themeAI = themes.some((t) => /^(ai|artificial intelligence|machine learning|data science|ml|generative ai|llm|nlp|computer vision|deep learning)$/i.test(String(t).trim()));
      if (!themeAI && !isAI(re, h.name, h.tagline, themes.join(' '), h.description)) { filtered++; continue; }
      const end = endIso ? beijingDate(endIso) : null;
      const start = h.starts_at ? beijingDate(h.starts_at) : null;
      const expired = Number.isFinite(endsMs) && endsMs < now;
      records.push(
        mk({
          source: 'devfolio',
          key: `devfolio:${h.slug}`,
          name: h.name,
          url: `https://${h.slug}.devfolio.co/`,
          organizer: h.devfolio_official ? 'Devfolio' : (h.team?.name || ''),
          prize: '',
          deadline: end,
          deadlineRaw: endIso || '',
          startDate: start,
          status: bucketStatus === 'closed' || expired ? 'closed' : 'open',
          region: 'intl',
          tags: ['hackathon', h.is_online ? 'online' : 'onsite', ...themes],
          description: h.tagline || '',
          evidence: `${h.participants_count ?? '?'} 人报名 · ${h.is_online ? '线上' : '线下'} · 时区 ${h.timezone || '?'}${themes.length ? ` · 主题 ${themes.join('/')}` : ''}`,
        }),
      );
    }
  }
  return { records, note: `扫到 ${scanned} 场，AI 相关 ${records.length} 场（关键词过滤掉 ${filtered} 场）` };
}

/* ----------------------------------------------------------------- TAIKAI */

async function taikai(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const m = res.text.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) throw new Error('页面结构变化：未找到 __NEXT_DATA__');
  let j;
  try { j = JSON.parse(m[1]); } catch (e) { throw new Error(`__NEXT_DATA__ 不是合法 JSON：${e.message}`); }

  // Apollo 规范化缓存：ROOT_QUERY.challenges(...) 只存 __ref，
  // 真数据在 apolloState["Challenge:xxx"] 里，组织/币种/行业也各自是一条 ref。
  const ap = j?.props?.apolloState;
  if (!ap) throw new Error('页面结构变化：未找到 apolloState');
  // 查询键里带着整段 where 条件，会随页面变体变；所以先按前缀找，找不到就
  // 直接拿缓存里所有 Challenge 对象（规范化缓存里一定有）。
  const rootKey = Object.keys(ap).find((k) => /^ROOT_QUERY\.challenges\(/.test(k) && Array.isArray(ap[k]));
  let refs = rootKey ? (ap[rootKey] || []).map((r) => r?.__ref).filter(Boolean) : [];
  if (!refs.length) refs = Object.keys(ap).filter((k) => k.startsWith('Challenge:'));
  if (!refs.length) throw new Error('页面结构变化：apolloState 里没有 Challenge 对象');
  const ref = (x) => (x?.__ref ? ap[x.__ref] : null);

  const re = hintRe(settings);
  const records = [];
  let filtered = 0;
  for (const r of refs) {
    const c = ap[r];
    if (!c?.slug) continue;
    const org = ref(c.organization);
    const cur = ref(c.prizeCurrency);
    const industries = (c.industries || []).map((x) => ref(x)?.title).filter(Boolean);
    if (!isAI(re, c.name, c.shortDescription, industries.join(' '))) { filtered++; continue; }
    const prizeNum = Number(c.prize);
    const prize = Number.isFinite(prizeNum) && prizeNum > 0 ? `${prizeNum.toLocaleString('en-US')} ${cur?.name || ''}`.trim() : '';
    records.push(
      mk({
        source: 'taikai',
        key: `taikai:${c.slug}`,
        name: c.name,
        url: `https://taikai.network/en/hackathons/${c.slug}`,
        organizer: org?.name || '',
        prize,
        deadline: null, // 列表页不返回任何日期，只有 isClosed
        status: c.isClosed ? 'closed' : 'listed',
        region: 'intl',
        tags: ['hackathon', ...industries],
        description: c.shortDescription || '',
        evidence: `${c.isClosed ? '已关闭' : '进行中'} · ${c.participantsCount ?? '?'} 人参与${industries.length ? ` · ${industries.join('/')}` : ''}（列表不展示截止日）`,
      }),
    );
  }
  return { records, note: `列表 ${refs.length} 场，AI 相关 ${records.length} 场（过滤掉 ${filtered} 场）` };
}

/* ---------------------------------------------------------------- lablab.ai */

/** Next.js App Router 把页面数据塞在 self.__next_f.push([1,"..."]) 的 flight 流里。 */
function flightText(html) {
  let out = '';
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g)) {
    try { out += JSON.parse(m[1]); } catch { /* 单块坏了就跳过 */ }
  }
  return out;
}

async function lablab(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

  // 列表页只给 slug（标题和日期都在详情页的 JSON-LD 里）。
  const slugs = [...new Set(
    [...res.text.matchAll(/href="\/ai-hackathons\/([a-z0-9][a-z0-9-]*)"/gi)].map((m) => m[1]),
  )].filter((s) => s !== 'year' && s.length > 3);
  if (!slugs.length) throw new Error('页面结构变化：列表页没找到 /ai-hackathons/<slug> 链接');

  const now = Date.now();
  const cap = 20; // 每次最多抓 20 个详情页，别把对方打疼
  const targets = slugs.slice(0, cap);
  const records = [];
  let detailFails = 0;

  const one = async (slug) => {
    const url = `https://lablab.ai/ai-hackathons/${slug}`;
    try {
      const r = await http(url, { timeoutMs: settings.timeoutMs, retries: 1, userAgent: settings.userAgent });
      if (r.status !== 200) { detailFails++; return null; }
      const flight = flightText(r.text);
      const m = flight.match(/"@type":"Event","name":"((?:[^"\\]|\\.)*)"[\s\S]{0,800}?"startDate":"([^"]+)","endDate":"([^"]+)"/);
      let name = '';
      let start = null;
      let end = null;
      if (m) {
        try { name = JSON.parse(`"${m[1]}"`); } catch { name = m[1]; }
        start = beijingDate(m[2]);
        end = beijingDate(m[3]);
      } else {
        // 退一步：JSON-LD 没了，至少用 h1 拿标题
        const h1 = r.text.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
        name = h1 ? stripTags(h1[1]) : slug.replace(/-/g, ' ');
      }
      const expired = end ? Date.parse(`${end}T23:59:59+08:00`) < now : false;
      return mk({
        source: 'lablab',
        key: `lablab:${slug}`,
        name: name || slug,
        url,
        organizer: 'lablab.ai',
        prize: '',
        deadline: end,
        deadlineRaw: m ? m[3] : '',
        startDate: start,
        status: expired ? 'closed' : 'open',
        region: 'intl',
        tags: ['hackathon', 'ai'],
        description: '',
        evidence: m ? `详情页 JSON-LD：${start || '?'} → ${end || '?'}` : '详情页没解析到 JSON-LD，标题取自 h1',
      });
    } catch {
      detailFails++;
      return null;
    }
  };

  // 详情页单页 0.6–2.7 秒，串着抓 12 个就是 8 秒 —— 一次全发出去，一轮就够。
  for (let i = 0; i < targets.length; i += 12) {
    const batch = targets.slice(i, i + 12);
    const got = await Promise.all(batch.map(one));
    for (const g of got) if (g) records.push(g);
  }

  return {
    records,
    note: `列表 ${slugs.length} 个，抓了 ${targets.length} 个详情页，成功 ${records.length} 个${detailFails ? `，失败 ${detailFails}` : ''}`,
  };
}

/* ----------------------------------------------------------------- EvalAI */

async function evalai(cfg, settings) {
  // 前端是 Angular，数据来自这三个接口：present / future / past。
  // 只要在办和即将开始的 —— past 会把往届全灌进来。
  const kinds = ['present', 'future'];
  const records = [];
  let scanned = 0;
  let placeholders = 0;
  const notes = [];

  for (const kind of kinds) {
    let url = `https://eval.ai/api/challenges/challenge/${kind}/approved/public`;
    let got = 0;
    for (let page = 0; page < 4 && url; page++) {
      const res = await http(url, { accept: 'application/json', timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
      if (res.status !== 200) throw new Error(`${kind} 接口 HTTP ${res.status}`);
      const j = JSON.parse(res.text);
      const list = j.results || [];
      scanned += list.length;
      got += list.length;
      for (const c of list) {
        const end = c.end_date ? beijingDate(c.end_date) : null;
        const start = c.start_date ? beijingDate(c.start_date) : null;
        // 有些老 challenge 的 end_date 是占位值（2042 / 2099 这种），
        // 留着会把「常设练习赛」灌一堆假的。超过 3 年的一律当占位跳过。
        if (end && Date.parse(`${end}T23:59:59+08:00`) > Date.now() + 3 * 365 * 86400000) { placeholders++; continue; }
        const expired = end ? Date.parse(`${end}T23:59:59+08:00`) < Date.now() : false;
        const team = c.creator?.team_name || '';
        records.push(
          mk({
            source: 'evalai',
            key: `evalai:${c.id}`,
            name: c.title,
            url: `https://eval.ai/web/challenges/challenge-page/${c.id}/overview`,
            organizer: team,
            prize: c.has_prize ? '有奖金（详见页面）' : '',
            deadline: end,
            deadlineRaw: c.end_date || '',
            startDate: start,
            status: expired ? 'closed' : 'open',
            region: 'intl',
            tags: [c.domain_name, ...(Array.isArray(c.list_tags) ? c.list_tags : [])].filter(Boolean),
            description: c.short_description || '',
            evidence: `报名${c.is_registration_open ? '开放' : '已关闭'}${team ? ` · 主办 ${team}` : ''}`,
          }),
        );
      }
      url = j.next || null;
    }
    notes.push(`${kind} ${got}`);
  }
  return { records, note: `${notes.join(' / ')}（共 ${scanned} 项${placeholders ? `，跳过 ${placeholders} 个 2099 占位日的常设 benchmark` : ''}）` };
}

/* --------------------------------------------------------------- AIBetas */

/**
 * 国内 AIGC / 应用创作赛的聚合站（地方政府、文旅、创业公司主办）。
 *
 * 为什么值得单独做一个源：雷达原本最大的盲区就是这一类 —— 天池/讯飞/百度都抓不到，
 * 而「小而密、名额多」的国内赛事恰恰是确定性最高的一批。
 * AIBetas 的竞赛日历是**服务端渲染**的，列表结构稳定
 * （article.competition-calendar-agenda-item），不需要逆向 XHR。
 *
 * 注意：它是聚合站转述，字段以官网为准 —— 所以 confidence 标「未核实（聚合站转述）」，
 * 摘要里会挂 ⚠️，和 curated.json 里第三方转述的条目一个待遇。
 */
function prizeFromTitle(name) {
  // 数字可能在关键词前面：「6.8万元现金奖池」「1000万元奖金池」
  let m = name.match(/([¥￥]?\s*[\d.]+\s*万\s*元?)\s*(?:现金奖池|奖金池|总奖金|奖金)/);
  if (m) return m[0].trim();
  // 也可能在后面：「总奖金5万元」「最高奖200万元」
  m = name.match(/(?:总奖金|奖金池|现金奖池|最高奖金?|最高)\s*[:：]?\s*([¥￥]?\s*[\d.]+\s*万?\s*元?)/);
  if (m) return m[0].trim();
  m = name.match(/[¥￥]?\s*[\d.]+\s*万\s*元/);
  return m ? m[0].trim() : '';
}

async function aibetas(cfg, settings) {
  const res = await http(cfg.home, { timeoutMs: settings.timeoutMs, retries: settings.retries, userAgent: settings.userAgent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const html = res.text;
  const records = [];
  const itemRe = /<article class="competition-calendar-agenda-item[^"]*">([\s\S]*?)<\/article>/gi;

  for (const m of html.matchAll(itemRe)) {
    const block = m[1];
    const dateM = block.match(/competition-calendar-agenda-date[\s\S]*?<strong>\s*(\d{1,2})\/(\d{1,2})\s*<\/strong>/i);
    const titleM = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    const typeM = block.match(/competition-calendar-agenda-type[^>]*>([\s\S]*?)<\/span>/i);
    const linkM = block.match(/competition-calendar-agenda-link[\s\S]*?href="([^"]+)"/i) || block.match(/href="(https?:[^"]+)"/i);
    if (!titleM || !dateM) continue;

    const rawTitle = stripTags(titleM[1]);
    // 标题形如「2026山东文旅AIGC视频创作大赛｜总奖金5万元，11月20日截止」
    // 赛事名取 ｜ 前那段，后半段进 evidence（那里往往写着奖金和截止口径）
    const [head, ...tail] = rawTitle.split(/[｜|]/);
    const name = (head || rawTitle).trim();
    if (!name) continue;

    const mm = Number(dateM[1]);
    const dd = Number(dateM[2]);
    if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) continue;
    const now = new Date();
    const withYear = (y) => `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    let deadline = withYear(now.getFullYear());
    // 日历里不写年份；已经过去一个月以上的，按明年算
    if (Date.parse(deadline) < Date.now() - 30 * 86400000) deadline = withYear(now.getFullYear() + 1);

    const url = linkM ? linkM[1] : '';
    records.push(
      mk({
        source: 'aibetas',
        key: `aibetas:${url || name}`,
        name,
        url,
        organizer: '',
        prize: prizeFromTitle(rawTitle),
        deadline,
        status: 'open',
        region: 'cn',
        tags: ['aigc', stripTags(typeM ? typeM[1] : '')].filter(Boolean),
        evidence: `AIBetas 竞赛日历：${rawTitle}${tail.length ? `（${tail.join('｜').trim()}）` : ''}；聚合站转述，字段以官网为准`,
        confidence: '未核实（聚合站转述）',
      }),
    );
  }

  return { records, note: `竞赛日历解析 ${records.length} 条（聚合站转述，字段以官网为准）` };
}

export const ADAPTERS = {
  kaggle,
  mlcontests,
  grandchallenge,
  datafountain,
  aicrowd,
  codalab,
  drivendata,
  evalai,
  devfolio,
  taikai,
  lablab,
  aibetas,
  ctftime,
};

export async function runSource(id, cfg, settings) {
  const fn = ADAPTERS[id];
  if (!fn) return { id, ok: false, error: `未知来源适配器: ${id}`, records: [], ms: 0 };
  const t0 = Date.now();
  try {
    const { records, note, meta, walkError } = await fn(cfg, settings);
    return { id, ok: true, note, records, meta, walkError, ms: Date.now() - t0 };
  } catch (e) {
    return { id, ok: false, error: String(e.message || e), records: [], ms: Date.now() - t0 };
  }
}
