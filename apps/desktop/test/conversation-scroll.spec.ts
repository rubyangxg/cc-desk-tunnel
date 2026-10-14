import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';

test('returning from settings settles at the latest message and keeps manual reading stationary', async ({
  page,
}) => {
  const now = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: '长会话滚动',
    autoTitle: false,
    projectPath: 'D:\\Work',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  const events: SessionEvent[] = [];
  let sequence = 0;
  for (let i = 0; i < 35; i++) {
    const runId = randomUUID();
    for (const payload of [
      {
        type: 'message.user' as const,
        messageId: randomUUID(),
        text: `第 ${i} 个问题`,
        scenario: 'chat' as const,
      },
      {
        type: 'text.delta' as const,
        messageId: randomUUID(),
        text:
          `## 第 ${i} 个回答\n\n` +
          Array.from(
            { length: (i % 5) + 8 },
            (_, row) =>
              `段落 ${row}：这里是完整的任务进展，需要等待排版结束后才能知道消息的实际高度。\n`,
          ).join('\n'),
      },
      { type: 'run.status' as const, status: 'completed' as const, connectionId: randomUUID() },
    ])
      events.push({ sessionId: session.id, runId, sequence: ++sequence, createdAt: now, payload });
  }
  let push: (event: SessionEvent) => void = () => {};
  await page.routeWebSocket('ws://127.0.0.1:18894/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    push = (event) => send({ type: 'session.event', event });
    route.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'device') return;
      if (m.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.4.7',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [session],
        });
        return;
      }
      if (m.type === 'session.subscribe')
        send({
          type: 'session.snapshot',
          requestId: m.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: sequence,
          hasEarlier: false,
          events,
        });
      send({ type: 'response', requestId: m.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18894/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('offline-scroll-test-token-123456');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await page.locator('.session-select').filter({ hasText: session.title }).click();
  const view = page.locator('.conversation');
  const gap = () => view.evaluate((e) => e.scrollHeight - e.clientHeight - e.scrollTop);
  for (let round = 0; round < 3; round++) {
    await view.evaluate((e) => {
      e.scrollTop = 0;
    });
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '设置', exact: true }).click();
    await expect(view).not.toBeVisible();
    await page
      .getByRole('navigation', { name: '页面' })
      .getByRole('button', { name: '会话', exact: true })
      .click();
    await expect.poll(gap, { timeout: 5000 }).toBeLessThan(3);
    // A later frame must remain at the bottom after offscreen messages acquire their real sizes.
    await page.waitForTimeout(250);
    expect(await gap()).toBeLessThan(3);
  }
  await page.setViewportSize({ width: 900, height: 650 });
  await expect.poll(gap).toBeLessThan(3);
  await view.hover();
  await page.mouse.wheel(0, -600);
  await expect.poll(gap).toBeGreaterThan(200);
  const top = await view.evaluate((e) => e.scrollTop);
  push({
    sessionId: session.id,
    runId: randomUUID(),
    sequence: ++sequence,
    createdAt: now,
    payload: {
      type: 'text.delta',
      messageId: randomUUID(),
      text: '阅读历史时到达的新消息。\n'.repeat(30),
    },
  });
  await expect(page.locator('.message.assistant').last()).toContainText('阅读历史时到达的新消息');
  expect(Math.abs((await view.evaluate((e) => e.scrollTop)) - top)).toBeLessThan(3);
  const continuationId = randomUUID();
  const continuationRun = randomUUID();
  push({
    sessionId: session.id,
    runId: continuationRun,
    sequence: ++sequence,
    createdAt: now,
    payload: {
      type: 'message.user',
      messageId: continuationId,
      text: 'continue',
      scenario: 'chat',
      continued: true,
    },
  });
  for (const [status, label] of [
    ['submitted', '已提交'],
    ['received', '原生已接收'],
  ] as const) {
    push({
      sessionId: session.id,
      runId: continuationRun,
      sequence: ++sequence,
      createdAt: now,
      payload: { type: 'message.delivery', messageId: continuationId, status },
    });
    await expect(view.getByRole('status').filter({ hasText: `继续 · ${label}` })).toHaveCount(1);
  }
});
