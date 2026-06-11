// scripts/audit-hallucination.js —— PRD §2.2 P0 红线：口播提及的歌 100% 在已确认歌单内
// 原理：用真实 LLM + 假音乐源反复跑管线，校验所有 segment 文本里的《》都在确认歌单内。
import { runRefill } from '../src/pipeline.js';
import { resolveTracks } from '../src/music/index.js';
import { openDb } from '../src/db.js';

const FAKE_POOL = [
  ['红豆', '方大同'], ['理想三旬', '陈鸿宇'], ['玫瑰', '贰佰'], ['斑马斑马', '宋冬野'],
  ['春风十里', '鹿先森乐队'], ['小半', '陈粒'], ['运气来得若有似无', '颜人中'],
];
// 假 provider：候选只要命中池子就"可播"（模拟一部分候选会落空的现实）
const provider = { getTrack: async (q) => {
  const hit = FAKE_POOL.find(([t, a]) => q.includes(t));
  return hit ? { id: q, title: hit[0], artist: hit[1], streamUrl: 'http://fake', lyrics: '' } : null;
} };
const noTts = async () => '/tmp/fake.mp3'; // 审计只看文本，不真合成

let violations = 0, runs = 0;
for (let i = 0; i < 20; i++) {
  const db = openDb(':memory:'); // 每轮新库，避免去重耗尽池子
  const out = await runRefill(db, {
    resolveTracks: (cands, opts) => resolveTracks(cands, { ...opts, provider }), // 真闸门 + 假音乐源
    synthesize: noTts,
  });
  if (!out) { console.log(`#${i} 管线返回 null（第一段失败或全部落空），跳过`); continue; }
  runs++;
  const known = new Set(out.tracks.map(t => t.title));
  for (const s of out.segments) {
    for (const m of String(s.text).matchAll(/《([^》]+)》/g)) {
      if (!known.has(m[1])) { violations++; console.error(`❌ #${i} 幻觉：${m[1]} ∉ 确认歌单`); }
    }
  }
  console.log(`#${i} ok — ${out.tracks.length} 首 / ${out.segments.length} 段（落空候选 ${out.failed.length}）`);
}
console.log(`\n有效轮次 ${runs}，幻觉违例 ${violations}`);
if (runs === 0) { console.error('❌ 零有效轮次：审计未覆盖任何输出（检查 API key / 网络）'); process.exit(1); }
process.exit(violations === 0 ? 0 : 1);
