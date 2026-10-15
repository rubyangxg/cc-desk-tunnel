import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { EventPayload, Session } from '@cc-desk-tunnel/protocol';

test('slash menu filters native commands, completes without sending, and dispatches commands intact', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '指令测试',
    autoTitle: false,
    projectPath: 'D:\\Work',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const runId = randomUUID();
  const sent: { type: string; text?: string }[] = [];
  let push: (payload: EventPayload) => void = () => {};
  let sequence = 2;
  const capabilities: EventPayload = {
    type: 'native.capabilities',
    models: [],
    account: {},
    commands: ['goal', 'compact', 'review', 'context', 'usage', 'custom-check', 'exit'],
    commandDetails: [
      { name: 'goal', description: 'Set goal', argumentHint: '<condition>' },
      { name: 'custom-check', description: 'Check project', argumentHint: '<file>' },
      ...['compact', 'review', 'context', 'usage', 'exit'].map((name) => ({
        name,
        description: '',
        argumentHint: '',
      })),
    ],
    terminalCommands: ['exit'],
  };
  await page.routeWebSocket('ws://127.0.0.1:18892/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    push = (payload) =>
      send({
        type: 'session.event',
        event: { sessionId: session.id, runId, sequence: ++sequence, createdAt: now, payload },
      });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId: randomUUID(),
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
          lastSequence: 2,
          hasEarlier: false,
          events: [
            capabilities,
            { type: 'native.context', nativeSessionId: session.id, persisted: true },
          ].map((payload, index) => ({
            sessionId: session.id,
            runId,
            sequence: index + 1,
            createdAt: now,
            payload,
          })),
        });
      if (['message.send', 'session.compact'].includes(message.type)) sent.push(message);
      send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18892/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('offline-command-test-token-123456');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const menu = page.getByRole('listbox', { name: '会话命令', exact: true });
  await input.fill('/');
  await expect(menu.getByRole('option', { name: /^\/goal.*设置或查看任务目标/ })).toBeVisible();
  await expect(menu.getByRole('option', { name: /^\/exit/ })).toHaveCount(0);
  await expect(menu.getByRole('option', { name: /^\/init/ })).toHaveCount(0);
  await input.fill('/go');
  await expect(menu.getByRole('option', { name: /^\/review/ })).toHaveCount(0);
  await input.press('Tab');
  await expect(input).toHaveValue('/goal ');
  expect(sent).toHaveLength(0);
  await input.fill('/goal 所有测试通过');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ type: 'message.send', text: '/goal 所有测试通过' });
  await input.fill('/review');
  await menu.getByRole('option', { name: /^\/review.*审查代码/ }).click();
  await expect(input).toHaveValue('/review ');
  expect(sent).toHaveLength(1);
  await input.fill('/review 当前修改');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1].text).toBe('/review 当前修改');
  await input.fill('/compact');
  await input.press('Enter');
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2].type).toBe('session.compact');
  await input.fill('/');
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await input.press('ArrowDown');
  await input.press('Tab');
  await expect(input).toHaveValue('/review ');
  await input.fill('/custom');
  await expect(menu).toContainText('<file>');
  await input.press('Escape');
  await expect(menu).not.toBeVisible();
  push({ ...capabilities, commands: ['review'], commandDetails: [] });
  await input.fill('/goal');
  await expect(menu.getByRole('option', { name: /^\/goal/ })).toHaveCount(0);
  await expect(menu).not.toBeVisible();
  expect(sent).toHaveLength(3);
  await input.fill('/refresh');
  await input.press('Enter');
  await expect(input).toHaveValue('');
  expect(sent).toHaveLength(3);
});
