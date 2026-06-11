// tests/notify.test.js —— 飞书周报推送
import { test } from 'node:test';
import assert from 'node:assert';
import { formatReportMarkdown, pushLark, lanUrl } from '../src/notify.js';

const REPORT = {
  weekOf: '2026-06-11',
  observations: ['本周切掉 2 首钢琴曲', '完整听完《红豆》'],
  suggestions: [
    { change: '把"钢琴"移到仅深夜', why: '白天切钢琴' },
    { change: '增加周杰伦权重', why: '主动点歌' },
  ],
};

test('formatReportMarkdown: 含观察、建议、电台链接', () => {
  const md = formatReportMarkdown(REPORT, 'http://localhost:8080');
  assert.ok(md.includes('2026-06-11'));
  assert.ok(md.includes('本周切掉 2 首钢琴曲'));
  assert.ok(md.includes('把"钢琴"移到仅深夜'));
  assert.ok(md.includes('http://localhost:8080'));
});

test('lanUrl: 返回 http://IP:port，不用 localhost（手机点得开）', () => {
  const u = lanUrl(8080);
  assert.match(u, /^http:\/\/[\d.]+:8080$/);
  assert.ok(!u.includes('localhost'), '飞书链接不能是 localhost');
  assert.ok(!u.includes('198.18.'), '不能选到 VPN/代理虚拟网卡');
});

test('pushLark: 配了 userId → 用 lark-cli 发 markdown 给本人', async () => {
  let calledArgs = null;
  const exec = async (bin, args) => { calledArgs = { bin, args }; return '{"ok":true}'; };
  const ok = await pushLark(REPORT, { exec, bin: '/x/lark-cli', userId: 'ou_me', url: 'http://localhost:8080' });
  assert.equal(ok, true);
  assert.equal(calledArgs.bin, '/x/lark-cli');
  assert.deepEqual(calledArgs.args.slice(0, 4), ['im', '+messages-send', '--user-id', 'ou_me']);
  assert.ok(calledArgs.args.includes('--markdown'));
  const md = calledArgs.args[calledArgs.args.indexOf('--markdown') + 1];
  assert.ok(md.includes('钢琴'));
});

test('pushLark: 没配 userId → 跳过不报错（功能未启用）', async () => {
  let called = false;
  const exec = async () => { called = true; return '{}'; };
  assert.equal(await pushLark(REPORT, { exec, userId: '' }), false);
  assert.equal(called, false);
});

test('pushLark: 没有 report → 不发', async () => {
  let called = false;
  const exec = async () => { called = true; return '{}'; };
  assert.equal(await pushLark(null, { exec, userId: 'ou_me' }), false);
  assert.equal(called, false);
});

test('pushLark: lark-cli 抛错 → 返回 false 不冒泡（推送失败不该拖垮周报）', async () => {
  const exec = async () => { throw new Error('cli down'); };
  assert.equal(await pushLark(REPORT, { exec, userId: 'ou_me' }), false);
});
