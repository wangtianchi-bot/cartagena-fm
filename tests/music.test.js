// tests/music.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { resolveTracks } from '../src/music/index.js';
import { openDb } from '../src/db.js';

// 伪造 provider：查表返回 track 或 null
function fakeProvider(table) {
  return { getTrack: async (q) => table[q] ?? null };
}

const SONG = (t, a) => ({ id: 1, title: t, artist: a, streamUrl: `http://x/${t}`, lyrics: '' });

test('resolveTracks: 可播的进确认单，查不到的进 failed', async () => {
  const db = openDb(':memory:');
  const { confirmed, failed } = await resolveTracks(
    ['红豆 - 方大同', '不存在 - 谁'],
    { db, provider: fakeProvider({ '红豆 - 方大同': SONG('红豆', '方大同') }) });
  assert.equal(confirmed.length, 1);
  assert.equal(confirmed[0].title, '红豆');
  assert.deepEqual(failed, ['不存在 - 谁']);
});

test('resolveTracks: 24h 内播过的同曲被拒', async () => {
  const db = openDb(':memory:');
  db.addPlay({ title: '红豆', artist: '方大同' });
  const { confirmed, failed } = await resolveTracks(
    ['红豆 - 方大同'],
    { db, provider: fakeProvider({ '红豆 - 方大同': SONG('红豆', '方大同') }) });
  assert.equal(confirmed.length, 0);
  assert.equal(failed.length, 1);
});

test('resolveTracks: 近 5 首出现过的艺人被回避', async () => {
  const db = openDb(':memory:');
  db.addPlay({ title: '爱爱爱', artist: '方大同' });
  const { confirmed } = await resolveTracks(
    ['红豆 - 方大同'],
    { db, provider: fakeProvider({ '红豆 - 方大同': SONG('红豆', '方大同') }) });
  assert.equal(confirmed.length, 0);
});

test('resolveTracks: 同批次内去重（LLM 重复给同一首）', async () => {
  const db = openDb(':memory:');
  const tbl = { '红豆 - 方大同': SONG('红豆', '方大同') };
  const { confirmed } = await resolveTracks(
    ['红豆 - 方大同', '红豆 - 方大同'], { db, provider: fakeProvider(tbl) });
  assert.equal(confirmed.length, 1);
});

test('resolveTracks: 多候选并行解析（开台提速），确认顺序仍按候选顺序', async () => {
  const db = openDb(':memory:');
  let inflight = 0, maxInflight = 0;
  const provider = { getTrack: async (q) => {
    inflight++; maxInflight = Math.max(maxInflight, inflight);
    await new Promise(r => setTimeout(r, 20));
    inflight--;
    const [t, a] = q.split(' - ');
    return SONG(t, a);
  } };
  const { confirmed } = await resolveTracks(
    ['红豆 - 方大同', '安和桥 - 宋冬野', '理想 - 赵雷'], { db, provider });
  assert.ok(maxInflight >= 2, `解析应并行，实际最大并发 ${maxInflight}`);
  assert.deepEqual(confirmed.map(t => t.title), ['红豆', '安和桥', '理想']);
});

test('resolveTracks: relaxed（明确点歌）跳过 24h 冷却与同艺人回避，但仍挡队列重复', async () => {
  const db = openDb(':memory:');
  db.addPlay({ title: '有何不可', artist: '许嵩' }); // 24h 冷却 + 近 5 首艺人都命中
  const tbl = {
    '有何不可 - 许嵩': SONG('有何不可', '许嵩'),
    '雅俗共赏 - 许嵩': SONG('雅俗共赏', '许嵩'),
  };
  // 默认规则：全被拦
  const strict = await resolveTracks(Object.keys(tbl), { db, provider: fakeProvider(tbl) });
  assert.equal(strict.confirmed.length, 0);
  // relaxed：点名就给——这是"点歌直接切播"的配套（azu 决策 2026-06-11）
  const relaxed = await resolveTracks(Object.keys(tbl), { db, provider: fakeProvider(tbl), relaxed: true });
  assert.deepEqual(relaxed.confirmed.map(t => t.title), ['有何不可', '雅俗共赏']);
  // relaxed 仍不重复队列里已有的歌
  const queued = await resolveTracks(['有何不可 - 许嵩'],
    { db, provider: fakeProvider(tbl), relaxed: true, queued: [{ title: '有何不可', artist: '许嵩' }] });
  assert.equal(queued.confirmed.length, 0);
});

test('resolveTracks: 队列里已有的歌不再确认', async () => {
  const db = openDb(':memory:');
  const tbl = { '红豆 - 方大同': SONG('红豆', '方大同') };
  const { confirmed } = await resolveTracks(
    ['红豆 - 方大同'],
    { db, provider: fakeProvider(tbl), queued: [{ title: '红豆', artist: '方大同' }] });
  assert.equal(confirmed.length, 0);
});
