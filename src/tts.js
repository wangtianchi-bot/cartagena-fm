// src/tts.js
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config, ROOT } from './config.js';

const DEFAULT_CACHE = path.join(ROOT, 'cache', 'tts');

function voiceFor(role) {
  return role === 'caller' ? config.tts.caller : config.tts.dj;
}

export function cachePathFor(text, role, cacheDir = DEFAULT_CACHE) {
  const v = voiceFor(role);
  const key = crypto.createHash('md5').update(`${role}:${v.voiceType}:${text}`).digest('hex');
  return path.join(cacheDir, `${key}.mp3`);
}

// 返回 mp3 文件绝对路径。火山响应是逐行 JSON：code:0 带 base64 块，code:20000000 结束。
export async function synthesize(text, { role = 'dj', cacheDir = DEFAULT_CACHE, fetcher = fetch } = {}) {
  const file = cachePathFor(text, role, cacheDir);
  if (fs.existsSync(file)) return file;
  fs.mkdirSync(cacheDir, { recursive: true });

  const v = voiceFor(role);
  const res = await fetcher(config.tts.endpoint, {
    method: 'POST',
    headers: {
      'X-Api-App-Key': v.appId,
      'X-Api-Access-Key': v.accessToken,
      'X-Api-Resource-Id': v.resourceId,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      user: { uid: 'azu' },
      req_params: {
        text,
        speaker: v.voiceType,
        audio_params: { format: config.tts.format, sample_rate: config.tts.sampleRate },
      },
    }),
  });
  if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);

  const chunks = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.code === 0 && msg.data) chunks.push(Buffer.from(msg.data, 'base64'));
    else if (msg.code === 20000000) break;
    else if (msg.code !== 0) throw new Error(`TTS error ${msg.code}: ${msg.message || ''}`);
  }
  if (!chunks.length) throw new Error('TTS empty audio');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat(chunks));
  fs.renameSync(tmp, file); // 原子写，避免半截缓存被命中
  return file;
}
