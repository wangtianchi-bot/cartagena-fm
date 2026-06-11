// tests/llm.test.js
import { test } from 'node:test';
import assert from 'node:assert';
import { askJson } from '../src/llm.js';

// 伪造 OpenAI 兼容 client：依次返回 replies 里的字符串
function fakeClient(replies) {
  let i = 0;
  return { chat: { completions: { create: async () => ({ choices: [{ message: { content: replies[i++] } }] }) } } };
}

test('askJson: 正常 JSON 直接返回对象', async () => {
  const out = await askJson('p', { client: fakeClient(['{"play":["a - b"]}']) });
  assert.deepEqual(out, { play: ['a - b'] });
});

test('askJson: 容忍 markdown 代码围栏', async () => {
  const out = await askJson('p', { client: fakeClient(['```json\n{"x":1}\n```']) });
  assert.deepEqual(out, { x: 1 });
});

test('askJson: 首次坏 JSON → 重试 1 次成功', async () => {
  const out = await askJson('p', { client: fakeClient(['不是 JSON', '{"x":2}']) });
  assert.deepEqual(out, { x: 2 });
});

test('askJson: 两次都坏 → 返回 null（绝不返回原始文本）', async () => {
  const out = await askJson('p', { client: fakeClient(['坏', '还是坏']) });
  assert.equal(out, null);
});

test('askJson: client 抛错 → 返回 null 不上抛', async () => {
  const boom = { chat: { completions: { create: async () => { throw new Error('429'); } } } };
  assert.equal(await askJson('p', { client: boom }), null);
});

test('chatStream：流式分块回调 + 返回全文（V1.1.6 热线引擎）', async () => {
  const { chatStream } = await import('../src/llm.js');
  const fakeStream = {
    async *[Symbol.asyncIterator]() {
      yield { choices: [{ delta: { content: '嗯，' } }] };
      yield { choices: [{ delta: { content: '累在哪了？' } }] };
    },
  };
  const client = { chat: { completions: { create: async () => fakeStream } } };
  const deltas = [];
  const full = await chatStream([{ role: 'user', content: 'hi' }], { client, onDelta: (d) => deltas.push(d) });
  assert.deepEqual(deltas, ['嗯，', '累在哪了？']);
  assert.equal(full, '嗯，累在哪了？');
});
