// tests/prompts.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { buildPickPrompt, buildScriptPrompt, buildHotlineSystem } from '../src/prompts.js';

const ctx = '【上下文占位】';
const tracks = [
  { title: '红豆', artist: '方大同' },
  { title: '理想三旬', artist: '陈鸿宇' },
];

test('第一段 prompt：含上下文/触发原因/数量/输出格式', () => {
  const p = buildPickPrompt(ctx, { reason: 'refill', count: 3 });
  assert.ok(p.includes(ctx));
  assert.ok(p.includes('3 首'));
  assert.ok(p.includes('"play"'));
});

test('第一段 prompt：点歌时点名的歌/歌手必须进候选且排第一（直接切播，别让人落空）', () => {
  const p = buildPickPrompt(ctx, { reason: 'request', userText: '想听许嵩的歌' });
  assert.ok(p.includes('想听许嵩的歌'));
  assert.ok(p.includes('第一位'));
  assert.ok(p.includes('立刻切播'));
  // 点名豁免回避规则——否则点名歌手在最近播放里就永远点不到
  assert.ok(p.includes('不受任何回避规则限制'));
  assert.ok(!p.includes('会被系统过滤'));
});

test('第二段 prompt：确认歌单逐曲列出 + 防幻觉硬约束 + 汉字区间', () => {
  const p = buildScriptPrompt(ctx, { tracks, kind: 'cold_open' });
  assert.ok(p.includes('红豆'));
  assert.ok(p.includes('理想三旬'));
  assert.ok(p.includes('只允许提及'));
  assert.ok(p.includes('120'));  // 冷开场下限
  assert.ok(p.includes('220'));  // 冷开场上限
});

test('第二段 prompt：bridge 满串场——每个接缝必说（点评上一首+推荐下一首），含进场 segment', () => {
  const p = buildScriptPrompt(ctx, { tracks, kind: 'bridge', recentTalk: '上两次串场都偏长' });
  assert.ok(p.includes('40'));
  assert.ok(p.includes('90'));
  assert.ok(p.includes('满串场'));
  assert.ok(p.includes('before_track'));   // 进场 segment：压在上一首结尾播
  assert.ok(p.includes('点评'));
  assert.ok(p.includes('上两次串场都偏长'));
});

test('第二段 prompt：bridge 带 nowPlaying（首播曲）→ 进场点评从它说起且列入白名单', () => {
  const p = buildScriptPrompt(ctx, { tracks, kind: 'bridge', nowPlaying: { title: '岁月神偷', artist: '金玟岐' } });
  assert.ok(p.includes('《岁月神偷》'));
  assert.ok(p.includes('正在播'));
});

// ===== F14 情感热线（V1.1.7 人设 2.0 system prompt）=====
test('热线 system prompt：纯文本流式 + 节奏起伏 + 身份速答 + 反审讯 + 切歌诚实边界', () => {
  const p = buildHotlineSystem(ctx);
  assert.ok(p.includes(ctx));               // 人物档案经 context（dj-persona.md）注入
  assert.ok(p.includes('纯文本'));          // 不再要求 JSON（流式的前提）
  assert.ok(!p.includes('JSON：'));         // 旧 JSON 输出协议必须消失
  assert.ok(p.includes('15 字'));           // 极简铁律保留，但允许情绪驱动起伏
  assert.ok(p.includes('不许每句等长'));    // 反"节奏零方差"（八轮反馈：像机器人）
  assert.ok(p.includes('卡卡啊，你的深夜专线。')); // 身份速答（人设 2.0：电子女友+知心姐姐）
  assert.ok(p.includes('问号'));            // 反连环提问（审讯感是机器人感主因之一）
  assert.ok(p.includes('你现在有手了'));    // V1.1.9：切歌/点歌由系统代执行，凭系统注记确认
  assert.ok(p.includes('系统注记'));        // 没有注记=没办成，不许瞎承诺
  assert.ok(p.includes('万能应付句'));
  assert.ok(p.includes('告别'));            // 告别→轻收束（closing 由服务端正则判断）
});

test('第一段 prompt：hotline 收歌——贴合对话优先于日常品味', () => {
  const p = buildPickPrompt(ctx, { reason: 'hotline', count: 1, userText: '听众：聊到怎么求婚的' });
  assert.ok(p.includes('1 首'));
  assert.ok(p.includes('收尾'));
  assert.ok(p.includes('聊到怎么求婚的'));
  assert.ok(p.includes('贴合对话比贴合听众日常品味更重要'));
});

test('第二段 prompt：send_song 收歌口播（轻收束+推荐理由，≤60 字）', () => {
  const p = buildScriptPrompt(ctx, { tracks, kind: 'send_song', userText: '通话摘要XX' });
  assert.ok(p.includes('60'));
  assert.ok(p.includes('immediate'));
  assert.ok(p.includes('通话摘要XX'));
  assert.ok(p.includes('红豆'));  // 确认歌单仍在场（两段式防幻觉不豁免收歌）
});
