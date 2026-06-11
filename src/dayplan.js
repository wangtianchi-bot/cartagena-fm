// src/dayplan.js —— F11 当日节目计划：07:00 由 scheduler 生成，全天进上下文给 DJ 一条贯穿线
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { buildContext } from './context.js';
import { askJson as realAskJson } from './llm.js';
import { buildDayPlanPrompt } from './prompts.js';

const CACHE_PATH = path.join(ROOT, 'data', 'dayplan.json');

export const todayStr = (d = new Date()) => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short',
}).format(d); // YYYY-MM-DD

export function readDayPlan({ cachePath = CACHE_PATH } = {}) {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    return c.date === todayStr() && c.text ? c : null;
  } catch { return null; }
}

// 生成（输入=人格+品味+作息+今天的日程+天气，全在 buildContext 里）；失败 → null 不落盘
export async function prepareDayPlan(db, deps = {}) {
  const { askJson = realAskJson, buildCtx = buildContext, cachePath = CACHE_PATH } = deps;
  const out = await askJson(buildDayPlanPrompt(await buildCtx(db)));
  const text = String(out?.text || '').trim();
  if (!text) return null;
  const entry = { date: todayStr(), text };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(entry, null, 2));
  return entry;
}
