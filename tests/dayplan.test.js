// tests/dayplan.test.js —— F11 当日节目计划（07:00 生成）
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareDayPlan, readDayPlan, todayStr } from '../src/dayplan.js';
import { openDb } from '../src/db.js';

const tmpPlan = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dp-')), 'dayplan.json');

test('prepareDayPlan: LLM 出计划 → 落盘带今天日期；readDayPlan 同日命中', async () => {
  const cachePath = tmpPlan();
  const db = openDb(':memory:');
  const out = await prepareDayPlan(db, {
    askJson: async () => ({ text: '上午低打扰器乐为主，落日时段转城市民谣。' }),
    buildCtx: async () => 'CTX', cachePath,
  });
  assert.equal(out.date, todayStr());
  const read = readDayPlan({ cachePath });
  assert.ok(read.text.includes('落日时段'));
});

test('readDayPlan: 跨日失效 → null', () => {
  const cachePath = tmpPlan();
  fs.writeFileSync(cachePath, JSON.stringify({ date: '2020-01-01', text: '旧计划' }));
  assert.equal(readDayPlan({ cachePath }), null);
});

test('prepareDayPlan: LLM 失败/空文本 → null 不落盘', async () => {
  const cachePath = tmpPlan();
  const db = openDb(':memory:');
  assert.equal(await prepareDayPlan(db, { askJson: async () => null, buildCtx: async () => 'CTX', cachePath }), null);
  assert.equal(readDayPlan({ cachePath }), null);
});
