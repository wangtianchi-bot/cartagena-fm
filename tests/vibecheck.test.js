// tests/vibecheck.test.js —— F11 整点 vibe check / 日程提醒口播
import { test } from 'node:test';
import assert from 'node:assert';
import { runVibeCheck } from '../src/pipeline.js';
import { openDb } from '../src/db.js';

const deps = (text, synthCalls = []) => {
  const d = {
    buildCtx: async () => 'CTX',
    askJson: async (prompt) => { d.lastPrompt = prompt; return text == null ? null : { text }; },
    synthesize: async (t) => { synthCalls.push(t); return '/tmp/fake.mp3'; },
  };
  return d;
};

test('runVibeCheck: 整点 → 单条 immediate segment + TTS', async () => {
  const db = openDb(':memory:');
  const out = await runVibeCheck(db, deps('两点了，窗外有点闷热，接着放轻的。'));
  assert.equal(out.segments.length, 1);
  assert.equal(out.segments[0].position, 'immediate');
  assert.equal(out.segments[0].status, 'ready');
  assert.ok(out.segments[0].ttsUrl);
});

test('runVibeCheck: 日程提醒模式 → prompt 含事件名', async () => {
  const db = openDb(':memory:');
  const d = deps('提醒一句，半小时后有个面试，这首之后我少说话。');
  const out = await runVibeCheck(db, d, { event: { title: '模拟面试', start: new Date() } });
  assert.ok(d.lastPrompt.includes('模拟面试'), 'prompt 应包含事件名');
  assert.ok(out.segments[0].text.includes('面试'));
});

test('runVibeCheck: 提到歌单外歌名 → 防幻觉降级 → null（宁可沉默）', async () => {
  const db = openDb(':memory:');
  const out = await runVibeCheck(db, deps('接下来听《不存在的歌》吧。'));
  assert.equal(out, null);
});

test('runVibeCheck: 提到最近播过的歌 → 放行（白名单）', async () => {
  const db = openDb(':memory:');
  db.addPlay({ title: '红豆', artist: '方大同' });
  const out = await runVibeCheck(db, deps('刚那首《红豆》收得真稳。'));
  assert.ok(out.segments[0].text.includes('红豆'));
});

test('runVibeCheck: LLM 挂了 → null（绝不硬凑口播）', async () => {
  const db = openDb(':memory:');
  assert.equal(await runVibeCheck(db, deps(null)), null);
});
