// tests/weather.test.js —— F10 天气感知
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeWmo, getWeather } from '../src/weather.js';

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wx-')), 'weather.json');
const fakeFetch = (payload) => {
  const f = async () => ({ ok: true, json: async () => payload });
  const counted = async (...a) => { counted.calls++; return f(...a); };
  counted.calls = 0;
  return counted;
};

const SUNNY = { current: { temperature_2m: 25.6, weather_code: 0 },
  daily: { temperature_2m_max: [28], temperature_2m_min: [19], precipitation_probability_max: [10] } };
const RAINY = { current: { temperature_2m: 18.2, weather_code: 63 },
  daily: { temperature_2m_max: [20], temperature_2m_min: [15], precipitation_probability_max: [90] } };

test('describeWmo: 常见天气码映射中文 + 雨判定', () => {
  assert.deepEqual(describeWmo(0), { text: '晴', rainy: false });
  assert.deepEqual(describeWmo(63), { text: '中雨', rainy: true });
  assert.deepEqual(describeWmo(95), { text: '雷雨', rainy: true });
  assert.deepEqual(describeWmo(999), { text: '', rainy: false }); // 未知码不瞎说
});

test('getWeather: 正常取数 → 摘要含城市/温度/天气；雨天 rainy=true', async () => {
  const w = await getWeather({ cfg: { lat: 30, lon: 120, city: '杭州', cacheMs: 1800_000 },
    fetchFn: fakeFetch(RAINY), cachePath: tmpCache() });
  assert.ok(w.summary.includes('中雨'), w.summary);
  assert.ok(w.summary.includes('18'), w.summary);
  assert.ok(w.summary.includes('杭州'), w.summary);
  assert.equal(w.rainy, true);
});

test('getWeather: 30min 内走缓存不重复请求', async () => {
  const f = fakeFetch(SUNNY);
  const cachePath = tmpCache();
  const cfg = { lat: 30, lon: 120, city: '', cacheMs: 1800_000 };
  await getWeather({ cfg, fetchFn: f, cachePath });
  const w2 = await getWeather({ cfg, fetchFn: f, cachePath });
  assert.equal(f.calls, 1);
  assert.ok(w2.summary.includes('晴'));
});

test('getWeather: 未配置坐标 → null 且不发请求（功能未启用=降级）', async () => {
  const f = fakeFetch(SUNNY);
  assert.equal(await getWeather({ cfg: { lat: null, lon: null, cacheMs: 0 }, fetchFn: f, cachePath: tmpCache() }), null);
  assert.equal(f.calls, 0);
});

test('getWeather: API 挂了 → 有陈缓存用陈缓存，没有 → null（绝不编造）', async () => {
  const boom = async () => { throw new Error('net down'); };
  const cachePath = tmpCache();
  assert.equal(await getWeather({ cfg: { lat: 30, lon: 120, cacheMs: 0 }, fetchFn: boom, cachePath }), null);
  await getWeather({ cfg: { lat: 30, lon: 120, cacheMs: 1 }, fetchFn: fakeFetch(SUNNY), cachePath });
  await new Promise(r => setTimeout(r, 10));
  const stale = await getWeather({ cfg: { lat: 30, lon: 120, cacheMs: 1 }, fetchFn: boom, cachePath });
  assert.ok(stale.summary.includes('晴'));
});
