import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { ServerPoolState } from '@cc-desk-tunnel/protocol';
import { join } from 'node:path';
import { screenshots } from './helpers.ts';

test('quota countdown follows server waits, ticks every second and shows account-specific costs', async ({
  page,
}) => {
  const now = Date.now();
  const sessionId = randomUUID();
  const backup = randomUUID();
  let pool: ServerPoolState = {
    settings: {
      enabled: true,
      strategy: 'reset',
      order: ['default', backup],
      preferredId: 'default',
    },
    accounts: ['default', backup].map((id, index) => ({
      id,
      name: index ? '备用账号' : '主账号',
      enabled: true,
      loggedIn: true,
      checkedAt: now,
      blockedUntil: null,
      busy: index === 0,
      login: null,
      limits: {
        available: true,
        windows: [
          {
            name: 'five_hour',
            utilization: 100,
            resetsAt: new Date(now + (index ? 7200000 : 5000)).toISOString(),
          },
          { name: 'seven_day', utilization: 31, resetsAt: new Date(now + 86400000).toISOString() },
        ],
      },
      usage: [
        { name: 'five_hour', requests: 20, costUsd: index ? 2.5 : 12.34 },
        { name: 'seven_day', requests: 40, costUsd: index ? 10 : 30 },
      ],
    })),
    refreshing: false,
    serverTime: now,
    nextReset: { accountId: 'default', at: now + 5000 },
    quotaWaits: [{ sessionId, accountId: 'default', at: now + 5000 }],
  };
  let push = () => {};
  let close = () => {};
  const sent: string[] = [];
  await page.clock.install({ time: now });
  await page.routeWebSocket('ws://127.0.0.1:18893/ws', (route) => {
    const send = (value: unknown) => route.send(JSON.stringify(value));
    push = () => send({ type: 'pool.state', ...pool });
    close = () => route.close();
    route.onMessage((raw) => {
      const m = JSON.parse(String(raw));
      sent.push(m.type);
      if (m.type === 'device') return;
      if (m.type === 'auth') {
        send({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.4.6',
          connectionId: randomUUID(),
          adapter: 'claude-code',
          sessions: [],
          features: ['account-pool'],
        });
        return;
      }
      if (m.type === 'pool.status') push();
      send({ type: 'response', requestId: m.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18893/ws');
  await page.getByLabel('服务凭据', { exact: true }).fill('offline-countdown-token-12345678');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await page.getByRole('button', { name: 'Claude 账号池', exact: true }).click();
  const banner = page.getByLabel('额度重置倒计时', { exact: true });
  const timer = banner.getByRole('timer');
  await expect(timer).toHaveText('00:00:05');
  await expect(banner).toContainText('恢复后自动发送 continue · 1 个任务等待');
  await expect(page.getByRole('article', { name: 'Claude 账号 · 主账号' })).toContainText(
    '等价 $12.34',
  );
  await expect(page.getByRole('article', { name: 'Claude 账号 · 备用账号' })).toContainText(
    '等价 $2.50',
  );
  await page.clock.runFor(1000);
  await expect(timer).toHaveText('00:00:04');
  await page.clock.runFor(4000);
  await expect(timer).toHaveText('正在确认额度恢复…');
  expect(sent.filter((t) => ['run.continue', 'message.send'].includes(t))).toEqual([]);
  pool = { ...pool, quotaWaits: [], nextReset: { accountId: backup, at: now + 7200000 } };
  push();
  await expect(banner).toContainText('暂无待续任务');
  await expect(banner).not.toContainText('自动发送');
  await expect(banner).toContainText('备用账号');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(screenshots, 'pool-countdown-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(banner).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(screenshots, 'pool-countdown-mobile.png') });
  close();
  await expect(banner).not.toBeVisible();
});
