import { test, expect } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';
import { resolve } from 'node:path';
import { login, createSession, send, settled, screenshots } from './helpers.ts';

test('an upgrade outage shows one retry notice and recovers the session without replaying work', async ({
  page,
}) => {
  let unavailable = false;
  let connections = 0;
  let current: WebSocketRoute;
  let sends = 0;
  await page.routeWebSocket('**/ws', (socket) => {
    current = socket;
    connections++;
    if (unavailable) return; // The service is not ready; keep the attempt pending until explicitly failed.
    const server = socket.connectToServer();
    socket.onMessage((raw) => {
      if (JSON.parse(String(raw)).type === 'message.send') sends++;
      server.send(raw);
    });
  });
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '重启后恢复');
  await send(page, '只发一次', 'tool');
  await expect(page.getByRole('button', { name: '允许', exact: true })).toBeVisible();
  const clockStart = Date.now();
  await page.clock.install({ time: clockStart });
  await page.clock.pauseAt(clockStart + 60_000);
  unavailable = true;
  current!.send(JSON.stringify({ type: 'service.update', state: 'restarting', latest: '0.4.17' }));
  current!.close();
  const notice = page.locator('.reconnect-notice');
  await expect(notice).toContainText('服务端重启中，正在自动重连');
  await expect(notice).toContainText('1 秒后重试');
  await expect(page.locator('.error-banner')).toHaveCount(0);
  await expect(page.locator('.elsewhere-bar')).toHaveCount(0);
  await expect(page.locator('.session-row.selected')).toContainText('状态待确认');
  await expect(page.getByText('连接中断，任务状态待确认', { exact: true })).toBeVisible();
  await page.clock.runFor(1000);
  await expect.poll(() => connections).toBe(2);
  await expect(notice).toContainText('正在进行第 1 次重试');
  await expect(notice.getByRole('button', { name: '连接中…' })).toBeDisabled();
  current!.send(
    JSON.stringify({
      type: 'connection.error',
      code: 'connection_lost',
      message: '服务端暂未启动',
    }),
  );
  current!.close();
  await expect(notice).toContainText('2 秒后重试');
  await notice.getByText('连接详情', { exact: true }).click();
  await expect(notice).toContainText('服务端暂未启动');
  await page.screenshot({ path: resolve(screenshots, 'reconnect-upgrade.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice.getByRole('button', { name: '立即重试' })).toBeInViewport();
  await page.screenshot({ path: resolve(screenshots, 'reconnect-mobile.png') });
  unavailable = false;
  await notice.getByRole('button', { name: '立即重试' }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await expect(notice).toHaveCount(0);
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await settled(page);
  await expect(page.locator('.message.user')).toHaveCount(1);
  expect(sends).toBe(1);
  await page.clock.runFor(15000);
  expect(connections).toBe(3);
});
