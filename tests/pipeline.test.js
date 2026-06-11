// tests/pipeline.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { runProgramStart, runRefill, runRequest, runHotlineTurn } from '../src/pipeline.js';
import { openDb } from '../src/db.js';

const TRACK = { title: '红豆', artist: '方大同', streamUrl: 'http://x/1', lyrics: '' };

// 可编程假依赖：pickReply→第一段返回值，scriptReply→第二段返回值
function fakeDeps({ pickReply, scriptReply, resolved = [TRACK] } = {}) {
  const calls = { prompts: [], tts: [] };
  return {
    calls,
    askJson: async (prompt) => {
      calls.prompts.push(prompt);
      return prompt.includes('"play"') ? pickReply : scriptReply; // 第一段 prompt 含 "play" 字样
    },
    resolveTracks: async (candidates) => ({ confirmed: resolved, failed: [] }),
    synthesize: async (text) => { calls.tts.push(text); return `/tmp/${calls.tts.length}.mp3`; },
  };
}

test('开台：选歌→验证→口播→TTS 全链路', async () => {
  const db = openDb(':memory:');
  const deps = fakeDeps({
    pickReply: { play: ['红豆 - 方大同'] },
    scriptReply: { title: '深夜场', segments: [
      { type: 'cold_open', position: 'before_track', trackIndex: 0, text: '十一点了，欢迎回来。', part: 'anchor' },
    ] },
  });
  const out = await runProgramStart(db, deps);
  assert.equal(out.tracks[0].title, '红豆');
  assert.equal(out.segments[0].ttsUrl, '/tts/1.mp3');
  // 第二段 prompt 必须只见确认歌单（含《红豆》），这是防幻觉的根
  const stage2 = deps.calls.prompts[1];
  assert.ok(stage2.includes('确认歌单'));
  assert.ok(stage2.includes('红豆'));
});

test('第一段失败 → 返回 null（上层退避）', async () => {
  const db = openDb(':memory:');
  const out = await runProgramStart(db, fakeDeps({ pickReply: null }));
  assert.equal(out, null);
});

test('第二段失败 → 静默续歌（有歌无口播，绝不念原文）', async () => {
  const db = openDb(':memory:');
  const out = await runRefill(db, fakeDeps({ pickReply: { play: ['红豆 - 方大同'] }, scriptReply: null }));
  assert.equal(out.tracks.length, 1);
  assert.deepEqual(out.segments, []);
});

test('验证后歌单全空 → 返回 null 而不是让 DJ 干念', async () => {
  const db = openDb(':memory:');
  const deps = fakeDeps({ pickReply: { play: ['x - y'] }, resolved: [] });
  assert.equal(await runRefill(db, deps), null);
});

test('点歌走 relaxed 解析（点名就给），自动选歌不放宽', async () => {
  const db = openDb(':memory:');
  const opts = [];
  const mk = () => ({
    askJson: async (p) => p.includes('"play"') ? { play: ['x - y'] } : { segments: [] },
    resolveTracks: async (c, o) => { opts.push(o.relaxed); return { confirmed: [TRACK], failed: [] }; },
    synthesize: async () => '/tmp/x.mp3',
  });
  await runRequest(db, '想听许嵩', mk());
  await runRefill(db, mk());
  assert.deepEqual(opts, [true, false]);
});

test('点歌：DJ 回应进 segments，对话写入 messages', async () => {
  const db = openDb(':memory:');
  const deps = fakeDeps({
    pickReply: { play: ['红豆 - 方大同'] },
    scriptReply: { segments: [{ type: 'quick_touch', position: 'immediate', text: '收到，红豆排到下一首。' }] },
  });
  const out = await runRequest(db, '我想听方大同', deps);
  assert.equal(out.segments[0].position, 'immediate');
  const msgs = db.recentMessages(8);
  assert.ok(msgs.some(m => m.role === 'user' && m.content.includes('方大同')));
  assert.ok(msgs.some(m => m.role === 'dj'));
});

test('notify：歌单确认即上报 tracks，阶段进度依次上报（开台提速的根）', async () => {
  const db = openDb(':memory:');
  const events = [];
  const deps = fakeDeps({
    pickReply: { play: ['红豆 - 方大同'] },
    scriptReply: { title: '深夜场', segments: [
      { type: 'cold_open', position: 'before_track', trackIndex: 0, text: '十一点了。', part: 'anchor' },
    ] },
  });
  deps.notify = (n) => events.push(n);
  const out = await runProgramStart(db, deps);
  assert.ok(out);
  // tracks 事件必须在管线返回前就带着确认歌单发出（前端靠它先开播音乐）
  const trackEvt = events.find(e => e.event === 'tracks');
  assert.equal(trackEvt.tracks[0].title, '红豆');
  // 进度事件覆盖关键阶段
  const stages = events.filter(e => e.event === 'progress').map(e => e.stage);
  assert.ok(stages.includes('选歌'));
  assert.ok(stages.includes('口播'));
  assert.ok(stages.includes('合成'));
});

test('TTS 并行合成：5 段耗时 ≈ 单段而非 5 倍', async () => {
  const db = openDb(':memory:');
  const segs = ['anchor', 'heart', 'turn', 'image', 'invitation'].map((p, i) => (
    { type: 'cold_open', position: 'before_track', trackIndex: 0, text: `第${i}句。`, part: p }
  ));
  const deps = fakeDeps({ pickReply: { play: ['红豆 - 方大同'] }, scriptReply: { title: 'T', segments: segs } });
  let inflight = 0, maxInflight = 0;
  deps.synthesize = async () => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 30));
    inflight--;
    return '/tmp/x.mp3';
  };
  const out = await runProgramStart(db, deps);
  assert.equal(out.segments.length, 5);
  assert.ok(maxInflight >= 2, `TTS 应并行合成，实际最大并发 ${maxInflight}`);
});

test('单条 TTS 失败 → 该段降级 text-only，不丢文本', async () => {
  const db = openDb(':memory:');
  const deps = fakeDeps({
    pickReply: { play: ['红豆 - 方大同'] },
    scriptReply: { segments: [{ type: 'bridge', position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 0, text: '下一首红豆。' }] },
  });
  deps.synthesize = async () => { throw new Error('tts down'); };
  const out = await runRefill(db, deps);
  assert.equal(out.segments[0].status, 'text-only');
  assert.equal(out.segments[0].text, '下一首红豆。');
});

// ===== F14 情感热线（V1.1.6 流式）=====
test('热线流式：逐字 delta → 句末标点即切句 emit sentence（保序）→ 终局 reply 拼全', async () => {
  const db = openDb(':memory:');
  const events = [];
  const out = await runHotlineTurn(db, [{ role: 'user', text: '前情' }, { role: 'dj', text: '嗯' }], '我失恋了', {
    chatStream: async (messages, { onDelta }) => {
      assert.equal(messages[0].role, 'system');            // 多轮走 messages 数组
      assert.equal(messages.at(-1).content, '我失恋了');
      for (const d of ['失恋', '了啊。', '想说', '就说？']) onDelta(d); // 模拟流式分块
      return '失恋了啊。想说就说？';
    },
    synthesize: async () => '/tmp/cache/tts/x.mp3',
    emit: (n) => events.push(n),
  });
  const sentences = events.filter(e => e.event === 'sentence').map(e => e.segment.text);
  assert.deepEqual(sentences, ['失恋了啊。', '想说就说？']); // 句末标点出现就出句，顺序不乱
  assert.ok(events.filter(e => e.event === 'delta').length >= 4);
  assert.equal(out.reply, '失恋了啊。想说就说？');
  assert.equal(out.closing, false);
  assert.equal(db.recentMessages(4).some(m => m.role === 'user' && m.content === '我失恋了'), true);
});

test('热线流式：用户话带告别词 → closing=true（规则判断，不靠 LLM 输出字段）', async () => {
  const db = openDb(':memory:');
  const out = await runHotlineTurn(db, [], '就这样吧，拜拜', {
    chatStream: async (m, { onDelta }) => { onDelta('嗯，晚安。'); return '嗯，晚安。'; },
    synthesize: async () => '/tmp/cache/tts/x.mp3',
  });
  assert.equal(out.closing, true);
});

test('热线流式：流式失败且零产出 → 回退非流式兜底；冒出白名单外《歌名》→ 降级', async () => {
  const db = openDb(':memory:');
  const out = await runHotlineTurn(db, [], '随便聊聊', {
    chatStream: async () => { throw new Error('stream down'); },
    chatOnce: async () => '我放一首《不存在的歌》给你。',
    synthesize: async () => '/tmp/cache/tts/x.mp3',
  });
  assert.equal(out, null); // 唯一一句被防幻觉闸门降级成 silence → 无可播文本 → null（上层提示重说）
});
