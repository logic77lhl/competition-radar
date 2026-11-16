// 用几种不同的请求姿势尝试拿到微信公众号正文（该站对无头抓取会返回验证页）
const URL_ = 'https://mp.weixin.qq.com/s/EH2nbss71J4b7fCv_hS8Pg';
const attempts = [
  {
    label: 'browser-ua + referer',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      referer: 'https://mp.weixin.qq.com/',
      'accept-language': 'zh-CN,zh;q=0.9',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    },
  },
  {
    label: 'wechat-android-ua',
    headers: {
      'user-agent': 'Mozilla/5.0 (Linux; Android 13; SM-S9180) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.47.2560(0x28002F3D) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64',
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9',
    },
  },
];

for (const a of attempts) {
  try {
    const res = await fetch(URL_, { headers: a.headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const html = await res.text();
    const isCaptcha = /wappoc_appmsgcaptcha|环境异常/.test(html);
    const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1]
      || html.match(/var msg_title = ['"]([^'"]*)['"]/)?.[1] || '';
    const author = html.match(/var nickname = ['"]([^'"]*)['"]/)?.[1] || '';
    const bodyLen = html.match(/id="js_content"/) ? (html.split('id="js_content"')[1] || '').length : 0;
    console.log(`[${a.label}] ${res.status} len=${html.length} captcha=${isCaptcha} contentLen=${bodyLen}`);
    console.log(`    title=${title}  author=${author}  finalUrl=${res.url.slice(0, 120)}`);
    if (!isCaptcha && html.length > 20000) {
      const fs = await import('node:fs');
      fs.writeFileSync('wechat-article.html', html);
      console.log('    已保存 wechat-article.html');
    }
  } catch (e) {
    console.log(`[${a.label}] ERR ${e.message}`);
  }
}
