// tests/server.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import WebSocket from 'ws';
import { createApp } from '../server.js';
import { openDb } from '../src/db.js';

function waitMsg(ws, type, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`等不到 ${type}`)), timeout);
    ws.on('message', (d) => {
      const m = JSON.parse(d);
      if (m.type === type) { clearTimeout(t); resolve(m); }
    });
  });
}

async function boot(pipelines, asr = null, intro = null, opener = null, weekly = null) {
  const db = openDb(':memory:');
  // opener 缺省注入空桩：让既有用例走旧流程，且测试里绝不碰真 LLM/TTS/音乐源
  const openerDep = opener ?? { resolve: async () => null, prepare: async () => null };
  const { server } = createApp({ db, pipelines, asr, intro, opener: openerDep, weekly });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/stream`);
  await new Promise(r => ws.on('open', r));
  return { port, ws, server, db };
}

test('POST /api/start → 先 program-start（歌单）后 program-segments（口播）', async () => {
  const fake = { start: async () => ({ title: 'T', tracks: [{ title: 'a' }], segments: [] }) };
  const { port, ws, server } = await boot(fake);
  const pTracks = waitMsg(ws, 'program-start');
  const pSegs = waitMsg(ws, 'program-segments');
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  const tracks = await pTracks;
  assert.equal(tracks.tracks[0].title, 'a');
  const segs = await pSegs;
  assert.equal(segs.title, 'T');
  ws.close(); server.close();
});

test('管线 notify tracks → 歌单先行广播，segments 殿后（开台音乐先响）', async () => {
  const fake = { start: async (notify) => {
    notify({ event: 'progress', stage: '选歌' });
    notify({ event: 'tracks', tracks: [{ title: 'early' }] });
    await new Promise(r => setTimeout(r, 50)); // 模拟第二段 LLM + TTS 耗时
    return { title: 'T', tracks: [{ title: 'early' }], segments: [{ type: 'silence', position: 'immediate', text: '' }] };
  } };
  const { port, ws, server } = await boot(fake);
  const order = [];
  const pProgress = waitMsg(ws, 'progress').then(m => { order.push('progress'); return m; });
  const pTracks = waitMsg(ws, 'program-start').then(m => { order.push('tracks'); return m; });
  const pSegs = waitMsg(ws, 'program-segments').then(m => { order.push('segments'); return m; });
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  const [prog, tracks] = await Promise.all([pProgress, pTracks]);
  assert.equal(prog.stage, '选歌');
  assert.equal(tracks.tracks[0].title, 'early');
  await pSegs;
  assert.deepEqual(order, ['progress', 'tracks', 'segments']);
  ws.close(); server.close();
});

test('模糊点歌 notify tracks → 广播 request-tracks（前端直接切歌），dj-response 不重复带歌', async () => {
  const fake = { request: async (text, queued, notify) => {
    notify({ event: 'tracks', tracks: [{ title: '点的歌' }] });
    return { title: '', tracks: [{ title: '点的歌' }], segments: [{ type: 'quick_touch', position: 'immediate', text: '收到。' }] };
  } };
  const { port, ws, server } = await boot(fake);
  const pReq = waitMsg(ws, 'request-tracks');
  const pDj = waitMsg(ws, 'dj-response');
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '来点雨天的' }), // 抽不出点名 → 走两段式
  });
  const req = await pReq;
  assert.equal(req.tracks[0].title, '点的歌');
  const dj = await pDj;
  assert.deepEqual(dj.tracks, []); // 已经走 request-tracks 切过了，不能再插一遍
  assert.equal(dj.segments[0].text, '收到。');
  ws.close(); server.close();
});

test('明确点名 → 快路径：直搜直切，不走两段式管线', async () => {
  const searched = [];
  const fake = {
    search: async (q) => { searched.push(q); return [{ title: '有何不可', artist: '许嵩' }]; },
    quick: async (text, tracks) => ({ title: '', tracks, segments: [{ type: 'quick_touch', position: 'immediate', text: '好，给你。' }] }),
    request: async () => { throw new Error('明确点名不应走两段式'); },
  };
  const { port, ws, server } = await boot(fake);
  const pReq = waitMsg(ws, 'request-tracks');
  const pDj = waitMsg(ws, 'dj-response');
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '我想听许嵩的歌' }),
  });
  const req = await pReq;
  assert.deepEqual(searched, ['许嵩']);
  assert.equal(req.tracks[0].title, '有何不可');
  const dj = await pDj;
  assert.deepEqual(dj.tracks, []);
  assert.equal(dj.segments[0].text, '好，给你。');
  ws.close(); server.close();
});

test('开台：开场白缓存未命中 → 现场生成也要先开口，intro 先于 program-start', async () => {
  const fake = { start: async () => ({ title: 'T', tracks: [{ title: 'a' }], segments: [] }) };
  const intro = { read: () => null, prepare: async () => ({ slot: '中午', text: '现做的开场。', ttsUrl: '/tts/f.mp3' }) };
  const { port, ws, server } = await boot(fake, null, intro);
  const order = [];
  const pIntro = waitMsg(ws, 'intro').then(m => { order.push('intro'); return m; });
  const pStart = waitMsg(ws, 'program-start').then(m => { order.push('start'); return m; });
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  const i = await pIntro;
  assert.equal(i.text, '现做的开场。');
  await pStart;
  assert.deepEqual(order, ['intro', 'start']);
  ws.close(); server.close();
});

test('开台：开场白缓存命中 → 立刻广播 intro（点击 <1s 有人声）', async () => {
  const fake = { start: async () => ({ title: 'T', tracks: [{ title: 'a' }], segments: [] }) };
  let prepared = 0;
  const intro = { read: () => ({ text: '十点的太阳很好。', ttsUrl: '/tts/i.mp3' }), prepare: async () => { prepared++; } };
  const { port, ws, server } = await boot(fake, null, intro);
  const order = [];
  const pIntro = waitMsg(ws, 'intro').then(m => { order.push('intro'); return m; });
  const pSegs = waitMsg(ws, 'program-segments').then(m => { order.push('segments'); return m; });
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  const i = await pIntro;
  assert.equal(i.text, '十点的太阳很好。');
  assert.equal(i.ttsUrl, '/tts/i.mp3');
  await pSegs;
  assert.deepEqual(order, ['intro', 'segments']); // 开场白必须先于一切管线产物
  assert.equal(prepared, 1); // 节目开起来后为下次预热
  ws.close(); server.close();
});

test('管线返回 null → 广播 job-status 失败（音乐不断的退避由前端处理）', async () => {
  const fake = { start: async () => null };
  const { port, ws, server } = await boot(fake);
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  const msg = await waitMsg(ws, 'job-status');
  assert.equal(msg.status, 'failed');
  ws.close(); server.close();
});

test('POST /api/played 写入播放历史', async () => {
  const db = openDb(':memory:');
  const { server } = createApp({ db, pipelines: {} });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  await fetch(`http://127.0.0.1:${port}/api/played`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '红豆', artist: '方大同', sourceUrl: 'http://x' }),
  });
  assert.equal(db.recentPlays(1)[0].title, '红豆');
  server.close();
});

test('POST /api/message → 先广播 user-message（纯文字，语音复述已废除）再 dj-response', async () => {
  const fake = { request: async () => ({ title: '', tracks: [], segments: [] }) };
  const { port, ws, server } = await boot(fake);
  // 先挂监听再发请求，避免广播先于监听到达
  const order = []; // 记录两类广播的实际到达顺序
  const pUser = waitMsg(ws, 'user-message').then((m) => { order.push('user-message'); return m; });
  const pDj = waitMsg(ws, 'dj-response').then((m) => { order.push('dj-response'); return m; });
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '来点雨天的' }),
  });
  const msg = await pUser;
  assert.equal(msg.transcript, '来点雨天的');
  assert.equal(msg.ttsUrl, undefined); // 不再 TTS 复述用户的话
  await pDj;
  assert.equal(order[0], 'user-message'); // 用户消息先于 DJ 回应进聊天流
  ws.close(); server.close();
});

test('POST /api/voice 带 queued query → 待播队列传入点歌管线（去重数据源）', async () => {
  let captured = null;
  const fake = { request: async (text, queued) => { captured = { text, queued }; return { title: '', tracks: [], segments: [] }; } };
  const asr = { webmToPcm: async (b) => b, transcribe: async () => '来一首歌' };
  const { port, ws, server } = await boot(fake, asr);
  const queued = [{ title: '红豆', artist: '方大同' }];
  // 先挂监听再发请求，避免广播先于监听到达
  const pDj = waitMsg(ws, 'dj-response');
  await fetch(`http://127.0.0.1:${port}/api/voice?queued=` + encodeURIComponent(JSON.stringify(queued)), {
    method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('fake-webm-audio-data'),
  });
  await pDj;
  assert.deepEqual(captured.queued, queued); // body 是音频流，待播队列必须经 query 透传进管线
  ws.close(); server.close();
});

test('音乐先行（V1.0.8）：首播曲命中 → program-start(首播曲) 先于 intro，后续整批走 tracks-ready', async () => {
  const fake = { start: async (notify, nowPlaying) => {
    assert.equal(nowPlaying.title, '首播曲'); // 首播曲要传进管线（去重 + 进场点评）
    return { title: '午后', tracks: [{ title: 'b' }], segments: [{ type: 'bridge', position: 'before_track', trackIndex: 0, text: '接住刚才。' }] };
  } };
  const intro = { read: () => ({ text: '音乐已经响了。', ttsUrl: '/tts/i.mp3' }), prepare: async () => null };
  const opener = { resolve: async () => ({ title: '首播曲', artist: '某人', streamUrl: 'http://x' }), prepare: async () => null };
  const { port, ws, server } = await boot(fake, null, intro, opener);
  const order = [];
  const pStart = waitMsg(ws, 'program-start').then(m => { order.push('music'); return m; });
  const pIntro = waitMsg(ws, 'intro').then(m => { order.push('intro'); return m; });
  const pReady = waitMsg(ws, 'tracks-ready').then(m => { order.push('ready'); return m; });
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  const first = await pStart;
  assert.equal(first.tracks[0].title, '首播曲'); // 第一秒先响音乐
  await pIntro;
  const ready = await pReady;
  assert.equal(ready.tracks[0].title, 'b');
  assert.equal(ready.segments[0].text, '接住刚才。'); // 进场串场随批次到，前端按队列长度对齐
  assert.deepEqual(order, ['music', 'intro', 'ready']); // 音乐 → 人声 → 后续歌单
  ws.close(); server.close();
});

test('POST /api/transcribe → 只转写回填，不进 DJ 管线（听写模式）', async () => {
  const fake = { request: async () => { throw new Error('听写不应触发 DJ 管线'); } };
  const asr = { webmToPcm: async (b) => b, transcribe: async () => '来一首红豆' };
  const { port, ws, server } = await boot(fake, asr);
  const r = await fetch(`http://127.0.0.1:${port}/api/transcribe`, {
    method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.from('fake-webm'),
  });
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.text, '来一首红豆');
  ws.close(); server.close();
});

test('F14 热线：接通后消息路由进热线对话；closing → 收歌仪式 → 收线后恢复点歌路由', async () => {
  const calls = [];
  const fake = {
    hotlineTurn: async (turns, text) => {
      calls.push(['turn', text]);
      const closing = text.includes('拜拜');
      return { reply: closing ? '嗯，回去早点睡。' : '哦？然后呢。', closing,
               segments: [{ type: 'quick_touch', position: 'immediate', text: 'x' }] };
    },
    hotlineSong: async (summary) => {
      calls.push(['song', summary.includes('听众')]);
      return { title: '', tracks: [{ title: '告白', artist: '某人' }],
               segments: [{ type: 'quick_touch', position: 'immediate', text: '送你这首。' }], failed: [] };
    },
    request: async (text) => { calls.push(['request', text]); return { title: '', tracks: [], segments: [] }; },
  };
  const { port, ws, server } = await boot(fake);
  const say = (text) => fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });

  await fetch(`http://127.0.0.1:${port}/api/hotline/open`, { method: 'POST' });
  const pReply = waitMsg(ws, 'hotline-reply');
  await say('我想聊聊感情的事');
  const reply = await pReply;
  assert.equal(reply.segments[0].text, 'x');

  const pSong = waitMsg(ws, 'hotline-song');
  const pClosed = waitMsg(ws, 'hotline-closed');
  await say('就这样吧拜拜');
  const song = await pSong;
  assert.equal(song.tracks[0].title, '告白');   // 收歌仪式：贴合对话的歌 + 送歌口播
  assert.equal(song.segments[0].text, '送你这首。');
  await pClosed;

  const pDj = waitMsg(ws, 'dj-response');
  await say('来点下雨天的歌');                   // 收线后回电台模式：消息走点歌管线
  await pDj;
  assert.deepEqual(calls.map(c => c[0]), ['turn', 'turn', 'song', 'request']);
  assert.equal(calls[2][1], true);               // 收歌摘要里带通话记录
  ws.close(); server.close();
});

test('F14 热线快车道（V1.1.2 真人感红线）：选歌管线占线时，回显与回应都不排队', async () => {
  let releaseStart;
  const fake = {
    start: () => new Promise(r => { releaseStart = () => r({ title: '', tracks: [{ title: 'a' }], segments: [] }); }),
    hotlineTurn: async () => ({ reply: '嗯。', closing: false,
      segments: [{ type: 'quick_touch', position: 'immediate', text: '嗯。' }] }),
  };
  const { port, ws, server } = await boot(fake);
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });   // 开台管线挂起占住全局队列
  await fetch(`http://127.0.0.1:${port}/api/hotline/open`, { method: 'POST' });
  const t0 = Date.now();
  const pUser = waitMsg(ws, 'user-message');
  const pThink = waitMsg(ws, 'hotline-thinking'); // V1.1.6：思考状态替代应声词
  const pReply = waitMsg(ws, 'hotline-reply');
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '在吗' }) });
  await Promise.all([pUser, pThink, pReply]);
  assert.ok(Date.now() - t0 < 1500, `热线被全局队列卡住了（${Date.now() - t0}ms）`); // 修复前会等到开台跑完
  releaseStart();
  await waitMsg(ws, 'program-start');
  ws.close(); server.close();
});

test('F14 连发合并（V1.1.4）：上一轮没回完时连发两句 → 不堆积，合并成一条回应；应声只响一次/波', async () => {
  const turnTexts = [];
  let releaseTurn;
  const fake = {
    hotlineTurn: (turns, text) => new Promise(r => {
      turnTexts.push(text);
      const done = () => r({ reply: '嗯。', closing: false,
        segments: [{ type: 'quick_touch', position: 'immediate', text: '嗯。' }] });
      if (turnTexts.length === 1) releaseTurn = done; else done(); // 第一轮挂起，后续秒回
    }),
  };
  const thinkCount = { n: 0 };
  const { port, ws, server } = await boot(fake);
  ws.on('message', (d) => { if (JSON.parse(d).type === 'hotline-thinking') thinkCount.n++; });
  const say = (text) => fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
  await fetch(`http://127.0.0.1:${port}/api/hotline/open`, { method: 'POST' });
  let replies = 0;
  const twoReplies = new Promise(res => ws.on('message', (d) => {
    if (JSON.parse(d).type === 'hotline-reply' && ++replies === 2) res();
  }));
  await say('第一句');
  await new Promise(r => setTimeout(r, 80)); // 第一轮在跑（挂起中）
  await say('第二句'); await say('第三句');   // 忙时连发 → 积压
  await new Promise(r => setTimeout(r, 80));
  releaseTurn();                              // 第一轮完成 → 积压合并成一轮
  await twoReplies;
  assert.equal(turnTexts.length, 2);          // 三句话只跑两轮，不是三轮
  assert.equal(turnTexts[1], '第二句；第三句'); // 积压合并成一条
  assert.equal(thinkCount.n, 2);              // "正在想"状态一波一次，不是一句一次
  ws.close(); server.close();
});

test('F14 热线：主动挂断（/api/hotline/close）也触发收歌仪式', async () => {
  const fake = {
    hotlineTurn: async () => ({ reply: '嗯。', closing: false,
      segments: [{ type: 'quick_touch', position: 'immediate', text: '嗯。' }] }),
    hotlineSong: async () => ({ title: '', tracks: [{ title: '晚安曲', artist: 'x' }],
      segments: [], failed: [] }),
  };
  const { port, ws, server } = await boot(fake);
  await fetch(`http://127.0.0.1:${port}/api/hotline/open`, { method: 'POST' });
  const pReply = waitMsg(ws, 'hotline-reply');
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '聊两句' }) });
  await pReply;
  const pSong = waitMsg(ws, 'hotline-song');
  await fetch(`http://127.0.0.1:${port}/api/hotline/close`, { method: 'POST' });
  const song = await pSong;
  assert.equal(song.tracks[0].title, '晚安曲');
  ws.close(); server.close();
});

test('同 key 任务去重：连点两次 start 只跑一次', async () => {
  let runs = 0;
  const fake = { start: () => new Promise(r => setTimeout(() => { runs++; r({ title: '', tracks: [], segments: [] }); }, 100)) };
  const { port, ws, server } = await boot(fake);
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  await fetch(`http://127.0.0.1:${port}/api/start`, { method: 'POST' });
  await waitMsg(ws, 'program-start');
  assert.equal(runs, 1);
  ws.close(); server.close();
});

test('V1.1.9 热线工具：口头"切歌" → 广播 hotline-skip + 系统注记喂给卡卡', async () => {
  let captured = null;
  const fake = {
    hotlineTurn: async (turns, text, emit, opts) => {
      captured = opts;
      return { reply: '换了。', closing: false,
        segments: [{ type: 'quick_touch', position: 'immediate', text: '换了。' }] };
    },
  };
  const { port, ws, server } = await boot(fake);
  await fetch(`http://127.0.0.1:${port}/api/hotline/open`, { method: 'POST' });
  const pSkip = waitMsg(ws, 'hotline-skip');
  const pReply = waitMsg(ws, 'hotline-reply');
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '帮我切歌，这首太吵了' }) });
  await pSkip;                                  // 前端先动手
  await pReply;
  assert.ok(captured.sysNote.includes('切歌指令已自动执行')); // 卡卡看到"已办成"
  ws.close(); server.close();
});

test('V1.1.9 热线工具：口头点名 → 直搜直切 + 注记带歌名（白名单放行）', async () => {
  let captured = null;
  const fake = {
    search: async (q) => { assert.equal(q, '许嵩'); return [{ title: '有何不可', artist: '许嵩' }]; },
    hotlineTurn: async (turns, text, emit, opts) => {
      captured = opts;
      return { reply: '好，《有何不可》给你。', closing: false,
        segments: [{ type: 'quick_touch', position: 'immediate', text: '好，《有何不可》给你。' }] };
    },
    request: async () => { throw new Error('热线点歌不应走电台点歌管线'); },
  };
  const { port, ws, server } = await boot(fake);
  await fetch(`http://127.0.0.1:${port}/api/hotline/open`, { method: 'POST' });
  const pTracks = waitMsg(ws, 'request-tracks');
  const pReply = waitMsg(ws, 'hotline-reply');
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '我想听许嵩' }) });
  const tr = await pTracks;
  assert.equal(tr.tracks[0].title, '有何不可');  // 歌先切上
  await pReply;
  assert.ok(captured.sysNote.includes('有何不可'));
  assert.deepEqual(captured.allowTitles, ['有何不可']); // 防幻觉白名单放行这一首
  ws.close(); server.close();
});

// ===== F12 行为信号采集 =====
test('POST /api/signal: skip/finish 入库；非法 type 400', async () => {
  const { port, server, ws, db } = await boot({});
  const r1 = await fetch(`http://127.0.0.1:${port}/api/signal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'skip', title: '玫瑰', artist: '贰佰', pct: 0.08 }),
  });
  assert.equal(r1.status, 200);
  const r2 = await fetch(`http://127.0.0.1:${port}/api/signal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'hack', title: 'x', artist: 'y' }),
  });
  assert.equal(r2.status, 400);
  const r3 = await fetch(`http://127.0.0.1:${port}/api/signal`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'skip', title: '', artist: '' }), // 缺曲目信息也算坏请求
  });
  assert.equal(r3.status, 400);
  const sigs = db.signalsSince(Date.now() - 5000);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].type, 'skip');
  assert.equal(sigs[0].pct, 0.08);
  ws.close(); server.close();
});

test('点歌（快路径）自动记 request 信号', async () => {
  const fake = {
    search: async () => [{ title: '晴天', artist: '周杰伦' }],
    quick: async () => ({ title: '', segments: [], tracks: [] }),
  };
  const { port, server, ws, db } = await boot(fake);
  const pReq = waitMsg(ws, 'request-tracks');
  await fetch(`http://127.0.0.1:${port}/api/message`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: '想听晴天' }),
  });
  await pReq;
  await new Promise(r => setTimeout(r, 100)); // 等管线队列排空
  const sigs = db.signalsSince(Date.now() - 5000);
  assert.equal(sigs.length, 1);
  assert.equal(sigs[0].type, 'request');
  assert.equal(sigs[0].title, '晴天');
  ws.close(); server.close();
});

test('F12 周报端点：generate 广播 taste-report，apply 带勾选下标并广播 taste-applied', async () => {
  let appliedIdx = null;
  const weekly = {
    run: async () => ({ weekOf: 'x', status: 'pending', observations: ['o'], suggestions: [{ change: 'c', why: 'w' }] }),
    read: () => ({ weekOf: 'x', status: 'pending' }),
    apply: (idx) => { appliedIdx = idx; return { weekOf: 'x', status: 'applied' }; },
  };
  const { port, server, ws } = await boot({}, null, null, null, weekly);
  const r0 = await fetch(`http://127.0.0.1:${port}/api/taste/report`);
  assert.equal((await r0.json()).report.status, 'pending');
  const pRep = waitMsg(ws, 'taste-report');
  await fetch(`http://127.0.0.1:${port}/api/taste/report/generate`, { method: 'POST' });
  assert.equal((await pRep).report.suggestions[0].change, 'c');
  const pApplied = waitMsg(ws, 'taste-applied');
  const r2 = await fetch(`http://127.0.0.1:${port}/api/taste/report/apply`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accepted: [0] }),
  });
  assert.equal((await r2.json()).report.status, 'applied');
  assert.deepEqual(appliedIdx, [0]);
  await pApplied;
  ws.close(); server.close();
});
