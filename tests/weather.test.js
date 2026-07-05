// tests/weather.test.js —— F10 天气感知
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeWmo, getWeather, geocodeCity, setLocation, readLocation } from '../src/weather.js';

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wx-')), 'weather.json');
// 每个用例独立定位文件：默认不存在 = 无界面覆盖，回落 cfg（避免真机 user/weather.json 影响单测）
const tmpLoc = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wxloc-')), 'weather.json');
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
    fetchFn: fakeFetch(RAINY), cachePath: tmpCache(), locFile: tmpLoc() });
  assert.ok(w.summary.includes('中雨'), w.summary);
  assert.ok(w.summary.includes('18'), w.summary);
  assert.ok(w.summary.includes('杭州'), w.summary);
  assert.equal(w.rainy, true);
});

test('getWeather: 30min 内走缓存不重复请求', async () => {
  const f = fakeFetch(SUNNY);
  const cachePath = tmpCache();
  const locFile = tmpLoc();
  const cfg = { lat: 30, lon: 120, city: '', cacheMs: 1800_000 };
  await getWeather({ cfg, fetchFn: f, cachePath, locFile });
  const w2 = await getWeather({ cfg, fetchFn: f, cachePath, locFile });
  assert.equal(f.calls, 1);
  assert.ok(w2.summary.includes('晴'));
});

test('getWeather: 未配置坐标 → null 且不发请求（功能未启用=降级）', async () => {
  const f = fakeFetch(SUNNY);
  assert.equal(await getWeather({ cfg: { lat: null, lon: null, cacheMs: 0 }, fetchFn: f, cachePath: tmpCache(), locFile: tmpLoc() }), null);
  assert.equal(f.calls, 0);
});

test('getWeather: API 挂了 → 有陈缓存用陈缓存，没有 → null（绝不编造）', async () => {
  const boom = async () => { throw new Error('net down'); };
  const cachePath = tmpCache();
  const locFile = tmpLoc();
  assert.equal(await getWeather({ cfg: { lat: 30, lon: 120, cacheMs: 0 }, fetchFn: boom, cachePath, locFile }), null);
  await getWeather({ cfg: { lat: 30, lon: 120, cacheMs: 1 }, fetchFn: fakeFetch(SUNNY), cachePath, locFile });
  await new Promise(r => setTimeout(r, 10));
  const stale = await getWeather({ cfg: { lat: 30, lon: 120, cacheMs: 1 }, fetchFn: boom, cachePath, locFile });
  assert.ok(stale.summary.includes('晴'));
});

// ===== V1.2 城市切换 =====

test('geocodeCity: 命中 → {city,lat,lon}；查无此城 → null', async () => {
  const hit = fakeFetch({ results: [{ name: '伦敦', latitude: 51.5, longitude: -0.12 }] });
  assert.deepEqual(await geocodeCity('伦敦', { fetchFn: hit }), { city: '伦敦', lat: 51.5, lon: -0.12 });
  assert.equal(await geocodeCity('没有这个城', { fetchFn: fakeFetch({ results: [] }) }), null);
});

test('geocodeCity: 同名城市取人口最大的（London=英国伦敦，不是加拿大 London）', async () => {
  const twins = fakeFetch({ results: [
    { name: '伦敦', latitude: 42.98, longitude: -81.23, population: 383_000 },   // 加拿大安大略
    { name: '倫敦', latitude: 51.5, longitude: -0.12, population: 8_961_000 },   // 英国
  ] });
  const loc = await geocodeCity('London', { fetchFn: twins });
  assert.equal(loc.lat, 51.5);
});

test('geocodeCity: 常见海外城市中文名先换成英文再查（数据源中文搜海外城市不可靠）', async () => {
  const urls = [];
  const spy = async (u) => { urls.push(u); return { ok: true, json: async () => ({ results: [
    { name: '倫敦', latitude: 51.5, longitude: -0.12, population: 8_961_000 }] }) }; };
  const loc = await geocodeCity('伦敦', { fetchFn: spy });
  assert.ok(urls[0].includes(encodeURIComponent('London')), urls[0]); // 查询词已换成英文
  assert.equal(loc.lat, 51.5);
  assert.equal(loc.city, '伦敦'); // 显示名用用户输入的简体，不用 API 的繁体「倫敦」
});

test('setLocation/readLocation: 界面切的城市优先于 .env；文件缺失回落 cfg', () => {
  const file = tmpLoc();
  const cfg = { lat: 30, lon: 120, city: '杭州' };
  assert.equal(readLocation({ cfg, file }).city, '杭州');      // 没切过 → 用 .env
  assert.equal(readLocation({ cfg, file }).source, 'env');
  setLocation({ city: '伦敦', lat: 51.5, lon: -0.12 }, { file });
  const loc = readLocation({ cfg, file });
  assert.equal(loc.city, '伦敦');
  assert.equal(loc.source, 'user');
});

test('getWeather: 切城市后旧坐标缓存立刻失效、重新取数，摘要换新城市', async () => {
  const cachePath = tmpCache();
  const locFile = tmpLoc();
  const cfg = { lat: 30, lon: 120, city: '杭州', cacheMs: 1800_000 };
  const f1 = fakeFetch(SUNNY);
  await getWeather({ cfg, fetchFn: f1, cachePath, locFile });
  assert.equal(f1.calls, 1);
  setLocation({ city: '伦敦', lat: 51.5, lon: -0.12 }, { file: locFile });
  const f2 = fakeFetch(RAINY);
  const w = await getWeather({ cfg, fetchFn: f2, cachePath, locFile });
  assert.equal(f2.calls, 1);                       // 缓存没挡住 → 真的重取了
  assert.ok(w.summary.startsWith('伦敦：'), w.summary);
  assert.equal(w.rainy, true);
  assert.equal(w.city, '伦敦');
});
