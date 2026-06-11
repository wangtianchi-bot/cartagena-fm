// src/opener.js —— 首播曲预缓存：开台第一秒先响音乐，DJ 压着音乐进来
// （azu 决策 2026-06-11 三轮反馈："打开电台第一秒就有歌，随机的，你猜我喜欢"）
// 缓存只存歌名/艺人候选（播放 URL 有时效），开台时现解析真实 URL（本地 sidecar，亚秒级）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { buildContext } from './context.js';
import { askJson as realAskJson } from './llm.js';
import { buildPickPrompt } from './prompts.js';
import { resolveTracks as realResolve } from './music/index.js';

const CACHE_PATH = path.join(ROOT, 'data', 'opener-cache.json');

export function readOpener({ cachePath = CACHE_PATH } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return Array.isArray(c.candidates) && c.candidates.length ? c.candidates : null;
  } catch { return null; }
}

// 预生成：LLM 按品味挑 3 首候选落盘（服务启动 / 每次开台后刷新，不在开台路径上花时间）
export async function prepareOpener(db, deps = {}) {
  const { askJson = realAskJson, cachePath = CACHE_PATH } = deps;
  const pick = await askJson(buildPickPrompt(await buildContext(db), { reason: 'open', count: 3 }));
  if (!pick?.play?.length) return null;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({ candidates: pick.play }, null, 2));
  return pick.play;
}

// 开台时调用：候选 → 现实解析（走正常去重，24h 冷却仍生效），返回第一首可播的。
// 全落空返回 null → 服务端回退旧流程（intro 先开口、管线选歌后才有音乐）。
export async function resolveOpener(db, deps = {}) {
  const { resolveTracks = realResolve, cachePath = CACHE_PATH } = deps;
  const candidates = readOpener({ cachePath });
  if (!candidates) return null;
  const { confirmed } = await resolveTracks(candidates, { db });
  return confirmed[0] ?? null;
}
