// src/asr.js —— 火山流式识别：webm/opus → ffmpeg 转 16k pcm → WS 二进制协议 → 文本
// 协议帧格式与字段含义见 scripts/asr-spike.js（Task 2 已实测校准：响应帧带 4 字节 sequence，gzip 载荷从偏移 12 开始）
import WebSocket from 'ws';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { config } from './config.js';

export function webmToPcm(webmBuffer) {
  return new Promise((resolve, reject) => {
    const child = execFile('ffmpeg',
      ['-i', 'pipe:0', '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
      { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 15_000 },
      (err, stdout) => err ? reject(err) : resolve(stdout));
    // EPIPE 走 EventEmitter 而非 promise，必须吞掉否则打崩常驻进程（execFile 回调已用退出错误 reject）
    child.stdin.on('error', () => {});
    child.stdin.end(webmBuffer);
  });
}

function frame(type, flags, payload) {
  const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  const gz = zlib.gzipSync(raw);
  const head = Buffer.from([0x11, (type << 4) | flags, 0x11, 0x00]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(gz.length);
  return Buffer.concat([head, len, gz]);
}

// 服务端响应帧 → { type, flags, obj }；解析失败返回 null。
// 压缩与否以帧头 buf[2] 低 4 位为准——线上实测服务端会回未压缩 JSON（buf[2]=0x10），
// 无条件 gunzip 会把所有帧解崩导致超时（2026-06-11 验收时发现）。
export function parseServerFrame(buf) {
  try {
    const type = buf[1] >> 4;
    const flags = buf[1] & 0x0f;
    let payload = buf.subarray(12);
    if ((buf[2] & 0x0f) === 1) payload = zlib.gunzipSync(payload);
    return { type, flags, obj: JSON.parse(payload.toString()) };
  } catch { return null; }
}

// pcm: 16k 单声道 16bit。返回转写文本；失败 reject（上层降级文字框）。
export function transcribe(pcm, { timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.asr.endpoint, {
      headers: {
        'X-Api-App-Key': config.asr.appId,
        'X-Api-Access-Key': config.asr.accessToken,
        'X-Api-Resource-Id': config.asr.resourceId,
        'X-Api-Connect-Id': crypto.randomUUID(),
      },
    });
    let lastText = '';
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('asr timeout')); }, timeoutMs);
    const done = (fn, v) => { clearTimeout(timer); ws.close(); fn(v); };

    ws.on('open', () => {
      ws.send(frame(0b0001, 0, {
        user: { uid: 'azu' },
        audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1 },
        request: { model_name: 'bigmodel', enable_punc: true },
      }));
      const chunk = 3200;
      for (let i = 0; i < pcm.length; i += chunk) {
        ws.send(frame(0b0010, i + chunk >= pcm.length ? 0b0010 : 0, pcm.subarray(i, i + chunk)));
      }
    });
    ws.on('message', (data) => {
      const parsed = parseServerFrame(Buffer.from(data));
      if (!parsed) return; // 忽略无法解析的中间帧
      const { type, flags, obj } = parsed;
      if (obj?.result?.text) lastText = obj.result.text;
      if (type === 0b1001 && (flags & 0b0010)) {
        lastText ? done(resolve, lastText) : done(reject, new Error('asr empty'));
      }
    });
    ws.on('error', (e) => done(reject, e));
  });
}
