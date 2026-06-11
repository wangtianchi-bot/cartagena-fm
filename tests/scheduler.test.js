// tests/scheduler.test.js —— F11 定时器：07:00 计划 / 09:00 早间 / 整点 vibe check / 日程提醒
import { test } from 'node:test';
import assert from 'node:assert';
import { createScheduler } from '../src/scheduler.js';
import { openDb } from '../src/db.js';

function harness({ clients = true, schedule = null } = {}) {
  const calls = { dayplan: 0, intro: 0, vibe: [], weekly: 0, pushed: 0, broadcasts: [] };
  const sch = createScheduler({
    db: openDb(':memory:'),
    broadcast: (m) => calls.broadcasts.push(m),
    hasClients: () => clients,
    deps: {
      prepareDayPlan: async () => { calls.dayplan++; return { date: 'x', text: 'p' }; },
      prepareIntro: async () => { calls.intro++; return {}; },
      runVibeCheck: async (db, deps, opts = {}) => {
        calls.vibe.push(opts.event?.title ?? 'hourly');
        return { segments: [{ type: 'quick_touch', position: 'immediate', text: 'v', status: 'ready', ttsUrl: '/tts/x.mp3' }] };
      },
      getSchedule: async () => schedule,
      runWeeklyReport: async () => { calls.weekly++; return { weekOf: 'w', suggestions: [{ change: 'c' }] }; },
      pushLark: async () => { calls.pushed++; return true; },
    },
  });
  return { sch, calls };
}

const at = (s) => new Date(s);

test('07:00 → 当日计划 + 开场白预热各一次；同一分钟重复 tick 不重触发', async () => {
  const { sch, calls } = harness();
  await sch.tick(at('2026-06-12T07:00:10+08:00'));
  await sch.tick(at('2026-06-12T07:00:40+08:00'));
  assert.equal(calls.dayplan, 1);
  assert.equal(calls.intro, 1);
});

test('09:00 有客户端 → 广播 morning-call；无客户端 → 不广播', async () => {
  const a = harness();
  await a.sch.tick(at('2026-06-12T09:00:00+08:00'));
  assert.ok(a.calls.broadcasts.some(m => m.type === 'morning-call'));
  const b = harness({ clients: false });
  await b.sch.tick(at('2026-06-12T09:00:00+08:00'));
  assert.ok(!b.calls.broadcasts.some(m => m.type === 'morning-call'));
});

test('整点（10-23 点）→ vibe-check 广播；凌晨 3 点 / 非整点不触发', async () => {
  const { sch, calls } = harness();
  await sch.tick(at('2026-06-12T14:00:05+08:00'));
  assert.deepEqual(calls.vibe, ['hourly']);
  assert.ok(calls.broadcasts.some(m => m.type === 'vibe-check' && m.segments.length));
  await sch.tick(at('2026-06-12T03:00:05+08:00'));
  await sch.tick(at('2026-06-12T14:23:05+08:00'));
  assert.equal(calls.vibe.length, 1);
});

test('日程 30 分钟内开始 → 提醒一次且只一次（F9 规则示例落地）', async () => {
  const ev = { title: '模拟面试', start: at('2026-06-12T10:20:00+08:00'), end: at('2026-06-12T11:00:00+08:00') };
  const { sch, calls } = harness({ schedule: { events: [ev], text: 't' } });
  await sch.tick(at('2026-06-12T09:55:00+08:00'));
  await sch.tick(at('2026-06-12T10:00:00+08:00')); // 第二个 5 分钟刻：不该再提醒
  assert.deepEqual(calls.vibe.filter(v => v === '模拟面试').length, 1);
});

test('周日 20:00 → 周报生成并广播；周中 20:00 不触发（F12）', async () => {
  const a = harness();
  await a.sch.tick(at('2026-06-14T20:00:00+08:00')); // 周日
  assert.equal(a.calls.weekly, 1);
  assert.equal(a.calls.pushed, 1); // 同时推送飞书
  assert.ok(a.calls.broadcasts.some(m => m.type === 'taste-report'));
  const b = harness();
  await b.sch.tick(at('2026-06-12T20:00:30+08:00')); // 周五
  assert.equal(b.calls.weekly, 0);
});

test('vibe check 无客户端不烧 LLM', async () => {
  const { sch, calls } = harness({ clients: false });
  await sch.tick(at('2026-06-12T14:00:05+08:00'));
  assert.equal(calls.vibe.length, 0);
});
