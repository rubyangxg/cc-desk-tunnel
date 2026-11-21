import { test, expect } from '@playwright/test';

test('simultaneous file panels read and preview only their own server', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const reactModule = '/node_modules/.vite/deps/react.js';
    const { default: React } = await import(reactModule);
    const domModule = '/node_modules/.vite/deps/react-dom_client.js';
    const {
      default: { createRoot },
    } = await import(domModule);
    const { default: FilePanel } = await import('../src/FilePanel.tsx');
    document.getElementById('root')!.style.display = 'none';
    const calls: string[] = [];
    Object.defineProperty(window, 'fileCalls', { value: calls });
    Object.defineProperty(window, 'desktop', {
      value: {
        files: {
          list: () => {
            throw Error('unscoped access');
          },
        },
        filesFor: (profile: string) => ({
          list: async () => {
            calls.push(`list:${profile}`);
            return [{ name: 'README.md', kind: 'file', size: 20, mtime: 0 }];
          },
          read: async () => {
            calls.push(`read:${profile}`);
            return {
              bytes: new TextEncoder().encode(`# Server ${profile}`),
              size: 20,
              truncated: false,
            };
          },
          onProgress: () => () => {},
        }),
      },
    });
    for (const profile of ['A', 'B']) {
      const host = document.createElement('section');
      host.id = `panel-${profile}`;
      host.style.cssText =
        'height:380px;position:relative;width:100%;display:flex;flex-direction:column;min-height:0';
      document.body.append(host);
      createRoot(host).render(
        React.createElement(FilePanel, {
          profileId: profile,
          places: [{ id: 'server', label: '服务端', kind: 'server', style: 'posix' }],
          start: () => '/workspace',
          sessionKey: profile,
          info: { server: true, protected: true, home: '/home', dataDir: '/data' },
          layout: 'wide',
          setPage: () => {},
          close: () => {},
          noticeKey: profile,
          project: null,
        }),
      );
    }
  });
  for (const profile of ['A', 'B']) {
    const panel = page.locator(`#panel-${profile}`);
    await panel.locator('.file-row').filter({ hasText: 'README.md' }).click();
    await expect(panel.locator('.file-preview')).toContainText(`Server ${profile}`);
  }
  expect(
    await page.evaluate(() =>
      (window as unknown as { fileCalls: string[] }).fileCalls.slice().sort(),
    ),
  ).toEqual(['list:A', 'list:B', 'read:A', 'read:B']);
});
