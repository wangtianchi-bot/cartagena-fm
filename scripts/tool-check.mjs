import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:8080/stream');
const say = (t) => fetch('http://localhost:8080/api/message', { method: 'POST',
  headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }) });
const Q = ['帮我切歌，这首不想听', '我想听周杰伦的晴天'];
let i = 0;
ws.on('open', async () => { await fetch('http://localhost:8080/api/hotline/open', { method: 'POST' }); say(Q[i]); });
ws.on('message', (d) => {
  const m = JSON.parse(d);
  if (m.type === 'hotline-skip') console.log('⏭ 收到切歌指令（前端会立刻执行）');
  if (m.type === 'request-tracks') console.log('🎵 已切上：' + m.tracks[0].title + ' — ' + m.tracks[0].artist);
  if (m.type === 'hotline-reply') {
    console.log(`问：${Q[i]}\n卡卡：${m.segments.map(s => s.text).join('')}\n`);
    i++;
    if (i < Q.length) setTimeout(() => say(Q[i]), 600);
    else { fetch('http://localhost:8080/api/hotline/close', { method: 'POST' }); setTimeout(() => process.exit(0), 3000); }
  }
});
setTimeout(() => process.exit(0), 60000);
