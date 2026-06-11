// src/pipeline.js —— 两段式管线：选歌 → 现实验证 → 口播（只见确认歌单）→ TTS
import path from 'node:path';
import { buildContext, buildChatContext } from './context.js';
import { askJson as realAskJson, chatStream as realChatStream, chatOnce as realChatOnce } from './llm.js';
import { buildPickPrompt, buildScriptPrompt, buildHotlineSystem, buildVibePrompt } from './prompts.js';
import { sanitizeSegments, countHan } from './segments.js';
import { resolveTracks as realResolve } from './music/index.js';
import { synthesize as realSynthesize } from './tts.js';

// 节奏反馈（满串场模式下不再建议沉默，只控制长度，V1.0.8）
function recentTalkFeedback(db) {
  const djTalks = db.recentMessages(8).filter(m => m.role === 'dj').slice(-3);
  if (djTalks.length >= 2 && djTalks.every(m => countHan(m.content) > 60)) {
    return '最近几次串场都偏长，这次说短一点。';
  }
  return '';
}

// 并行合成：开台延迟瓶颈之一是 5 段冷开场逐段串行 TTS（验收反馈 2026-06-11）
async function synthesizeSegments(segments, synthesize) {
  await Promise.all(segments.map(async (s) => {
    if (s.type === 'silence' || !s.text) { s.status = 'silent'; return; }
    try {
      const file = await synthesize(s.text, { role: 'dj' });
      s.ttsUrl = '/tts/' + path.basename(file);
      s.status = 'ready';
    } catch (e) {
      console.error('[tts] 降级 text-only:', e.message);
      s.status = 'text-only'; // TTS 挂了显示文字，不报错
    }
  }));
  return segments;
}

function recordDjTalk(db, segments) {
  const said = segments.filter(s => s.text).map(s => s.text).join(' ');
  if (said) db.addMessage('dj', said);
}

// 非可重入：依赖 server 单工任务队列串行调用
// 核心管线。pickArgs 决定第一段怎么问，scriptKind 决定第二段写什么。
// deps.notify：阶段事件回调（{event:'progress',stage} / {event:'tracks',tracks}）——
// 歌单一确认就上报，前端先开播音乐，口播随后压混进来（验收反馈：开台 35s 体感差）。
async function runStage(db, deps, { pickArgs, scriptKind, userText = '' }) {
  const { askJson = realAskJson, resolveTracks = realResolve, synthesize = realSynthesize, queued = [] } = deps;
  const notify = typeof deps.notify === 'function' ? deps.notify : () => {};
  const ctx = await buildContext(db);

  notify({ event: 'progress', stage: '选歌' });
  const pick = await askJson(buildPickPrompt(ctx, pickArgs));            // 【第一段】
  if (!pick?.play?.length) return null;

  notify({ event: 'progress', stage: '验证' });
  // 明确点歌放宽去重（点名就给）；自动选歌仍走 24h 冷却 + 同艺人回避
  const relaxed = pickArgs.reason === 'request';
  const { confirmed, failed } = await resolveTracks(pick.play, { db, queued, relaxed }); // 现实关卡
  if (!confirmed.length) return null;
  notify({ event: 'tracks', tracks: confirmed });

  notify({ event: 'progress', stage: '口播' });
  const script = await askJson(buildScriptPrompt(ctx, {                  // 【第二段】只见确认歌单
    tracks: confirmed, kind: scriptKind, userText, recentTalk: recentTalkFeedback(db),
    nowPlaying: deps.nowPlaying ?? null, // 满串场：进场点评要从正在播的歌说起（V1.0.8）
  }));
  notify({ event: 'progress', stage: '合成' });
  // 第二段失败 → 静默续歌：有歌、零口播，绝不把原始文本当口播
  // 白名单 = 正在播的歌 + 最近播放（满串场允许点评刚播过的歌，其余《》仍按幻觉降级）
  const extraKnown = [deps.nowPlaying?.title, ...db.recentPlays(5).map(p => p.title)].filter(Boolean);
  const segments = script ? sanitizeSegments(script.segments, confirmed, extraKnown) : [];
  await synthesizeSegments(segments, synthesize);
  recordDjTalk(db, segments);
  return { title: String(script?.title || '').slice(0, 20), tracks: confirmed, segments, failed };
}

// 开场白已由 intro 预缓存秒播（src/intro.js），开台管线只写歌间串场，不再生成冷开场
// V1.0.8 音乐先行：deps.nowPlaying = 首播曲（已在播），deps.queued 把它带进去重，进场串场从它说起
export function runProgramStart(db, deps = {}) {
  return runStage(db, deps, { pickArgs: { reason: 'open' }, scriptKind: 'bridge' });
}

// 点歌快路径第二步：歌已直搜直切（quickSearch），这里只让 DJ 补一句 ≤20 字回应
export async function runQuickRequest(db, userText, tracks, deps = {}) {
  const { askJson = realAskJson, synthesize = realSynthesize } = deps;
  db.addMessage('user', userText);
  const script = await askJson(buildScriptPrompt(await buildContext(db), {
    tracks, kind: 'response', userText, recentTalk: recentTalkFeedback(db),
  }));
  const segments = script ? sanitizeSegments(script.segments, tracks) : [];
  await synthesizeSegments(segments, synthesize);
  recordDjTalk(db, segments);
  return { title: '', tracks, segments, failed: [] };
}

export function runRefill(db, deps = {}) {
  return runStage(db, deps, { pickArgs: { reason: 'refill' }, scriptKind: 'bridge' });
}

// 点歌与情绪指令共用：kind=request|mood
export async function runRequest(db, userText, deps = {}, kind = 'request') {
  db.addMessage('user', userText);
  return runStage(db, deps, {
    pickArgs: { reason: kind, userText }, scriptKind: 'response', userText,
  });
}

// ===== F11 整点 vibe check / 日程提醒 =====
// 一句很短的口播，由 scheduler 触发、前端排在下一个接缝播出（F3 接缝红线不破）。
// 防幻觉：禁报歌名，白名单只放最近播放；越线降级 silence → 返回 null（宁可这个整点不说话）。
export async function runVibeCheck(db, deps = {}, { event = null } = {}) {
  const { askJson = realAskJson, synthesize = realSynthesize, buildCtx = buildContext } = deps;
  const out = await askJson(buildVibePrompt(await buildCtx(db), { event }));
  const text = String(out?.text || '').trim();
  if (!text) return null;
  const extraKnown = db.recentPlays(5).map(p => p.title);
  const segments = sanitizeSegments(
    [{ type: 'quick_touch', position: 'immediate', text }], [], extraKnown)
    .filter(s => s.type !== 'silence');
  if (!segments.length) return null;
  await synthesizeSegments(segments, synthesize);
  recordDjTalk(db, segments);
  return { segments };
}

// ===== F14 情感热线（V1.1.6 流式重写，学 Claudio）=====
// 一轮通话：流式纯文本——逐字 emit delta（前端字幕逐字打出），句末标点一出现就切句、
// 串行 TTS（保序，第一句最快出声）逐句 emit sentence。收线判断 = 用户话里的告别词（不再让 LLM 输出 JSON 字段）。
const GOODBYE_RE = /(拜拜|再见|就这样吧?|先这样|挂了|不聊了|去忙|睡了|晚安)/;

export async function runHotlineTurn(db, turns, userText, deps = {}) {
  const { synthesize = realSynthesize, chatStream = realChatStream, chatOnce = realChatOnce,
          emit = () => {}, sysNote = null, allowTitles = [] } = deps;
  db.addMessage('user', userText);
  // 多轮走标准 messages 数组（system + 逐轮 user/assistant），模型对轮次的理解远好于拼接大 prompt
  // sysNote（V1.1.9）：规则级工具的执行结果（"歌已切好"）——卡卡看得到刚发生的事，只需口头确认
  const messages = [
    { role: 'system', content: buildHotlineSystem(buildChatContext(db)) },
    ...turns.map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text })),
    ...(sysNote ? [{ role: 'system', content: sysNote }] : []),
    { role: 'user', content: userText },
  ];
  // 热线闲聊不该出现《》报歌；万一出现，按白名单（最近播放+刚切上的歌）外即幻觉的老规矩降级
  const extraKnown = [...allowTitles, ...db.recentPlays(5).map(p => p.title)];
  const segments = [];
  let ttsChain = Promise.resolve(); // 串行链保证句序：第一句永远第一个响
  const pushSentence = (text) => {
    const [seg] = sanitizeSegments([{ type: 'quick_touch', position: 'immediate', text }], [], extraKnown);
    if (!seg) return;
    segments.push(seg);
    ttsChain = ttsChain.then(async () => {
      if (seg.type !== 'silence') {
        try {
          const file = await synthesize(seg.text, { role: 'dj' });
          seg.ttsUrl = '/tts/' + path.basename(file);
          seg.status = 'ready';
        } catch (e) {
          console.error('[tts] 热线句降级 text-only:', e.message);
          seg.status = 'text-only';
        }
      }
      emit({ event: 'sentence', segment: seg });
    });
  };
  let buffer = '';
  const onDelta = (d) => {
    emit({ event: 'delta', text: d });
    buffer += d;
    let m;
    while ((m = buffer.match(/[。！？…!?]/))) {
      const sent = buffer.slice(0, m.index + 1).trim();
      buffer = buffer.slice(m.index + 1);
      if (sent) pushSentence(sent);
    }
  };
  try {
    await chatStream(messages, { timeoutMs: 20_000, maxTokens: 300, onDelta });
  } catch (e) {
    console.error('[hotline] 流式失败:', e.message);
    // 一个字都没出来才走非流式兜底；出过字就用已有的，别重复
    if (!segments.length && !buffer.trim()) {
      try { onDelta(await chatOnce(messages, { timeoutMs: 15_000, maxTokens: 300 })); }
      catch (e2) { console.error('[hotline] 兜底也失败:', e2.message); }
    }
  }
  const rest = buffer.trim();
  if (rest) pushSentence(rest);
  await ttsChain;
  const reply = segments.filter(s => s.text).map(s => s.text).join('');
  if (!reply) return null;
  db.addMessage('dj', reply);
  return { reply, closing: GOODBYE_RE.test(userText), segments };
}

// 收歌仪式：通话摘要 → 两段式选 1 首贴合的歌 + 送歌口播（压垫乐说，说完音乐渐起）
export function runHotlineSong(db, summary, deps = {}) {
  return runStage(db, deps, {
    pickArgs: { reason: 'hotline', count: 1, userText: summary },
    scriptKind: 'send_song', userText: summary,
  });
}
