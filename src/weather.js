// src/weather.js —— F10 天气感知：Open-Meteo（免费无密钥），30min 缓存落盘
// 选型说明：PRD 11.5 的"和风 vs OpenWeather"都要本人注册 Key；Open-Meteo 免注册即用（2026-06-11 拍板）。
// 降级矩阵（PRD 8.2）：API 挂了 → 先用陈缓存，再不行返回 null——上下文留空，DJ 绝不编造天气。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';

const CACHE_PATH = path.join(ROOT, 'data', 'weather-cache.json');

// WMO weather code → 中文 + 是否在下雨（雨天规则 S6 的判定源）
const WMO = [
  [[0], '晴'], [[1], '基本晴'], [[2], '多云'], [[3], '阴'], [[45, 48], '有雾'],
  [[51, 53, 55, 56, 57], '毛毛雨', true],
  [[61, 80], '小雨', true], [[63, 81], '中雨', true], [[65, 82], '大雨', true],
  [[66, 67], '冻雨', true], [[71, 73, 75, 77, 85, 86], '下雪'],
  [[95, 96, 99], '雷雨', true],
];
export function describeWmo(code) {
  for (const [codes, text, rainy] of WMO) if (codes.includes(code)) return { text, rainy: !!rainy };
  return { text: '', rainy: false };
}

async function fetchOpenMeteo(lat, lon, fetchFn) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,weather_code'
    + '&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max'
    + '&timezone=Asia%2FShanghai&forecast_days=1';
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const { text, rainy } = describeWmo(j.current?.weather_code);
  const t = Math.round(j.current?.temperature_2m);
  if (!Number.isFinite(t)) throw new Error('open-meteo bad payload');
  const hi = Math.round(j.daily?.temperature_2m_max?.[0]);
  const lo = Math.round(j.daily?.temperature_2m_min?.[0]);
  const pop = j.daily?.precipitation_probability_max?.[0];
  const parts = [text || null, `气温 ${t}°C`];
  if (Number.isFinite(hi) && Number.isFinite(lo)) parts.push(`今天 ${lo}~${hi}°C`);
  if (Number.isFinite(pop)) parts.push(`降水概率 ${pop}%`);
  return { summary: parts.filter(Boolean).join('，'), rainy };
}

// 坐标没配 → null（功能未启用，不报错不猜城市）；缓存 30min（PRD 6.1：天气上下文缓存 ≥30min）
export async function getWeather({ cfg = config.weather, fetchFn = fetch, cachePath = CACHE_PATH, now = Date.now } = {}) {
  if (!Number.isFinite(cfg.lat) || !Number.isFinite(cfg.lon)) return null;
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  if (cached && now() - cached.at < cfg.cacheMs) return cached.weather;
  try {
    const weather = await fetchOpenMeteo(cfg.lat, cfg.lon, fetchFn);
    if (cfg.city) weather.summary = `${cfg.city}：${weather.summary}`;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ at: now(), weather }, null, 2));
    return weather;
  } catch (e) {
    console.error('[weather]', e.message);
    return cached?.weather ?? null; // 陈缓存好过编造；连陈的都没有就留空
  }
}
