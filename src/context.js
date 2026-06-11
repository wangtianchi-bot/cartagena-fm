// src/context.js —— 三层记忆 + 感知数据源（V1.1：天气/日程）→ 每次生成的 shared context
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { getWeather as realGetWeather } from './weather.js';
import { getSchedule as realGetSchedule } from './calendar.js';
import { readDayPlan as realReadDayPlan } from './dayplan.js';

function readOr(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch { return fallback; }
}

// 感知源的统一保险丝：抛错=拿不到=该上下文留空（降级矩阵：DJ 不提及，绝不编造）
async function safeCall(fn) {
  try { return await fn(); } catch (e) { console.error('[context]', e.message); return null; }
}

// 热线轻上下文（V1.1.4）：聊天用不上品味档案/作息/歌单——砍掉约七成 token，LLM 明显提速
export function buildChatContext(db, { baseDir = ROOT } = {}) {
  const persona = readOr(path.join(baseDir, 'prompts', 'dj-persona.md'));
  const mood = readOr(path.join(baseDir, 'user', 'mood-rules.md'));
  const now = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short',
  }).format(new Date());
  const msgs = db.recentMessages(8);
  const msgLines = msgs.length
    ? msgs.map(m => `${m.role === 'user' ? '听众' : 'DJ'}：${m.content}`).join('\n')
    : '（还没有对话）';
  return [
    persona,
    `# 情绪规则\n${mood}`,
    `# 环境\n当前时间：${now}`,
    `# 最近对话\n${msgLines}`,
  ].join('\n\n');
}

export async function buildContext(db, { baseDir = ROOT, getWeather = realGetWeather, getCalendar = realGetSchedule, getDayPlan = realReadDayPlan } = {}) {
  const persona = readOr(path.join(baseDir, 'prompts', 'dj-persona.md'));
  const taste = readOr(path.join(baseDir, 'user', 'taste.md'));
  const routines = readOr(path.join(baseDir, 'user', 'routines.md'));
  const mood = readOr(path.join(baseDir, 'user', 'mood-rules.md'));

  const now = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short',
  }).format(new Date());

  // F10 天气 / F9 日程：拿不到就整段不提（规则只随真实数据注入，影响第一段选歌与第二段口播）
  const [weather, schedule, dayplan] = await Promise.all([
    safeCall(getWeather), safeCall(getCalendar), safeCall(getDayPlan)]);
  const envLines = [`当前时间：${now}`];
  if (weather?.summary) {
    envLines.push(`窗外天气：${weather.summary}`);
    if (weather.rainy) envLines.push(
      '正在下雨——选歌偏向空灵、温柔、有雨天质感的曲目；串场可以自然提一句窗外的雨，点到为止别渲染。');
  }

  const plays = db.recentPlays(20);
  const playLines = plays.length
    ? plays.map(p => `- 《${p.title}》 ${p.artist}`).join('\n')
    : '（还没有播放记录）';
  const msgs = db.recentMessages(8);
  const msgLines = msgs.length
    ? msgs.map(m => `${m.role === 'user' ? '听众' : 'DJ'}：${m.content}`).join('\n')
    : '（还没有对话）';

  return [
    persona,
    `# 听众音乐品味\n${taste}`,
    `# 听众作息\n${routines}`,
    `# 情绪规则\n${mood}`,
    `# 环境\n${envLines.join('\n')}`,
    ...(schedule?.text ? [`# 今天的日程（来自飞书日历，作息表让位于它）\n${schedule.text}`] : []),
    ...(dayplan?.text ? [`# 今日节目计划（清晨拟的内部基调，跟着走但别照念）\n${dayplan.text}`] : []),
    `# 最近播放历史（新→旧，选歌时避开这些曲目与艺人）\n${playLines}`,
    `# 最近对话\n${msgLines}`,
  ].join('\n\n');
}
