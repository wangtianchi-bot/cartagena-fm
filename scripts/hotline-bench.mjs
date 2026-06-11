// 热线延迟基准（V1.1.6 流式版）：测思考提示/首字/首声/整句到达时间
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8080/stream');
const t0 = Date.now();
const log = (s) => console.log(((Date.now() - t0) / 1000).toFixed(1) + 's', s);
const say = (text) => fetch('http://localhost:8080/api/message', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
ws.on('open', async () => {
  await fetch('http://localhost:8080/api/hotline/open', { method: 'POST' });
  await say('你是谁？'); log('发出 #1「你是谁？」');
  setTimeout(() => say('最近工作好累，感觉一直在原地打转').then(() => log('发出 #2')), 6000);
});
let gotDelta = false, replies = 0;
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'hotline-thinking') { gotDelta = false; log('● 思考提示'); }
  if (m.type === 'hotline-delta' && !gotDelta) { gotDelta = true; log('▶ 首字: ' + m.text); }
  if (m.type === 'hotline-say') log('🔊 整句就绪: ' + m.segment.text);
  if (m.type === 'hotline-reply') { replies++; log('✔ 完整回应: ' + m.segments.map(s => s.text).join('')); if (replies >= 2) finish(); }
  if (m.type === 'job-status') log('FAILED: ' + m.error);
});
async function finish() {
  await fetch('http://localhost:8080/api/hotline/close', { method: 'POST' });
  setTimeout(() => process.exit(0), 100);
}
setTimeout(() => { console.log('-- 60s 超时收尾 --'); finish(); }, 60000);
