// 核实公众号文章里那些雷达抓不到的赛事（天池 / Zindi / DataFountain / AIcrowd）
// 只信官方页面能读到的字段，读不到就如实标"未核实"。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const targets = [
  ['tianchi', 'AI+跨境黑客松', 'https://tianchi.aliyun.com/competition/entrance/532509'],
  ['tianchi', '欧莱雅 赛题1 数据共情者', 'https://tianchi.aliyun.com/competition/entrance/532503'],
  ['tianchi', '欧莱雅 赛题2 信任守护师', 'https://tianchi.aliyun.com/competition/entrance/532496'],
  ['tianchi', '欧莱雅 赛题3 无界体验家', 'https://tianchi.aliyun.com/competition/entrance/532497'],
  ['tianchi', '余震预测技术国际大赛', 'https://tianchi.aliyun.com/competition/entrance/532460'],
  ['tianchi', '跨本体具身认知极限联合挑战赛', 'https://tianchi.aliyun.com/competition/entrance/532508'],
  ['tianchi', '蚂蚁灵波具身大模型挑战赛', 'https://tianchi.aliyun.com/competition/entrance/532514'],
  ['tianchi', 'OpenLET 具身智能挑战赛', 'https://tianchi.aliyun.com/competition/entrance/532515'],
  ['tianchi', '知乎知学堂大模型挑战赛', 'https://tianchi.aliyun.com/competition/entrance/532510'],
  ['tianchi', 'CCL25-Eval 任务2 汉语框架语义解析', 'https://tianchi.aliyun.com/competition/entrance/532338'],
  ['datafountain', '6G/B6G 内生AI MIMO', 'https://www.datafountain.cn/competitions/1176'],
  ['zindi', 'Climate Risk and Health', 'https://zindi.africa/competitions/climate-risk-health-prediction-challenge'],
  ['zindi', 'Sasol Customer Value', 'https://zindi.africa/competitions/sasol-customer-value-recruitment-challenge'],
  ['zindi', 'IndabaX Eswatini VAT', 'https://zindi.africa/competitions/eswatini-indabax-hack'],
  ['zindi', 'Bias Bounty Mapping Equity', 'https://zindi.africa/competitions/bias-bounty-mapping-equity-challenge'],
  ['zindi', 'Google WAXAL ASR Study Jam', 'https://zindi.africa/competitions/google-waxal-asr-challenge-october-study-jam'],
  ['aicrowd', 'ARC White-Box Estimation 2026', 'https://www.aicrowd.com/challenges/arc-white-box-estimation-challenge-2026'],
];

function meta(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${prop}["']`, 'i');
  return (html.match(re) || html.match(re2) || [])[1] || '';
}

for (const [src, name, url] of targets) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const html = await res.text();
    const title = meta(html, 'og:title') || (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const desc = meta(html, 'og:description') || meta(html, 'description');
    // 找页面里出现的日期串（中文日期 / 2026-10-20 这类）
    const dates = [...new Set((html.match(/20\d{2}[-.\/年]\s?\d{1,2}[-.\/月]\s?\d{1,2}/g) || []).map((s) => s.replace(/\s/g, '')))].slice(0, 8);
    const prize = [...new Set((html.match(/[¥￥]\s?[\d,]{3,}|[\d,]+\s?(?:万|USD|usd|元)/g) || []).map((s) => s.trim()))].slice(0, 4);
    console.log(`\n### [${src}] ${name}`);
    console.log(`  HTTP ${res.status} len=${html.length}`);
    console.log(`  title: ${title.slice(0, 120)}`);
    console.log(`  desc : ${(desc || '(无)').replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(`  dates: ${dates.length ? dates.join(' | ') : '(无)'}`);
    console.log(`  prize: ${prize.length ? prize.join(' | ') : '(无)'}`);
  } catch (e) {
    console.log(`\n### [${src}] ${name}\n  ERR ${e.message}`);
  }
}
