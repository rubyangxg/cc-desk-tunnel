import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createProxyServer } from '../../server/src/server.ts';
import { createSession, screenshots } from './helpers.ts';

let server: ReturnType<typeof createProxyServer>;
let url: string;
let directory: string;
const token = randomUUID();
test.beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'cc-pool-ui-'));
  const config = join(directory, 'original');
  mkdirSync(config);
  writeFileSync(
    join(config, 'fixture.json'),
    JSON.stringify({ loggedIn: true, email: 'primary@example.test', hours: 1 }),
  );
  server = createProxyServer({
    token,
    dataDir: directory,
    reverseProxy: true,
    tunnel: {},
    allowedOrigins: ['http://127.0.0.1:15173'],
    claude: {
      executable: resolve('apps/server/test/fixtures/pool-cli.mjs'),
      environment: { CLAUDE_CONFIG_DIR: config },
    },
  });
  url = (await server.listen(0)).replace('http', 'ws') + '/ws';
});
test.afterAll(async () => {
  await server?.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

test('one-service account dashboard logs in independent accounts, saves policy and keeps manual switches in one history', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() =>
    localStorage.setItem('proxy-account-pool', JSON.stringify({ enabled: false })),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill(url);
  await page.getByLabel('服务凭据', { exact: true }).fill(token);
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await page.getByRole('button', { name: 'Claude 账号池', exact: true }).click();
  const main = page.getByRole('region', { name: 'Claude 账号池', exact: true });
  await expect(main.getByRole('heading', { name: 'Claude 账号池', exact: true })).toBeVisible();
  await expect(main.getByText('primary@example.test', { exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: '检测全部账号', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '添加 Claude 账号', exact: true }).click();
  await page.getByLabel('Claude 账号名称', { exact: true }).fill('备用账号');
  await page.getByRole('button', { name: '添加账号', exact: true }).click();
  const backup = page.getByRole('article', { name: 'Claude 账号 · 备用账号', exact: true });
  await backup.getByRole('button', { name: '登录账号', exact: true }).click();
  await expect(backup.getByRole('button', { name: '打开授权页', exact: true })).toBeVisible();
  await backup.getByLabel('备用账号 的授权码', { exact: true }).fill('offline-test-authorization');
  await backup.getByRole('button', { name: '完成登录', exact: true }).click();
  await expect(backup.getByText('new-account@example.test', { exact: true })).toBeVisible();
  await expect(backup.getByText('可调度', { exact: true })).toBeVisible();
  await page.getByRole('switch', { name: '启用服务端账号池', exact: true }).click();
  await expect(page.getByRole('switch', { name: '启用服务端账号池', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByLabel('服务端账号优先顺序', { exact: true }).selectOption('order');
  await page.getByRole('button', { name: '上移 备用账号', exact: true }).click();
  await expect(page.locator('.server-account-card').first()).toHaveAttribute(
    'aria-label',
    'Claude 账号 · 备用账号',
  );
  await backup.getByRole('switch', { name: '启用 备用账号', exact: true }).click();
  await expect(backup.getByText('已停用', { exact: true })).toBeVisible();
  await backup.getByRole('switch', { name: '启用 备用账号', exact: true }).click();
  await expect(backup.getByText('可调度', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1080 });
  await main.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({ path: join(screenshots, 'server-account-pool-desktop.png') });
  await page.getByRole('button', { name: '会话', exact: true }).click();
  const title = await createSession(page, '统一历史');
  await expect(page.locator('.connection-status')).toContainText('待选择账号');
  const projectHeading = page.locator('.project-group > h2').first();
  const resumeOption = page.getByRole('menuitemradio', { name: '额度重置后自动继续', exact: true });
  await projectHeading.click({ button: 'right' });
  await expect(resumeOption).toHaveAttribute('aria-checked', 'false');
  await resumeOption.click();
  await projectHeading.click({ button: 'right' });
  await expect(resumeOption).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByLabel('服务凭据', { exact: true }).fill(token);
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await projectHeading.click({ button: 'right' });
  await expect(resumeOption).toHaveAttribute('aria-checked', 'true');
  await resumeOption.click();
  await projectHeading.click({ button: 'right' });
  await expect(resumeOption).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await page.locator('.session-row').filter({ hasText: title }).click();

  const accountId = await page
    .getByLabel('当前会话 Claude 账号', { exact: true })
    .locator('option')
    .filter({ hasText: '备用账号' })
    .getAttribute('value');
  await page.getByLabel('当前会话 Claude 账号', { exact: true }).selectOption(accountId!);
  await expect(page.getByLabel('当前会话 Claude 账号', { exact: true })).toHaveValue(accountId!);
  await expect(page.locator('.connection-status')).toContainText('new-account@example.test');
  await expect(page.locator('.connection-status')).not.toContainText('primary@example.test');
  await expect(page.locator('.session-row').filter({ hasText: title })).toHaveCount(1);
  await page.getByLabel('当前会话 Claude 账号', { exact: true }).selectOption('default');
  await expect(page.getByLabel('当前会话 Claude 账号', { exact: true })).toHaveValue('default');
  await expect(page.locator('.connection-status')).toContainText('primary@example.test');
  await expect(page.locator('.connection-status')).not.toContainText('new-account@example.test');
  await expect(page.locator('.session-row').filter({ hasText: title })).toHaveCount(1);
  const otherTitle = await createSession(page, '另一个账号');
  await expect(page.locator('.connection-status')).toContainText('待选择账号');
  await page.getByLabel('当前会话 Claude 账号', { exact: true }).selectOption(accountId!);
  await expect(page.locator('.connection-status')).toContainText('new-account@example.test');
  await page.locator('.session-row').filter({ hasText: title }).click();
  await expect(page.locator('.connection-status')).toContainText('primary@example.test');
  await page.locator('.session-row').filter({ hasText: otherTitle }).click();
  await expect(page.locator('.connection-status')).toContainText('new-account@example.test');
  await page.getByRole('button', { name: '管理账号池', exact: true }).click();
  await expect(page.locator('.connection-status')).toContainText('new-account@example.test');
  await expect(page.getByLabel('服务端账号优先顺序', { exact: true })).toHaveValue('order');
  await page.setViewportSize({ width: 390, height: 844 });
  await main.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(main.getByRole('heading', { name: 'Claude 账号池', exact: true })).toBeVisible();
  await page.screenshot({ path: join(screenshots, 'server-account-pool-mobile.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
