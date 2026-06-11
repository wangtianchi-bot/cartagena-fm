// src/llm.js
import OpenAI from 'openai';
import { config } from './config.js';

let defaultClient;
function getClient() {
  defaultClient ??= new OpenAI({ apiKey: config.deepseekApiKey, baseURL: 'https://api.deepseek.com' });
  return defaultClient;
}

function extractJson(text) {
  if (!text) return null;
  // 容忍 ```json 围栏与前后闲话：取第一个 { 到最后一个 }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

// 流式多轮对话（F14 热线，V1.1.6 学 Claudio）：纯文本输出、逐块回调——
// 首批字 ~1s 就到，前端逐字上屏 + 逐句 TTS，这才是"想一秒就开口"的来源。失败抛错，上层回退 chatOnce。
export async function chatStream(messages, { client = getClient(), timeoutMs = 20_000, maxTokens = 300, onDelta = () => {} } = {}) {
  const stream = await client.chat.completions.create({
    model: config.deepseekModel, messages, temperature: 0.85, max_tokens: maxTokens, stream: true,
  }, { timeout: timeoutMs });
  let full = '';
  for await (const chunk of stream) {
    const d = chunk.choices?.[0]?.delta?.content;
    if (d) { full += d; onDelta(d); }
  }
  return full;
}

// 非流式一次性对话：chatStream 失败时的兜底
export async function chatOnce(messages, { client = getClient(), timeoutMs = 15_000, maxTokens = 300 } = {}) {
  const res = await client.chat.completions.create({
    model: config.deepseekModel, messages, temperature: 0.85, max_tokens: maxTokens,
  }, { timeout: timeoutMs });
  return res.choices?.[0]?.message?.content || '';
}

// 返回解析后的对象；两次尝试均失败返回 null（上层自行降级，绝不把原文当口播）
// timeoutMs/maxTokens：热线等延迟敏感场景用——API 抖动时快速失败，绝不让用户干等（V1.1.4）
export async function askJson(prompt, { client = getClient(), retries = 1, timeoutMs = null, maxTokens = null } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const body = {
        model: config.deepseekModel,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.8,
      };
      if (maxTokens) body.max_tokens = maxTokens;
      const res = await client.chat.completions.create(body, timeoutMs ? { timeout: timeoutMs } : undefined);
      const obj = extractJson(res.choices?.[0]?.message?.content);
      if (obj) return obj;
    } catch (e) {
      console.error(`[llm] attempt ${attempt} failed:`, e.message);
    }
  }
  return null;
}
