// src/quickpick.js —— 点歌快路径的点名抽取（借鉴 Claudio V1.5：明确点名不过 LLM，直搜直切）
// 抽不出明确点名返回 null，上层回退到两段式 LLM 管线。

// 只认"明确点歌"句式；裸"放/换/听"开头太容易误伤（"放松一下"），不收
const LEAD = /^(?:我?想要?听|来[一]?首|点[一]?首|放[一]?首|我要听|切[到成]|换成)\s*/;
// 尾部语气词/标点/"的歌|的音乐"逐层剥掉
const TAIL = /(?:的歌|的音乐|歌曲|吧|呗|啊|呀|呢|哦|喔|嘛|了|[。！？!?，,．.\s])+$/;
// 模糊词：剥完只剩这些说明没点名
const VAGUE = new Set(['歌', '音乐', '什么', '点什么', '一首', '随便', '安静的', '热闹的']);

export function extractSongQuery(text) {
  let s = String(text || '').trim();
  const m = s.match(LEAD);
  if (!m) return null;
  s = s.slice(m[0].length);
  s = s.replace(TAIL, '').replace(/^《|》$/g, '').trim();
  if (!s || s.length > 30 || VAGUE.has(s)) return null;
  return s;
}
