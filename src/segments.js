// src/segments.js —— 第二道防幻觉闸门：结构校验 + 歌单外提及降级 silence
const TYPES = new Set(['cold_open', 'bridge', 'quick_touch', 'back_announce', 'silence']);
const POSITIONS = new Set(['before_track', 'between_tracks', 'after_track', 'immediate']);

export function countHan(text) {
  return (String(text).match(/\p{Script=Han}/gu) || []).length;
}

// 热线回应分句（F14）：逐句独立 TTS，句间自然留呼吸——"断句思考感"是拆出来的
export function splitSentences(text) {
  return String(text).split(/(?<=[。！？…!?])/).map(s => s.trim()).filter(Boolean);
}

function structOk(s, trackCount) {
  if (!TYPES.has(s.type) || !POSITIONS.has(s.position)) return false;
  const inRange = (i) => Number.isInteger(i) && i >= 0 && i < trackCount;
  if (s.position === 'between_tracks') return inRange(s.afterTrackIndex) && inRange(s.beforeTrackIndex);
  if (s.position === 'before_track' || s.position === 'after_track') return inRange(s.trackIndex);
  return true; // immediate 无索引要求
}

// 《》里出现了不在确认歌单里的名字 → 视为幻觉
// extraKnown：额外合法曲名（满串场要点评刚播过的歌——nowPlaying / 最近播放，V1.0.8）
// V1.1.9 改包含匹配：搜到的常是「晴天周杰伦(从前从前…)」这种翻唱长名，DJ 自然说《晴天》
// 不该被拦——提及名 ≥2 字且与白名单互为包含即放行；真幻觉（完全无关的歌名）照拦
function mentionsUnknownTitle(text, tracks, extraKnown = []) {
  const known = [...tracks.map(t => t.title), ...extraKnown];
  for (const m of String(text).matchAll(/《([^》]+)》/g)) {
    const name = m[1];
    const ok = known.some(k => k === name ||
      (name.length >= 2 && (k.includes(name) || name.includes(k))));
    if (!ok) return true;
  }
  return false;
}

export function sanitizeSegments(segments, tracks, extraKnown = []) {
  if (!Array.isArray(segments)) return [];
  const out = [];
  for (const s of segments) {
    if (!s || !structOk(s, tracks.length)) continue;
    if (s.type === 'silence') { out.push({ ...s, text: '' }); continue; }
    if (!s.text || mentionsUnknownTitle(s.text, tracks, extraKnown)) {
      console.warn('[anti-hallucination] segment 降级 silence:', String(s.text ?? '').slice(0, 50));
      out.push({ ...s, type: 'silence', text: '' });
      continue;
    }
    out.push(s);
  }
  return out;
}
