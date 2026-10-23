import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { ServerPoolState } from '@cc-desk-tunnel/protocol';
import { join } from 'node:path';
import { screenshots } from './helpers.ts';

test('all servers share one account page with scoped controls, costs and honest offline state', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const makePool = (names: string[]): ServerPoolState => ({
    settings: { enabled: false, strategy: 'reset', order: ['default'], preferredId: 'default' },
    refreshing: false,
    accounts: names.map((name, index) => ({
      id: index ? randomUUID() : 'default',
      name,
      enabled: true,
      loggedIn: true,
      busy: false,
      login: null,
      checkedAt: Date.now(),
      blockedUntil: null,
      limits: {
        available: true,
        windows: [
          {
            name: 'five_hour',
            utilization: 25,
            resetsAt: new Date(Date.now() + 3600000).toISOString(),
          },
        ],
      },
      usage: [{ name: 'five_hour', requests: 10, costUsd: 12.34 + index }],
    })),
  });
  const local = makePool(['同名账号']);
  const remote = makePool(['同名账号', '备用账号']);
  await page.addInitScript(
    ({ local, remote }) => {
      localStorage.setItem(
        'proxy-account-pool',
        JSON.stringify({ enabled: true, strategy: 'reset', order: [], disabled: ['b'] }),
      );
      const log: string[] = [];
      let fail = false;
      let saved = {
        activeId: 'a',
        profiles: ['a', 'b'].map((id) => ({
          id,
          name: id === 'a' ? '服务器 1' : '服务器 2',
          url: `wss://${id}.example/ws`,
          fingerprint: '',
          token: 'test-token-12345678901234567890',
          mode: 'remote',
          remember: true,
          autoLogin: id === 'a',
        })),
      };
      const states = { a: local, b: remote };
      Object.assign(window, {
        testLog: log,
        failRemote: () => {
          fail = true;
        },
        exhaustRemote: () => {
          fail = false;
          remote.accounts.forEach((account) => {
            account.limits!.windows[0]!.utilization = 100;
          });
          remote.nextReset = { accountId: remote.accounts[1]!.id, at: Date.now() + 50000 };
        },
        desktop: {
          dev: true,
          platform: 'win32',
          onSharedChanged: () => () => {},
          saveShared: async () => {},
          setBusy: async () => {},
          version: async () => '0.4.15',
          device: async () => ({ id: '33333333-3333-4333-8333-333333333333', name: 'test' }),
          loadProfiles: async () => structuredClone(saved),
          saveProfiles: async (value: typeof saved) => {
            saved = structuredClone(value);
          },
          workspaceRoots: async () => [],
          foldersExist: async (paths: string[]) => paths.map(() => true),
          loadDrafts: async () => ({}),
          saveDrafts: async () => {},
          loadSchedules: async () => ({ path: '', text: '{"tasks":[]}' }),
          onSchedulesChanged: () => () => {},
          onNotifyClicked: () => () => {},
          onUpdateProgress: () => () => {},
          connectProxy: async ({ profileId }: { profileId: string }) => {
            log.push(`connect:${profileId}`);
            return { url: `ws://127.0.0.1:18894/${profileId}` };
          },
          disconnectProxy: async () => {
            log.push('disconnect');
          },
          profileSessions: async () => [],
          probeQuota: async () => null,
          profilePool: async (
            id: 'a' | 'b',
            command?: { type: string; accountId?: string; enabled?: boolean; values?: object },
          ) => {
            if (id === 'b' && fail) throw new Error('服务器离线（测试）');
            const state = states[id];
            if (command) {
              log.push(`${id}:${command.type}:${command.accountId ?? ''}`);
              if (command.type === 'pool.configure') Object.assign(state.settings, command.values);
              if (command.type === 'pool.account.update')
                state.accounts.find((a) => a.id === command.accountId)!.enabled = command.enabled!;
            }
            return { state: structuredClone(state), limits: state.accounts[0]!.limits };
          },
        },
      });
    },
    { local, remote },
  );
  const sent: string[] = [];
  await page.routeWebSocket(/ws:\/\/127\.0\.0\.1:18894\//, (route) => {
    const pool = route.url().endsWith('/a') ? local : remote;
    const push = () => route.send(JSON.stringify({ type: 'pool.state', ...pool }));
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      sent.push(message.type);
      if (message.type === 'auth') {
        route.send(
          JSON.stringify({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.4.15',
            connectionId: randomUUID(),
            adapter: 'claude-code',
            sessions: [],
            features: ['account-pool'],
          }),
        );
        return;
      }
      if (message.type === 'device') return;
      if (message.type === 'pool.configure') Object.assign(pool.settings, message.values);
      if (message.type === 'pool.status' || message.type === 'pool.configure') push();
      route.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true }));
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Claude 账号池', exact: true }).click();
  await expect(page.locator('.server-account-card')).toHaveCount(3);
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-account-pool')!).disabled),
  ).not.toContain('b');
  const remoteCard = page.getByRole('article', {
    name: 'Claude 账号 · 服务器 2 · 同名账号',
    exact: true,
  });
  await expect(remoteCard).toContainText('等价 $12.34');
  await expect(page.getByRole('switch', { name: '启用统一账号池' })).toHaveCount(1);
  await remoteCard.getByRole('switch').click();
  await expect(remoteCard).toContainText('已停用');
  expect(await page.evaluate(() => (window as unknown as { testLog: string[] }).testLog)).toContain(
    'b:pool.account.update:default',
  );
  await expect(
    page.getByRole('article', { name: 'Claude 账号 · 同名账号', exact: true }).getByRole('switch'),
  ).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('switch', { name: '启用统一账号池' }).click();
  await expect(page.getByRole('switch', { name: '启用统一账号池' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  expect(sent).toContain('pool.configure');
  expect(await page.evaluate(() => (window as unknown as { testLog: string[] }).testLog)).toContain(
    'b:pool.configure:',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(screenshots, 'unified-accounts-desktop.png') });
  await page.evaluate(() => (window as unknown as { failRemote: () => void }).failRemote());
  await page.getByRole('button', { name: '检测全部账号', exact: true }).click();
  await expect(page.getByText(/服务器 2：.*服务器离线/)).toBeVisible();
  await expect(
    page.getByRole('article', { name: 'Claude 账号 · 服务器 2 · 备用账号', exact: true }),
  ).toContainText('离线 · 上次数据');
  await expect(page.locator('.server-account-card')).toHaveCount(3);
  expect(
    (await page.evaluate(() => (window as unknown as { testLog: string[] }).testLog)).filter(
      (line) => line.startsWith('connect:'),
    ),
  ).toEqual(['connect:a']);
  local.accounts[0]!.limits!.windows[0]!.utilization = 100;
  local.nextReset = { accountId: 'default', at: Date.now() + 100000 };
  await page.evaluate(() => (window as unknown as { exhaustRemote: () => void }).exhaustRemote());
  await page.getByRole('button', { name: '检测全部账号', exact: true }).click();
  await expect(page.getByLabel('额度重置倒计时', { exact: true })).toContainText(
    '服务器 2 · 备用账号',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('管理服务器', { exact: true }).selectOption('b');
  await expect(page.getByLabel('管理服务器', { exact: true })).toHaveValue('b');
  await expect(
    page.getByRole('article', { name: 'Claude 账号 · 备用账号', exact: true }),
  ).toBeVisible();
  expect(
    (await page.evaluate(() => (window as unknown as { testLog: string[] }).testLog)).filter(
      (line) => line.startsWith('connect:'),
    ),
  ).toEqual(['connect:a', 'connect:b']);
  expect(sent.filter((type) => type === 'message.send')).toEqual([]);
  expect(errors).toEqual([]);
});
