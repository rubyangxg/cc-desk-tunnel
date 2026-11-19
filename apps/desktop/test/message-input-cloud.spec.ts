import { resolve } from 'node:path';
import { test, expect } from '@playwright/test';

test('rich file input preserves quoted source text, supports removing an attachment and exposes completion state', async ({
  page,
}) => {
  await page.route('**/input-harness', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window);
window.$RefreshReg$ = () => {};
window.$RefreshSig$ = () => type => type;
window.__vite_plugin_react_preamble_installed__ = true;
window.desktop = {};
await import(${JSON.stringify('/@fs/' + resolve('apps/desktop/test/input-harness.tsx').replaceAll('\\', '/'))});
</script>`,
    }),
  );
  await page.goto('/input-harness');
  const box = page.getByRole('textbox', { name: '消息' });
  await expect(box).toHaveAttribute('contenteditable', 'true');
  await expect(box).toHaveAttribute('aria-activedescendant', 'command-one');
  const file = box.locator('.path-chip.file');
  await expect(file).toContainText('my file.txt');
  const before = await page.evaluate(
    () => (window as unknown as { currentText: string }).currentText,
  );
  expect(before).toBe(`Please read "${['C:', 'work', 'my file.txt'].join('\\')}" next`);
  await file.hover();
  await file.locator('.path-chip-remove').click();
  await expect(file).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { currentText: string }).currentText),
  ).toBe('Please read next');
});
