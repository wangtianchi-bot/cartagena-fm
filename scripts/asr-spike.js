// scripts/asr-spike.js —— 验证火山 ASR（sauc bigmodel 流式大模型识别）完整收发链路
// 用法：node scripts/asr-spike.js path/to/audio.wav（16k 单声道 16bit PCM wav）
//
// 【已验证 2026-06-11，供 src/asr.js 移植参考】
// - 握手：4 个 X-Api-* 头即可，响应头 X-Tt-Logid 可用于排障。
// - 客户端帧：简单形式即可，**无需** sequence 字段。
//   首帧 full client request type=0b0001 flags=0；音频帧 type=0b0010，
//   最后一片 flags=0b0010 标记结束。payload 一律 gzip。
// - 服务端响应：type=0b1001，flags 带 0b0001 位 → 4 字节头后有 4 字节大端
//   int32 sequence（偏移 4），payload 长度在偏移 8，gzip payload 从偏移 12 开始。
//   最后一包 flags=0b0011（sequence + 结束位）。
// - 每 100ms 音频回一包增量结果，result.text 为当前完整转写（非追加），
//   最后一包带标点、utterances[].definite=true。
import WebSocket from 'ws';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { config } from '../src/config.js';

const wavPath = process.argv[2];
if (!wavPath) {
  console.error('用法：node scripts/asr-spike.js path/to/audio.wav');
  process.exit(1);
}
const pcm = fs.readFileSync(wavPath).subarray(44); // 跳过 wav 头

function frame(type, flags, payloadObj) {
  const raw = Buffer.isBuffer(payloadObj) ? payloadObj : Buffer.from(JSON.stringify(payloadObj));
  const gz = zlib.gzipSync(raw);
  const head = Buffer.from([0x11, (type << 4) | flags, 0x11, 0x00]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length);
  return Buffer.concat([head, len, gz]);
}

const ws = new WebSocket(config.asr.endpoint, {
  headers: {
    'X-Api-App-Key': config.asr.appId,
    'X-Api-Access-Key': config.asr.accessToken,
    'X-Api-Resource-Id': config.asr.resourceId,
    'X-Api-Connect-Id': crypto.randomUUID(),
  },
});

const timeout = setTimeout(() => {
  console.error('❌ 15s 超时未收到最终结果');
  process.exit(2);
}, 15000);

ws.on('upgrade', (res) => {
  console.log('握手响应 X-Tt-Logid:', res.headers['x-tt-logid']);
});

ws.on('open', () => {
  console.log('✅ 握手成功');
  ws.send(frame(0b0001, 0, {
    user: { uid: 'azu' },
    audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
    request: { model_name: 'bigmodel', enable_punc: true },
  }));
  // 模拟流式：按 100ms 分片发送，最后一片 flags=0b0010（NEG_SEQUENCE 标记结束）
  const chunk = 3200; // 16000Hz * 2byte * 0.1s
  for (let i = 0; i < pcm.length; i += chunk) {
    const last = i + chunk >= pcm.length;
    ws.send(frame(0b0010, last ? 0b0010 : 0, pcm.subarray(i, i + chunk)));
  }
});

ws.on('message', (data) => {
  const buf = Buffer.from(data);
  const type = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const serialization = buf[2] >> 4;      // 1=JSON, 0=none
  const compression = buf[2] & 0x0f;      // 1=gzip, 0=none
  // 校准点：服务端响应在 4 字节头后带 4 字节 sequence，payload 长度在偏移 8，payload 从偏移 12 开始。
  // 错误帧（type 0b1111）无 sequence：偏移 4 是错误码，偏移 8 是长度，payload 从 12 开始。
  let payloadBuf;
  let seqOrCode = buf.readInt32BE(4);
  payloadBuf = buf.subarray(12);
  if (compression === 1) {
    try { payloadBuf = zlib.gunzipSync(payloadBuf); }
    catch {
      // 退路：无 sequence 变体（payload 从偏移 8 开始）
      payloadBuf = zlib.gunzipSync(buf.subarray(8));
      seqOrCode = null;
    }
  }
  let obj = null;
  if (serialization === 1 && payloadBuf.length) {
    try { obj = JSON.parse(payloadBuf.toString()); } catch { /* 非 JSON */ }
  }
  console.log(`收到 type=0b${type.toString(2).padStart(4, '0')} flags=0b${flags.toString(2).padStart(4, '0')} seq/code=${seqOrCode}`,
    obj ? JSON.stringify(obj).slice(0, 300) : `<${payloadBuf.length} bytes>`);
  if (type === 0b1111) {
    console.error('❌ 服务端错误帧，错误码：', seqOrCode);
    process.exit(1);
  }
  if (obj?.result?.text !== undefined) console.log('🎤 转写结果：', obj.result.text);
  if (type === 0b1001 && (flags & 0b0010)) { // 最后一包（NEG_SEQUENCE flag）
    clearTimeout(timeout);
    console.log('🏁 收到最终包，转写完成');
    ws.close();
  }
});

ws.on('error', (e) => { console.error('❌', e.message); process.exit(1); });
ws.on('close', () => { clearTimeout(timeout); console.log('连接关闭'); });
