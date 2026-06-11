// src/weekly.js —— F12 品味自进化闭环：信号聚合 → 《品味观察周报》提案 → 用户确认合入
// 价值观（PRD F12）：taste.md 是用户主权文件——Agent 只能提案，没有 applyReport 调用一个字都不动。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { askJson as realAskJson } from './llm.js';
import { buildWeeklyPrompt } from './prompts.js';
import { todayStr } from './dayplan.js';

const REPORT_PATH = path.join(ROOT, 'data', 'taste-report.json');
const TASTE_PATH = path.join(ROOT, '..', 'user', 'taste.md');
const WEEK_MS = 7 * 24 * 3600_000;
const EARLY_PCT = 0.3; // 前 30% 进度切掉 = 最强负信号（PRD F12：前 30s 切意义最强的工程化）

// 近 7 天信号 → 给 LLM 看的事实清单（只给事实不给结论，结论让它提）
export function summarizeSignals(db, { since = Date.now() - WEEK_MS } = {}) {
  const sigs = db.signalsSince(since);
  if (!sigs.length) return null;
  const line = (s) => {
    const song = `《${s.title}》- ${s.artist}`;
    if (s.type === 'skip') {
      const early = s.pct != null && s.pct <= EARLY_PCT;
      return `- 切歌：${song}${s.pct != null ? `（播到 ${Math.round(s.pct * 100)}%${early ? '，开头就切，强烈不对味' : ''}）` : ''}`;
    }
    if (s.type === 'finish') return `- 完整听完：${song}`;
    return `- 主动点歌：${song}（最强正信号）`;
  };
  return sigs.map(line).join('\n');
}

export function readReport({ reportPath = REPORT_PATH } = {}) {
  try { return JSON.parse(fs.readFileSync(reportPath, 'utf8')); } catch { return null; }
}

// 「开机就补」判据：本地服务周日 20:00 未必开着，所以每次启动检查是否欠一份周报。
// 该补 = 近 7 天有信号 且 没有未处理(pending)的报告 且（从没出过 / 上份距今 ≥7 天）。
export function isReportDue(db, { reportPath = REPORT_PATH, now = Date.now } = {}) {
  if (!summarizeSignals(db)) return false;
  const last = readReport({ reportPath });
  if (!last) return true;
  if (last.status === 'pending') return false; // 还有没看的，先别催第二份
  return now() - (last.createdAt ?? 0) >= WEEK_MS;
}

// 每周日由 scheduler 触发（也可手动 /api/taste/report/generate）；无信号 → null 不出空报告
export async function runWeeklyReport(db, deps = {}) {
  const { askJson = realAskJson, reportPath = REPORT_PATH } = deps;
  const facts = summarizeSignals(db);
  if (!facts) return null;
  const out = await askJson(buildWeeklyPrompt(facts));
  const suggestions = (out?.suggestions ?? [])
    .map(s => ({ change: String(s?.change || '').trim(), why: String(s?.why || '').trim() }))
    .filter(s => s.change);
  if (!suggestions.length) return null;
  const report = {
    weekOf: todayStr(),
    createdAt: Date.now(),
    observations: (out.observations ?? []).map(String),
    suggestions,
    status: 'pending',
    applied: [],
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}

// 用户确认合入：只把勾选的建议追加到 taste.md 末尾的修订记录小节，原文一字不动
export function applyReport(indices, { reportPath = REPORT_PATH, tastePath = TASTE_PATH } = {}) {
  const report = readReport({ reportPath });
  if (!report || report.status !== 'pending') return report;
  const picked = (indices ?? []).map(i => report.suggestions[i]).filter(Boolean);
  if (picked.length) {
    let taste = fs.readFileSync(tastePath, 'utf8');
    const HEAD = '## 自进化修订记录（用户确认合入）';
    if (!taste.includes(HEAD)) taste = taste.replace(/\s*$/, `\n\n${HEAD}\n`);
    taste = taste.replace(/\s*$/, '\n' + picked.map(s => `- ${todayStr()}：${s.change}`).join('\n') + '\n');
    fs.writeFileSync(tastePath, taste);
  }
  report.status = picked.length ? 'applied' : 'dismissed';
  report.applied = picked.map(s => s.change);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  return report;
}
