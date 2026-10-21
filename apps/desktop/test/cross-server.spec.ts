import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent, EventPayload } from '@cc-desk-tunnel/protocol';

for (const { manual, loseAck } of [
  { manual: false, loseAck: false },
  { manual: true, loseAck: false },
  { manual: false, loseAck: true },
])
  test(`cross-server ${manual ? 'manual' : 'quota'}${loseAck ? ' lost acknowledgement' : ''} handoff retains history, submits once and survives reload`, async ({
    page,
  }) => {
    const device = { id: randomUUID(), name: 'test computer', platform: 'linux' as const };
    const runId = randomUUID();
    const connectionId = randomUUID();
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
      activeRun: manual ? null : { id: runId, connectionId, status: 'running', surface: 'chat' },
    };
    let target: Session | undefined;
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
    event(
      source,
      { type: 'run.status', status: manual ? 'completed' : 'running', connectionId },
      old,
    );
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    for (const server of [1, 2])
      await page.routeWebSocket(`ws://127.0.0.1:1899${server}/ws`, (route) => {
        const send = (value: unknown) => route.send(JSON.stringify(value));
        route.onMessage((raw) => {
          const m = JSON.parse(String(raw));
          sent.push({ server, type: m.type, text: m.text });
          if (m.type === 'device') return;
          const current = server === 1 ? source : target;
          if (m.type === 'auth') {
            send({
              type: 'ready',
              protocolVersion: PROTOCOL_VERSION,
              version: '0.4.13',
              connectionId,
              adapter: 'claude-code',
              sessions: current ? [current] : [],
              features: ['account-pool', 'cross-server-handoff'],
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
              quotaWaits:
                server === 1 && source.activeRun
                  ? [{ sessionId: source.id, accountId: 'default', at: Date.now() + 3600000 }]
                  : [],
            });
          if (m.type === 'session.subscribe' && current)
            send({
              type: 'session.snapshot',
              requestId: m.requestId,
              session: current,
              mode: 'replace',
              firstSequence: 1,
              lastSequence: (server === 1 ? old : live).length,
              hasEarlier: false,
              events: server === 1 ? old : live,
            });
          if (m.type === 'run.handoff') {
            expect(server).toBe(1);
            source.activeRun = null;
            send({
              type: 'session.event',
              event: event(source, { type: 'run.status', status: 'cancelled', connectionId }, old),
            });
            send({ type: 'session.updated', session: source });
          }
          if (m.type === 'session.create') {
            target = { ...source, id: randomUUID(), activeRun: null, title: m.title };
            send({ type: 'session.updated', session: target });
          }
          if (m.type === 'message.send' && target) {
            expect(source.activeRun).toBeNull();
            send({
              type: 'session.event',
              event: event(
                target,
                { type: 'message.user', messageId: randomUUID(), text: m.text, scenario: 'chat' },
                live,
              ),
            });
            send({
              type: 'session.event',
              event: event(
                target,
                { type: 'text.delta', messageId: randomUUID(), text: '服务器2继续完成第二步' },
                live,
              ),
            });
            send({
              type: 'session.event',
              event: event(target, { type: 'run.status', status: 'completed', connectionId }, live),
            });
          }
          send({
            type: 'response',
            requestId: m.requestId,
            ok: true,
            sessionId: m.type === 'session.create' ? target?.id : m.sessionId,
          });
        });
      });
    await page.addInitScript(
      ({ device, manual }) => {
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
        if (!localStorage.getItem('proxy-account-pool'))
          localStorage.setItem(
            'proxy-account-pool',
            JSON.stringify({ enabled: !manual, strategy: 'manual', order: ['default', 'second'] }),
          );
        let firstProbe = !localStorage.getItem('test-profiles');
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
            saveProfiles: async (value: unknown) =>
              localStorage.setItem('test-profiles', JSON.stringify(value)),
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
            probeQuota: async (id: string) => ({
              available: true,
              measuredAt: new Date().toISOString(),
              windows: [
                {
                  name: 'five_hour',
                  utilization:
                    id === 'default' ? (firstProbe ? ((firstProbe = false), 0) : 100) : 10,
                  resetsAt: null,
                },
              ],
            }),
          },
        });
      },
      { device, manual },
    );
    await page.goto('/');
    if (manual) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await page.getByLabel('续接到服务器', { exact: true }).selectOption('second');
    }
    await expect(page.getByText('当前服务器：服务器2', { exact: true })).toBeVisible();
    await expect(page.locator('.message.user')).toContainText('保留原来的任务和对话');
    await expect(page.getByText('已经完成第一步', { exact: true })).toBeVisible();
    await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
    expect(sent.filter((m) => m.type === 'run.handoff')).toHaveLength(manual ? 0 : 1);
    expect(sent.filter((m) => m.type === 'message.send')).toHaveLength(1);
    expect(sent.find((m) => m.type === 'message.send')?.text).toContain('保留原来的任务和对话');
    await page.reload();
    await page.getByRole('button', { name: '同一个任务 · 服务器2', exact: true }).click();
    await expect(page.locator('.message.user')).toContainText('保留原来的任务和对话');
    await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
    expect(sent.filter((m) => m.type === 'message.send')).toHaveLength(1);
    await page.getByRole('button', { name: '设置与账号', exact: true }).click();
    await page.getByRole('menuitem', { name: '切换代理服务 · 服务器1', exact: true }).click();
    await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '前往当前会话', exact: true }).click();
    await expect(page.getByText('当前服务器：服务器2', { exact: true })).toBeVisible();
    await expect(page.locator('.message.user')).toContainText('保留原来的任务和对话');
    expect(sent.filter((m) => m.type === 'message.send')).toHaveLength(1);
    expect(errors).toEqual([]);
  });
