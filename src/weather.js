// src/weather.js —— F10 天气感知：Open-Meteo（免费无密钥），30min 缓存落盘
// 选型说明：PRD 11.5 的"和风 vs OpenWeather"都要本人注册 Key；Open-Meteo 免注册即用（2026-06-11 拍板）。
// 降级矩阵（PRD 8.2）：API 挂了 → 先用陈缓存，再不行返回 null——上下文留空，DJ 绝不编造天气。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';

const CACHE_PATH = path.join(ROOT, 'data', 'weather-cache.json');
// V1.2 城市切换：用户在界面切的城市持久化在这（个人数据、已 gitignore），优先级高于 .env 坐标
const LOC_PATH = path.join(ROOT, 'user', 'weather.json');

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
  return { summary: parts.filter(Boolean).join('，'), rainy, text, temp: t };
}

// Open-Meteo 中文搜海外城市不可靠（「伦敦」只返回加拿大 London、「纽约」查无结果——2026-07 实测），
// 常见海外城市先过这张中→英对照表；表外的海外城市输英文即可（国内城市中文直搜没问题）
const CITY_ALIAS = {
  '伦敦': 'London', '纽约': 'New York', '东京': 'Tokyo', '巴黎': 'Paris', '首尔': 'Seoul',
  '洛杉矶': 'Los Angeles', '旧金山': 'San Francisco', '西雅图': 'Seattle', '新加坡': 'Singapore',
  '曼谷': 'Bangkok', '悉尼': 'Sydney', '柏林': 'Berlin', '莫斯科': 'Moscow', '迪拜': 'Dubai',
  '温哥华': 'Vancouver', '墨尔本': 'Melbourne',
};

// V1.2 城市名 → 坐标（Open-Meteo 免密钥地理编码）；查无此城返回 null、不猜。
// 同名城市取人口最大的那个——「London」该是英国伦敦，不是加拿大安大略的 London（实测踩过）
export async function geocodeCity(name, { fetchFn = fetch } = {}) {
  const zh = name.trim();
  const url = 'https://geocoding-api.open-meteo.com/v1/search?count=5&language=zh&format=json&name='
    + encodeURIComponent(CITY_ALIAS[zh] || zh);
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`open-meteo geocoding ${res.status}`);
  const rs = ((await res.json()).results || [])
    .filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
  if (!rs.length) return null;
  const r = rs.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  // 走对照表来的，显示名用用户输入的简体（API 的中文名可能是繁体「倫敦」）
  return { city: CITY_ALIAS[zh] ? zh : r.name, lat: r.latitude, lon: r.longitude };
}

// 定位取值顺序：界面切过的城市（user/weather.json）> .env 坐标；都没有 = 功能未启用
export function readLocation({ cfg = config.weather, file = LOC_PATH } = {}) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) return { ...o, source: 'user' };
  } catch {}
  return { lat: cfg.lat, lon: cfg.lon, city: cfg.city, source: 'env' };
}

export function setLocation({ city, lat, lon }, { file = LOC_PATH } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ city, lat, lon }, null, 2));
}

// 坐标没配 → null（功能未启用，不报错不猜城市）；缓存 30min（PRD 6.1：天气上下文缓存 ≥30min）
// V1.2：缓存按坐标判有效——界面一切城市，旧城市的缓存立刻作废、马上重取
export async function getWeather({ cfg = config.weather, fetchFn = fetch, cachePath = CACHE_PATH, locFile = LOC_PATH, now = Date.now } = {}) {
  const loc = readLocation({ cfg, file: locFile });
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) return null;
  const locKey = `${loc.lat},${loc.lon}`;
  let cached = null;
  try { cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  if (cached?.loc !== locKey) cached = null;
  if (cached && now() - cached.at < cfg.cacheMs) return cached.weather;
  try {
    const weather = await fetchOpenMeteo(loc.lat, loc.lon, fetchFn);
    weather.city = loc.city || '';
    if (loc.city) weather.summary = `${loc.city}：${weather.summary}`;
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ at: now(), loc: locKey, weather }, null, 2));
    return weather;
  } catch (e) {
    console.error('[weather]', e.message);
    return cached?.weather ?? null; // 陈缓存好过编造；连陈的都没有就留空
  }
}
