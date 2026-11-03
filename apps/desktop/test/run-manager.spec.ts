import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { RunInfo, Session } from '@cc-desk-tunnel/protocol';
import { screenshots } from './helpers.ts';

const shot = (page: Page, name: string) =>
  page.screenshot({ path: resolve(screenshots, 'redesign', `${name}.png`) });

// A service with one session whose run waits on an SSH command in the foreground, while a question sent
// after it waits for the command to end.
async function serve(page: Page, features: string[]) {
  const now = new Date(Date.now() - 95_000).toISOString();
  const connectionId = randomUUID();
  const runId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    title: '远程部署',
    autoTitle: false,
    projectPath: '/srv/部署',
    permissionMode: 'auto',
    model: null,
    effort: null,
    createdAt: now,
    updatedAt: now,
    activeRun: { id: runId, status: 'running', connectionId },
  };
  const later = randomUUID();
  const command = 'ssh -F /tmp/cfg pc device-script tail -f build.log';
  const run: RunInfo = {
    sessionId: session.id,
    runId,
    title: session.title,
    projectPath: session.projectPath,
    device: { id: randomUUID(), name: '办公电脑' },
    startedAt: now,
    status: 'running',
    queued: 1,
    queue: 0,
    processes: 5,
    tools: [
      {
        toolId: 'call-ssh',
        taskId: 'b-ssh',
        name: 'Bash',
        summary: command,
        startedAt: now,
        remote: true,
      },
    ],
    tasks: [{ id: 'b-dev', kind: 'local_bash', description: 'npm run dev' }],
  };
  const sent: Record<string, unknown>[] = [];
  await page.routeWebSocket('ws://127.0.0.1:18890/ws', (route) => {
    const reply = (value: unknown) => route.send(JSON.stringify(value));
    const event = (sequence: number, payload: unknown) => ({
      sessionId: session.id,
      runId,
      sequence,
      createdAt: now,
      payload,
    });
    route.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'device') return;
      if (message.type === 'auth') {
        reply({
          type: 'ready',
          protocolVersion: PROTOCOL_VERSION,
          version: '0.0.1',
          connectionId,
          adapter: 'claude-code',
          sessions: [session],
          features,
        });
        return;
      }
      if (message.type === 'session.subscribe') {
        reply({
          type: 'session.snapshot',
          requestId: message.requestId,
          session,
          mode: 'replace',
          firstSequence: 1,
          lastSequence: 6,
          hasEarlier: false,
          events: [
            event(1, {
              type: 'message.user',
              messageId: randomUUID(),
              text: '部署到办公电脑',
              scenario: 'chat',
            }),
            event(2, { type: 'run.status', status: 'running', connectionId }),
            event(3, {
              type: 'tool.requested',
              toolId: 'call-ssh',
              name: 'Bash',
              input: JSON.stringify({ command }, null, 2),
              target: 'Linux',
            }),
            event(4, { type: 'tool.task', toolId: 'call-ssh', taskId: 'b-ssh' }),
            event(5, {
              type: 'message.user',
              messageId: later,
              text: '好了吗？',
              scenario: 'chat',
            }),
            event(6, { type: 'message.delivery', messageId: later, status: 'queued' }),
          ],
        });
        return;
      }
      if (message.type === 'runs.list') {
        reply({ type: 'runs.state', requestId: message.requestId, runs: [run] });
        reply({ type: 'response', requestId: message.requestId, ok: true });
        return;
      }
      if (['run.kill', 'run.cancel', 'run.task.stop', 'run.task.background'].includes(message.type))
        sent.push(
          Object.fromEntries(
            Object.entries(message).filter(([key]) => !['requestId'].includes(key)),
          ),
        );
      reply({ type: 'response', requestId: message.requestId, ok: true });
    });
  });
  await page.goto('/');
  await page.getByLabel('服务地址', { exact: true }).fill('ws://127.0.0.1:18890/ws');
  await page
    .getByLabel('服务凭据', { exact: true })
    .fill('test-only-run-manager-token-with-enough-length');
  await page.getByRole('button', { name: '连接选中的服务', exact: true }).click();
  return { session, run, sent };
}

async function select(page: Page, title: string) {
  const expand = page.getByRole('button', { name: '展开会话列表', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.session-row').filter({ hasText: title }).locator('.session-select').click();
}

test('a command the run still waits on shows running though a later question closed its turn', async ({
  page,
}) => {
  const { session, sent } = await serve(page, []);
  await select(page, session.title);
  const group = page.locator('details.work');
  // The turn the question closed still shows its command running, not as done.
  await expect(group.locator('> summary')).toContainText('正在运行');
  await expect(group.locator('> summary .spinning')).toBeVisible();
  // The question sent after it says what it waits for, with a way to free it.
  const blocked = page.locator('.queue-blocked');
  await expect(blocked).toContainText('1 条消息在等当前命令结束');
  await expect(blocked).toContainText('ssh -F /tmp/cfg');
  await shot(page, '30-消息等待前台命令');
  await blocked.getByRole('button', { name: '转后台' }).click();
  await expect
    .poll(() => sent)
    .toEqual([
      {
        type: 'run.task.background',
        sessionId: session.id,
        runId: session.activeRun!.id,
        toolId: 'call-ssh',
      },
    ]);
  // A service without the run manager has no page for it.
  await expect(page.getByRole('button', { name: '运行管理', exact: true })).toHaveCount(0);
});

test('the run manager lists what runs and stops it gracefully or by force', async ({ page }) => {
  const { session, sent } = await serve(page, ['run-manager']);
  await page.getByRole('button', { name: '运行管理', exact: true }).click();
  const card = page.getByRole('article', { name: `运行 ${session.title}` });
  await expect(card).toContainText('运行中');
  await expect(card).toContainText('办公电脑');
  await expect(card).toContainText('1 条消息等待处理');
  await expect(card).toContainText('5 个进程');
  await expect(card).toContainText('设备 / SSH');
  await expect(card).toContainText('npm run dev');
  await expect(card).toContainText(/已运行 1 分 3\d 秒/);
  await shot(page, '31-运行管理');
  const runId = session.activeRun!.id;
  const target = { sessionId: session.id, runId };
  const command = card.locator('.run-item').filter({ hasText: 'ssh -F' });
  await command.getByRole('button', { name: '转后台' }).click();
  await expect.poll(() => sent.length).toBe(1);
  // A force stop asks first, in the page; cancelling sends nothing.
  await command.getByRole('button', { name: '强制停止' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('ssh -F /tmp/cfg');
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await command.getByRole('button', { name: '强制停止' }).click();
  await shot(page, '32-运行管理-强制停止');
  await page.getByRole('dialog').getByRole('button', { name: '强制停止' }).click();
  await expect.poll(() => sent.length).toBe(2);
  await card
    .locator('.run-item')
    .filter({ hasText: 'npm run dev' })
    .getByRole('button', { name: '停止' })
    .click();
  await expect.poll(() => sent.length).toBe(3);
  await card
    .locator('.run-card-actions')
    .getByRole('button', { name: '停止', exact: true })
    .click();
  await expect.poll(() => sent.length).toBe(4);
  await card.locator('.run-card-actions').getByRole('button', { name: '强制停止' }).click();
  await expect(page.getByRole('dialog')).toContainText('整个任务');
  await page.getByRole('dialog').getByRole('button', { name: '强制停止' }).click();
  await expect.poll(() => sent.length).toBe(5);
  expect(sent).toEqual([
    { type: 'run.task.background', ...target, toolId: 'call-ssh' },
    { type: 'run.kill', ...target, toolId: 'call-ssh' },
    { type: 'run.task.stop', ...target, taskId: 'b-dev' },
    { type: 'run.cancel', ...target },
    { type: 'run.kill', ...target },
  ]);
  // The run's name leads to its session.
  await card.getByRole('button', { name: session.title }).click();
  await expect(page.locator('details.work > summary')).toContainText('正在运行');
});
