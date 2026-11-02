import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent, EventPayload } from '@cc-desk-tunnel/protocol';

// Two mocked servers: server 1 owns a task that failed on quota, server 2 is the pool target.
async function harness(
  page: Page,
  options: {
    queued?: boolean;
    remoteUtilization?: number;
    rejectFirstCreate?: boolean;
    clock?: boolean;
    hang?: boolean;
  } = {},
) {
  const device = { id: randomUUID(), name: 'test computer', platform: 'linux' as const };
  const connectionId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  const source: Session = {
    id: randomUUID(),
    title: '同一个任务',
    autoTitle: false,
    projectPath: '/project',
    createdAt: now,
    updatedAt: now,
    permissionMode: 'default',
    model: null,
    effort: null,
    device,
    messageQueue: options.queued
      ? {
          items: [1, 2].map((n) => ({
            id: randomUUID(),
            text: `后续任务${n}`,
            scenario: 'chat' as const,
            createdAt: now,
          })),
          paused: false,
        }
      : undefined,
    activeRun: null,
  };
  const state = { target: undefined as Session | undefined, hang: !!options.hang, creates: 0 };
  const sent: { server: number; type: string; text?: string }[] = [];
  const old: SessionEvent[] = [];
  const live: SessionEvent[] = [];
  const event = (session: Session, payload: EventPayload, entries: SessionEvent[]) => {
    const e = {
      sessionId: session.id,
      runId,
      sequence: entries.length + 1,
      createdAt: now,
      payload,
    };
    entries.push(e);
    return e;
  };
  event(
    source,
    {
      type: 'message.user',
      messageId: randomUUID(),
      text: '保留原来的任务和对话',
      scenario: 'chat',
    },
    old,
  );
  event(source, { type: 'text.delta', messageId: randomUUID(), text: '已经完成第一步' }, old);
  event(source, { type: 'run.error', code: 'quota_five_hour', message: '旧账号额度耗尽' }, old);
  event(source, { type: 'run.status', status: 'failed', connectionId }, old);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  for (const server of [1, 2])
    await page.routeWebSocket(`ws://127.0.0.1:1899${server}/ws`, (route) => {
      const send = (value: unknown) => route.send(JSON.stringify(value));
      route.onMessage((raw) => {
        const m = JSON.parse(String(raw));
        sent.push({ server, type: m.type, text: m.text });
        if (m.type === 'device') return;
        if (server === 2 && state.hang) return;
        const current = server === 1 ? source : state.target;
        if (m.type === 'auth') {
          send({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            version: '0.4.13',
            connectionId,
            adapter: 'claude-code',
            sessions: current ? [current] : [],
            features: [
              'account-pool',
              'cross-server-handoff',
              'cross-server-queue-handoff',
              'cross-server-queue-recovery',
              'cross-server-task-confirmation',
              'message-queue',
              'goal-continuation',
            ],
          });
          return;
        }
        if (m.type === 'pool.status')
          send({
            type: 'pool.state',
            refreshing: false,
            serverTime: Date.now(),
            settings: {
              enabled: true,
              strategy: 'order',
              order: ['default'],
              preferredId: 'default',
            },
            accounts: [
              {
                id: 'default',
                name: `账号${server}`,
                enabled: true,
                loggedIn: true,
                checkedAt: Date.now(),
                blockedUntil: null,
                login: null,
                busy: false,
                limits: {
                  available: true,
                  windows: [
                    { name: 'five_hour', utilization: server === 1 ? 100 : 10, resetsAt: null },
                  ],
                },
              },
            ],
            quotaWaits: [],
          });
        if (['session.subscribe', 'session.history'].includes(m.type) && current) {
          const entries = server === 1 ? old : live;
          send({
            type: 'session.snapshot',
            requestId: m.requestId,
            session: current,
            mode: m.type === 'session.history' ? 'prepend' : 'replace',
            firstSequence: entries[0]?.sequence ?? 0,
            lastSequence: entries.at(-1)?.sequence ?? 0,
            hasEarlier: false,
            events: entries,
          });
        }
        if (m.type === 'session.handoff') {
          expect(server).toBe(1);
          source.messageQueue = {
            ...source.messageQueue!,
            paused: true,
            handoff: { paused: source.messageQueue!.paused },
            reason: '跨服队列备份，请到续接会话继续。',
          };
          send({ type: 'session.updated', session: source });
        }
        if (m.type === 'session.handoff.cancel') {
          expect(server).toBe(1);
          expect(m.queueIds).toEqual(source.messageQueue!.items.map((item) => item.id));
          source.messageQueue = {
            items: source.messageQueue!.items,
            paused: true,
            reason: '原队列已恢复，请检查消息后继续队列。',
          };
          send({ type: 'session.updated', session: source });
        }
        if (m.type === 'run.continue' && server === 1) {
          send({
            type: 'response',
            requestId: m.requestId,
            ok: false,
            code: 'pool_unavailable',
            message: '账号池暂无可用额度',
          });
          return;
        }
        if (m.type === 'session.create') {
          state.creates++;
          if (options.rejectFirstCreate && state.creates === 1) {
            send({
              type: 'response',
              requestId: m.requestId,
              ok: false,
              code: 'internal',
              message: '目标服务器暂时无法创建会话',
            });
            return;
          }
          state.target = {
            ...source,
            id: randomUUID(),
            messageQueue: undefined,
            title: m.title,
          };
          send({ type: 'session.updated', session: state.target });
        }
        if (m.type === 'message.send' && server === 2 && state.target) {
          const target = state.target;
          for (const payload of [
            { type: 'message.user', messageId: randomUUID(), text: m.text, scenario: 'chat' },
            { type: 'text.delta', messageId: randomUUID(), text: '服务器2继续完成第二步' },
            { type: 'run.status', status: 'completed', connectionId },
          ] as EventPayload[])
            send({ type: 'session.event', event: event(target, payload, live) });
        }
        send({
          type: 'response',
          requestId: m.requestId,
          ok: true,
          sessionId: m.type === 'session.create' ? state.target?.id : m.sessionId,
        });
      });
    });
  await page.addInitScript(
    ({ device, remoteUtilization }) => {
      const profiles = [1, 2].map((n) => ({
        id: n === 1 ? 'default' : 'second',
        name: `服务器${n}`,
        url: `wss://server${n}.example/ws`,
        token: 'offline-test-token-1234567890',
        fingerprint: '',
        mode: 'remote',
        remember: true,
        autoLogin: true,
      }));
      localStorage.setItem(
        'proxy-account-pool',
        JSON.stringify({ enabled: true, strategy: 'manual', order: ['default', 'second'] }),
      );
      let firstProbe = true;
      const noop = async () => {};
      const subscription = () => () => {};
      Object.assign(window, {
        desktop: {
          dev: true,
          platform: 'linux',
          version: async () => '0.4.13',
          device: async () => device,
          loadProfiles: async () =>
            JSON.parse(
              localStorage.getItem('test-profiles') ??
                JSON.stringify({ profiles, activeId: 'default' }),
            ),
          saveProfiles: async (value: unknown) => {
            const test = window as unknown as { failNextSave?: boolean };
            if (test.failNextSave) {
              test.failNextSave = false;
              throw new Error('配置写入失败');
            }
            localStorage.setItem('test-profiles', JSON.stringify(value));
          },
          connectProxy: async ({ profileId }: { profileId: string }) => ({
            url: `ws://127.0.0.1:${profileId === 'default' ? '18991' : '18992'}/ws`,
          }),
          disconnectProxy: noop,
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
          notify: noop,
          probeQuota: async (id: string) => {
            const initial = firstProbe;
            if (id === 'default') firstProbe = false;
            return {
              available: true,
              measuredAt: new Date().toISOString(),
              windows: [
                {
                  name: 'five_hour',
                  utilization: id === 'default' ? (initial ? 0 : 100) : remoteUtilization,
                  resetsAt: null,
                },
              ],
            };
          },
        },
      });
    },
    { device, remoteUtilization: options.remoteUtilization ?? 10 },
  );
  if (options.clock) await page.clock.install();
  await page.goto('/');
  const openSource = () =>
    page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
  const continueSource = () =>
    page.getByRole('button', { name: '接着上一轮继续', exact: true }).click();
  return { source, state, sent, errors, openSource, continueSource };
}

test('a target that fails after taking the handoff releases it, so a retry is not refused', async ({
  page,
}) => {
  const { sent, errors, openSource, continueSource } = await harness(page, {
    rejectFirstCreate: true,
  });
  await openSource();
  await continueSource();
  await expect(page.getByLabel('当前服务器：服务器2', { exact: true })).toBeVisible();
  const failure = page
    .getByRole('alert')
    .filter({ hasText: /自动续接已暂停：目标服务器暂时无法创建会话/ });
  await expect(failure).toBeVisible();
  await expect(failure).toContainText('服务器1 → 服务器2');
  await expect(failure).toContainText('可回到原会话重新续接');
  expect(sent.filter((m) => m.server === 2 && m.type === 'message.send')).toHaveLength(0);
  // Previously the target kept its handoff slot and every retry said "already in progress".
  await openSource();
  await continueSource();
  await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
  await expect(page.getByText(/已有续接正在处理/)).toHaveCount(0);
  expect(sent.filter((m) => m.server === 2 && m.type === 'session.create')).toHaveLength(2);
  expect(sent.filter((m) => m.server === 2 && m.type === 'message.send')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a handoff whose target never connects times out and frees the target for a retry', async ({
  page,
}) => {
  const { state, sent, errors, openSource, continueSource } = await harness(page, {
    clock: true,
    hang: true,
  });
  // Server 2 accepts the socket but never answers, so the handoff can never start resuming.
  await openSource();
  await continueSource();
  await expect(page.getByRole('status').filter({ hasText: '正在打开会话…' })).toBeVisible();
  await page.clock.fastForward(91_000);
  await page.clock.runFor(1000);
  const timeout = page.getByRole('alert').filter({ hasText: /续接已超时取消/ });
  await expect(timeout).toBeVisible();
  await expect(timeout).toContainText('服务器1 → 服务器2');
  expect(sent.filter((m) => m.server === 2 && m.type === 'message.send')).toHaveLength(0);
  // The hung socket hit its connect timeout and the pool parked 服务器2; once it answers again the
  // background probe brings it back, and the retry is no longer refused as a handoff in progress.
  state.hang = false;
  await page.clock.runFor(61_000);
  await continueSource();
  await expect(page.getByText(/已有续接正在处理/)).toHaveCount(0);
  await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible({
    timeout: 20000,
  });
  expect(sent.filter((m) => m.server === 2 && m.type === 'message.send')).toHaveLength(1);
  expect(errors).toEqual([]);
});

test('a switch that fails after freezing the source queue gives the queue back', async ({
  page,
}) => {
  const { source, sent, errors, openSource, continueSource } = await harness(page, {
    queued: true,
  });
  await openSource();
  await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('后续任务1');
  await page.evaluate(() => Object.assign(window, { failNextSave: true }));
  await continueSource();
  await expect(
    page.getByRole('alert').filter({ hasText: /配置写入失败。原排队消息已退回本会话并保持暂停/ }),
  ).toBeVisible();
  expect(sent.filter((m) => m.type === 'session.handoff')).toHaveLength(1);
  expect(sent.filter((m) => m.type === 'session.handoff.cancel')).toHaveLength(1);
  expect(source.messageQueue?.handoff).toBeUndefined();
  expect(source.messageQueue?.paused).toBe(true);
  expect(source.messageQueue?.items.map((item) => item.text)).toEqual(['后续任务1', '后续任务2']);
  expect(
    sent.filter((m) => m.server === 2 && ['session.create', 'message.send'].includes(m.type)),
  ).toHaveLength(0);
  await expect(page.getByLabel('当前服务器：服务器1', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('an account at 99.5% five-hour usage shows 0% left and is never chosen', async ({ page }) => {
  const { sent, errors, openSource, continueSource } = await harness(page, {
    remoteUtilization: 99.5,
  });
  await openSource();
  await continueSource();
  await expect(page.getByRole('alert').filter({ hasText: /暂无可用的其他服务器/ })).toBeVisible();
  expect(sent.filter((m) => m.type === 'session.handoff')).toHaveLength(0);
  expect(
    sent.filter((m) => m.server === 2 && ['session.create', 'message.send'].includes(m.type)),
  ).toHaveLength(0);
  await expect(page.getByLabel('当前服务器：服务器1', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
