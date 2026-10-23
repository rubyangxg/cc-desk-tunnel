import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent, EventPayload } from '@cc-desk-tunnel/protocol';

for (const {
  manual,
  loseAck,
  localAvailable = false,
  paginated = false,
  queued = false,
  paused = false,
  stoppedSend = false,
  away = false,
  loseQueueAck = false,
  quotaQueue = false,
  legacyQueue = false,
  userPaused = false,
} of [
  { manual: false, loseAck: false, queued: true, quotaQueue: true },
  { manual: false, loseAck: false, queued: true, quotaQueue: true, legacyQueue: true },
  { manual: false, loseAck: false, queued: true, quotaQueue: true, userPaused: true },
  { manual: false, loseAck: false },
  { manual: true, loseAck: false },
  { manual: false, loseAck: true },
  { manual: false, loseAck: false, paginated: true },
  { manual: false, loseAck: false, localAvailable: true },
  { manual: false, loseAck: false, queued: true },
  { manual: false, loseAck: true, queued: true },
  { manual: false, loseAck: false, queued: true, paused: true },
  { manual: false, loseAck: false, queued: true, stoppedSend: true },
  { manual: false, loseAck: false, away: true },
  { manual: false, loseAck: false, queued: true, loseQueueAck: true },
])
  test(`cross-server ${manual ? 'manual' : 'quota'}${loseAck ? ' lost acknowledgement' : ''}${paginated ? ' paginated' : ''}${localAvailable ? ' available local account' : ''}${queued ? ' queued' : ''}${paused ? ' paused' : ''}${stoppedSend ? ' stopped resend' : ''}${away ? ' other device' : ''}${loseQueueAck ? ' lost queue acknowledgement' : ''}${quotaQueue ? ' idle quota queue' : ''}${legacyQueue ? ' legacy' : ''}${userPaused ? ' user paused' : ''} handoff retains history, submits once and survives reload`, async ({
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
      device: away ? { ...device, id: randomUUID(), name: 'home-win11' } : device,
      messageQueue: queued
        ? {
            items: [1, 2].map((n) => ({
              id: randomUUID(),
              text: `后续任务${n}`,
              scenario: 'chat' as const,
              createdAt: now,
            })),
            paused: paused || stoppedSend || quotaQueue,
            ...(quotaQueue
              ? {
                  reason: userPaused ? undefined : '账号池暂无可用额度，请检测账号或等待额度重置。',
                  ...(!legacyQueue && !userPaused
                    ? { reasonCode: 'pool_unavailable' as const }
                    : {}),
                }
              : {}),
          }
        : undefined,
      activeRun:
        manual || localAvailable || stoppedSend || quotaQueue
          ? null
          : { id: runId, connectionId, status: 'running', surface: 'chat' },
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
    if (paginated)
      for (let i = 0; i < 60; i++)
        event(source, { type: 'native.notice', text: `历史记录 ${i}` }, old);
    if (localAvailable)
      event(source, { type: 'run.error', code: 'quota_five_hour', message: '旧账号额度耗尽' }, old);
    event(
      source,
      {
        type: 'run.status',
        status: localAvailable
          ? 'failed'
          : stoppedSend
            ? 'cancelled'
            : manual || quotaQueue
              ? 'completed'
              : 'running',
        connectionId,
      },
      old,
    );
    if (localAvailable)
      old.forEach((event) => {
        event.createdAt = new Date(Date.now() + 10000).toISOString();
      });
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
              features: [
                'account-pool',
                'cross-server-handoff',
                'cross-server-queue-handoff',
                'message-queue',
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
                      {
                        name: 'five_hour',
                        utilization: server === 1 && !localAvailable ? 100 : 10,
                        resetsAt: null,
                      },
                    ],
                  },
                },
              ],
              quotaWaits:
                server === 1 && source.activeRun
                  ? [{ sessionId: source.id, accountId: 'default', at: Date.now() + 3600000 }]
                  : [],
            });
          if (['session.subscribe', 'session.history'].includes(m.type) && current) {
            const entries = (server === 1 ? old : live).filter(
              (event) => !m.beforeSequence || event.sequence < m.beforeSequence,
            );
            const page = paginated && server === 1 ? entries.slice(-10) : entries;
            send({
              type: 'session.snapshot',
              requestId: m.requestId,
              session: current,
              mode: m.type === 'session.history' ? 'prepend' : 'replace',
              firstSequence: page[0]?.sequence ?? 0,
              lastSequence: page.at(-1)?.sequence ?? 0,
              hasEarlier: page.length < entries.length,
              events: page,
            });
          }
          if (m.type === 'run.handoff' || m.type === 'session.handoff') {
            expect(server).toBe(1);
            if (queued) {
              expect(m.queueIds).toEqual(source.messageQueue!.items.map((item) => item.id));
              source.messageQueue = {
                ...source.messageQueue!,
                paused: true,
                handoff: { paused: source.messageQueue!.paused },
              };
            }
            source.activeRun = null;
            send({
              type: 'session.event',
              event: event(source, { type: 'run.status', status: 'cancelled', connectionId }, old),
            });
            send({ type: 'session.updated', session: source });
          }
          if (m.type === 'session.create') {
            target = {
              ...source,
              id: randomUUID(),
              activeRun: null,
              messageQueue: undefined,
              device,
              title: m.title,
            };
            send({ type: 'session.updated', session: target });
          }
          if (m.type === 'message.send' && server === 1 && stoppedSend) {
            send({
              type: 'response',
              requestId: m.requestId,
              ok: false,
              code: 'pool_unavailable',
              message: '账号池暂无可用额度',
            });
            return;
          }
          if (m.type === 'message.queue.pause' && target) {
            target.messageQueue = { ...(target.messageQueue ?? { items: [] }), paused: m.paused };
            send({ type: 'session.updated', session: target });
          }
          if (m.type === 'message.enqueue' && target) {
            expect(target.messageQueue?.paused).toBe(true);
            target.messageQueue!.items.push({
              id: m.requestId,
              text: m.text,
              scenario: m.scenario,
              createdAt: now,
            });
            send({ type: 'session.updated', session: target });
          }
          if (m.type === 'message.send' && target && server === 2) {
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
          if (loseAck && m.type === 'message.send') return;
          if (loseQueueAck && m.type === 'message.enqueue') return;
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
    if (away) {
      await page.getByRole('button', { name: '展开其他设备的会话', exact: true }).click();
      await page
        .getByRole('button', { name: /同一个任务/ })
        .first()
        .click();
      await expect(page.getByText(/额度等待中；跨服接力需由 home-win11/)).toBeVisible();
      expect(
        sent.some((m) => ['run.handoff', 'session.handoff', 'message.send'].includes(m.type)),
      ).toBe(false);
      return;
    }
    if (userPaused) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('已暂停');
      await page.waitForTimeout(700);
      expect(
        sent.some((m) => ['session.handoff', 'run.handoff', 'message.send'].includes(m.type)),
      ).toBe(false);
      expect(source.messageQueue?.items).toHaveLength(2);
      return;
    }
    if (stoppedSend) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('停止后新的指令');
      await page.getByRole('textbox', { name: '消息', exact: true }).press('Control+Enter');
    }
    if (localAvailable) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await expect(page.locator('.message.user')).toContainText('保留原来的任务和对话');
      await page.waitForTimeout(700); // The legacy fallback used to start after 150 ms.
      await expect(page.getByLabel('当前服务器：服务器1', { exact: true })).toBeVisible();
      expect(sent.some((message) => message.server === 2)).toBe(false);
      expect(
        sent.filter((message) =>
          ['run.handoff', 'message.send', 'run.continue'].includes(message.type),
        ),
      ).toHaveLength(0);
      expect(errors).toEqual([]);
      return;
    }
    if (manual) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await page.getByLabel('续接到服务器', { exact: true }).selectOption('second');
    }
    await expect(page.getByLabel('当前服务器：服务器2', { exact: true })).toBeVisible();
    if (loseQueueAck) {
      await expect(page.getByText(/自动续接已暂停：排队请求超时/)).toBeVisible({ timeout: 15000 });
      expect(target?.messageQueue?.items.map((item) => item.text)).toEqual(['后续任务1']);
      expect(target?.messageQueue?.paused).toBe(true);
      expect(source.messageQueue?.items).toHaveLength(2);
      expect(source.messageQueue?.handoff).toBeDefined();
      expect(sent.filter((m) => m.type === 'message.send')).toHaveLength(0);
      await page.reload();
      await page.getByRole('button', { name: '同一个任务 · 服务器2', exact: true }).click();
      await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('已暂停');
      expect(sent.filter((m) => m.type === 'message.enqueue')).toHaveLength(1);
      expect(sent.filter((m) => m.type === 'message.send')).toHaveLength(0);
      return;
    }
    await expect(page.locator('.message.user')).toContainText('保留原来的任务和对话');
    await expect(page.getByText('已经完成第一步', { exact: true })).toBeVisible();
    await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
    expect(sent.filter((m) => m.type === 'run.handoff')).toHaveLength(
      manual || stoppedSend || quotaQueue ? 0 : 1,
    );
    expect(sent.filter((m) => m.type === 'message.send' && m.server === 2)).toHaveLength(1);
    expect(sent.find((m) => m.type === 'message.send' && m.server === 2)?.text).toContain(
      '保留原来的任务和对话',
    );
    if (quotaQueue) {
      expect(sent.filter((m) => m.type === 'session.handoff')).toHaveLength(1);
      await expect(page.getByLabel('续接到服务器', { exact: true })).toHaveCount(0);
      await expect(page.getByLabel('当前会话 Claude 账号', { exact: true })).toHaveCount(0);
    }
    if (queued) {
      await expect.poll(() => target?.messageQueue?.items.length).toBe(2);
      expect(target!.messageQueue!.items.map((item) => item.text)).toEqual([
        '后续任务1',
        '后续任务2',
      ]);
      if (!loseAck)
        await expect.poll(() => target!.messageQueue!.paused).toBe(paused || stoppedSend);
      else expect(target!.messageQueue!.paused).toBe(true);
      expect(source.messageQueue?.handoff).toBeDefined();
      if (stoppedSend)
        expect(sent.find((m) => m.type === 'message.send' && m.server === 2)?.text).toContain(
          '停止后新的指令',
        );
    }
    if (paginated)
      expect(sent.filter((message) => message.type === 'session.history').length).toBeGreaterThan(
        1,
      );
    await page.reload();
    await page.getByRole('button', { name: '同一个任务 · 服务器2', exact: true }).click();
    await expect(page.locator('.message.user')).toContainText('保留原来的任务和对话');
    await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
    expect(sent.filter((m) => m.type === 'message.send' && m.server === 2)).toHaveLength(1);
    await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '前往当前会话', exact: true }).click();
    await expect(page.getByLabel('当前服务器：服务器2', { exact: true })).toBeVisible();
    await expect(page.locator('.message.user')).toContainText('保留原来的任务和对话');
    expect(sent.filter((m) => m.type === 'message.send' && m.server === 2)).toHaveLength(1);
    expect(errors).toEqual([]);
  });
