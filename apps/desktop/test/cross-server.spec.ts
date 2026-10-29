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
  prioritySend = false,
  priorityBlocked = false,
  manualPriority = false,
  overnight = false,
  otherRunning = false,
  goal = false,
  legacyGoal = false,
  storageAbort = false,
  storageFull = false,
  continueQuota = false,
  continueUnconfirmed = false,
  continueTimeout = false,
  continueLocal = false,
  frozenQueue = false,
  legacyRecovery = false,
  confirmedContinue = false,
  taskConfirmation = false,
  legacyTaskConfirmation = false,
} of [
  { manual: false, loseAck: false, queued: true, continueQuota: true, taskConfirmation: true },
  {
    manual: false,
    loseAck: false,
    queued: true,
    continueQuota: true,
    taskConfirmation: true,
    legacyTaskConfirmation: true,
  },
  {
    manual: false,
    loseAck: false,
    queued: true,
    continueQuota: true,
    continueUnconfirmed: true,
    confirmedContinue: true,
  },
  { manual: false, loseAck: false, queued: true, frozenQueue: true },
  { manual: false, loseAck: false, queued: true, frozenQueue: true, legacyRecovery: true },
  { manual: false, loseAck: false, queued: true, continueUnconfirmed: true },
  { manual: false, loseAck: false, queued: true, quotaQueue: true, continueUnconfirmed: true },
  { manual: false, loseAck: false, queued: true, continueQuota: true, continueUnconfirmed: true },
  { manual: false, loseAck: false, continueQuota: true, otherRunning: true },
  { manual: false, loseAck: false, continueQuota: true, continueUnconfirmed: true },
  { manual: false, loseAck: false, continueQuota: true, continueTimeout: true },
  { manual: false, loseAck: false, continueQuota: true, continueLocal: true },
  { manual: false, loseAck: false, storageAbort: true },
  { manual: false, loseAck: false, storageFull: true, queued: true },
  { manual: false, loseAck: false, goal: true },
  { manual: false, loseAck: false, goal: true, legacyGoal: true },
  { manual: false, loseAck: false, otherRunning: true },
  { manual: false, loseAck: false, overnight: true },
  { manual: false, loseAck: false, prioritySend: true },
  { manual: false, loseAck: false, prioritySend: true, manualPriority: true },
  {
    manual: false,
    loseAck: false,
    prioritySend: true,
    manualPriority: true,
    priorityBlocked: true,
  },
  { manual: false, loseAck: false, prioritySend: true, priorityBlocked: true },
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
  test(`cross-server ${manual ? 'manual' : 'quota'}${goal ? ' goal' : ''}${legacyGoal ? ' legacy goal' : ''}${loseAck ? ' lost acknowledgement' : ''}${paginated ? ' paginated' : ''}${localAvailable ? ' available local account' : ''}${queued ? ' queued' : ''}${paused ? ' paused' : ''}${stoppedSend ? ' stopped resend' : ''}${away ? ' other device' : ''}${loseQueueAck ? ' lost queue acknowledgement' : ''}${quotaQueue ? ' idle quota queue' : ''}${legacyQueue ? ' legacy' : ''}${userPaused ? ' user paused' : ''}${prioritySend ? ' weekly priority send' : ''}${priorityBlocked ? ' unresolved tool' : ''}${manualPriority ? ' manual preference' : ''}${overnight ? ' overnight weekly recovery' : ''}${otherRunning ? ' other active task' : ''}${storageAbort ? ' storage abort' : ''}${storageFull ? ' storage full' : ''}${continueQuota ? ' continue button' : ''}${continueUnconfirmed ? ' unconfirmed receipt' : ''}${continueTimeout ? ' timeout' : ''}${continueLocal ? ' local success' : ''}${frozenQueue ? ' frozen recovery' : ''}${legacyRecovery ? ' old server' : ''}${confirmedContinue ? ' user verified' : ''}${taskConfirmation ? ' historical tasks' : ''}${legacyTaskConfirmation ? ' legacy confirmation' : ''} handoff retains history, submits once and survives reload`, async ({
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
      ...(goal
        ? {
            goal: {
              condition: '不在历史摘录里的原始验收条件',
              status: 'active' as const,
              iterations: 7,
              lastReason: '还差验证',
              updatedAt: now,
            },
          }
        : {}),
      device: away ? { ...device, id: randomUUID(), name: 'home-win11' } : device,
      messageQueue: queued
        ? {
            items: [1, 2].map((n) => ({
              id: randomUUID(),
              text: `后续任务${n}`,
              scenario: 'chat' as const,
              createdAt: now,
            })),
            paused: paused || stoppedSend || quotaQueue || frozenQueue,
            ...(frozenQueue
              ? { handoff: { paused: false }, reason: '跨服队列备份，请到续接会话继续。' }
              : {}),
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
        manual ||
        localAvailable ||
        stoppedSend ||
        quotaQueue ||
        prioritySend ||
        continueQuota ||
        frozenQueue
          ? null
          : { id: runId, connectionId, status: 'running', surface: 'chat' },
    };
    const companion: Session = {
      ...source,
      id: randomUUID(),
      title: '其他正在执行的任务',
      projectPath: '/other',
      activeRun: { id: randomUUID(), connectionId, status: 'running', surface: 'chat' },
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
    if (priorityBlocked)
      event(
        source,
        {
          type: 'tool.result',
          toolId: 'unconfirmed',
          status: 'unknown',
          output: 'pending verification',
          exitCode: null,
        },
        old,
      );
    if (paginated)
      for (let i = 0; i < 60; i++)
        event(source, { type: 'native.notice', text: `历史记录 ${i}` }, old);
    if (localAvailable || continueQuota)
      event(source, { type: 'run.error', code: 'quota_five_hour', message: '旧账号额度耗尽' }, old);
    if (taskConfirmation)
      event(
        source,
        {
          type: 'native.tasks',
          tasks: [{ id: 'stale-task', kind: 'local_bash', description: '旧后台构建' }],
        },
        old,
      );
    if (continueUnconfirmed)
      event(
        source,
        {
          type: 'message.delivery',
          messageId: old[0]!.payload.type === 'message.user' ? old[0]!.payload.messageId : '',
          status: 'unconfirmed',
        },
        old,
      );
    event(
      source,
      {
        type: 'run.status',
        status:
          localAvailable || continueQuota
            ? 'failed'
            : stoppedSend
              ? 'cancelled'
              : manual || quotaQueue || prioritySend
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
    if (storageAbort || storageFull)
      await page.addInitScript(
        ({ full }) => {
          const put = IDBObjectStore.prototype.put;
          let aborted = false;
          IDBObjectStore.prototype.put = function (value, key) {
            const attaching =
              this.name === 'history' && typeof key === 'string' && !key.startsWith('pending:');
            if (attaching && full) throw new DOMException('Disk full', 'QuotaExceededError');
            const request = put.call(this, value, key);
            if (attaching && !aborted) {
              aborted = true;
              request.addEventListener('success', () => this.transaction.abort());
            }
            return request;
          };
        },
        { full: storageFull },
      );
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
              sessions: [
                ...(current ? [current] : []),
                ...(server === 1 && otherRunning ? [companion] : []),
              ],
              features: [
                'account-pool',
                'cross-server-handoff',
                'cross-server-queue-handoff',
                ...(!legacyRecovery ? ['cross-server-queue-recovery'] : []),
                ...(!legacyTaskConfirmation ? ['cross-server-task-confirmation'] : []),
                'message-queue',
                ...(!legacyGoal || server === 1 ? ['goal-continuation'] : []),
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
                        utilization: server === 1 && !localAvailable && !prioritySend ? 100 : 10,
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
            if (confirmedContinue)
              expect(m.confirmedMessageIds).toEqual(
                old.flatMap(({ payload }) =>
                  payload.type === 'message.delivery' && payload.status === 'unconfirmed'
                    ? [payload.messageId]
                    : [],
                ),
              );
            else expect(m.confirmedMessageIds).toBeUndefined();
            if (taskConfirmation) expect(m.confirmedTaskIds).toEqual(['stale-task']);
            else expect(m.confirmedTaskIds).toBeUndefined();
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
          if (m.type === 'session.create') {
            target = {
              ...source,
              id: randomUUID(),
              activeRun: null,
              messageQueue: undefined,
              goal: undefined,
              device,
              title: m.title,
            };
            send({ type: 'session.updated', session: target });
          }
          if (m.type === 'session.configure' && target) {
            if (goal) expect(m.goal).toEqual(source.goal);
            target.goal = m.goal;
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
          if (m.type === 'run.continue' && server === 1 && continueQuota) {
            if (continueTimeout) return;
            if (!continueLocal) {
              send({
                type: 'response',
                requestId: m.requestId,
                ok: false,
                code: 'pool_unavailable',
                message: '账号池暂无可用额度',
              });
              return;
            }
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
            if (goal) expect(target.goal).toEqual(source.goal);
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
      ({ device, manual, prioritySend, manualPriority, overnight }) => {
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
            JSON.stringify({
              enabled: !manual,
              strategy: prioritySend && !manualPriority ? 'reset' : 'manual',
              order: manualPriority ? ['second', 'default'] : ['default', 'second'],
            }),
          );
        let firstRemoteProbe = true;
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
            probeQuota: async (id: string) => {
              const initial = firstProbe;
              if (id === 'default') firstProbe = false;
              const remoteUnavailable =
                (manualPriority && id === 'second' && firstRemoteProbe) ||
                (overnight && !(window as unknown as { recovered?: boolean }).recovered);
              if (id === 'second') firstRemoteProbe = false;
              return {
                available: true,
                measuredAt: new Date().toISOString(),
                windows: [
                  {
                    name: 'five_hour',
                    utilization:
                      id === 'default'
                        ? initial || prioritySend
                          ? 0
                          : 100
                        : remoteUnavailable
                          ? 100
                          : 10,
                    resetsAt: null,
                  },
                  ...(prioritySend || overnight
                    ? [
                        {
                          name: 'seven_day',
                          utilization: overnight && remoteUnavailable ? 100 : 20,
                          resetsAt: new Date(
                            Date.now() + (id === 'default' ? (initial ? 1 : 158) : 11) * 3600000,
                          ).toISOString(),
                        },
                      ]
                    : []),
                ],
              };
            },
          },
        });
      },
      { device, manual, prioritySend, manualPriority, overnight },
    );
    if (overnight) await page.clock.install();
    await page.goto('/');
    if (frozenQueue) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      const recovery = page.getByRole('button', { name: '恢复原队列', exact: true });
      const queueRegion = page.getByRole('region', { name: '待发送消息' });
      await expect(queueRegion).toContainText('等待续接确认');
      await page.evaluate(() => {
        window.desktop!.copyText = async (text) => {
          Object.assign(window, { copiedQueue: text });
        };
      });
      await page.getByRole('button', { name: '复制待发送消息', exact: true }).click();
      await expect(page.getByRole('button', { name: '已复制', exact: true })).toBeVisible();
      expect(
        await page.evaluate(() => (window as unknown as { copiedQueue: string }).copiedQueue),
      ).toBe('后续任务1\n\n后续任务2');
      expect(source.messageQueue?.handoff).toBeDefined();
      expect(
        sent.filter((m) => ['message.send', 'session.handoff.cancel'].includes(m.type)),
      ).toHaveLength(0);
      if (legacyRecovery) {
        await expect(recovery).toBeDisabled();
        await expect(recovery).toHaveAttribute('title', /升级服务端/);
        await expect(queueRegion).toContainText('请先升级服务端');
        expect(sent.filter((m) => m.type === 'session.handoff.cancel')).toHaveLength(0);
        return;
      }
      await expect(recovery).toBeEnabled();
      page.once('dialog', (dialog) => dialog.dismiss());
      await recovery.click();
      expect(source.messageQueue?.handoff).toBeDefined();
      expect(sent.filter((m) => m.type === 'session.handoff.cancel')).toHaveLength(0);
      page.once('dialog', (dialog) => dialog.accept());
      await recovery.click();
      await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('原队列已恢复');
      expect(source.messageQueue?.handoff).toBeUndefined();
      expect(source.messageQueue?.paused).toBe(true);
      expect(source.messageQueue?.items.map((item) => item.text)).toEqual([
        '后续任务1',
        '后续任务2',
      ]);
      await expect(page.getByRole('button', { name: '继续队列', exact: true })).toBeEnabled();
      await page.reload();
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await expect(page.getByRole('region', { name: '待发送消息' })).toContainText('原队列已恢复');
      expect(
        sent.filter((m) => ['message.send', 'message.enqueue', 'run.continue'].includes(m.type)),
      ).toHaveLength(0);
      expect(sent.filter((m) => m.type === 'session.handoff.cancel')).toHaveLength(1);
      expect(errors).toEqual([]);
      return;
    }
    if (continueUnconfirmed && !continueQuota) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await expect(page.getByRole('alert').filter({ hasText: /消息送达状态未确认/ })).toBeVisible();
      expect(source.messageQueue?.handoff).toBeUndefined();
      expect(source.messageQueue?.items).toHaveLength(2);
      expect(
        sent.filter((m) => ['session.handoff', 'run.handoff', 'message.send'].includes(m.type)),
      ).toHaveLength(0);
      expect(errors).toEqual([]);
      return;
    }
    if (overnight) {
      await expect(
        page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }),
      ).toBeVisible();
      await page.clock.runFor(1000);
      expect(sent.filter((m) => ['run.handoff', 'message.send'].includes(m.type))).toHaveLength(0);
      await page.evaluate(() => Object.assign(window, { recovered: true }));
      await page.clock.fastForward(61_000);
      await page.clock.runFor(1000);
    }
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
    if (prioritySend) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('优先使用快重置的周额度');
      await page.getByRole('textbox', { name: '消息', exact: true }).press('Control+Enter');
      if (priorityBlocked && manualPriority) {
        await expect(page.getByRole('alert').filter({ hasText: /工具|确认/ })).toBeVisible();
        expect(sent.filter((m) => m.type === 'message.send')).toHaveLength(0);
        await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
          '优先使用快重置的周额度',
        );
        return;
      }
      if (priorityBlocked) {
        await expect
          .poll(() => sent.filter((m) => m.type === 'message.send' && m.server === 1).length)
          .toBe(1);
        expect(
          sent.filter((m) => m.server === 2 && ['session.create', 'message.send'].includes(m.type)),
        ).toHaveLength(0);
        await expect(page.getByLabel('当前服务器：服务器1', { exact: true })).toBeVisible();
        await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue('');
        return;
      }
    }
    if (stoppedSend) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('停止后新的指令');
      await page.getByRole('textbox', { name: '消息', exact: true }).press('Control+Enter');
    }
    if (continueQuota) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      if (taskConfirmation && !legacyTaskConfirmation) {
        page.once('dialog', (dialog) => {
          expect(dialog.message()).toContain('旧后台构建');
          dialog.dismiss();
        });
        await page.getByRole('button', { name: '接着上一轮继续', exact: true }).click();
        await expect(
          page.getByRole('alert').filter({ hasText: /历史记录中仍有后台任务/ }),
        ).toBeVisible();
        expect(source.messageQueue?.handoff).toBeUndefined();
        expect(sent.filter((m) => m.type === 'session.handoff')).toHaveLength(0);
        page.once('dialog', (dialog) => dialog.accept());
      }
      if (confirmedContinue) page.once('dialog', (dialog) => dialog.accept());
      await page.getByRole('button', { name: '接着上一轮继续', exact: true }).click();
      if (legacyTaskConfirmation) {
        await expect(
          page.getByRole('alert').filter({ hasText: /请先升级来源服务端和客户端/ }),
        ).toBeVisible();
        expect(source.messageQueue?.handoff).toBeUndefined();
        expect(
          sent.filter((m) => ['session.handoff', 'message.send'].includes(m.type)),
        ).toHaveLength(0);
        return;
      }
      if ((continueUnconfirmed && !confirmedContinue) || continueTimeout || continueLocal) {
        if (!continueLocal)
          await expect(
            page
              .getByRole('alert')
              .filter({ hasText: continueTimeout ? /超时/ : /消息送达状态未确认/ }),
          ).toBeVisible({ timeout: 15000 });
        else
          await expect(
            page.getByRole('button', { name: '接着上一轮继续', exact: true }),
          ).toBeEnabled();
        expect(sent.filter((m) => m.type === 'run.continue')).toHaveLength(1);
        if (queued) {
          expect(source.messageQueue?.handoff).toBeUndefined();
          expect(sent.filter((m) => m.type === 'session.handoff')).toHaveLength(0);
        }
        expect(
          sent.filter((m) => m.server === 2 && ['session.create', 'message.send'].includes(m.type)),
        ).toHaveLength(0);
        await expect(page.getByLabel('当前服务器：服务器1', { exact: true })).toBeVisible();
        expect(errors).toEqual([]);
        return;
      }
    }
    if (localAvailable) {
      await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
      await expect(page.locator('.service-workspace:not([hidden]) .message.user')).toContainText(
        '保留原来的任务和对话',
      );
      await page.waitForTimeout(700); // The legacy fallback used to start after 150 ms.
      await expect(page.getByLabel('当前服务器：服务器1', { exact: true })).toBeVisible();
      expect(
        sent.some(
          (message) =>
            message.server === 2 &&
            ['session.create', 'message.send', 'run.handoff'].includes(message.type),
        ),
      ).toBe(false);
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
    if (legacyGoal) {
      await expect(page.getByText(/目标服务器不支持 \/goal 续接/)).toBeVisible();
      expect(sent.filter((m) => ['session.create', 'message.send'].includes(m.type))).toHaveLength(
        0,
      );
      expect(source.goal?.condition).toBe('不在历史摘录里的原始验收条件');
      return;
    }
    if (storageFull) {
      await expect(page.getByText(/本地存储空间不足/)).toBeVisible();
      await expect(page.getByText(/续接消息尚未发送，上下文已保留/)).toBeVisible();
      await expect(page.getByRole('textbox', { name: '消息', exact: true })).toHaveValue(
        /保留原来的任务和对话/,
      );
      expect(sent.filter((m) => m.server === 2 && m.type === 'session.create')).toHaveLength(1);
      expect(sent.filter((m) => ['message.send', 'message.enqueue'].includes(m.type))).toHaveLength(
        0,
      );
      expect(source.messageQueue?.items).toHaveLength(2);
      expect(source.messageQueue?.handoff).toBeDefined();
      expect(errors).toEqual([]);
      return;
    }
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
    await expect(page.locator('.service-workspace:not([hidden]) .message.user')).toContainText(
      '保留原来的任务和对话',
    );
    // Wait until the target reply has joined the archived turn before opening its process fold.
    await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
    // Upstream groups continuation into the original turn. Earlier replies remain in its process fold.
    const earlierTurns = page.locator(
      '.service-workspace:not([hidden]) .turn-process:not([open]) > summary',
    );
    while (await earlierTurns.count()) await earlierTurns.first().click();
    await expect(
      page.locator('.service-workspace:not([hidden])').getByText('已经完成第一步', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
    if (goal)
      await expect(page.getByRole('status', { name: '会话目标' }).last()).toContainText(
        '不在历史摘录里的原始验收条件',
      );
    expect(sent.filter((m) => m.type === 'run.handoff')).toHaveLength(
      manual || stoppedSend || quotaQueue || prioritySend || continueQuota ? 0 : 1,
    );
    expect(sent.filter((m) => m.type === 'message.send' && m.server === 2)).toHaveLength(1);
    if (continueQuota)
      expect(sent.filter((m) => m.type === 'run.continue')).toHaveLength(taskConfirmation ? 2 : 1);
    if (storageAbort)
      expect(sent.filter((m) => m.type === 'session.create' && m.server === 2)).toHaveLength(1);
    if (otherRunning) {
      expect(companion.activeRun?.status).toBe('running');
      expect(sent.filter((m) => m.type === 'run.cancel')).toHaveLength(0);
    }
    if (prioritySend) {
      expect(sent.filter((m) => m.type === 'message.send' && m.server === 1)).toHaveLength(0);
      expect(sent.find((m) => m.type === 'message.send' && m.server === 2)?.text).toContain(
        '优先使用快重置的周额度',
      );
    }
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
    await expect(page.locator('.service-workspace:not([hidden]) .message.user')).toContainText(
      '保留原来的任务和对话',
    );
    await expect(page.getByText('服务器2继续完成第二步', { exact: true })).toBeVisible();
    expect(sent.filter((m) => m.type === 'message.send' && m.server === 2)).toHaveLength(1);
    await page.getByRole('button', { name: '同一个任务 · 服务器1', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '消息', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '前往当前会话', exact: true }).click();
    await expect(page.getByLabel('当前服务器：服务器2', { exact: true })).toBeVisible();
    await expect(page.locator('.service-workspace:not([hidden]) .message.user')).toContainText(
      '保留原来的任务和对话',
    );
    expect(sent.filter((m) => m.type === 'message.send' && m.server === 2)).toHaveLength(1);
    expect(errors).toEqual([]);
  });
