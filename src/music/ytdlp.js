// src/music/ytdlp.js —— 备用源：搜索 YouTube 取直链音频，20s 超时
import { execFile } from 'node:child_process';
import { config } from '../config.js';

function run(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile('yt-dlp', args, { timeout: timeoutMs }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

export async function getTrack(query) {
  const t = config.rules.ytdlpTimeoutMs;
  const url = await run(['--no-playlist', '--print', 'webpage_url', `ytsearch1:${query}`], t);
  if (!url) return null;
  const audioUrl = await run(['-x', '--get-url', url], t);
  if (!audioUrl) return null;
  const streamUrl = audioUrl.split('\n').map(s => s.trim()).find(Boolean) ?? null;
  if (!streamUrl) return null;
  const [title, artist] = query.split(' - ').map(s => s.trim());
  return { id: url, title: title || query, artist: artist || '未知', streamUrl, lyrics: '', source: 'yt-dlp' };
}
