// src/music/index.js —— F2 现实关卡 + F8 去重，两段式管线的中间闸门
import * as netease from './netease.js';
import * as ytdlp from './ytdlp.js';
import { config } from '../config.js';

const defaultProvider = {
  async getTrack(query) {
    let track = null;
    if (config.musicProvider !== 'yt-dlp') track = await netease.getTrack(query);
    if (!track && config.musicProvider !== 'netease') track = await ytdlp.getTrack(query);
    return track;
  },
};

const key = (t) => `${t.title}::${t.artist}`;

// 点歌快路径（借鉴 Claudio V1.5 play_music）：点名关键词直搜直切，不过 LLM。
// 只挡"队列里已有"的重复——点名不受 24h/同艺人回避（与 relaxed 同语义）。
export async function quickSearch(query, { queued = [], searcher = netease.searchTracks, limit = 3 } = {}) {
  const tracks = await searcher(query, limit);
  const seen = new Set(queued.map(key));
  const out = [];
  for (const t of tracks) {
    if (seen.has(key(t))) continue;
    seen.add(key(t));
    out.push(t);
  }
  return out;
}

// candidates: ["歌名 - 艺人", ...]；queued: 当前播放队列里还没播的 track
// relaxed: 明确点歌时放宽 24h 冷却与同艺人回避——去重是给自动选歌防腻的，不该拦明确点名（2026-06-11 验收发现）
// 返回 { confirmed: track[], failed: string[] }
export async function resolveTracks(candidates, { db, provider = defaultProvider, queued = [], relaxed = false } = {}) {
  const confirmed = [];
  const failed = [];
  const seen = new Set(queued.map(key));
  const recentArtists = new Set(db.recentArtists(config.rules.artistWindow));

  // 解析（网络）并行跑，去重判断按候选顺序串行——既提速又保持确定性（验收反馈：开台慢）
  const tracks = await Promise.all(candidates.map(q => provider.getTrack(q)));
  for (let i = 0; i < candidates.length; i++) {
    const query = candidates[i];
    const track = tracks[i];
    if (!track) { failed.push(query); continue; }
    const dup = seen.has(key(track))
      || (!relaxed && (db.playedWithin(track.title, track.artist, config.rules.trackCooldownMs)
                       || recentArtists.has(track.artist)));
    if (dup) { failed.push(query); continue; }
    seen.add(key(track));
    confirmed.push(track);
  }
  return { confirmed, failed };
}
