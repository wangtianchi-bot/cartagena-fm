// src/scheduler.js —— F11 定时主动节目：07:00 当日计划 / 09:00 早间自动开播 / 整点 vibe check
// 外加 F9 的规则示例落地：日程开始前 30 分钟提醒一次（每 5 分钟查一次日历缓存）。
// 设计约束：vibe check 类口播只广播给前端排到下一个接缝（F3 红线：绝不压人声段）；
// 没有客户端连着就不烧 LLM/TTS（azu 不在听，说给谁呢）。
import { prepareDayPlan as realPrepareDayPlan } from './dayplan.js';
import { prepareIntro as realPrepareIntro, readIntro as realReadIntro } from './intro.js';
import { runVibeCheck as realRunVibeCheck } from './pipeline.js';
import { getSchedule as realGetSchedule } from './calendar.js';
import { runWeeklyReport as realRunWeeklyReport } from './weekly.js';
import { pushLark as realPushLark } from './notify.js';

const VIBE_HOURS = { from: 10, to: 23 }; // 整点 vibe check 时段（09:00 归早间节目，凌晨不吵人）
const REMIND_MS = 30 * 60_000;

const sh = (d, opts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', ...opts }).format(d);
const dateKey = (d) => sh(d, { dateStyle: 'short' });
const hm = (d) => sh(d, { hour: '2-digit', minute: '2-digit', hour12: false }); // HH:MM
const isSunday = (d) => new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(d) === 'Sun';

export function createScheduler({ db, broadcast, hasClients, deps = {}, intervalMs = 30_000 }) {
  const {
    prepareDayPlan = realPrepareDayPlan,
    prepareIntro = realPrepareIntro,
    readIntro = realReadIntro,
    runVibeCheck = realRunVibeCheck,
    getSchedule = realGetSchedule,
    runWeeklyReport = realRunWeeklyReport,
    pushLark = realPushLark,
  } = deps;

  const fired = new Set();      // "YYYY-MM-DD HH:MM name"：同一分钟只触发一次
  const reminded = new Set();   // "YYYY-MM-DD title@HH:MM"：单日程只提醒一次
  let today = '';

  const once = (d, name) => {
    const key = `${dateKey(d)} ${hm(d)} ${name}`;
    if (fired.has(key)) return false;
    fired.add(key);
    return true;
  };

  async function vibeBroadcast(opts) {
    const out = await runVibeCheck(db, {}, opts);
    if (out?.segments?.length) broadcast({ type: 'vibe-check', segments: out.segments });
  }

  async function tick(d = new Date()) {
    // 跨日清理（fired/reminded 不无限涨）
    if (dateKey(d) !== today) { today = dateKey(d); fired.clear(); reminded.clear(); }
    const [hh, mm] = hm(d).split(':').map(Number);

    try {
      // 07:00 当日计划 + 重热开场白（早间冷开场要带上今天的日程/天气/计划）
      if (hh === 7 && mm === 0 && once(d, 'dayplan')) {
        await prepareDayPlan(db);
        await prepareIntro(db);
      }
      // 开场白预缓存翻页补热：跨日/跨时段后旧缓存必失效——若等用户点开台再现做，
      // 开场得干等 LLM+TTS（实测撞上午夜边界约 1 分钟没声）。失效即在 30s 内补热，
      // 同一分钟去重、失败下一分钟自动重试；07:00 的重热在上面先跑，热好后这里自然跳过。
      if (!readIntro() && once(d, 'intro-warm')) {
        await prepareIntro(db);
      }
      // 09:00 早间节目自动开播（前端没开播才会响应，开着就忽略）
      if (hh === 9 && mm === 0 && hasClients() && once(d, 'morning')) {
        broadcast({ type: 'morning-call' });
      }
      // 整点 vibe check（10:00–23:00，须有人在听）
      if (mm === 0 && hh >= VIBE_HOURS.from && hh <= VIBE_HOURS.to && hasClients() && once(d, 'vibe')) {
        await vibeBroadcast({});
      }
      // 周日 20:00 品味观察周报（F12）：生成提案 → 推送飞书 + 广播给在线前端，合不合入用户拍板
      if (hh === 20 && mm === 0 && isSunday(d) && once(d, 'weekly')) {
        const report = await runWeeklyReport(db);
        if (report) { await pushLark(report); broadcast({ type: 'taste-report', report }); }
      }
      // 日程提醒：每 5 分钟对照日历，30 分钟内要开始且没提醒过的 → 提醒一次
      if (mm % 5 === 0 && hasClients() && once(d, 'remind-scan')) {
        const sch = await getSchedule();
        for (const ev of sch?.events ?? []) {
          const lead = ev.start - d;
          if (lead <= 0 || lead > REMIND_MS) continue;
          const key = `${dateKey(d)} ${ev.title}@${hm(ev.start)}`;
          if (reminded.has(key)) continue;
          reminded.add(key);
          await vibeBroadcast({ event: ev });
        }
      }
    } catch (e) {
      console.error('[scheduler]', e.message);
    }
  }

  let timer = null;
  return {
    tick,
    start() { timer ??= setInterval(() => tick().catch(e => console.error('[scheduler]', e)), intervalMs); },
    stop() { clearInterval(timer); timer = null; },
  };
}
