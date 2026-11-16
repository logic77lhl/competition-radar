// 从微信公众号页面里抽出正文文本与链接（页面里塞了大量 base64 图片，必须先清掉）
import fs from 'node:fs';

const html = fs.readFileSync('wechat-article.html', 'utf8');
const start = html.indexOf('id="js_content"');
if (start < 0) throw new Error('找不到 js_content');
// 正文大致到这篇的结尾标记为止
let body = html.slice(start);
const endMarkers = ['id="js_article_bottom_bar"', 'id="js_tags_preview"', 'id="js_pc_qr_code"', 'rich_media_area_extra'];
let end = body.length;
for (const m of endMarkers) {
  const i = body.indexOf(m);
  if (i > 0 && i < end) end = i;
}
body = body.slice(0, end);

const links = [];
body.replace(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g, (_, href, txt) => {
  const t = txt.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  if (href.startsWith('http') && !href.includes('mp.weixin.qq.com')) links.push(`${t}  ->  ${href}`);
  return '';
});

const text = body
  .replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<style[\s\S]*?<\/style>/gi, '')
  .replace(/<img[^>]*>/gi, '\n[图]\n')
  .replace(/<\/(p|section|div|li|h[1-6]|tr)>/gi, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/[ \t\u00a0]+/g, ' ')
  .split('\n')
  .map((l) => l.trim())
  .filter((l, i, arr) => l.length > 0 || (i > 0 && arr[i - 1].length > 0))
  .join('\n')
  .replace(/\n{3,}/g, '\n\n');

fs.writeFileSync('wechat-article.txt', text, 'utf8');
fs.writeFileSync('wechat-links.txt', links.join('\n'), 'utf8');
console.log(`正文 ${text.length} 字，外链 ${links.length} 条`);
console.log('===== 正文 =====');
console.log(text);
