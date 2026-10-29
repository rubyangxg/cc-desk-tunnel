import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';

for (const slow of [false, true])
  test(`warm server navigation ${slow ? 'with delayed destination and alias' : ''} preserves both running sessions, drafts and execution connections`, async ({
    page,
  }) => {
    const device = { id: randomUUID(), name: 'test computer', platform: 'linux' as const };
    const createdAt = new Date().toISOString();
    const sessions: Session[] = [1, 2].map((n) => ({
      id: randomUUID(),
      title: `任务${n}`,
      autoTitle: false,
      projectPath: `/project${n}`,
      createdAt,
      updatedAt: createdAt,
      permissionMode: 'default',
      model: null,
      effort: null,
      device,
      activeRun: { id: randomUUID(), status: 'running', connectionId: randomUUID() },
    }));
    sessions[1]!.id = sessions[0]!.id; // IDs may collide across independent services.
    let finishReady: (() => void) | undefined;
    const errors: string[] = [];
    const sent: { server: number; type: string }[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let dialogs = 0;
    page.on('dialog', async (dialog) => {
      dialogs++;
      await dialog.dismiss();
    });
    const events: SessionEvent[][] = [[], []];
    const pushers = new Map<number, (value: unknown) => void>();
    const event = (index: number, text: string): SessionEvent => ({
      sessionId: sessions[index]!.id,
      runId: sessions[index]!.activeRun!.id,
      sequence: events[index]!.length + 1,
      createdAt: new Date().toISOString(),
      payload: { type: 'text.delta', messageId: randomUUID(), text },
    });
    const quotaEvent = (index: number, five: number, week: number): SessionEvent => ({
      ...event(index, ''),
      payload: {
        type: 'native.metrics',
        context: null,
        usage: null,
        rateLimits: {
          available: true,
          measuredAt: new Date().toISOString(),
          windows: [
            { name: 'five_hour', utilization: five, resetsAt: null },
            { name: 'seven_day', utilization: week, resetsAt: null },
          ],
        },
      },
    });
    for (let n = 1; n <= 2; n++) {
      events[n - 1]!.push(event(n - 1, `服务器${n}正在运行`));
      events[n - 1]!.push(quotaEvent(n - 1, n === 1 ? 20 : 60, n === 1 ? 40 : 80));
      await page.routeWebSocket(`ws://127.0.0.1:1889${n}/ws`, (route) => {
        const send = (value: unknown) => route.send(JSON.stringify(value));
        pushers.set(n, send);
        route.onMessage((raw) => {
          const message = JSON.parse(String(raw));
          sent.push({ server: n, type: message.type });
          if (message.type === 'device') return;
          if (message.type === 'auth') {
            const ready = () =>
              send({
                type: 'ready',
                protocolVersion: PROTOCOL_VERSION,
                version: '0.4.25',
                connectionId: randomUUID(),
                adapter: 'claude-code',
                sessions: [sessions[n - 1]],
                features: [],
              });
            if (slow && n === 2) finishReady = ready;
            else ready();
            return;
          }
          if (message.type === 'session.subscribe')
            send({
              type: 'session.snapshot',
              requestId: message.requestId,
              session: sessions[n - 1],
              mode: 'replace',
              events: events[n - 1],
              firstSequence: 1,
              lastSequence: events[n - 1]!.length,
              hasEarlier: false,
            });
          send({ type: 'response', requestId: message.requestId, ok: true });
        });
      });
    }
    await page.addInitScript(
      ({ device, remote, slow }) => {
        localStorage.setItem('proxy-prefs', JSON.stringify({ sessionBar: { enabled: true } }));
        localStorage.setItem(
          'proxy-account-pool',
          JSON.stringify({ enabled: false, strategy: 'manual', order: [] }),
        );
        const log: string[] = [];
        let saved = {
          activeId: 'a',
          profiles: ['a', 'b'].map((id, i) => ({
            id,
            name: `服务${i + 1}`,
            url: `wss://service${i + 1}.example/ws`,
            fingerprint: '',
            token: 'offline-test-token-1234567890',
            mode: 'remote',
            remember: true,
            autoLogin: true,
          })),
        };
        if (slow) saved.profiles.push({ ...saved.profiles[1]!, id: 'alias', name: '服务2别名' });
        const noop = async () => {};
        const subscription = () => () => {};
        Object.assign(window, {
          testLog: log,
          desktop: {
            dev: true,
            platform: 'win32',
            version: async () => '0.4.25',
            device: async () => device,
            loadProfiles: async () => structuredClone(saved),
            saveProfiles: async (value: typeof saved) => {
              saved = structuredClone(value);
            },
            connectProxy: async ({ profileId }: { profileId: string }) => {
              log.push(`connect:${profileId}`);
              return { url: `ws://127.0.0.1:${profileId === 'a' ? '18891' : '18892'}/ws` };
            },
            disconnectProxy: async (profileId: string) => {
              log.push(`disconnect:${profileId}`);
            },
            probeQuota: async () => null,
            profileSessions: async (id: string) => (id === 'b' || id === 'alias' ? [remote] : []),
            setBusy: async (runs: unknown[], id: string) => {
              if (runs.length) log.push(`busy:${id}`);
            },
            workspaceRoots: async () => [],
            foldersExist: async (paths: string[]) => paths.map(() => true),
            gitBranch: async () => null,
            loadDrafts: async () => ({}),
            saveDrafts: noop,
            loadSchedules: async () => ({ path: '', text: '{"tasks":[]}' }),
            saveSchedules: noop,
            onSchedulesChanged: subscription,
            onSharedChanged: subscription,
            saveShared: noop,
            onNotifyClicked: subscription,
            onUpdateProgress: subscription,
            notify: noop,
          },
        });
      },
      { device, remote: sessions[1]!, slow },
    );
    await page.goto('/');
    await expect(page.getByRole('button', { name: /任务2 · 服务2/ })).toBeVisible();
    await page.getByRole('button', { name: /任务1 · 服务1/ }).click();
    const quota = page.getByRole('button', { name: '当前账号剩余额度' });
    await expect(quota).toHaveText('5 小时剩余 80% · 周剩余 60%');
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('服务器1的草稿');
    await page.getByRole('button', { name: /任务2 · 服务2/ }).click();
    if (slow) {
      await expect(page.getByText('正在打开会话…', { exact: false })).toBeVisible();
      await expect(page.getByText('服务器1正在运行', { exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toHaveCount(0);
      await expect.poll(() => !!finishReady).toBe(true);
      finishReady!();
    }
    await expect(page.getByText('服务器2正在运行', { exact: true })).toBeVisible();
    await expect(quota).toHaveText('5 小时剩余 40% · 周剩余 20%');
    await expect(page.getByRole('heading', { name: '连接代理服务', exact: true })).toHaveCount(0);
    await input.fill('服务器2的草稿');
    const background = event(0, '切换后任务1仍继续输出');
    events[0]!.push(background);
    pushers.get(1)!({ type: 'session.event', event: background });
    const backgroundQuota = quotaEvent(0, 50, 45);
    events[0]!.push(backgroundQuota);
    pushers.get(1)!({ type: 'session.event', event: backgroundQuota });
    await expect(quota).toHaveText('5 小时剩余 40% · 周剩余 20%');
    await page.getByRole('button', { name: /任务1 · 服务1/ }).click();
    await expect(page.getByText('切换后任务1仍继续输出', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('服务器1的草稿');
    await expect(quota).toHaveText('5 小时剩余 50% · 周剩余 55%');
    await page.getByRole('button', { name: /任务2 · 服务2/ }).click();
    await expect(input).toHaveValue('服务器2的草稿');
    await expect(quota).toHaveText('5 小时剩余 40% · 周剩余 20%');
    await expect
      .poll(async () =>
        page.evaluate(
          async ({ id }) => {
            const { cacheKey, readHistoryCache } = await import('../src/historyCache.ts');
            // Saved fixture profiles remain in the desktop mock; use their exact endpoint identity.
            const values = await window.desktop!.loadProfiles();
            const a = values!.profiles.find((p) => p.id === 'a')!;
            const b = values!.profiles.find((p) => p.id === 'b')!;
            const first = await readHistoryCache(cacheKey(a, id), '0.4.25');
            const second = await readHistoryCache(cacheKey(b, id), '0.4.25');
            return [first?.events.length ?? 0, second?.events.length ?? 0];
          },
          { id: sessions[0]!.id },
        ),
      )
      .toEqual([4, 2]);
    expect(dialogs).toBe(0);
    expect(
      sent.filter((item) =>
        ['run.cancel', 'run.handoff', 'session.create', 'message.send'].includes(item.type),
      ),
    ).toEqual([]);
    const log = await page.evaluate(() => (window as unknown as { testLog: string[] }).testLog);
    expect(log.filter((line) => line.startsWith('connect:'))).toEqual(['connect:a', 'connect:b']);
    expect(log.filter((line) => line.startsWith('disconnect:'))).toEqual([]);
    expect(log).toContain('busy:a');
    expect(log).toContain('busy:b');
    expect(errors).toEqual([]);
  });
