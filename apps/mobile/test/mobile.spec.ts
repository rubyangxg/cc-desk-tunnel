import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, type Session } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../../server/src/server.ts';

async function fixture() {
  const token = 'mobile-test-' + randomUUID(),
    deviceId = randomUUID();
  const servers = await Promise.all(
    [1, 2].map(async (n) => {
      const dir = mkdtempSync(join(tmpdir(), 'cc-mobile-ui-'));
      const server = createProxyServer({
        token,
        dataDir: dir,
        stepMs: 50,
        allowedOrigins: ['http://127.0.0.1:15175'],
        graceMs: 20,
      });
      const url = await server.listen(0),
        socket = new WebSocket(url.replace('http', 'ws') + '/ws');
      await once(socket, 'open');
      socket.send(
        JSON.stringify({
          type: 'auth',
          token,
          protocolVersion: PROTOCOL_VERSION,
          deviceName: `电脑${n}`,
        }),
      );
      socket.send(JSON.stringify({ type: 'device', id: deviceId }));
      await new Promise((resolve) => setTimeout(resolve, 30));
      const session = server.store.create(randomUUID(), `服务器${n}的任务`, `D:\\项目${n}`, {
        id: deviceId,
        name: `电脑${n}`,
      });
      return {
        server,
        socket,
        dir,
        session,
        profile: {
          id: randomUUID(),
          name: `服务器${n}`,
          url: url.replace('http', 'ws') + '/ws',
          fingerprint: '',
        },
      };
    }),
  );
  return {
    servers,
    token,
    async close() {
      for (const f of servers) {
        f.socket.terminate();
        await f.server.close();
        rmSync(f.dir, { recursive: true, force: true });
      }
    },
  };
}
async function phone(
  page: import('@playwright/test').Page,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  await page.addInitScript(
    ({ profiles, token }) => {
      const connections = new Map<string, WebSocket>();
      let dropReply = false;
      let lostRequest = '';
      const receive = (value: unknown) => window.__nativeReceive(JSON.stringify(value));
      window.MobileNative = {
        postMessage(raw) {
          const { id, method, args } = JSON.parse(raw);
          let result: unknown = null;
          try {
            if (method === 'profiles.list')
              result = {
                profiles,
                deviceId: 'cd955610-c94d-4ea1-af31-9abc8d4f019b',
                notifications: false,
              };
            else if (method === 'socket.open') {
              const p = profiles.find((p) => p.id === args.profileId)!;
              const ws = new WebSocket(p.url);
              connections.set(args.socketId, ws);
              ws.onopen = () => receive({ id: args.socketId, event: 'open' });
              ws.onmessage = (e) => {
                const message = JSON.parse(e.data);
                if (message.type === 'response' && message.requestId === lostRequest) {
                  ws.close();
                  lostRequest = '';
                  return;
                }
                receive({ id: args.socketId, event: 'message', data: e.data });
              };
              ws.onclose = (e) => receive({ id: args.socketId, event: 'close', code: e.code });
            } else if (method === 'socket.send') {
              const frame = JSON.parse(args.data);
              if (frame.type === 'auth') frame.token = token;
              if (dropReply && frame.type === 'message.send') {
                lostRequest = frame.requestId;
                dropReply = false;
              }
              connections.get(args.socketId)!.send(JSON.stringify(frame));
            } else if (method === 'socket.close') {
              connections.get(args.socketId)?.close();
              connections.delete(args.socketId);
            } else if (method === 'profiles.save') {
              const p = { ...args, id: args.id ?? crypto.randomUUID() };
              profiles.push(p);
              result = p;
            } else if (method === 'profiles.remove') {
              profiles.splice(
                profiles.findIndex((p) => p.id === args.id),
                1,
              );
            }
            queueMicrotask(() => receive({ id, ok: true, result }));
          } catch (e) {
            queueMicrotask(() => receive({ id, ok: false, error: String(e) }));
          }
        },
      };
      (window as any).testDropNextReply = () => {
        dropReply = true;
      };
      (window as any).testDisconnect = () => {
        for (const ws of connections.values()) ws.close();
      };
    },
    { profiles: f.servers.map((s) => s.profile), token: f.token },
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: /服务器1的任务/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /服务器2的任务/ })).toBeVisible();
}

test('phone controls two real servers, queues and approves without interrupting another task', async ({
  page,
}) => {
  const f = await fixture();
  try {
    await phone(page, f);
    await page.getByRole('button', { name: /服务器1的任务/ }).click();
    await page.getByLabel('发送方式').selectOption('direct');
    await page.getByLabel('消息', { exact: true }).fill('第一台直接消息');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByText('第一台直接消息', { exact: true })).toBeVisible();
    await expect
      .poll(() => f.servers[0].server.store.get(f.servers[0].session.id).session.activeRun)
      .toBeNull();
    // Start an approval task through the real desktop connection, then switch the phone elsewhere.
    f.servers[0].socket.send(
      JSON.stringify({
        type: 'message.send',
        requestId: randomUUID(),
        sessionId: f.servers[0].session.id,
        text: '需要审批的电脑任务',
        scenario: 'tool',
      }),
    );
    await expect(page.getByRole('button', { name: '允许这次操作' })).toBeVisible();
    const run = f.servers[0].server.store.get(f.servers[0].session.id).session.activeRun!.id;
    await page.getByRole('button', { name: '返回会话列表' }).click();
    await page.getByRole('button', { name: /服务器2的任务/ }).click();
    await page.getByLabel('消息', { exact: true }).fill('第二台排队消息');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect
      .poll(() =>
        f.servers[1].server.store
          .snapshot(f.servers[1].session.id)
          .events.some(
            (e) => e.payload.type === 'message.user' && e.payload.text === '第二台排队消息',
          ),
      )
      .toBe(true);
    expect(f.servers[0].server.store.get(f.servers[0].session.id).session.activeRun?.id).toBe(run);
    await page.getByRole('button', { name: '返回会话列表' }).click();
    await page.getByRole('button', { name: /服务器1的任务/ }).click();
    await page.getByRole('button', { name: '允许这次操作' }).click();
    await expect
      .poll(() =>
        f.servers[0].server.store
          .snapshot(f.servers[0].session.id)
          .events.some((e) => e.payload.type === 'approval.resolved' && e.payload.allowed),
      )
      .toBe(true);
    await expect
      .poll(() => f.servers[0].server.store.get(f.servers[0].session.id).session.activeRun)
      .toBeNull();
    await page.getByRole('button', { name: '继续', exact: true }).click();
    await expect
      .poll(() =>
        f.servers[0].server.store
          .snapshot(f.servers[0].session.id)
          .events.some((e) => e.payload.type === 'message.user' && e.payload.continued),
      )
      .toBe(true);
    await page.getByRole('button', { name: '返回会话列表' }).click();
    await page.getByRole('button', { name: '新建会话' }).click();
    await page.getByLabel('会话名称').fill('手机创建的项目任务');
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await expect(page.getByRole('heading', { name: '手机创建的项目任务' })).toBeVisible();
    const created = f.servers
      .flatMap((s) => s.server.store.list())
      .find((s) => s.title === '手机创建的项目任务')!;
    expect(created.device?.id).toBe(f.servers[0].session.device?.id);
  } finally {
    await page.close();
    await f.close();
  }
});

test('reconnect retains draft and history, never resends an accepted message, goal command is exact', async ({
  page,
}) => {
  const f = await fixture();
  try {
    await phone(page, f);
    await page.getByRole('button', { name: /服务器1的任务/ }).click();
    await page.getByRole('button', { name: '设置目标', exact: true }).click();
    await page.getByLabel('目标条件').fill('验证手机端目标条件');
    await page.getByRole('button', { name: '开始执行' }).click();
    await expect
      .poll(
        () =>
          f.servers[0].server.store
            .snapshot(f.servers[0].session.id)
            .events.filter(
              (e) =>
                e.payload.type === 'message.user' && e.payload.text === '/goal 验证手机端目标条件',
            ).length,
      )
      .toBe(1);
    await expect(page.getByLabel('消息', { exact: true })).toBeEnabled();
    await page.getByLabel('消息', { exact: true }).fill('断线保留的草稿');
    await page.evaluate(() => (window as any).testDisconnect());
    await expect(page.getByText(/恢复后会补齐/)).toBeVisible();
    await expect(page.getByText(/恢复后会补齐/)).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('断线保留的草稿');
    expect(
      f.servers[0].server.store
        .snapshot(f.servers[0].session.id)
        .events.filter(
          (e) => e.payload.type === 'message.user' && e.payload.text === '/goal 验证手机端目标条件',
        ),
    ).toHaveLength(1);
    await page.screenshot({ path: test.info().outputPath('mobile-chat.png'), fullPage: true });
  } finally {
    await page.close();
    await f.close();
  }
});

test('lost send acknowledgement is reported and not automatically retried', async ({ page }) => {
  const f = await fixture();
  try {
    await phone(page, f);
    await page.getByRole('button', { name: /服务器1的任务/ }).click();
    await page.getByLabel('发送方式').selectOption('direct');
    await page.evaluate(() => (window as any).testDropNextReply());
    await page.getByLabel('消息', { exact: true }).fill('只执行一次的指令');
    await page.getByRole('button', { name: '发送消息' }).click();
    await expect(page.getByRole('alert')).toContainText('确认未收到');
    await expect(page.getByText(/恢复后会补齐/)).toHaveCount(0, { timeout: 15000 });
    expect(
      f.servers[0].server.store
        .snapshot(f.servers[0].session.id)
        .events.filter(
          (e) => e.payload.type === 'message.user' && e.payload.text === '只执行一次的指令',
        ),
    ).toHaveLength(1);
    await expect(page.getByLabel('消息', { exact: true })).toHaveValue('只执行一次的指令');
  } finally {
    await page.close();
    await f.close();
  }
});
