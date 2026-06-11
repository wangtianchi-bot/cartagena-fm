// tests/weekly.test.js —— F12 品味观察周报：信号聚合 → LLM 提案 → 用户确认合入 taste.md
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summarizeSignals, runWeeklyReport, readReport, applyReport, isReportDue } from '../src/weekly.js';
import { openDb } from '../src/db.js';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wk-'));

function seedDb() {
  const db = openDb(':memory:');
  db.addSignal({ type: 'skip', title: '慢板钢琴一', artist: 'A', pct: 0.1 });
  db.addSignal({ type: 'skip', title: '慢板钢琴二', artist: 'A', pct: 0.8 });
  db.addSignal({ type: 'finish', title: '红豆', artist: '方大同', pct: 1 });
  db.addSignal({ type: 'request', title: '晴天', artist: '周杰伦' });
  return db;
}

test('summarizeSignals: 按类聚合；前 30% 切掉的标记为强负', () => {
  const s = summarizeSignals(seedDb());
  assert.ok(s.includes('慢板钢琴一'));
  assert.ok(s.includes('开头就切')); // 前 30% 进度切掉 → 权重最高
  assert.ok(s.includes('红豆') && s.includes('晴天'));
});

test('summarizeSignals: 无信号 → null', () => {
  assert.equal(summarizeSignals(openDb(':memory:')), null);
});

test('runWeeklyReport: LLM 提案 → 落盘 pending；无信号不出报告', async () => {
  const dir = tmpDir();
  const reportPath = path.join(dir, 'report.json');
  const out = await runWeeklyReport(seedDb(), {
    askJson: async () => ({ observations: ['本周切了 2 首钢琴曲'], suggestions: [
      { change: '把"钢琴"从通用偏好移到"仅深夜"', why: '白天切钢琴' },
      { change: '增加周杰伦权重', why: '主动点歌' },
    ] }),
    reportPath,
  });
  assert.equal(out.status, 'pending');
  assert.equal(out.suggestions.length, 2);
  assert.equal(readReport({ reportPath }).observations[0], '本周切了 2 首钢琴曲');
  assert.equal(await runWeeklyReport(openDb(':memory:'), { askJson: async () => null, reportPath }), null);
});

test('applyReport: 只合入勾选项、追加小节、原文不动；未 apply 时 taste.md 原样', async () => {
  const dir = tmpDir();
  const reportPath = path.join(dir, 'report.json');
  const tastePath = path.join(dir, 'taste.md');
  fs.writeFileSync(tastePath, '# 品味档案\n\n原始内容。\n');
  await runWeeklyReport(seedDb(), {
    askJson: async () => ({ observations: ['o'], suggestions: [
      { change: '建议甲', why: 'w1' }, { change: '建议乙', why: 'w2' },
    ] }),
    reportPath,
  });
  assert.equal(fs.readFileSync(tastePath, 'utf8').includes('建议甲'), false); // 没确认一个字不动
  const applied = applyReport([1], { reportPath, tastePath }); // 只采纳"建议乙"
  assert.equal(applied.applied.length, 1);
  const taste = fs.readFileSync(tastePath, 'utf8');
  assert.ok(taste.startsWith('# 品味档案\n\n原始内容。')); // 原文未动
  assert.ok(taste.includes('自进化修订记录'));
  assert.ok(taste.includes('建议乙') && !taste.includes('建议甲'));
  assert.equal(readReport({ reportPath }).status, 'applied');
});

test('isReportDue: 有信号且无报告 → 该补', () => {
  const reportPath = path.join(tmpDir(), 'report.json');
  assert.equal(isReportDue(seedDb(), { reportPath }), true);
});

test('isReportDue: 无信号 → 不补', () => {
  const reportPath = path.join(tmpDir(), 'report.json');
  assert.equal(isReportDue(openDb(':memory:'), { reportPath }), false);
});

test('isReportDue: 存在 pending 报告 → 不重复补（等用户先处理）', () => {
  const reportPath = path.join(tmpDir(), 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ weekOf: 'x', status: 'pending', createdAt: 0, suggestions: [] }));
  assert.equal(isReportDue(seedDb(), { reportPath }), false);
});

test('isReportDue: 上份已处理但 <7 天 → 不补；≥7 天 → 补', () => {
  const reportPath = path.join(tmpDir(), 'report.json');
  const now = Date.parse('2026-06-14T20:00:00+08:00');
  fs.writeFileSync(reportPath, JSON.stringify({ weekOf: 'x', status: 'applied',
    createdAt: now - 3 * 24 * 3600_000, suggestions: [] }));
  assert.equal(isReportDue(seedDb(), { reportPath, now: () => now }), false);
  fs.writeFileSync(reportPath, JSON.stringify({ weekOf: 'x', status: 'applied',
    createdAt: now - 8 * 24 * 3600_000, suggestions: [] }));
  assert.equal(isReportDue(seedDb(), { reportPath, now: () => now }), true);
});

test('applyReport: 空勾选 = 全部驳回，taste.md 不动、报告标记 dismissed', () => {
  const dir = tmpDir();
  const reportPath = path.join(dir, 'report.json');
  const tastePath = path.join(dir, 'taste.md');
  fs.writeFileSync(tastePath, 'X');
  fs.writeFileSync(reportPath, JSON.stringify({ weekOf: 'x', status: 'pending',
    observations: [], suggestions: [{ change: 'c', why: 'w' }] }));
  applyReport([], { reportPath, tastePath });
  assert.equal(fs.readFileSync(tastePath, 'utf8'), 'X');
  assert.equal(readReport({ reportPath }).status, 'dismissed');
});
