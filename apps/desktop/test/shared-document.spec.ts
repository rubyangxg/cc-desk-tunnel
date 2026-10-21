import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { load, save, importFile, documentPath } = createRequire(import.meta.url)(
  '../electron/shared-document.cjs',
);

async function editor(page: Page, base: string, imported: string) {
  await page.exposeFunction('testLoadDocument', () => load(base));
  await page.exposeFunction('testSaveDocument', (text: string, version: string) =>
    save(base, text, version),
  );
  await page.exposeFunction('testImportDocument', () => importFile(imported));
  await page.addInitScript(() => {
    const api = window as unknown as Record<string, (...args: unknown[]) => unknown>;
    const noop = async () => {};
    const subscription = () => () => {};
    Object.assign(window, {
      desktop: {
        dev: true,
        platform: 'linux',
        boot: { connection: '', shared: { connections: [], busy: [] } },
        version: async () => '0.4.15',
        device: async () => ({
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          name: '测试电脑',
          platform: 'linux',
        }),
        loadProfiles: async () => null,
        saveProfiles: noop,
        onSharedChanged: subscription,
        saveShared: noop,
        setBusy: noop,
        foldersExist: async (paths: string[]) => paths.map(() => true),
        workspaceRoots: async () => [],
        gitBranch: async () => null,
        loadDrafts: async () => ({}),
        saveDrafts: noop,
        loadSchedules: async () => ({ path: '', text: '{"tasks":[]}' }),
        saveSchedules: noop,
        onSchedulesChanged: subscription,
        onNotifyClicked: subscription,
        onUpdateProgress: subscription,
        windowSettings: async () => ({ closeToTray: true }),
        connections: async () => [],
        loadSharedDocument: () => api.testLoadDocument(),
        saveSharedDocument: (text: string, version: string) => api.testSaveDocument(text, version),
        importSharedDocument: () => api.testImportDocument(),
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '本机设置', exact: true }).click();
  await page.getByRole('button', { name: '共享文档', exact: true }).click();
  await expect(page.getByLabel('共享 Markdown 文档')).toBeEnabled();
}

test('import, edit, save, revisit and restart use the same Markdown file', async ({ page }) => {
  const base = mkdtempSync(join(tmpdir(), 'cc-document-ui-'));
  const file = join(base, 'import.md');
  const original = '# 服务器\n\nIP：192.0.2.1\n';
  writeFileSync(file, original);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await editor(page, base, file);
    await page.getByRole('button', { name: '导入 Markdown', exact: true }).click();
    await expect(page.getByLabel('共享 Markdown 文档')).toHaveValue(original);
    expect(load(base).text).toBe('');
    const changed = `${original}\n端口：22\n`;
    await page.getByLabel('共享 Markdown 文档').fill(changed);
    await page.getByRole('button', { name: '通知', exact: true }).click();
    await page.getByRole('button', { name: '共享文档', exact: true }).click();
    await expect(page.getByLabel('共享 Markdown 文档')).toHaveValue(changed);
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存');
    expect(readFileSync(documentPath(base), 'utf8')).toBe(changed);
    expect(readFileSync(file, 'utf8')).toBe(original);
    await page.reload();
    await page.getByRole('button', { name: '本机设置', exact: true }).click();
    await page.getByRole('button', { name: '共享文档', exact: true }).click();
    await expect(page.getByLabel('共享 Markdown 文档')).toHaveValue(changed);
    await page.screenshot({ path: '.local/screenshots/shared-document.png' });
    expect(errors).toEqual([]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a second connection cannot overwrite a changed document; its draft remains editable', async ({
  page,
  context,
}) => {
  const base = mkdtempSync(join(tmpdir(), 'cc-document-ui-'));
  const file = join(base, 'import.md');
  writeFileSync(file, '# imported');
  const second = await context.newPage();
  try {
    await editor(page, base, file);
    await editor(second, base, file);
    await second.getByLabel('共享 Markdown 文档').fill('second window draft');
    await page.getByLabel('共享 Markdown 文档').fill('first window saved');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存');
    await second.getByRole('button', { name: '保存', exact: true }).click();
    await expect(second.getByRole('alert')).toContainText('已在别处修改');
    await expect(second.getByLabel('共享 Markdown 文档')).toHaveValue('second window draft');
    expect(load(base).text).toBe('first window saved');
    second.once('dialog', (dialog) => dialog.dismiss());
    await second.getByRole('button', { name: '重新载入', exact: true }).click();
    await expect(second.getByLabel('共享 Markdown 文档')).toHaveValue('second window draft');
    second.once('dialog', (dialog) => dialog.accept());
    await second.getByRole('button', { name: '重新载入', exact: true }).click();
    await expect(second.getByLabel('共享 Markdown 文档')).toHaveValue('first window saved');
  } finally {
    await second.close();
    rmSync(base, { recursive: true, force: true });
  }
});
