// tests/calendar.test.js —— F9 日程感知
import { test } from 'node:test';
import assert from 'node:assert';
import { parseAgenda, formatSchedule, getSchedule, _resetCache } from '../src/calendar.js';

// 真实 lark-cli calendar +agenda --json 的形状（2026-06-11 实测）
const CLI_OUT = `[lark-cli] [WARN] proxy detected\n` + JSON.stringify({ ok: true, data: [
  { summary: '模拟面试',
    start_time: { datetime: '2026-06-12T10:00:00+08:00', timezone: 'Asia/Shanghai' },
    end_time: { datetime: '2026-06-12T11:00:00+08:00', timezone: 'Asia/Shanghai' } },
  { summary: '',
    start_time: { datetime: '2026-06-12T15:00:00+08:00' },
    end_time: { datetime: '2026-06-12T15:30:00+08:00' } },
] });

test('parseAgenda: 容忍 WARN 前缀；lark JSON → {title,start,end}[]', () => {
  const evs = parseAgenda(CLI_OUT);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].title, '模拟面试');
  assert.ok(evs[0].start instanceof Date && !isNaN(evs[0].start));
  assert.equal(evs[1].title, '（无标题日程）');
});

test('parseAgenda: ok=false 或坏 JSON → 抛错（上层降级）', () => {
  assert.throws(() => parseAgenda('{"ok":false}'));
  assert.throws(() => parseAgenda('not json'));
});

test('formatSchedule: 渲染时间段；30 分钟内开始的标记临近', () => {
  const now = new Date('2026-06-12T09:40:00+08:00');
  const evs = [
    { title: '面试', start: new Date('2026-06-12T10:00:00+08:00'), end: new Date('2026-06-12T11:00:00+08:00') },
    { title: '晚课', start: new Date('2026-06-12T20:00:00+08:00'), end: new Date('2026-06-12T21:00:00+08:00') },
  ];
  const text = formatSchedule(evs, now);
  assert.ok(text.includes('10:00') && text.includes('面试'), text);
  assert.ok(text.includes('30 分钟内开始'), text);
  assert.ok(!text.includes('晚课（30 分钟内开始'), text);
  assert.ok(text.includes('日程规则'), text); // 低打扰规则随数据注入
});

test('formatSchedule: 空日程 → null（上下文不提日程）', () => {
  assert.equal(formatSchedule([], new Date()), null);
});

test('getSchedule: 10min 缓存内不重复执行 lark-cli', async () => {
  _resetCache();
  let calls = 0;
  const exec = async () => { calls++; return CLI_OUT; };
  const a = await getSchedule({ exec, now: () => new Date('2026-06-12T09:40:00+08:00') });
  const b = await getSchedule({ exec, now: () => new Date('2026-06-12T09:41:00+08:00') });
  assert.equal(calls, 1);
  assert.ok(a.text.includes('面试') && b.text.includes('面试'));
});

test('getSchedule: lark-cli 挂了 → null（留空，绝不编造日程）', async () => {
  _resetCache();
  assert.equal(await getSchedule({ exec: async () => { throw new Error('cli down'); } }), null);
});

test('getSchedule: 今天没日程 → null', async () => {
  _resetCache();
  const exec = async () => JSON.stringify({ ok: true, data: [] });
  assert.equal(await getSchedule({ exec }), null);
});
