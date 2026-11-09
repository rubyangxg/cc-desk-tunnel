import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';

test('goal banner shows clear control that sends /goal clear after confirm', async ({ page }) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '目标清除测试',
    autoTitle: false,
    projectPath: 'D:\\Work',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
    goal: {
      condition: '持续优化全自动任务的功能',
      status: 'active',
      iterations: 2,
      updatedAt: now,
    },
  };
  const runId = randomUUID();
  const sent: { type: string; text?: string }[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18892/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
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
          features: ['message-queue'],
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
            {
              type: 'native.capabilities',
              models: [],
              account: {},
              commands: ['goal'],
              commandDetails: [
                { name: 'goal', description: 'Set goal', argumentHint: '<condition>' },
              ],
              terminalCommands: [],
            },
            { type: 'native.context', nativeSessionId: session.id, persisted: true },
          ].map((payload, index) => ({
            sessionId: session.id,
            runId,
            sequence: index + 1,
            createdAt: now,
            payload,
          })),
        });
      if (message.type === 'message.send') {
        sent.push(message);
        send({ type: 'response', requestId: message.requestId, ok: true });
        return;
      }
      if (message.requestId) send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18892/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('offline-goal-clear-token-1234567890');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  const banner = page.getByRole('status', { name: '会话目标' });
  await expect(banner).toContainText('目标进行中');
  await expect(banner).toContainText('持续优化全自动任务的功能');
  const clear = banner.getByRole('button', { name: '清除目标' });
  await expect(clear).toBeEnabled();
  page.once('dialog', (dialog) => dialog.dismiss());
  await clear.click();
  await expect.poll(() => sent.length).toBe(0);
  // Draft in the composer must survive clearing the goal.
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  await input.fill('还没发出的草稿');
  page.once('dialog', (dialog) => dialog.accept());
  await clear.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ type: 'message.send', text: '/goal clear' });
  await expect(input).toHaveValue('还没发出的草稿');
});

test('goal clear stays available while a native run is active', async ({ page }) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '运行中清除目标',
    autoTitle: false,
    projectPath: 'D:\\Work',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: {
      id: randomUUID(),
      status: 'running',
      connectionId: randomUUID(),
      surface: 'chat',
    },
    goal: {
      condition: '所有红点任务都做完',
      status: 'active',
      iterations: 1,
      updatedAt: now,
    },
  };
  const runId = session.activeRun!.id;
  const sent: { type: string; text?: string }[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18892/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
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
          features: ['message-queue'],
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
          lastSequence: 1,
          hasEarlier: false,
          events: [
            {
              sessionId: session.id,
              runId,
              sequence: 1,
              createdAt: now,
              payload: {
                type: 'native.capabilities',
                models: [],
                account: {},
                commands: ['goal'],
                commandDetails: [],
                terminalCommands: [],
              },
            },
          ],
        });
      if (message.type === 'message.send') {
        sent.push(message);
        send({ type: 'response', requestId: message.requestId, ok: true });
        return;
      }
      if (message.requestId) send({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18892/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('offline-goal-clear-run-token-123456');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  const clear = page
    .getByRole('status', { name: '会话目标' })
    .getByRole('button', { name: '清除目标' });
  await expect(clear).toBeEnabled();
  page.once('dialog', (dialog) => dialog.accept());
  await clear.click();
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]).toMatchObject({ type: 'message.send', text: '/goal clear' });
});
