import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

// The desktop's translator (preload `translator`, backed by the user's own OpenAI-compatible API in the main process)
// stood in for in the page: it records what it was asked and answers with a fixed Chinese text per English one.
const answer =
  '**What this gives the port:**\n\n- Set `target_type = 3` first\n- Keep `src/port.ts` as it is\n\n```ts\nconst port = 3;\n```\n\nNext:';
const answerZh =
  '**这给移植带来了什么：**\n\n- 先设置 `target_type = 3`\n- 保持 `src/port.ts` 不变\n\n```ts\nconst port = 3;\n```\n\n下一步：';
const step = 'Checking the parser before changing it.';
const stepZh = '先检查解析器再修改。';
const thought = 'The parser probably drops the last token.';
const thoughtZh = '解析器大概丢掉了最后一个记号。';
const [m1, m2, m3] = [randomUUID(), randomUUID(), randomUUID()];
const connectionId = randomUUID();

async function stubTranslator(page: Page, enabled: boolean) {
  await page.addInitScript(
    ({ enabled, pairs }) => {
      const asked: string[] = [];
      (window as unknown as { translationsAsked: string[] }).translationsAsked = asked;
      const table = new Map(pairs);
      window.translator = {
        settings: async () => ({
          enabled,
          baseUrl: 'https://cpa.example.com:50443',
          model: 'grok-4.20-0309-non-reasoning',
          hasKey: true,
          secure: true,
        }),
        save: async () => ({ error: 'not in this test' }),
        models: async () => ({ value: [] }),
        test: async () => ({ error: 'not in this test' }),
        cached: async () => null,
        translate: async (text: string) => {
          asked.push(text);
          return { value: table.get(text) ?? `译文：${text}` };
        },
      };
    },
    {
      enabled,
      pairs: [
        [answer, answerZh],
        [step, stepZh],
        [thought, thoughtZh],
      ] as [string, string][],
    },
  );
}
const asked = (page: Page) =>
  page.evaluate(() => (window as unknown as { translationsAsked: string[] }).translationsAsked);

async function open(page: Page, history: (event: (payload: unknown) => unknown) => unknown[]) {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '翻译测试',
    autoTitle: false,
    projectPath: 'D:\\Work',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  let push: (payload: unknown) => void = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18871/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    let sequence = 0;
    const runId = randomUUID();
    const start = Date.now() - 3_600_000;
    const event = (payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence: ++sequence,
      createdAt: new Date(start + sequence * 1000).toISOString(),
      payload,
    });
    const events = history(event);
    const liveRun = randomUUID();
    push = (payload) =>
      send({
        type: 'session.event',
        event: {
          sessionId: session.id,
          runId: liveRun,
          sequence: ++sequence,
          createdAt: new Date().toISOString(),
          payload,
        },
      });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (message.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events,
        });
      if (message.requestId) send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18871/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('test-only-translation-token-1234567890');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  return (payload: unknown) => push(payload);
}

const finishedTurn = (event: (payload: unknown) => unknown) => [
  event({ type: 'message.user', messageId: randomUUID(), text: '修一下解析器', scenario: 'chat' }),
  event({ type: 'thinking.delta', messageId: m1, text: thought }),
  event({ type: 'text.delta', messageId: m1, text: step }),
  event({
    type: 'tool.requested',
    toolId: 't1',
    name: 'Bash',
    input: JSON.stringify({ command: 'ls', description: 'list files' }),
    target: 'Windows',
  }),
  event({
    type: 'tool.result',
    toolId: 't1',
    status: 'completed',
    output: 'English tool output that must stay as it is',
    exitCode: 0,
  }),
  event({ type: 'text.delta', messageId: m2, text: answer }),
  event({ type: 'run.status', status: 'completed', connectionId }),
];

test('history is not translated on its own; each block has a 翻译 button and shows a bilingual pair', async ({
  page,
}) => {
  await stubTranslator(page, true);
  await open(page, finishedTurn);
  const reply = page.locator('.message.assistant.latest');
  await expect(reply.locator('.message-content').first()).toContainText(
    'What this gives the port:',
  );
  // Opened history is left alone even with automatic translation on.
  await page.waitForTimeout(500);
  expect(await asked(page)).toEqual([]);
  await reply.getByRole('button', { name: '翻译', exact: true }).click();
  const pair = reply.getByRole('region', { name: '中文译文' });
  await expect(pair).toContainText('这给移植带来了什么：');
  // The translation is Markdown rendered as the original is: bold, a list, inline code and the code block.
  await expect(pair.locator('strong')).toHaveText('这给移植带来了什么：');
  await expect(pair.locator('li')).toHaveCount(2);
  await expect(pair.locator('li code').first()).toHaveText('target_type = 3');
  await expect(pair.locator('pre')).toContainText('const port = 3;');
  // The English stays above it.
  await expect(reply.locator('.message-content').first()).toContainText(
    'Set target_type = 3 first',
  );
  expect(await asked(page)).toEqual([answer]);
  // The pair folds and unfolds.
  await pair.getByRole('button', { name: '中文' }).click();
  await expect(pair.locator('strong')).toHaveCount(0);
  await pair.getByRole('button', { name: '中文' }).click();
  await expect(pair.locator('strong')).toHaveText('这给移植带来了什么：');
  // Text said along the way and the thinking have their own button; tool output has none.
  await page.locator('.turn-process > summary, .turn-process > button').first().click();
  const along = page.locator('.message.assistant').filter({ hasText: step });
  await along.getByRole('button', { name: '翻译', exact: true }).click();
  await expect(along.getByRole('region', { name: '中文译文' })).toContainText(stepZh);
  expect(await asked(page)).not.toContain('English tool output that must stay as it is');
});

test('with automatic translation on, every new block is translated once whole; Chinese is not', async ({
  page,
}) => {
  await stubTranslator(page, true);
  const push = await open(page, () => []);
  push({ type: 'run.status', status: 'running', connectionId });
  push({ type: 'message.user', messageId: randomUUID(), text: '修一下解析器', scenario: 'chat' });
  push({ type: 'thinking.delta', messageId: m1, text: thought });
  push({ type: 'text.delta', messageId: m1, text: 'Checking the parser ' });
  // Still being written: nothing is asked yet.
  await page.waitForTimeout(400);
  expect(await asked(page)).toEqual([thought]);
  push({ type: 'text.delta', messageId: m1, text: 'before changing it.' });
  push({
    type: 'tool.requested',
    toolId: 't1',
    name: 'Bash',
    input: JSON.stringify({ command: 'ls', description: 'list files' }),
    target: 'Windows',
  });
  push({
    type: 'tool.result',
    toolId: 't1',
    status: 'completed',
    output: 'English tool output that must stay as it is',
    exitCode: 0,
  });
  await expect.poll(() => asked(page)).toEqual([thought, step]);
  const along = page.locator('.message.assistant').filter({ hasText: step });
  await expect(along.getByRole('region', { name: '中文译文' })).toContainText(stepZh);
  push({ type: 'text.delta', messageId: m2, text: '好的，已经改完了，`npm test` 全部通过。' });
  push({ type: 'text.delta', messageId: m3, text: answer });
  push({ type: 'run.status', status: 'completed', connectionId });
  await expect.poll(() => asked(page)).toEqual([thought, step, answer]);
  const reply = page.locator('.message.assistant.latest');
  await expect(reply.getByRole('region', { name: '中文译文' }).locator('strong')).toHaveText(
    '这给移植带来了什么：',
  );
  // The Chinese reply along the way has no button and was never sent.
  await expect(
    page
      .locator('.message.assistant')
      .filter({ hasText: '已经改完了' })
      .getByRole('button', { name: '翻译', exact: true }),
  ).toHaveCount(0);
});

test('settings: base URL, masked key, model list, test and save go to the desktop translator only', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const calls: unknown[][] = [];
    (window as unknown as { translatorCalls: unknown[][] }).translatorCalls = calls;
    let saved = {
      enabled: false,
      baseUrl: '',
      model: 'grok-4.20-0309-non-reasoning',
      hasKey: false,
      secure: true,
    };
    window.translator = {
      settings: async () => saved,
      save: async (change) => {
        calls.push(['save', change]);
        saved = {
          ...saved,
          ...(change.enabled !== undefined ? { enabled: change.enabled } : {}),
          ...(change.baseUrl !== undefined
            ? { baseUrl: change.baseUrl.replace(/\/v1\/?$/, '') }
            : {}),
          ...(change.model !== undefined ? { model: change.model } : {}),
          ...(change.key !== undefined ? { hasKey: !!change.key } : {}),
        };
        return { value: saved };
      },
      models: async (draft) => {
        calls.push(['models', draft]);
        return { value: ['grok-3-mini-fast', 'grok-4.20-0309-non-reasoning', 'grok-4.3'] };
      },
      test: async (draft) => {
        calls.push(['test', draft]);
        return { value: { source: 'The build passed.', text: '构建通过了。', ms: 4800 } };
      },
      cached: async () => null,
      translate: async () => ({ error: 'unused' }),
    };
  });
  await open(page, () => []);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '回复翻译', exact: true }).click();
  const autoSwitch = page.getByRole('switch', { name: '自动翻译 AI 回复为中文' });
  await expect(autoSwitch).toHaveAttribute('aria-checked', 'false');
  // Not configured: switching on only says what is missing.
  await autoSwitch.click();
  await expect(page.getByRole('alert')).toContainText('请先填写并保存接口地址和 API Key');
  await page.getByLabel('接口地址（Base URL）').fill('https://cpa.ds.meread.com:50443/v1');
  const key = page.getByLabel('API Key');
  await expect(key).toHaveAttribute('type', 'password');
  await key.fill('typed-key-for-test');
  await page.getByRole('button', { name: '获取模型列表' }).click();
  await page.getByLabel('选择模型').selectOption('grok-4.3');
  await expect(page.getByLabel('模型', { exact: true })).toHaveValue('grok-4.3');
  await page.getByRole('button', { name: '测试', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '测试成功' })).toContainText(
    '构建通过了。',
  );
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(key).toHaveAttribute('placeholder', '已保存（留空保持不变）');
  await autoSwitch.click();
  await expect(autoSwitch).toHaveAttribute('aria-checked', 'true');
  const draft = {
    baseUrl: 'https://cpa.ds.meread.com:50443/v1',
    model: 'grok-4.20-0309-non-reasoning',
    key: 'typed-key-for-test',
  };
  expect(
    await page.evaluate(
      () => (window as unknown as { translatorCalls: unknown[][] }).translatorCalls,
    ),
  ).toEqual([
    ['models', draft],
    ['test', { ...draft, model: 'grok-4.3' }],
    ['save', { ...draft, model: 'grok-4.3' }],
    ['save', { enabled: true }],
  ]);
});
