import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session } from '@cc-desk-tunnel/protocol';
import { createSession, login, send, settled, screenshots } from './helpers.ts';

test('queue survives reload, can pause/delete/resume, and sends after the active task', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '消息队列');
  await send(page, '等待审批', 'tool');
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  await page.getByLabel('模拟场景').selectOption('chat');
  const input = page.getByRole('textbox', { name: '消息', exact: true });
  const queue = page.getByRole('region', { name: '待发送消息' });
  await input.fill('排队的第一条');
  await input.press('Enter');
  await expect(queue).toContainText('待发送 1');
  await expect(input).toHaveValue('');
  await input.fill('删除这条');
  await input.press('Enter');
  await expect(queue).toContainText('待发送 2');
  await expect(page.locator('.message.user').filter({ hasText: '排队的第一条' })).toHaveCount(0);
  await queue.getByRole('button', { name: '暂停队列', exact: true }).click();
  await expect(queue).toContainText('已暂停');
  await page.getByRole('button', { name: '允许', exact: true }).click();
  await settled(page);
  await page.reload();
  await login(page);
  await page.locator('.session-select').filter({ hasText: title }).click();
  await expect(queue).toContainText('待发送 2');
  await expect(queue).toContainText('已暂停');
  await queue.getByRole('button', { name: '删除排队消息：删除这条', exact: true }).click();
  await expect(queue).toContainText('待发送 1');
  await page.screenshot({ path: resolve(screenshots, 'message-queue.png') });
  await queue.getByRole('button', { name: '继续队列', exact: true }).click();
  await expect(page.locator('.message.user').filter({ hasText: '排队的第一条' })).toHaveCount(1);
  await settled(page);
  await expect(queue).toHaveCount(0);
  await expect(page.locator('.message.user').filter({ hasText: '删除这条' })).toHaveCount(0);
});

for (const supported of [true, false]) {
  test(`keyboard send modes, IME and button choice ${supported ? 'with queue support' : 'on older servers'}`, async ({
    page,
  }) => {
    const now = new Date().toISOString();
    const connectionId = randomUUID();
    const session: Session = {
      id: randomUUID(),
      title: '快捷键',
      autoTitle: false,
      projectPath: 'D:\\Work',
      permissionMode: 'auto',
      model: null,
      effort: null,
      createdAt: now,
      updatedAt: now,
      activeRun: { id: randomUUID(), status: 'running', connectionId },
    };
    const sent: { type: string; text: string }[] = [];
    await page.routeWebSocket('ws://127.0.0.1:18896/ws', (route) => {
      const push = (value: unknown) => route.send(JSON.stringify(value));
      route.onMessage((raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'device') return;
        if (message.type === 'auth') {
          push({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.4.12',
            connectionId,
            adapter: 'claude-code',
            sessions: [session],
            features: supported ? ['message-queue'] : [],
          });
          return;
        }
        if (message.type === 'session.subscribe')
          push({
            type: 'session.snapshot',
            requestId: message.requestId,
            session,
            mode: 'replace',
            firstSequence: 0,
            lastSequence: 0,
            hasEarlier: false,
            events: [],
          });
        if (message.type === 'message.send' || message.type === 'message.enqueue')
          sent.push(message);
        push({ type: 'response', requestId: message.requestId, ok: true });
      });
    });
    await page.goto('/');
    await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18896/ws');
    await page.getByLabel('服务凭据', { exact: true }).fill('offline-queue-test-token-123456');
    await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
    await page.locator('.session-select').filter({ hasText: session.title }).click();
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('first');
    await input.press('Enter');
    await expect
      .poll(() => sent.map(({ type }) => type))
      .toEqual([supported ? 'message.enqueue' : 'message.send']);
    await input.fill('direct');
    await input.press('Control+Enter');
    await expect.poll(() => sent.length).toBe(2);
    expect(sent[1].type).toBe('message.send');
    await input.fill('line');
    await input.press('Shift+Enter');
    await expect(input).toHaveValue('line\n');
    await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    expect(sent.length).toBe(2);
    await input.fill('mac direct');
    await input.press('Meta+Enter');
    await expect.poll(() => sent.length).toBe(3);
    expect(sent[2].type).toBe('message.send');
    const mode = page.getByRole('button', { name: '发送方式', exact: true });
    if (!supported) {
      await expect(mode).toHaveCount(0);
      return;
    }
    await mode.click();
    await page.getByRole('menuitemradio', { name: /排队发送/ }).click();
    await input.fill('button queued');
    await page.getByRole('button', { name: '排队发送', exact: true }).click();
    await expect.poll(() => sent.length).toBe(4);
    expect(sent[3].type).toBe('message.enqueue');
    // Key bindings stay fixed even when the button's selected mode changes.
    await input.fill('direct override');
    await input.press('Control+Enter');
    await expect.poll(() => sent.length).toBe(5);
    expect(sent[4].type).toBe('message.send');
    await mode.click();
    await page.getByRole('menuitemradio', { name: /直接发送/ }).click();
    await input.fill('button direct');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => sent.length).toBe(6);
    expect(sent[5].type).toBe('message.send');
    await page.setViewportSize({ width: 390, height: 844 });
    await mode.click();
    const menu = page.getByRole('menu', { name: '发送方式', exact: true });
    await expect(menu).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
}
