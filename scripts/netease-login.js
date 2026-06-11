// scripts/netease-login.js —— 启动 sidecar 后跑一次：生成二维码 → 终端展示 → 轮询登录态 → cookie 落盘 data/netease-cookie.txt
// 注意：sidecar（NeteaseCloudMusicApi）不保存用户登录态，cookie 必须由我们持久化并随每次请求回传（src/music/netease.js 读取）。
import { writeFileSync } from 'node:fs';
import { config, ROOT } from '../src/config.js';

const base = config.neteaseBase;
const j = (u) => fetch(base + u).then(r => r.json());

const { data: { unikey } } = await j(`/login/qr/key?timestamp=${Date.now()}`);
const { data: { qrurl } } = await j(`/login/qr/create?key=${unikey}&timestamp=${Date.now()}`);
console.log('用网易云 App 扫码登录（二维码内容如下，可粘贴到任意二维码生成器）：\n', qrurl);

for (;;) {
  await new Promise(r => setTimeout(r, 3000));
  const res = await j(`/login/qr/check?key=${unikey}&timestamp=${Date.now()}`);
  console.log(res.code, res.message || '');
  if (res.code === 803) {
    if (!res.cookie) { console.log('⚠️ 登录成功但响应中无 cookie，无法持久化'); break; }
    // res.cookie 是多条 set-cookie 用 ";;" 拼接的原始串（含 Max-Age/Path 等属性），
    // 直接当 Cookie 头回传会污染解析，必须清洗成纯 name=value 对
    const pairs = new Map();
    for (const seg of res.cookie.split(';;')) {
      const kv = seg.split(';', 1)[0].trim();
      const eq = kv.indexOf('=');
      if (eq > 0) pairs.set(kv.slice(0, eq), kv.slice(eq + 1));
    }
    const clean = [...pairs].map(([k, v]) => `${k}=${v}`).join('; ');
    writeFileSync(`${ROOT}/data/netease-cookie.txt`, clean, 'utf8');
    console.log('✅ 登录成功，cookie 已写入 data/netease-cookie.txt');
    break;
  }
  if (res.code === 800) { console.log('二维码过期，重跑本脚本'); break; }
}
