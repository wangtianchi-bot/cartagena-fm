// tests/asr.test.js —— 服务端响应帧解析（验收时发现：服务端可能回未压缩 JSON，不能无条件 gunzip）
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseServerFrame } from '../src/asr.js';

// 构造服务端响应帧：4 字节头 + 4 字节 sequence + 4 字节长度 + payload
function serverFrame({ type = 0b1001, flags = 0b0001, gzip = false, obj = {} }) {
  let payload = Buffer.from(JSON.stringify(obj));
  if (gzip) payload = zlib.gzipSync(payload);
  const head = Buffer.from([0x11, (type << 4) | flags, (1 << 4) | (gzip ? 1 : 0), 0x00]);
  const seq = Buffer.alloc(4); seq.writeInt32BE(1);
  const len = Buffer.alloc(4); len.writeUInt32BE(payload.length);
  return Buffer.concat([head, seq, len, payload]);
}

test('解析未压缩 JSON 响应帧（线上实测形态）', () => {
  const buf = serverFrame({ gzip: false, obj: { result: { text: '我想听红豆' } } });
  const { type, flags, obj } = parseServerFrame(buf);
  assert.equal(type, 0b1001);
  assert.equal(flags, 0b0001);
  assert.equal(obj.result.text, '我想听红豆');
});

test('解析 gzip 压缩响应帧（spike 实测形态）', () => {
  const buf = serverFrame({ gzip: true, obj: { result: { text: '来点安静的' } } });
  const { obj } = parseServerFrame(buf);
  assert.equal(obj.result.text, '来点安静的');
});

test('最终包 flags 带 0b0010 结束位', () => {
  const buf = serverFrame({ flags: 0b0011, gzip: false, obj: { result: { text: '完整句。' } } });
  const { type, flags, obj } = parseServerFrame(buf);
  assert.equal(type, 0b1001);
  assert.ok(flags & 0b0010);
  assert.equal(obj.result.text, '完整句。');
});

test('无法解析的帧返回 null 而不抛', () => {
  assert.equal(parseServerFrame(Buffer.from([0x11, 0x91, 0x11, 0x00, 0, 0, 0, 1])), null);
});
