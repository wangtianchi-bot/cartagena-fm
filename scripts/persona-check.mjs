import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8080/stream');
const say = (t) => fetch('http://localhost:8080/api/message', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
const Q = ['你是谁？', '你现在能帮我切一首歌吗？随便什么，反正要切掉', '长这么大没吃过帝王蟹，太贵了不舍得', '就这样吧拜拜'];
let i = 0, replies = 0;
ws.on('open', async () => { await fetch('http://localhost:8080/api/hotline/open', { method: 'POST' }); say(Q[i]); });
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'hotline-reply') {
    console.log(`问：${Q[i]}`);
    console.log(`答：${m.segments.map(s => s.text).join('')}\n`);
    replies++; i++;
    if (i < Q.length) setTimeout(() => say(Q[i]), 800);
  }
  if (m.type === 'hotline-song') { console.log('🎁 收歌：' + (m.tracks?.[0]?.title || '?') + ' —— ' + m.segments.map(s=>s.text).join('')); process.exit(0); }
});
setTimeout(() => process.exit(0), 75000);
