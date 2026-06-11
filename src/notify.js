// src/notify.js —— 把品味观察周报主动推送到 azu 的飞书（本机 lark-cli，发给自己）
// 没配 LARK_NOTIFY_USER_ID = 功能未启用，静默跳过；推送失败绝不拖垮周报生成。
import { execFile } from 'node:child_process';
import os from 'node:os';
import { config } from './config.js';

// 推送链接用的地址：飞书消息常在手机上点开，localhost 指手机自己→连不上（azu 实测 -1004）。
// 改用本机局域网 IP，同 WiFi 下手机也能打开；电脑点也通。优先私网段，避开 VPN/代理虚拟网卡（如 198.18.*）。
export function lanUrl(port = config.port) {
  const rank = (ip) => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1
    : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 9;
  const cands = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) cands.push(ni.address);
    }
  }
  cands.sort((a, b) => rank(a) - rank(b));
  const ip = cands.find(a => rank(a) < 9) ?? cands[0];
  return ip ? `http://${ip}:${port}` : `http://localhost:${port}`;
}

function realExec(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 15_000 }, (err, stdout) => {
      if (err) reject(err); else resolve(stdout);
    });
  });
}

// 纯函数：把周报渲染成飞书 markdown（lark-cli --markdown 会自动解析链接）
export function formatReportMarkdown(report, url) {
  const obs = (report.observations ?? []).map(o => `· ${o}`).join('\n') || '（这周没攒下什么观察）';
  const sug = (report.suggestions ?? []).map((s, i) => `${i + 1}. ${s.change}（依据：${s.why}）`).join('\n');
  return [
    `📻 **品味观察周报 · ${report.weekOf}**`,
    '',
    '这周电台对你的观察：',
    obs,
    '',
    '修订建议（去电台勾选确认才会写进 taste.md，不点一个字不动）：',
    sug || '（这周没有修订建议）',
    '',
    `👉 打开电台查看并确认：[${url}](${url})`,
    '（需电脑开着电台、手机连同一 WiFi；在电脑上点最稳）',
  ].join('\n');
}

export async function pushLark(report, {
  exec = realExec, bin = config.larkCliBin,
  userId = config.notify.larkUserId, url = lanUrl(),
} = {}) {
  if (!report || !userId) return false; // 未配置或无报告 = 不推送
  try {
    await exec(bin, ['im', '+messages-send', '--user-id', userId,
      '--markdown', formatReportMarkdown(report, url), '--format', 'json']);
    return true;
  } catch (e) {
    console.error('[notify]', e.message);
    return false;
  }
}
