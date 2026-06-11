// server.js —— 本地中枢：Express + ws 广播 + 单工任务队列
import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { config, ROOT } from './src/config.js';
import { openDb } from './src/db.js';
import * as pipeline from './src/pipeline.js';
import { quickSearch } from './src/music/index.js';
import { extractSongQuery } from './src/quickpick.js';
import { readIntro, prepareIntro } from './src/intro.js';
import { readOpener, prepareOpener, resolveOpener } from './src/opener.js';
import { createScheduler } from './src/scheduler.js';
import { runWeeklyReport, readReport, applyReport, isReportDue } from './src/weekly.js';
import { pushLark } from './src/notify.js';
export function createApp({ db = openDb(), pipelines = {}, asr = null, intro = null, opener = null, weekly = null } = {}) {
  // 可注入管线（测试用）；缺省接真实现
  const run = {
    start: pipelines.start ?? ((notify, nowPlaying) => pipeline.runProgramStart(db, {
      notify, nowPlaying, queued: nowPlaying ? [nowPlaying] : [], // 首播曲带进去重（V1.0.8 音乐先行）
    })),
    refill: pipelines.refill ?? ((queued) => pipeline.runRefill(db, { queued })),
    request: pipelines.request ?? ((text, queued, notify) => pipeline.runRequest(db, text, { queued, notify })),
    quick: pipelines.quick ?? ((text, tracks) => pipeline.runQuickRequest(db, text, tracks)),
    search: pipelines.search ?? ((q, queued) => quickSearch(q, { queued })),
    hotlineTurn: pipelines.hotlineTurn ?? ((turns, text, emit, opts = {}) => pipeline.runHotlineTurn(db, turns, text, { emit, ...opts })),
    hotlineSong: pipelines.hotlineSong ?? ((summary) => pipeline.runHotlineSong(db, summary)),
  };
  // F14 热线会话（单用户单会话，内存态）：on=接通中；turns=本通对话记录；
  // busy/pending=连发合并（V1.1.4：忙时积压，完成后合并成一条回应，不再串行堆积延迟）
  const hot = { on: false, turns: [], busy: false, pending: [] };
  // 开场白预缓存（开台秒级有人声）+ 首播曲预缓存（开台第一秒先响音乐，V1.0.8）
  const introDep = intro ?? { read: readIntro, prepare: () => prepareIntro(db) };
  const openerDep = opener ?? { resolve: () => resolveOpener(db), prepare: () => prepareOpener(db) };

  const app = express();
  app.use(express.json());
  app.use(express.raw({ type: 'audio/*', limit: '20mb' })); // 语音点歌录音
  // HTML 不缓存：页面是常驻 SPA，旧标签页靠 WS 重连能一直活着，刷新时必须拿到最新版
  app.use(express.static(path.join(ROOT, 'public'), {
    setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-store'); },
  }));
  app.use('/tts', express.static(path.join(ROOT, 'cache', 'tts')));

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/stream' });
  const broadcast = (obj) => {
    const s = JSON.stringify(obj);
    for (const c of wss.clients) if (c.readyState === 1) c.send(s);
  };

  // —— 单工任务队列（同 key 去重，串行排空；沿用复刻版验证过的模式）——
  const queue = [];
  const keys = new Set();
  let draining = false;
  function enqueue(key, fn) {
    if (keys.has(key)) return;
    keys.add(key);
    queue.push({ key, fn });
    drain();
  }
  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const { key, fn } = queue.shift();
      try { await fn(); }
      catch (e) {
        console.error(`[job ${key}]`, e);
        broadcast({ type: 'job-status', job: key, status: 'failed', error: e.message });
      }
      finally { keys.delete(key); }
    }
    draining = false;
  }

  // —— 热线快车道（V1.1.2 真人感红线）：独立于选歌管线的串行链——
  // 补歌/开台一跑就是几十秒，热线轮次绝不能排在它们后面（四轮验收事故：消息几十秒才回显）
  let hotChain = Promise.resolve();
  const hotEnqueue = (fn) => {
    hotChain = hotChain.then(fn).catch(e => {
      console.error('[hotline]', e);
      broadcast({ type: 'job-status', job: 'hotline', status: 'failed', error: e.message });
    });
  };

  const failOrBroadcast = (job, out, type, extra = {}) => {
    if (!out) broadcast({ type: 'job-status', job, status: 'failed', error: 'pipeline returned null' });
    else broadcast({ type, title: out.title, tracks: out.tracks, segments: out.segments, ...extra });
  };

  // 歌单一确认就广播（音乐先响），口播随后到 —— 开台 35s 体感差的修法（2026-06-11 验收反馈）
  const notifier = (job, tracksType) => {
    const state = { sentTracks: false };
    state.notify = (n) => {
      if (n.event === 'progress') broadcast({ type: 'progress', job, stage: n.stage });
      else if (n.event === 'tracks') { state.sentTracks = true; state.tracks = n.tracks; broadcast({ type: tracksType, tracks: n.tracks }); }
    };
    return state;
  };

  // 开台（V1.0.8 音乐先行，azu 三轮反馈）：① 首播曲缓存现解析 → 第一秒有音乐
  // ② 开场白压着音乐缓缓进来 ③ 管线续歌单+满串场。首播曲落空 → 回退旧流程（intro 先开口）。
  app.post('/api/start', (req, res) => {
    const cached = introDep.read();
    enqueue('start', async () => {
      // ① 音乐先行：候选预缓存 + 现解析真实 URL（本地 sidecar 亚秒级）
      let first = null;
      try { first = await openerDep.resolve(); } catch (e) { console.error('[opener]', e.message); }
      if (first) broadcast({ type: 'program-start', tracks: [first] });
      // ② DJ 压混进来：缓存命中秒播；未命中现场生成兜底（音乐已响，生成期间不冷场）
      if (cached) broadcast({ type: 'intro', text: cached.text, ttsUrl: cached.ttsUrl });
      else {
        broadcast({ type: 'progress', job: 'start', stage: '开场白' });
        try {
          const fresh = await introDep.prepare();
          if (fresh) broadcast({ type: 'intro', text: fresh.text, ttsUrl: fresh.ttsUrl });
        } catch (e) { console.error('[intro]', e.message); }
      }
      // ③ 管线续歌单 + 满串场口播
      const st = notifier('start', 'program-start');
      const out = await run.start(first ? (n) => { if (n.event === 'progress') st.notify(n); } : st.notify, first);
      if (!out) return broadcast({ type: 'job-status', job: 'start', status: 'failed', error: 'pipeline returned null' });
      if (first) {
        // 首播曲已占队列 0 号位：整批以 tracks-ready 追加，前端按当前队列长度对齐 segment 索引
        broadcast({ type: 'tracks-ready', tracks: out.tracks, segments: out.segments, title: out.title });
      } else {
        if (!st.sentTracks) broadcast({ type: 'program-start', tracks: out.tracks });
        broadcast({ type: 'program-segments', title: out.title, segments: out.segments });
      }
      // 为下次开台预热弹药（开场白 + 首播曲候选），不阻塞本次节目
      Promise.resolve(introDep.prepare()).catch(e => console.error('[intro]', e.message));
      Promise.resolve(openerDep.prepare()).catch(e => console.error('[opener]', e.message));
    });
    res.json({ ok: true });
  });

  // 听写模式（V1.0.8 麦双模式之一）：只转写、不进 DJ 管线——文字回填输入框，由用户决定发不发
  app.post('/api/transcribe', async (req, res) => {
    const body = req.body;
    if (!Buffer.isBuffer(body) || !body.length) return res.status(400).json({ ok: false });
    try {
      const { webmToPcm, transcribe } = asr ?? await import('./src/asr.js');
      const text = await transcribe(await webmToPcm(body));
      res.json({ ok: true, text });
    } catch (e) {
      console.error('[transcribe]', e.message);
      res.status(502).json({ ok: false });
    }
  });

  app.post('/api/refill', (req, res) => {
    const queued = req.body?.queued ?? [];
    enqueue('refill', async () => failOrBroadcast('refill', await run.refill(queued), 'tracks-ready'));
    res.json({ ok: true });
  });

  // ===== F14 情感热线（V1.1.0）=====
  app.post('/api/hotline/open', (req, res) => {
    hot.on = true; hot.turns = []; hot.busy = false; hot.pending = [];
    broadcast({ type: 'hotline-opened' });
    res.json({ ok: true });
  });

  // 挂断 → 收歌仪式：DJ 收束 + 送一首贴合本通对话的歌，音乐渐起回电台模式（走快车道）
  app.post('/api/hotline/close', (req, res) => {
    res.json({ ok: true });
    hotEnqueue(() => closeHotline());
  });

  const hotlineSummary = () =>
    hot.turns.map(t => `${t.role === 'user' ? '听众' : 'DJ'}：${t.text}`).join('\n').slice(-1500);

  async function closeHotline() {
    if (!hot.on) return;
    hot.on = false;
    hot.pending = [];
    if (hot.turns.length) {
      try {
        const out = await run.hotlineSong(hotlineSummary());
        if (out) {
          broadcast({ type: 'hotline-song', tracks: out.tracks, segments: out.segments });
          hot.turns = [];
          broadcast({ type: 'hotline-closed' });
          return;
        }
      } catch (e) { console.error('[hotline-song]', e.message); }
    }
    hot.turns = [];
    broadcast({ type: 'hotline-closed' }); // 没聊上话/选歌失败：静默收线，电台模式自然继续
  }

  // 热线规则级工具（V1.1.9：给卡卡装上"放歌/切歌的手"，不破坏流式管线）——
  // 你的话先过意图检测：切歌/点名直接执行，结果以系统注记喂给卡卡，她只需口头确认
  const SKIP_RE = /(切歌|换一首|换首歌|下一首|跳过这首|跳过吧)/;
  async function hotlineTools(text, queued) {
    if (SKIP_RE.test(text)) {
      broadcast({ type: 'hotline-skip' }); // 前端立刻切（含未开播兜底）
      return { sysNote: '（系统注记：切歌指令已自动执行，歌已经换了。你只需轻轻确认一句，别再说自己没手。这行是后台纸条，绝不要念出来。）', allowTitles: [] };
    }
    const q = extractSongQuery(text);
    if (!q) return null;
    try {
      const tracks = await run.search(q, queued);
      if (tracks.length) {
        broadcast({ type: 'request-tracks', tracks });
        db.addSignal({ type: 'request', title: tracks[0].title, artist: tracks[0].artist }); // F12 强正信号
        return {
          sysNote: `（系统注记：已经帮他切到《${tracks[0].title}》——${tracks[0].artist}，正在播。顺口确认一句即可，只许提这一首歌。这行是后台纸条，绝不要念出来。）`,
          allowTitles: [tracks[0].title],
        };
      }
      return { sysNote: `（系统注记：他点的「${q}」没搜到，老实说没找到，别承诺别的。）`, allowTitles: [] };
    } catch (e) {
      console.error('[hotline-pick]', e.message);
      return null;
    }
  }

  // 热线中的一轮通话（语音/文字共用，V1.1.6 流式）：
  // delta（逐字字幕）和 sentence（逐句出声）边生成边转发；终帧 hotline-reply 收尾（streamed 标记防前端重播）
  async function hotlineTurnJob(text, queued = []) {
    const tool = await hotlineTools(text, queued); // 先动手再开口：切歌/点歌 <1-3s 生效
    const out = await run.hotlineTurn(hot.turns, text, (n) => {
      if (n.event === 'delta') broadcast({ type: 'hotline-delta', text: n.text });
      else if (n.event === 'sentence') broadcast({ type: 'hotline-say', segment: n.segment });
    }, { sysNote: tool?.sysNote ?? null, allowTitles: tool?.allowTitles ?? [] });
    if (!out) return broadcast({ type: 'job-status', job: 'hotline', status: 'failed', error: 'hotline turn returned null' });
    hot.turns.push({ role: 'user', text }, { role: 'dj', text: out.reply });
    broadcast({ type: 'hotline-reply', segments: out.segments, streamed: true });
    if (out.closing) await closeHotline();
  }

  // 热线收到一句话：回显已在外面做。空闲 → 广播"DJ 正在想"状态（azu 要求：必须有反馈否则用户离开）+ 起一轮流式回应；
  // 忙（上一轮还在跑）→ 积压，本轮结束后合并成一条一起回应（V1.1.4 连发合并）
  function hotlineReceive(text, queued = []) {
    if (hot.busy) { hot.pending.push(text); return; }
    broadcast({ type: 'hotline-thinking' });
    hot.busy = true;
    hotEnqueue(async () => {
      try { await hotlineTurnJob(text, queued); }
      finally {
        hot.busy = false;
        const backlog = hot.pending.splice(0);
        if (backlog.length && hot.on) hotlineReceive(backlog.join('；'), queued);
      }
    });
  }

  // 文字消息：热线接通时立即回显+应声，走快车道；否则点歌 / 情绪指令（F5）走管线队列。
  app.post('/api/message', (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false });
    const queued = req.body?.queued ?? [];
    if (hot.on) {
      broadcast({ type: 'user-message', transcript: text }); // 秒回显：绝不排在选歌管线后面
      hotlineReceive(text, queued);
      return res.json({ ok: true });
    }
    enqueue(`msg:${text}`, async () => {
      broadcast({ type: 'user-message', transcript: text }); // 进聊天流（来电语音复述已废除，V1.0.6）
      await requestJob('message', text, queued);
    });
    res.json({ ok: true });
  });

  // 点歌共用。快路径（借鉴 Claudio V1.5 play_music）：明确点名 → 直搜直切（1-2s），
  // LLM 只补一句回应；抽不出点名/搜不到 → 回退两段式管线。
  // request-tracks 一广播前端立即切歌（azu 决策 2026-06-11），dj-response 只带口播
  async function requestJob(job, text, queued) {
    const q = extractSongQuery(text);
    if (q) {
      try {
        const tracks = await run.search(q, queued);
        if (tracks.length) {
          broadcast({ type: 'request-tracks', tracks });
          db.addSignal({ type: 'request', title: tracks[0].title, artist: tracks[0].artist }); // F12 强正信号
          const out = await run.quick(text, tracks);
          broadcast({ type: 'dj-response', title: out?.title || '', segments: out?.segments || [], tracks: [] });
          return;
        }
      } catch (e) { console.error('[quick]', e.message); } // 快路径失败不致命，落回两段式
    }
    const st = notifier(job, 'request-tracks');
    const out = await run.request(text, queued, st.notify);
    if (!out) return broadcast({ type: 'job-status', job, status: 'failed', error: 'pipeline returned null' });
    const first = (st.tracks ?? out.tracks)?.[0];
    if (first?.title && first.artist) db.addSignal({ type: 'request', title: first.title, artist: first.artist }); // F12 强正信号
    broadcast({ type: 'dj-response', title: out.title, segments: out.segments, tracks: st.sentTracks ? [] : out.tracks });
  }

  // 语音（F4/F14）：ASR 立即跑、绝不排队（V1.1.2）——转写一到就回显；
  // 之后才分流：热线轮次走快车道，点歌进管线队列
  app.post('/api/voice', (req, res) => {
    res.json({ ok: true });
    const body = req.body;
    // body 是音频流，待播队列走 query 参数（去重规则需要知道前端还没播的歌）
    let queued = [];
    try { queued = JSON.parse(req.query.queued || '[]'); } catch {}
    if (!Array.isArray(queued)) queued = [];
    (async () => {
      // content-type 不是 audio/* 时 body 是 {}，提前降级，避免白等 ffmpeg 超时
      if (!Buffer.isBuffer(body) || !body.length) {
        return broadcast({ type: 'voice-failed', reason: 'asr' });
      }
      let text;
      try {
        const { webmToPcm, transcribe } = asr ?? await import('./src/asr.js');
        text = await transcribe(await webmToPcm(body));
      } catch (e) {
        console.error('[asr]', e.message);
        return broadcast({ type: 'voice-failed', reason: 'asr' }); // 前端降级文字框（保留来电仪式）
      }
      broadcast({ type: 'user-message', transcript: text }); // 转写即回显，不等任何队列
      if (hot.on) return hotlineReceive(text, queued); // 热线：思考提示 + 快车道（F14）
      enqueue(`voice:${Date.now()}`, () => requestJob('voice', text, queued));
    })().catch(e => console.error('[voice]', e));
  });

  // ===== F12 品味自进化：周报提案 → 用户确认合入（taste.md 用户主权，没确认一个字不动）=====
  const weeklyDep = weekly ?? { run: () => runWeeklyReport(db), read: readReport, apply: applyReport };
  app.get('/api/taste/report', (req, res) => res.json({ ok: true, report: weeklyDep.read() }));
  app.post('/api/taste/report/generate', (req, res) => {
    enqueue('weekly', async () => {
      broadcast({ type: 'taste-report', report: await weeklyDep.run() }); // null = 信号不够，前端提示
    });
    res.json({ ok: true });
  });
  app.post('/api/taste/report/apply', (req, res) => {
    const accepted = Array.isArray(req.body?.accepted) ? req.body.accepted : [];
    const report = weeklyDep.apply(accepted);
    broadcast({ type: 'taste-applied', report });
    res.json({ ok: true, report });
  });

  // F12 行为信号：前端上报切歌（带进度）与自然听完；点歌信号由服务端在点歌路径自动记
  app.post('/api/signal', (req, res) => {
    const { type, title, artist, pct } = req.body || {};
    if (!['skip', 'finish'].includes(type) || !title || !artist) {
      return res.status(400).json({ ok: false });
    }
    db.addSignal({ type, title, artist, pct: Number.isFinite(pct) ? pct : null });
    res.json({ ok: true });
  });

  // 前端每开播一首歌上报一次（去重规则的数据源）
  app.post('/api/played', (req, res) => {
    const { title, artist, sourceUrl } = req.body || {};
    if (title && artist) db.addPlay({ title, artist, sourceUrl });
    res.json({ ok: true });
  });

  return { app, server, broadcast, db, hasClients: () => wss.clients.size > 0 };
}

// 直接运行时启动
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const { server, db, broadcast, hasClients } = createApp();
  server.listen(config.port, () =>
    console.log(`📻 卡塔赫纳柔和橙黑啤 → http://localhost:${config.port}`));
  // F11 定时主动节目：07:00 当日计划 / 09:00 早间自动开播 / 整点 vibe check / 日程提醒
  createScheduler({ db, broadcast, hasClients }).start();
  // F12「开机就补」：本地服务周日 20:00 未必开着——启动时若欠一份周报（≥7天且有信号），现补 + 推飞书
  if (isReportDue(db)) {
    runWeeklyReport(db)
      .then(report => report && pushLark(report).then(() => broadcast({ type: 'taste-report', report })))
      .catch(e => console.error('[weekly catch-up]', e.message));
  }
  // 预热开场白 + 首播曲候选：启动即备好"点开台第一秒有音乐、随即有人声"的弹药
  if (!readIntro()) {
    prepareIntro(db)
      .then(e => e && console.log(`[intro warmup] ${e.slot}「${e.text.slice(0, 24)}…」`))
      .catch(e => console.error('[intro warmup]', e.message));
  }
  if (!readOpener()) {
    prepareOpener(db)
      .then(c => c && console.log(`[opener warmup] 首播曲候选：${c.join(' / ')}`))
      .catch(e => console.error('[opener warmup]', e.message));
  }
}
