import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import translation from '../electron/translation.cjs';
import { mostlyChinese, translatable } from '../src/translation-text.ts';
import { conversation } from '../src/transcript.ts';

const {
  normalizeBase,
  protect,
  restore,
  translate,
  listModels,
  limiter,
  cache,
  loadConfig,
  encodeConfig,
  publicConfig,
  defaultModel,
} = translation;
const here = dirname(fileURLToPath(import.meta.url));
const source = (file) => readFileSync(join(here, '..', file), 'utf8');
// Code only: comments and the user-facing Chinese words (which say Claude is not used) are left out.
const code = (text) =>
  text
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(["'`])(?:(?!\1)[^\n])*[\u3400-\u9fff](?:(?!\1)[^\n])*\1/g, '""');
const key = 'user-own-key-0123456789';
const config = { baseUrl: 'https://cpa.example.com:50443', key, model: defaultModel };

function vault() {
  const secret = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'dpapi',
    encryptString(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, iv);
      const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    decryptString(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
// A stand-in for the OpenAI-compatible API, answering with what `reply` makes of the request.
function fakeFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, body } = await reply(calls.at(-1));
    return { ok: status < 300, status, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}
const completion = (content) => ({
  body: { choices: [{ message: { role: 'assistant', content } }] },
});

test('the base URL is accepted with or without /v1 and always reaches {base}/v1/...', () => {
  for (const value of [
    'https://cpa.ds.meread.com:50443',
    'https://cpa.ds.meread.com:50443/',
    'https://cpa.ds.meread.com:50443/v1',
    'https://cpa.ds.meread.com:50443/v1/',
    ' https://cpa.ds.meread.com:50443/v1/chat/completions ',
  ])
    assert.equal(normalizeBase(value), 'https://cpa.ds.meread.com:50443');
  assert.equal(normalizeBase('https://host/proxy/v1'), 'https://host/proxy');
  assert.equal(normalizeBase(''), '');
  assert.throws(() => normalizeBase('ftp://host'), /接口地址无效/);
  assert.throws(() => normalizeBase('not a url'), /接口地址无效/);
});

test('fenced code blocks are kept out of the request and come back unchanged', () => {
  const text = 'Run this:\n\n```bash\nnpm test -- --watch\n```\n\nThen:\n~~~\nraw\n~~~\nDone.';
  const { masked, blocks } = protect(text);
  assert.equal(blocks.length, 2);
  assert.ok(!masked.includes('npm test'));
  assert.ok(masked.includes('@@CODE_BLOCK_0@@') && masked.includes('@@CODE_BLOCK_1@@'));
  const back = restore(masked.replace('Run this:', '运行：').replace('Done.', '完成。'), blocks);
  assert.equal(back, text.replace('Run this:', '运行：').replace('Done.', '完成。'));
  // A placeholder the model dropped still shows its block.
  assert.match(restore('只有文字', blocks), /```bash\nnpm test -- --watch\n```/);
  // An unterminated fence runs to the end, as Markdown shows it.
  assert.equal(protect('Look:\n```\nopen').blocks[0], '```\nopen');
});

test('translate posts to {base}/v1/chat/completions with the bearer key and restores code', async () => {
  const { fetch, calls } = fakeFetch(({ body }) => {
    const text = body.messages[1].content;
    return completion(
      text
        .replace('**What this gives the port:**', '**这给移植带来了什么：**')
        .replace('- Set `target_type = 3` first', '- 先设置 `target_type = 3`')
        .replace('Next:', '下一步：'),
    );
  });
  const text =
    '**What this gives the port:**\n\n- Set `target_type = 3` first\n\n```ts\nconst a = 1;\n```\n\nNext:';
  const result = await translate({ ...config, baseUrl: `${config.baseUrl}/v1/` }, text, { fetch });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cpa.example.com:50443/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${key}`);
  assert.equal(calls[0].body.model, defaultModel);
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[0].content, /Simplified Chinese/);
  assert.match(calls[0].body.messages[0].content, /Markdown/);
  assert.ok(!calls[0].body.messages[1].content.includes('const a = 1;'));
  assert.equal(
    result,
    '**这给移植带来了什么：**\n\n- 先设置 `target_type = 3`\n\n```ts\nconst a = 1;\n```\n\n下一步：',
  );
});

test('a text of nothing but code is returned as it is, without a call', async () => {
  const { fetch, calls } = fakeFetch(() => completion('x'));
  const text = '```\nls -la\n```';
  assert.equal(await translate(config, text, { fetch }), text);
  assert.equal(calls.length, 0);
});

test('models come from GET {base}/v1/models', async () => {
  const { fetch, calls } = fakeFetch(() => ({
    body: {
      object: 'list',
      data: [{ id: 'grok-4.3' }, { id: defaultModel }, { id: 'grok-3-mini-fast' }],
    },
  }));
  const models = await listModels({ baseUrl: 'https://cpa.example.com:50443/v1', key }, { fetch });
  assert.equal(calls[0].url, 'https://cpa.example.com:50443/v1/models');
  assert.equal(calls[0].init.method, 'GET');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${key}`);
  assert.deepEqual(models, ['grok-3-mini-fast', defaultModel, 'grok-4.3']);
});

test('failures say why in Chinese, never with the key in them', async () => {
  const { fetch } = fakeFetch(() => ({
    status: 401,
    body: { error: { message: `bad key ${key}` } },
  }));
  await assert.rejects(translate(config, 'Hello there', { fetch }), (error) => {
    assert.match(error.message, /API Key 无效/);
    assert.ok(!error.message.includes(key));
    return true;
  });
  const empty = fakeFetch(() => ({ body: { choices: [] } }));
  await assert.rejects(translate(config, 'Hello', { fetch: empty.fetch }), /没有返回译文/);
  const hang = (_url, init) =>
    new Promise((_resolve, reject) =>
      init.signal.addEventListener('abort', () => reject(new Error('aborted'))),
    );
  await assert.rejects(translate(config, 'Hello', { fetch: hang, timeoutMs: 50 }), /没有响应/);
});

test('without the user’s own endpoint and key nothing is called: no fallback of any kind', async () => {
  const { fetch, calls } = fakeFetch(() => completion('不应调用'));
  await assert.rejects(translate({ ...config, baseUrl: '' }, 'Hello', { fetch }), /接口地址/);
  await assert.rejects(translate({ ...config, key: '' }, 'Hello', { fetch }), /API Key/);
  await assert.rejects(listModels({ baseUrl: '', key: '' }, { fetch }), /接口地址/);
  assert.equal(calls.length, 0);
});

test('translation never goes through Claude, the service, the account pool or the agent SDK', () => {
  const claude = /claude|anthropic|account[-_ ]?pool|accountPool|agent-sdk|query\(/i;
  // The engine reaches nothing but the fetch it is given, aimed at the configured base URL.
  const engine = source('electron/translation.cjs');
  assert.deepEqual([...engine.matchAll(/require\('([^']+)'\)/g)].map((match) => match[1]).sort(), [
    'node:crypto',
    'node:fs',
  ]);
  assert.doesNotMatch(code(engine), claude);
  // In the main process its handlers call only that engine through Electron's own net.fetch.
  const main = source('electron/main.cjs');
  const handlers = main.slice(main.indexOf("const translation = require('./translation.cjs')"));
  const block = handlers.slice(0, handlers.indexOf('// Replaces a file whole'));
  assert.match(block, /const translationFetch = \(url, init\) => net\.fetch\(url, init\);/);
  assert.doesNotMatch(code(block), claude);
  assert.doesNotMatch(block, /bridges|probe|proxy-bridge|quota|profiles/);
  // The window's side asks the desktop's translator only, never the connection to the service.
  for (const file of [
    'src/translation.ts',
    'src/ReplyTranslation.tsx',
    'src/TranslationSettings.tsx',
  ]) {
    const text = source(file);
    assert.doesNotMatch(
      text,
      /from '\.\/client\.ts'|@cc-desk-tunnel\/protocol|WebSocket|sendMessage/,
    );
    assert.doesNotMatch(code(text), claude);
  }
  const preload = source('electron/preload.cjs');
  const bridge = preload.slice(preload.indexOf("exposeInMainWorld('translator'"));
  assert.deepEqual(
    [...bridge.matchAll(/invoke\('([^']+)'/g)].map((match) => match[1]),
    [
      'translation:settings',
      'translation:save',
      'translation:models',
      'translation:test',
      'translation:cached',
      'translation:translate',
    ],
  );
  // And the service has no translation of its own to fall back to.
  for (const file of ['../server/src/claude.ts', '../server/src/server.ts'])
    try {
      assert.doesNotMatch(source(file), /translat/i);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
});

test('a real HTTP round trip against a local OpenAI-compatible stand-in', async () => {
  const seen = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      seen.push({ method: request.method, url: request.url, auth: request.headers.authorization });
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/models')
        return response.end(JSON.stringify({ data: [{ id: defaultModel }] }));
      const { messages } = JSON.parse(body);
      response.end(
        JSON.stringify({ choices: [{ message: { content: `译：${messages[1].content}` } }] }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const local = { ...config, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
    assert.deepEqual(await listModels(local, { fetch }), [defaultModel]);
    assert.equal(await translate(local, 'Hello', { fetch }), '译：Hello');
    assert.deepEqual(seen, [
      { method: 'GET', url: '/v1/models', auth: `Bearer ${key}` },
      { method: 'POST', url: '/v1/chat/completions', auth: `Bearer ${key}` },
    ]);
  } finally {
    server.close();
  }
});

test('at most two translations run at a time', async () => {
  const limit = limiter(2);
  let running = 0;
  let most = 0;
  const task = () =>
    limit(async () => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
    });
  await Promise.all(Array.from({ length: 7 }, task));
  assert.equal(most, 2);
});

test('translations are cached on disk by their text and survive a restart', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'ccdt-translation-')), 'translations.json');
  const first = cache(file, 2);
  first.set('Hello', '你好');
  first.set('World', '世界');
  assert.equal(cache(file).get('Hello'), '你好');
  first.set('Third', '第三');
  const again = cache(file);
  assert.equal(again.get('Hello'), null);
  assert.equal(again.get('Third'), '第三');
  assert.ok(!readFileSync(file, 'utf8').includes('Hello'));
});

test('the key is stored encrypted and the window only learns whether there is one', () => {
  const storage = vault();
  const saved = encodeConfig(
    { enabled: true, baseUrl: 'https://cpa.example.com:50443/v1/', key, model: '' },
    undefined,
    storage,
  );
  assert.ok(!JSON.stringify(saved).includes(key));
  assert.equal(saved.baseUrl, 'https://cpa.example.com:50443');
  assert.equal(saved.model, defaultModel);
  const loaded = loadConfig(saved, storage);
  assert.equal(loaded.key, key);
  assert.deepEqual(publicConfig(loaded, storage), {
    enabled: true,
    baseUrl: 'https://cpa.example.com:50443',
    model: defaultModel,
    hasKey: true,
    secure: true,
  });
  // Leaving the key out keeps it; '' removes it.
  assert.equal(loadConfig(encodeConfig({ model: 'grok-4.3' }, saved, storage), storage).key, key);
  assert.equal(loadConfig(encodeConfig({ key: '' }, saved, storage), storage).key, '');
  const plain = { ...vault(), getSelectedStorageBackend: () => 'basic_text' };
  assert.throws(() => encodeConfig({ key }, undefined, plain), /安全存储不可用/);
  assert.deepEqual(loadConfig(undefined, storage), {
    enabled: false,
    baseUrl: '',
    model: defaultModel,
    key: '',
  });
});

test('Chinese text and code alone are not translated; English is', () => {
  assert.equal(mostlyChinese('好的，我已经修改了 `src/app.ts` 里的配置。'), true);
  assert.equal(mostlyChinese('```\nconst value = compute();\n```'), true);
  assert.equal(mostlyChinese('**What this gives the port:** Set `target_type = 3` first.'), false);
  assert.equal(
    mostlyChinese('Fixed it. 已修复 the parser in several places for long inputs.'),
    false,
  );
});

let sequence = 0;
const at = (second) => new Date(Date.UTC(2026, 10, 10, 2, 0, second)).toISOString();
const event = (runId, second, payload) => ({
  sessionId: 'session',
  runId,
  sequence: ++sequence,
  createdAt: at(second),
  payload,
});

test('every block of AI text and thinking is translatable once whole, tool output never', () => {
  const events = [
    event('run', 0, { type: 'message.user', messageId: 'q', text: '做事' }),
    event('run', 1, {
      type: 'thinking.delta',
      messageId: 'm1',
      text: 'Let me look at the parser.',
    }),
    event('run', 2, { type: 'text.delta', messageId: 'm1', text: 'Checking the parser first.' }),
    event('run', 3, {
      type: 'tool.requested',
      toolId: 't1',
      name: 'Bash',
      input: 'ls',
      target: 'ls',
    }),
    event('run', 4, { type: 'text.delta', messageId: 'm2', text: '**What this gives the port:**' }),
  ];
  const writing = translatable(conversation(events));
  assert.deepEqual(
    writing.map((block) => [block.id, block.kind, block.complete]),
    [
      ['thinking-m1', 'thinking', true],
      ['m1', 'assistant', true],
      ['m2', 'assistant', false],
    ],
  );
  const done = translatable(
    conversation([
      ...events,
      event('run', 5, { type: 'text.delta', messageId: 'm2', text: '\n\n- one\n- two' }),
      event('run', 6, { type: 'run.status', status: 'completed' }),
    ]),
  );
  assert.deepEqual(
    done.map((block) => [block.id, block.complete]),
    [
      ['thinking-m1', true],
      ['m1', true],
      ['m2', true],
    ],
  );
  assert.equal(done.at(-1).text, '**What this gives the port:**\n\n- one\n- two');
  assert.ok(done.every((block) => block.kind !== 'tool'));
});
