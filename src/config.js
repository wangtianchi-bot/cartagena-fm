// src/config.js
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url)) + '/..';

export const config = {
  port: Number(process.env.PORT || 8080),
  // LLM
  deepseekApiKey: process.env.DEEPSEEK_API_KEY,
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
  // 音乐
  neteaseBase: process.env.NETEASE_API_BASE || 'http://127.0.0.1:3000',
  musicProvider: process.env.MUSIC_PROVIDER || 'auto', // auto | netease | yt-dlp
  // TTS（DJ 与来电者两套，三头鉴权）
  tts: {
    endpoint: process.env.VOLCENGINE_TTS_ENDPOINT,
    dj: {
      appId: process.env.VOLCENGINE_TTS_APP_ID,
      accessToken: process.env.VOLCENGINE_TTS_ACCESS_TOKEN,
      resourceId: process.env.VOLCENGINE_TTS_RESOURCE_ID,
      voiceType: process.env.VOLCENGINE_TTS_VOICE_TYPE,
    },
    caller: {
      appId: process.env.CALLER_TTS_APP_ID,
      accessToken: process.env.CALLER_TTS_ACCESS_TOKEN,
      resourceId: process.env.CALLER_TTS_RESOURCE_ID,
      voiceType: process.env.CALLER_TTS_VOICE_TYPE,
    },
    format: process.env.VOLCENGINE_TTS_FORMAT || 'mp3',
    sampleRate: Number(process.env.VOLCENGINE_TTS_SAMPLE_RATE || 24000),
  },
  // ASR
  asr: {
    endpoint: process.env.VOLCENGINE_ASR_ENDPOINT,
    appId: process.env.VOLCENGINE_ASR_APP_ID,
    accessToken: process.env.VOLCENGINE_ASR_ACCESS_TOKEN,
    resourceId: process.env.VOLCENGINE_ASR_RESOURCE_ID,
  },
  // 日程（F9，本机 lark-cli；没装/没授权 = 功能未启用，上下文留空绝不编造）
  larkCliBin: process.env.LARK_CLI_BIN || 'lark-cli',
  // 主动推送（F12 周报 → 飞书私信给自己；没配 user open_id = 不推送）
  notify: { larkUserId: process.env.LARK_NOTIFY_USER_ID || '' },
  // 天气（F10，Open-Meteo 免密钥；坐标未配置 = 功能未启用，上下文留空绝不编造）
  weather: {
    lat: process.env.WEATHER_LAT ? Number(process.env.WEATHER_LAT) : null,
    lon: process.env.WEATHER_LON ? Number(process.env.WEATHER_LON) : null,
    city: process.env.WEATHER_CITY || '',
    cacheMs: 30 * 60_000,
  },
  // 编排规则（PRD F2/F3/F8 数值，改这里不改代码）
  rules: {
    refillCount: 3,            // 每次补 3 首
    lowWaterTracks: 2,         // 队列剩 ≤2 首触发补歌
    maxBufferTracks: 6,        // 队列上限 6 首
    refillBackoffMs: 45_000,   // 补歌失败 45s 退避
    trackCooldownMs: 24 * 3600_000, // 24h 同曲不重复
    artistWindow: 5,           // 近 5 首回避同艺人
    segueLeadS: 15,            // 歌尾 15s 串场窗口
    duckRatio: 0.16,           // 压混音量 16%
    fadeMs: 260,               // 淡入淡出 260ms
    prefetchLeadS: 10,         // 下一首剩 10s 预取
    coldOpenZh: [120, 220],    // 冷开场汉字区间
    bridgeZh: [40, 90],        // 串场汉字区间
    voiceMaxSeconds: 30,       // 长按录音上限（决策项 #15）
    neteaseTimeoutMs: 8_000,
    ytdlpTimeoutMs: 20_000,
  },
};
