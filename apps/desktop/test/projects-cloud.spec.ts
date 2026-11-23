import { test, expect } from '@playwright/test';
import { login, createSession } from './helpers.ts';

test('server project names survive reconnect and removing a project keeps the session', async ({
  page,
}) => {
  await page.goto('/');
  await login(page);
  const title = await createSession(page, '项目登记');
  const project = page.locator('.project-group > h2').filter({ hasText: '中文项目' });
  await project.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '修改显示名称', exact: true }).click();
  await page.getByRole('dialog').getByLabel('显示名称').fill('服务端别名');
  await page.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.composer-context')).toContainText('服务端别名');
  await page.reload();
  await login(page);
  await page.locator('.session-select').filter({ hasText: title }).click();
  await expect(page.locator('.composer-context')).toContainText('服务端别名');
  const renamed = page.locator('.project-group > h2').filter({ hasText: '服务端别名' });
  await renamed.click({ button: 'right' });
  await page.getByRole('menuitem', { name: '移除项目', exact: true }).click();
  await expect(page.locator('.composer-context')).toContainText('普通会话');
  await expect(page.locator('.session-row.selected strong')).toHaveText(title);
});
