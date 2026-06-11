// tests/quickpick.test.js —— 点歌快路径：点名抽取 + 直搜直切（借鉴 Claudio V1.5 的 play_music 工具路径）
import { test } from 'node:test';
import assert from 'node:assert';
import { extractSongQuery } from '../src/quickpick.js';

test('明确点名：常见句式都能抽出关键词', () => {
  assert.equal(extractSongQuery('我想听许嵩的音乐。'), '许嵩');
  assert.equal(extractSongQuery('想听周杰伦的歌'), '周杰伦');
  assert.equal(extractSongQuery('来一首红豆'), '红豆');
  assert.equal(extractSongQuery('点一首安和桥吧'), '安和桥');
  assert.equal(extractSongQuery('放一首方大同的爱爱爱'), '方大同的爱爱爱');
  assert.equal(extractSongQuery('我要听稻香'), '稻香');
  assert.equal(extractSongQuery('切到晴天'), '晴天');
  assert.equal(extractSongQuery('换成李荣浩'), '李荣浩');
});

test('模糊/情绪请求：不抽取，留给 LLM 消化', () => {
  assert.equal(extractSongQuery('来点适合下雨天的'), null);
  assert.equal(extractSongQuery('放松一下'), null);
  assert.equal(extractSongQuery('我好累'), null);
  assert.equal(extractSongQuery('安静点的'), null);
  assert.equal(extractSongQuery('来一首歌'), null); // 剥完只剩空
  assert.equal(extractSongQuery('随便放点什么'), null);
});

test('尾缀与标点剥干净', () => {
  assert.equal(extractSongQuery('想听陈奕迅的歌！'), '陈奕迅');
  assert.equal(extractSongQuery('来一首《孤勇者》'), '孤勇者');
  assert.equal(extractSongQuery('想听 Taylor Swift 的音乐呢'), 'Taylor Swift');
});
