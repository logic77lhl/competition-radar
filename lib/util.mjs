/** Shared helpers: HTTP with retry, date parsing, HTML entity decoding, categorisation. */

export const TODAY = () => new Date();

export function ymd(d = new Date()) {
  // Local-time YYYY-MM-DD (the digest is a wall-clock document, not a UTC one).
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function dayDiff(fromYmd, toYmd) {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${toYmd}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse the date shapes this radar actually meets into YYYY-MM-DD.
 * Accepts: ISO strings, "15 Oct 2026", "2026.04.07", "2026/4/7", "2026-04-07",
 * and Chinese "2026年4月7日". Returns null rather than guessing.
 */
export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : ymd(value);
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;

  m = s.match(/^(\d{4})[.\/](\d{1,2})[.\/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }

  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  }

  m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;

  return null;
}

/**
 * UTC 时间戳 → 北京时间（Asia/Shanghai）的 YYYY-MM-DD。
 * Kaggle 等平台在网页上按**用户本地时区**显示截止日，而 API 给的是 UTC：
 * 例如 deadline "2026-10-22T23:59:00Z" 在北京时间其实是 10-23 07:59。
 * 直接截取 UTC 日期会早报一天，所以凡是有精确时间戳的地方都走这里。
 */
export function beijingDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

export function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** HTTP GET/POST with retry. Returns { status, headers, body } or throws. */
export async function http(url, opts = {}) {
  const {
    method = 'GET',
    body,
    headers = {},
    timeoutMs = 25000,
    retries = 2,
    userAgent,
    accept = 'text/html,application/json;q=0.9,*/*;q=0.8',
  } = opts;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': userAgent,
          accept,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
      });
      const buf = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: res.headers, buf, text: buf.toString('utf8') };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`${method} ${url} failed after ${retries + 1} attempts: ${lastErr?.message || lastErr}`);
}

/**
 * Keyword tables. A trailing `*` marks a stem (matches any suffix);
 * everything else matches on word boundaries only — otherwise "gene" would
 * fire on "general", which is exactly the bug this replaced.
 */
const AI4S_WORDS = [
  'ai4s', 'ai for science', 'science', 'scientif*', 'research',
  'biology', 'biological', 'biolog*', 'bio*', 'protein*', 'molecul*', 'chemistry', 'chemical*',
  'spectr*', 'genom*', 'physics', 'physical', 'quantum', 'astronom*', 'astro*', 'space',
  'galaxy', 'solar', 'cosmic', 'climate', 'weather', 'meteorolog*', 'ocean*', 'earth',
  'geolog*', 'seismic*', 'ecolog*', 'biodivers*', 'material*', 'crystal*', 'catalys*',
  'energy', 'fusion', 'particle', 'cell*', 'gene', 'drug*', 'battery', 'agricultur*',
  'crop*', 'forest*', 'wildfire*', 'satellite*', 'remote sensing', 'embryo*', 'neuroscien*',
];
const MEDICAL_WORDS = [
  'medical', 'medicine', 'health', 'clinical', 'radiology', 'rsna', 'patholog*', 'cancer',
  'tumor', 'diagnos*', 'eeg', 'ecg', 'mri', 'histopath*', 'dental', 'retina*', 'ophthalm*',
  'patient*', 'hospital', 'biomedical', 'anatomy', 'ultrasound', 'x-ray', 'xray', 'surgery',
  'dermatolog*', 'lesion*', 'stroke', 'radiotherapy',
];
const LLM_WORDS = [
  'llm', 'large language', 'language model', 'agent', 'agentic', 'nlp', 'natural language',
  'text', 'prompt*', 'rag', 'retrieval', 'chat*', 'conversation*', 'translation', 'summar*',
  'question answering', 'reasoning', 'generative', 'genai', 'multimodal', 'speech', 'voice',
  'asr', 'tts', 'vision-language', 'vlm',
];
const CV_WORDS = [
  'image', 'vision', 'visual', 'segmentation', 'detection', 'classification', 'video',
  'object', 'face', 'ocr', 'pose', 'depth', 'lidar', 'point cloud',
];
const RL_WORDS = [
  'reinforcement', 'game', 'simulation', 'robot*', 'embodied', 'control', 'drone',
  'autonomous', 'planning', 'optimization', 'scheduling', 'traffic', 'logistics',
];
const SEC_WORDS = ['security', 'ctf', 'vulnerab*', 'malware', 'attack', 'privacy', 'adversarial'];

function buildMatcher(words) {
  const parts = words.map((w) => {
    const stem = w.endsWith('*');
    const core = stem ? w.slice(0, -1) : w;
    const esc = core.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return stem ? `\\b${esc}\\w*` : `\\b${esc}\\b`;
  });
  return new RegExp(`(?:${parts.join('|')})`, 'i');
}

const MATCHERS = {
  ai4s: buildMatcher(AI4S_WORDS),
  medical: buildMatcher(MEDICAL_WORDS),
  security: buildMatcher(SEC_WORDS),
  'llm-agent': buildMatcher(LLM_WORDS),
  cv: buildMatcher(CV_WORDS),
  'rl-robotics': buildMatcher(RL_WORDS),
};

/**
 * Bucket a competition. Priority order matters: a protein-design challenge is
 * AI4S even though it is also biology and may mention "cell"/"image".
 */
export function categorise(...parts) {
  const hay = parts.filter(Boolean).join(' ').toLowerCase();
  for (const key of ['ai4s', 'medical', 'security', 'llm-agent', 'cv', 'rl-robotics']) {
    if (MATCHERS[key].test(hay)) return key;
  }
  return 'general';
}

export const CATEGORY_LABEL = {
  ai4s: '科学智能 AI4S',
  medical: '医疗健康',
  'llm-agent': '大模型 / Agent',
  cv: '计算机视觉',
  'rl-robotics': '强化学习 / 机器人',
  security: '安全',
  general: '综合',
};

/** Prize shape -> comparable magnitude in CNY-ish units, for sorting only. */
export function prizeMagnitude(prize) {
  if (!prize) return 0;
  const s = String(prize);
  const usd = /USD|\$/i.test(s);
  const nums = s.replace(/,/g, '').match(/\d+(?:\.\d+)?/g);
  if (!nums) return 0;
  const n = Math.max(...nums.map(Number));
  if (usd) return n * 7;
  if (/万/.test(s)) return n * 10000;
  if (/亿/.test(s)) return n * 1e8;
  return n;
}
