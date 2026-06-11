// tests/db.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { openDb } from '../src/db.js';

test('plays: 写入并按时间倒序读出', () => {
  const db = openDb(':memory:');
  db.addPlay({ title: '玫瑰', artist: '贰佰', sourceUrl: 'http://x/1' });
  db.addPlay({ title: '春风十里', artist: '鹿先森乐队', sourceUrl: 'http://x/2' });
  const plays = db.recentPlays(20);
  assert.equal(plays.length, 2);
  assert.equal(plays[0].title, '春风十里'); // 最新在前
});

test('playedWithin: 24h 同曲冷却判定', () => {
  const db = openDb(':memory:');
  db.addPlay({ title: '玫瑰', artist: '贰佰', sourceUrl: '' });
  assert.equal(db.playedWithin('玫瑰', '贰佰', 24 * 3600_000), true);
  assert.equal(db.playedWithin('不存在的歌', '谁', 24 * 3600_000), false);
});

test('recentArtists: 近 N 首艺人列表', () => {
  const db = openDb(':memory:');
  for (const a of ['A', 'B', 'C']) db.addPlay({ title: 't', artist: a, sourceUrl: '' });
  assert.deepEqual(db.recentArtists(2), ['C', 'B']);
});

test('signals: 三类行为信号写入读出（F12）', () => {
  const db = openDb(':memory:');
  db.addSignal({ type: 'skip', title: '玫瑰', artist: '贰佰', pct: 0.12 });
  db.addSignal({ type: 'finish', title: '红豆', artist: '方大同', pct: 1 });
  db.addSignal({ type: 'request', title: '晴天', artist: '周杰伦' }); // pct 可缺省
  const sigs = db.signalsSince(Date.now() - 1000);
  assert.equal(sigs.length, 3);
  assert.equal(sigs[0].type, 'skip');
  assert.equal(sigs[0].pct, 0.12);
  assert.equal(sigs[2].pct, null);
});

test('signalsSince: 只取窗口内的信号', () => {
  const db = openDb(':memory:');
  db.addSignal({ type: 'finish', title: 'a', artist: 'x', pct: 1 });
  assert.equal(db.signalsSince(Date.now() + 1000).length, 0);
});

test('messages: 写入读出近 N 条（时间正序，老的在前）', () => {
  const db = openDb(':memory:');
  db.addMessage('user', '来点适合下雨天的');
  db.addMessage('dj', '收到，下一首给你排上');
  const msgs = db.recentMessages(8);
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'user');
});
