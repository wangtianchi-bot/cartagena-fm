// tests/context.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildContext } from '../src/context.js';
import { openDb } from '../src/db.js';

function tmpProfiles() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-'));
  fs.mkdirSync(path.join(dir, 'user'));
  fs.mkdirSync(path.join(dir, 'prompts'));
  fs.writeFileSync(path.join(dir, 'prompts', 'dj-persona.md'), '人格内容X');
  fs.writeFileSync(path.join(dir, 'user', 'taste.md'), '品味内容Y');
  fs.writeFileSync(path.join(dir, 'user', 'routines.md'), '作息内容Z');
  fs.writeFileSync(path.join(dir, 'user', 'mood-rules.md'), '情绪规则W');
  return dir;
}

// 测试默认掐掉真实天气/日历/当日计划源：单测不出网不读真缓存
const noSense = { getWeather: async () => null, getCalendar: async () => null, getDayPlan: () => null };

test('buildContext: 拼齐人格/三件套/时间/历史/对话', async () => {
  const db = openDb(':memory:');
  db.addPlay({ title: '红豆', artist: '方大同' });
  db.addMessage('user', '来点下雨天的');
  const ctx = await buildContext(db, { baseDir: tmpProfiles(), ...noSense });
  for (const piece of ['人格内容X', '品味内容Y', '作息内容Z', '情绪规则W', '红豆', '来点下雨天的', '当前时间']) {
    assert.ok(ctx.includes(piece), `缺少：${piece}`);
  }
});

test('buildContext: 空库不炸', async () => {
  const db = openDb(':memory:');
  const ctx = await buildContext(db, { baseDir: tmpProfiles(), ...noSense });
  assert.ok(ctx.includes('（还没有播放记录）'));
});

test('buildContext: 注入天气；雨天附雨天规则（F10）', async () => {
  const db = openDb(':memory:');
  const ctx = await buildContext(db, { baseDir: tmpProfiles(),
    getWeather: async () => ({ summary: '杭州：中雨，气温 18°C', rainy: true }) });
  assert.ok(ctx.includes('中雨'));
  assert.ok(ctx.includes('正在下雨')); // 雨天规则生效（场景 S6）
});

test('buildContext: 晴天不带雨天规则', async () => {
  const db = openDb(':memory:');
  const ctx = await buildContext(db, { baseDir: tmpProfiles(),
    getWeather: async () => ({ summary: '晴，气温 25°C', rainy: false }) });
  assert.ok(ctx.includes('晴'));
  assert.ok(!ctx.includes('正在下雨'));
});

test('buildContext: 天气拿不到/数据源抛错 → 无天气字样（绝不编造）', async () => {
  const db = openDb(':memory:');
  const ctx = await buildContext(db, { baseDir: tmpProfiles(), ...noSense });
  assert.ok(!ctx.includes('天气'));
  const ctx2 = await buildContext(db, { baseDir: tmpProfiles(), ...noSense,
    getWeather: async () => { throw new Error('boom'); } });
  assert.ok(!ctx2.includes('天气'));
});

test('buildContext: 注入今天的日程（F9）', async () => {
  const ctx = await buildContext(openDb(':memory:'), { baseDir: tmpProfiles(), ...noSense,
    getCalendar: async () => ({ text: '- 10:00–11:00 模拟面试（30 分钟内开始）\n日程规则：低打扰。' }) });
  assert.ok(ctx.includes('模拟面试'));
  assert.ok(ctx.includes('今天的日程'));
});

test('buildContext: 注入今日节目计划（F11）', async () => {
  const ctx = await buildContext(openDb(':memory:'), { baseDir: tmpProfiles(), ...noSense,
    getDayPlan: () => ({ date: '2026-06-12', text: '上午低打扰，落日转民谣。' }) });
  assert.ok(ctx.includes('今日节目计划'));
  assert.ok(ctx.includes('落日转民谣'));
});

test('buildContext: 日历挂了/为空 → 无日程段（绝不编造）', async () => {
  const ctx = await buildContext(openDb(':memory:'), { baseDir: tmpProfiles(), ...noSense });
  assert.ok(!ctx.includes('今天的日程'));
  const ctx2 = await buildContext(openDb(':memory:'), { baseDir: tmpProfiles(), ...noSense,
    getCalendar: async () => { throw new Error('boom'); } });
  assert.ok(!ctx2.includes('今天的日程'));
});
