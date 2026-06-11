// src/intro.js —— 开场白预生成预合成（借鉴 Claudio V1.5 /api/intro + 缓存思路）
// 服务启动 / 每次开台后，按"时段"预生成下一份开场白并 TTS 落盘；
// 点开台时缓存命中 → 秒级有人声，音乐由管线随后接上（验收反馈：一进来就要主播的声音）。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { buildContext } from './context.js';
import { askJson as realAskJson } from './llm.js';
import { buildIntroPrompt } from './prompts.js';
import { synthesize as realSynthesize } from './tts.js';

const CACHE_PATH = path.join(ROOT, 'data', 'intro-cache.json');

export function timeSlot(d = new Date()) {
  const h = d.getHours();
  return h < 6 ? '凌晨' : h < 11 ? '清晨' : h < 14 ? '中午' : h < 18 ? '下午' : h < 22 ? '晚上' : '深夜';
}

// 缓存命中条件：同时段（开场白提到的时间感不能错位）+ TTS 文件还在
export function readIntro({ cachePath = CACHE_PATH, ttsDir = path.join(ROOT, 'cache', 'tts') } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (c.slot !== timeSlot()) return null;
    if (!fs.existsSync(path.join(ttsDir, path.basename(c.ttsUrl)))) return null;
    return { text: c.text, ttsUrl: c.ttsUrl };
  } catch { return null; }
}

// 生成 + 合成 + 落盘。开场白生成时无歌单，出现《》一律视为幻觉丢弃（不缓存坏货）。
export async function prepareIntro(db, deps = {}) {
  const { askJson = realAskJson, synthesize = realSynthesize, cachePath = CACHE_PATH } = deps;
  const out = await askJson(buildIntroPrompt(await buildContext(db)));
  const text = String(out?.text || '').trim();
  if (!text || /《[^》]*》/.test(text)) return null;
  const file = await synthesize(text, { role: 'dj' });
  const entry = { slot: timeSlot(), text, ttsUrl: '/tts/' + path.basename(file) };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2));
  return entry;
}
