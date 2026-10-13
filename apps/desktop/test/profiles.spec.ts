import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProxyServer } from '../../server/src/server.ts';
import { connection, createSession, send, settled } from './helpers.ts';

let second: ReturnType<typeof createProxyServer>;
let secondUrl: string;
let directory: string;
const secondToken = randomBytes(32).toString('hex');
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cc-profiles-ui-'));
  second = createProxyServer({
    token: secondToken,
    dataDir: directory,
    allowedOrigins: ['http://127.0.0.1:15173'],
  });
  secondUrl = (await second.listen(0)).replace('http', 'ws') + '/ws';
});
test.afterAll(async () => {
  await second?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('saved profiles share local projects, restore server history, isolate drafts and schedules, and never store browser tokens', async ({
  page,
}) => {
  const first = connection();
  await page.goto('/');
  await page.getByLabel('服务名称', { exact: true }).fill('工作账号');
  await page.getByLabel('服务地址', { exact: true }).fill(first.serverUrl);
  await page.getByLabel('服务凭据', { exact: true }).fill(first.token);
  await page.getByRole('button', { name: '保存配置', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('代理服务配置已保存。');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('工作账号');
  const title = await createSession(page, '账号A会话');
  await send(page, '切换服务前保留的历史消息');
  await settled(page);
  await page.getByRole('textbox', { name: '消息', exact: true }).fill('账号 A 的未发送草稿');
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('proxy-drafts')))
    .toContain('账号 A');
  await page.evaluate(() =>
    localStorage.setItem(
      'proxy-schedules',
      JSON.stringify({
        tasks: [
          {
            id: 'account-a-only',
            name: 'A 的定时任务',
            enabled: false,
            prompt: 'only for A',
            schedule: { type: 'interval', minutes: 10 },
            target: { type: 'new', projectPath: 'D:\\test' },
            model: null,
            effort: null,
          },
        ],
      }),
    ),
  );
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '管理代理服务', exact: true }).click();
  await page.getByRole('button', { name: '新增代理服务', exact: true }).click();
  await page.getByLabel('服务名称', { exact: true }).fill('个人账号');
  await page.getByLabel('服务地址', { exact: true }).fill(secondUrl);
  await page.getByLabel('服务凭据', { exact: true }).fill(secondToken);
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('个人账号');
  await expect(page.locator('.session-source')).toContainText('当前会话来源：个人账号');
  await expect(
    page.getByRole('button', { name: '新建会话 · D:\\工作\\中文项目', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('此服务暂无会话', { exact: true })).toBeVisible();
  await expect(page.locator('.session-row').filter({ hasText: title })).toHaveCount(0);
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await page.getByLabel('本机项目目录').fill('D:\\个人项目');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(page.getByText('A 的定时任务', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '切换代理服务 · 工作账号', exact: true }).click();
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveValue(first.serverUrl);
  await expect(page.getByLabel('服务凭据', { exact: true })).toHaveValue('');
  await page.getByLabel('服务凭据', { exact: true }).fill(first.token);
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await expect(page.locator('.session-source')).toContainText('当前会话来源：工作账号');
  await expect(
    page.getByRole('button', { name: '新建会话 · D:\\个人项目', exact: true }),
  ).toBeVisible();
  await page.locator('.session-row').filter({ hasText: title }).click();
  await expect(page.locator('.message.user')).toContainText('切换服务前保留的历史消息');
  await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
    '账号 A 的未发送草稿',
  );
  await page.getByRole('button', { name: '定时任务', exact: true }).click();
  await expect(page.getByText('A 的定时任务', { exact: true })).toBeVisible();
  const stored = await page.evaluate(() => localStorage.getItem('proxy-connection-profiles'));
  expect(stored).not.toContain(first.token);
  expect(stored).not.toContain(secondToken);
  await page.getByRole('button', { name: '设置与账号', exact: true }).click();
  await page.getByRole('menuitem', { name: '管理代理服务', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('代理服务', { exact: true }).selectOption({ label: '个人账号' });
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '删除代理服务', exact: true }).click();
  await expect(page.getByLabel('代理服务', { exact: true }).locator('option')).toHaveCount(1);
  await page.reload();
  await expect(page.getByLabel('服务名称', { exact: true })).toHaveValue('工作账号');
  expect(
    await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-local-projects')!)),
  ).toEqual(['D:\\工作\\中文项目', 'D:\\个人项目']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

for (const { recovery, failedService } of [
  { recovery: false, failedService: false },
  { recovery: true, failedService: false },
  { recovery: false, failedService: true },
])
  test(
    failedService
      ? 'a failed connection is disabled, skipped with its handoff preserved, and restored only by reconnecting'
      : recovery
        ? 'exhausted pool pauses and resumes the original session after a confirmed reset'
        : 'remembered desktop profiles switch in order and the pool resumes quota-blocked work on the next server',
    async ({ page }) => {
      const first = connection();
      await page.addInitScript(
        ({ first, secondUrl, secondToken, recovery, failedService }) => {
          const log: string[] = [];
          let limited = false;
          const Original = window.WebSocket;
          window.WebSocket = class extends Original {
            constructor(url: string | URL, protocols?: string | string[]) {
              super(url, protocols);
              this.addEventListener('message', (event) => {
                const message = JSON.parse(String(event.data));
                if (
                  String(url) === first.serverUrl &&
                  message.type === 'session.event' &&
                  message.event.payload.type === 'run.error' &&
                  message.event.payload.code === 'simulated_failure'
                ) {
                  limited = true;
                  message.event.payload = {
                    type: 'run.error',
                    code: 'quota_five_hour',
                    message: 'Claude 5 小时额度已耗尽。',
                    resetsAt: new Date(Date.now() + 3600_000).toISOString(),
                  };
                  Object.defineProperty(event, 'data', { value: JSON.stringify(message) });
                }
              });
            }
          };
          let saved = {
            activeId: 'default',
            profiles: [
              {
                id: 'default',
                name: '工作账号',
                url: 'wss://work.example.com/ws',
                fingerprint: '',
                token: first.token,
                mode: 'remote',
                remember: true,
                autoLogin: true,
              },
              {
                id: 'personal',
                name: '个人账号',
                url: 'wss://personal.example.com/ws',
                fingerprint: '',
                token: secondToken,
                mode: 'remote',
                remember: true,
                autoLogin: false,
              },
            ],
          };
          if (failedService)
            saved.profiles.push({
              ...saved.profiles[1]!,
              id: 'offline',
              name: '离线代理服务',
              url: 'wss://offline.example.com/ws',
            });
          Object.assign(window, {
            profileLog: log,
            desktop: {
              dev: true,
              platform: 'linux',
              version: async () => '0.3.1',
              loadProfiles: async () => structuredClone(saved),
              saveProfiles: async (profiles: typeof saved) => {
                saved = structuredClone(profiles);
              },
              device: async () => ({
                id: '33333333-3333-4333-8333-333333333333',
                name: 'profile test',
              }),
              workspaceRoots: async () => [],
              chooseProject: async () => '/tmp/pool-project',
              asOnDisk: async (path: string) => path,
              gitBranch: async () => null,
              probeQuota: async (id: string) => ({
                available: true,
                measuredAt: new Date().toISOString(),
                windows: [
                  {
                    name: 'five_hour',
                    utilization:
                      recovery && id !== 'default'
                        ? 100
                        : id === 'default' &&
                            limited &&
                            !(window as unknown as { poolRecovered?: boolean }).poolRecovered
                          ? 100
                          : 30,
                    resetsAt: new Date(
                      Date.now() + (id === 'default' ? 1 : 2) * 3600_000,
                    ).toISOString(),
                  },
                ],
              }),
              loadDrafts: async (id: string) => {
                log.push(`drafts:${id}`);
                return {};
              },
              saveDrafts: async () => {},
              loadSchedules: async (_text: string, id: string) => {
                log.push(`schedules:${id}`);
                return { path: '', text: '{"tasks":[]}' };
              },
              saveSchedules: async () => {},
              onSchedulesChanged: () => () => {},
              onNotifyClicked: () => () => {},
              onUpdateProgress: () => () => {},
              notify: async () => {},
              connectProxy: async (config: { profileId: string }) => {
                log.push(`connect:${config.profileId}`);
                if (
                  config.profileId === 'offline' &&
                  !(window as unknown as { serviceRecovered?: boolean }).serviceRecovered
                )
                  throw new Error('代理服务无法连接（测试）');
                return { url: config.profileId === 'default' ? first.serverUrl : secondUrl };
              },
              disconnectProxy: async () => {
                await new Promise((resolve) => setTimeout(resolve, 150));
                log.push('closed');
              },
            },
          });
        },
        { first, secondUrl, secondToken, recovery, failedService },
      );
      if (recovery) await page.clock.install();
      await page.goto('/');
      await expect(page.locator('.connection-status')).toContainText('工作账号');
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: '切换代理服务 · 个人账号', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('个人账号');
      const log = await page.evaluate(
        () => (window as unknown as { profileLog: string[] }).profileLog,
      );
      expect(log.indexOf('connect:personal')).toBeGreaterThan(log.indexOf('closed'));
      expect(log.filter((entry) => entry.startsWith('connect:'))).toEqual([
        'connect:default',
        'connect:personal',
      ]);
      expect(log).toContain('drafts:personal');
      expect(log).toContain('schedules:personal');
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: '切换代理服务 · 工作账号', exact: true }).click();
      await expect(page.locator('.connection-status')).toContainText('工作账号');
      await page.getByRole('button', { name: '设置与账号', exact: true }).click();
      await page.getByRole('menuitem', { name: /^账号 ·/ }).click();
      await page.getByRole('switch', { name: '启用账号池自动切换' }).click();
      await expect(page.getByRole('switch', { name: '启用账号池自动切换' })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await page.getByLabel('账号池使用顺序', { exact: true }).selectOption('manual');
      await page.getByRole('button', { name: '上移 个人账号', exact: true }).click();
      expect(
        await page.evaluate(() => JSON.parse(localStorage.getItem('proxy-account-pool')!).order),
      ).toEqual(failedService ? ['personal', 'default', 'offline'] : ['personal', 'default']);
      if (failedService) {
        await page.getByRole('button', { name: '上移 离线代理服务', exact: true }).click();
        await page.getByRole('button', { name: '上移 离线代理服务', exact: true }).click();
      }
      await page.getByRole('button', { name: '会话', exact: true }).click();
      await page.getByRole('button', { name: '添加项目', exact: true }).click();
      await page.getByRole('button', { name: '新建会话 · /tmp/pool-project', exact: true }).click();
      await send(page, '完成这个尚未完成的功能', 'error');
      if (recovery) {
        await expect(page.locator('.pool-notice')).toContainText('账号池已暂停');
        await expect(page.locator('.connection-status')).toContainText('工作账号');
        await page.evaluate(() => Object.assign(window, { poolRecovered: true }));
        await page.clock.fastForward(3_600_001);
        await expect(page.locator('.pool-notice')).toContainText('当前账号额度已重置');
        await settled(page);
        await expect(page.locator('.message.user')).toContainText('完成这个尚未完成的功能');
        await expect(page.locator('.message.user')).not.toContainText('账号池续接');
        const connections = await page.evaluate(() =>
          (window as unknown as { profileLog: string[] }).profileLog.filter((entry) =>
            entry.startsWith('connect:'),
          ),
        );
        expect(connections).toEqual(['connect:default', 'connect:personal', 'connect:default']);
        return;
      }
      await expect(page.locator('.connection-status')).toContainText('个人账号');
      await expect(page.locator('.message.user')).toContainText('账号池续接');
      await expect(page.locator('.message.user')).toContainText('完成这个尚未完成的功能');
      await expect(page.locator('.message.user')).toHaveCount(1);
      await settled(page);
      await expect(page.locator('.pool-notice')).toContainText('携带最近上下文继续任务');
      const switched = await page.evaluate(() =>
        (window as unknown as { profileLog: string[] }).profileLog.filter((entry) =>
          entry.startsWith('connect:'),
        ),
      );
      expect(switched).toEqual([
        'connect:default',
        'connect:personal',
        'connect:default',
        ...(failedService ? ['connect:offline'] : []),
        'connect:personal',
      ]);
      if (failedService) {
        expect(
          await page.evaluate(
            () => JSON.parse(localStorage.getItem('proxy-account-pool')!).disabled,
          ),
        ).toContain('offline');
        await page.reload();
        await expect(page.locator('.connection-status')).toContainText('个人账号');
        await page.getByRole('button', { name: '设置与账号', exact: true }).click();
        await page.getByRole('menuitem', { name: /^账号 ·/ }).click();
        const offline = page.locator('.pool-accounts li').filter({ hasText: '离线代理服务' });
        await expect(offline).toContainText('连接失败 · 已禁用调度');
        await page.getByRole('button', { name: '检测全部服务与额度', exact: true }).click();
        await expect(offline).toContainText('连接失败 · 已禁用调度');
        expect(
          await page.evaluate(() =>
            (window as unknown as { profileLog: string[] }).profileLog.filter((entry) =>
              entry.startsWith('connect:'),
            ),
          ),
        ).toEqual(['connect:personal']);
        await page.evaluate(() => Object.assign(window, { serviceRecovered: true }));
        await page.getByRole('button', { name: '设置与账号', exact: true }).click();
        await page
          .getByRole('menuitem', { name: '切换代理服务 · 离线代理服务', exact: true })
          .click();
        await expect(page.locator('.connection-status')).toContainText('离线代理服务');
        await expect
          .poll(() =>
            page.evaluate(() => JSON.parse(localStorage.getItem('proxy-account-pool')!).disabled),
          )
          .not.toContain('offline');
      }
    },
  );
