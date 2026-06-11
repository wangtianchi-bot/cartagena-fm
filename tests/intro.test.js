// tests/intro.test.js —— 开场白预生成预合成
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareIntro, readIntro, timeSlot } from '../src/intro.js';
import { openDb } from '../src/db.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'intro-')), 'intro-cache.json');

test('prepareIntro：生成→TTS→落盘，readIntro 同时段命中', async () => {
  const db = openDb(':memory:');
  const cachePath = tmp();
  const ttsDir = path.dirname(cachePath);
  fs.writeFileSync(path.join(ttsDir, 'fake.mp3'), 'x'); // 模拟 TTS 产物存在
  const out = await prepareIntro(db, {
    cachePath,
    askJson: async (p) => {
      assert.ok(p.includes('绝对禁止')); // 无歌单硬约束必须在 prompt 里
      return { text: '十点的太阳很好，我去翻翻今天的歌，你先坐。' };
    },
    synthesize: async () => `${ttsDir}/fake.mp3`,
  });
  assert.equal(out.slot, timeSlot());
  const hit = readIntro({ cachePath, ttsDir });
  assert.equal(hit.text, '十点的太阳很好，我去翻翻今天的歌，你先坐。');
  assert.equal(hit.ttsUrl, '/tts/fake.mp3');
});

test('开场白出现《》→ 视为幻觉，不缓存', async () => {
  const db = openDb(':memory:');
  const cachePath = tmp();
  const out = await prepareIntro(db, {
    cachePath,
    askJson: async () => ({ text: '先来一首《晴天》怎么样' }),
    synthesize: async () => { throw new Error('不应走到 TTS'); },
  });
  assert.equal(out, null);
  assert.ok(!fs.existsSync(cachePath));
});

test('TTS 文件丢失 → readIntro 不命中（绝不广播播不出的开场）', async () => {
  const db = openDb(':memory:');
  const cachePath = tmp();
  const ttsDir = path.dirname(cachePath);
  await prepareIntro(db, {
    cachePath,
    askJson: async () => ({ text: '早。' }),
    synthesize: async () => `${ttsDir}/gone.mp3`, // 从未真正写文件
  });
  assert.equal(readIntro({ cachePath, ttsDir }), null);
});
