// src/music/netease.js —— 依赖本地 sidecar：npx NeteaseCloudMusicApi（端口 3000）
import { readFileSync, statSync } from 'node:fs';
import { config, ROOT } from '../config.js';

// sidecar 不保存用户登录态，每次请求需回传扫码登录落盘的 cookie（scripts/netease-login.js 写入）
const COOKIE_PATH = `${ROOT}/data/netease-cookie.txt`;
let cookieCache = { mtimeMs: 0, value: '' };
function loginCookie() {
  try {
    const { mtimeMs } = statSync(COOKIE_PATH);
    if (mtimeMs !== cookieCache.mtimeMs) {
      cookieCache = { mtimeMs, value: readFileSync(COOKIE_PATH, 'utf8').trim() };
    }
  } catch { cookieCache = { mtimeMs: 0, value: '' }; }
  return cookieCache.value;
}

async function getJson(pathname, fetcher) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.rules.neteaseTimeoutMs);
  try {
    const cookie = loginCookie();
    const res = await fetcher(`${config.neteaseBase}${pathname}`, {
      signal: ctrl.signal,
      ...(cookie ? { headers: { Cookie: cookie } } : {}),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function hydrate(song, fetcher) {
  const urlRes = await getJson(`/song/url/v1?id=${song.id}&level=standard`, fetcher);
  const streamUrl = urlRes?.data?.[0]?.url;
  if (!streamUrl) return null; // 无版权/需会员 → 当作不可播

  const lyricRes = await getJson(`/lyric?id=${song.id}`, fetcher);
  return {
    id: song.id,
    title: song.name,
    artist: (song.artists || song.ar || []).map(a => a.name).join('/') || '未知',
    streamUrl,
    lyrics: lyricRes?.lrc?.lyric || '',
    source: 'netease',
  };
}

// query 形如 "红豆 - 方大同"。返回 {id,title,artist,streamUrl,lyrics} 或 null。
export async function getTrack(query, fetcher = fetch) {
  const search = await getJson(`/search?keywords=${encodeURIComponent(query)}&type=1&limit=1`, fetcher);
  const song = search?.result?.songs?.[0];
  if (!song) return null;
  return hydrate(song, fetcher);
}

// 点歌快路径：搜 top N 并行取播放链路，保持搜索结果顺序，过滤不可播
export async function searchTracks(query, limit = 3, fetcher = fetch) {
  const search = await getJson(`/search?keywords=${encodeURIComponent(query)}&type=1&limit=${limit}`, fetcher);
  const songs = search?.result?.songs || [];
  const tracks = await Promise.all(songs.map(s => hydrate(s, fetcher)));
  return tracks.filter(Boolean);
}
