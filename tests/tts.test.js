// tests/tts.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { synthesize, cachePathFor } from '../src/tts.js';

// 伪造火山逐行 JSON 流：两个音频块 + 结束行
function fakeFetcher(bodyCollector) {
  return async (url, opts) => {
    bodyCollector?.push(JSON.parse(opts.body));
    const lines = [
      JSON.stringify({ code: 0, data: Buffer.from('AAA').toString('base64') }),
      JSON.stringify({ code: 0, data: Buffer.from('BBB').toString('base64') }),
      JSON.stringify({ code: 20000000 }),
    ].join('\n');
    return new Response(lines, { status: 200 });
  };
}

test('synthesize: 拼接音频块并落盘', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const file = await synthesize('测试一句话', { role: 'dj', cacheDir: dir, fetcher: fakeFetcher() });
  assert.equal(fs.readFileSync(file).toString(), 'AAABBB');
});

test('synthesize: 命中缓存不再发请求', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const calls = [];
  await synthesize('同一句', { role: 'dj', cacheDir: dir, fetcher: fakeFetcher(calls) });
  await synthesize('同一句', { role: 'dj', cacheDir: dir, fetcher: fakeFetcher(calls) });
  assert.equal(calls.length, 1);
});

test('cachePathFor: 不同角色同文本缓存不同', () => {
  assert.notEqual(cachePathFor('你好', 'dj', '/c'), cachePathFor('你好', 'caller', '/c'));
});

test('synthesize: code 非 0 报错（不静默吞坏音频）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tts-'));
  const bad = async () => new Response(JSON.stringify({ code: 55000010, message: 'mismatch' }), { status: 200 });
  await assert.rejects(() => synthesize('x', { role: 'dj', cacheDir: dir, fetcher: bad }), /55000010/);
});
