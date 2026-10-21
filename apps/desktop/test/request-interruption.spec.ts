import { test, expect } from '@playwright/test';
import { login, createSession, send } from './helpers.ts';

test('a lost acknowledgement is described as a past interruption after reconnect, without resending', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    const sent: string[] = [];
    Object.assign(window, { interruptedSends: sent });
    let interrupted = false;
    window.WebSocket = class extends Original {
      pendingMessage?: string;
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('message', (event) => {
          const message = JSON.parse(String(event.data));
          if (
            !interrupted &&
            message.type === 'response' &&
            message.requestId === this.pendingMessage
          ) {
            // The server accepted the message, but the acknowledgement did not reach the renderer.
            interrupted = true;
            event.stopImmediatePropagation();
            this.close();
          }
        });
      }
      send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
        if (typeof data === 'string') {
          const command = JSON.parse(data);
          if (command.type === 'message.send') {
            sent.push(command.requestId);
            this.pendingMessage = command.requestId;
          }
        }
        super.send(data);
      }
    };
  });
  await page.goto('/');
  await login(page);
  await createSession(page, '确认丢失');
  await send(page, '这条消息只能发送一次');
  await expect(page.getByText('连接中断，正在自动重连', { exact: true })).toBeVisible();
  await expect(page.locator('.connection-status')).toContainText('已连接');
  await expect(page.locator('.error-banner')).toContainText('连接已恢复');
  await expect(page.locator('.error-banner')).toContainText('上次请求');
  await expect(page.locator('.error-banner')).toContainText('任务可能仍在运行');
  await expect(page.locator('.error-banner')).toContainText('不会自动重发');
  await expect(page.locator('.message.user')).toHaveCount(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { interruptedSends: string[] }).interruptedSends.length,
    ),
  ).toBe(1);
});
