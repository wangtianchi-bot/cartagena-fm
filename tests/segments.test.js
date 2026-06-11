// tests/segments.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { sanitizeSegments, countHan } from '../src/segments.js';

const tracks = [{ title: '红豆', artist: '方大同' }, { title: '理想三旬', artist: '陈鸿宇' }];

test('结构非法的 segment 被丢弃', () => {
  const out = sanitizeSegments([
    { type: 'bridge', position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1, text: '下一首理想三旬' },
    { type: '不存在的类型', position: 'immediate', text: 'x' },
    { type: 'bridge', position: 'between_tracks', afterTrackIndex: 5, beforeTrackIndex: 6, text: '索引越界' },
  ], tracks);
  assert.equal(out.length, 1);
});

test('提及歌单外曲目 → 降级为 silence', () => {
  const out = sanitizeSegments([
    { type: 'bridge', position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1,
      text: '接下来是《晴天》，周杰伦的经典' },
  ], tracks);
  assert.equal(out[0].type, 'silence');
  assert.equal(out[0].text, '');
});

test('提及歌单内曲目 → 原样通过', () => {
  const out = sanitizeSegments([
    { type: 'back_announce', position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1,
      text: '刚才那首《红豆》，方大同 2007 年的版本' },
  ], tracks);
  assert.equal(out[0].type, 'back_announce');
});

test('silence 永远合法且 text 置空', () => {
  const out = sanitizeSegments([
    { type: 'silence', position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1, text: '随便' },
  ], tracks);
  assert.equal(out[0].text, '');
});

test('extraKnown 白名单（V1.0.8 满串场）：点评刚播过的歌不算幻觉，名单外仍降级', () => {
  const seg = (text) => [{ type: 'back_announce', position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1, text }];
  // 白名单内（正在播/最近播放）→ 通过
  const ok = sanitizeSegments(seg('刚才的《岁月神偷》很妙，接下来《红豆》'), tracks, ['岁月神偷']);
  assert.equal(ok[0].type, 'back_announce');
  // 白名单外 → 仍按幻觉降级 silence
  const bad = sanitizeSegments(seg('刚才的《晴天》很妙'), tracks, ['岁月神偷']);
  assert.equal(bad[0].type, 'silence');
});

test('countHan 只数汉字', () => {
  assert.equal(countHan('红豆abc，123理想'), 4);
});

test('非数组/坏 text 类型不炸', () => {
  assert.deepEqual(sanitizeSegments(null, tracks), []);
  const out = sanitizeSegments([
    { type: 'bridge', position: 'between_tracks', afterTrackIndex: 0, beforeTrackIndex: 1, text: 0 },
  ], tracks);
  assert.equal(out[0].type, 'silence');
});

test('splitSentences：按句末标点分句（热线断句呼吸感）', async () => {
  const { splitSentences } = await import('../src/segments.js');
  assert.deepEqual(splitSentences('嗯。后来呢？好'), ['嗯。', '后来呢？', '好']);
  assert.deepEqual(splitSentences('就一句'), ['就一句']);
  assert.deepEqual(splitSentences(''), []);
});

test('V1.1.9 包含匹配：《晴天》⊂ 翻唱长名放行；完全无关的《傲寒》仍拦（实测案例）', () => {
  const cover = [{ title: '晴天周杰伦(从前从前有个人爱你很久)', artist: '沈幼楚' }];
  const seg = (text) => [{ type: 'quick_touch', position: 'immediate', text }];
  assert.equal(sanitizeSegments(seg('已经切了，《晴天》这会儿正放着呢。'), cover)[0].type, 'quick_touch');
  assert.equal(sanitizeSegments(seg('来，马頔这首《傲寒》。'), cover)[0].type, 'silence');
});
