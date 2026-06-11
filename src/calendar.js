// src/calendar.js —— F9 日程感知：本机 lark-cli 读当日日程（azu 的不对称优势，接入成本趋近于零）
// 缓存 10 分钟（PRD 6.1 的 [待补充：缓存时长]，2026-06-11 拍板）；
// 降级矩阵（PRD 8.2）：lark-cli 挂了 / 没装 / 没授权 → null，上下文留空，DJ 绝不编造日程。
// 隐私边界（PRD F9）：日程只在本机流转 + 进 LLM prompt，不落任何第三方存储。
import { execFile } from 'node:child_process';
import { config } from './config.js';

const CACHE_MS = 10 * 60_000;
const NEAR_MS = 30 * 60_000; // "临近"判定：30 分钟内开始 → 低打扰模式

function realExec(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['calendar', '+agenda', '--format', 'json'], { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// stdout 可能混有 [lark-cli] WARN 行：取第一个 { 起解析
export function parseAgenda(stdout) {
  const start = String(stdout).indexOf('{');
  if (start === -1) throw new Error('lark-cli: no JSON in output');
  const j = JSON.parse(String(stdout).slice(start));
  if (!j.ok || !Array.isArray(j.data)) throw new Error('lark-cli: agenda not ok');
  return j.data.map(ev => ({
    title: String(ev.summary || '').trim() || '（无标题日程）',
    start: new Date(ev.start_time?.datetime ?? ev.start_time?.date ?? Number(ev.start_time?.timestamp) * 1000),
    end: new Date(ev.end_time?.datetime ?? ev.end_time?.date ?? Number(ev.end_time?.timestamp) * 1000),
  })).filter(ev => !isNaN(ev.start));
}

const hhmm = (d) => new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(d);

export function formatSchedule(events, now = new Date()) {
  if (!events.length) return null;
  const lines = events.map(ev => {
    const near = ev.start - now > 0 && ev.start - now <= NEAR_MS ? '（30 分钟内开始）' : '';
    const done = ev.end - now < 0 ? '（已结束）' : '';
    return `- ${hhmm(ev.start)}–${hhmm(ev.end)} ${ev.title}${near || done}`;
  });
  lines.push('日程规则：有日程在 30 分钟内开始时进入低打扰——串场收短或静默、选歌偏轻偏器乐；日程密集时段同理。只许引用上面列出的日程，绝不编造。');
  return lines.join('\n');
}

// 模块级内存缓存（同进程内 pipeline/intro/opener 共享）
let cache = null; // { at, events }
export function _resetCache() { cache = null; }

export async function getSchedule({ exec = realExec, bin = config.larkCliBin, now = () => new Date() } = {}) {
  if (!cache || now() - cache.at >= CACHE_MS) {
    try {
      cache = { at: now().getTime(), events: parseAgenda(await exec(bin)) };
    } catch (e) {
      console.error('[calendar]', e.message);
      return null; // 不缓存失败：下次生成再试
    }
  }
  const text = formatSchedule(cache.events, now());
  return text ? { events: cache.events, text } : null;
}
