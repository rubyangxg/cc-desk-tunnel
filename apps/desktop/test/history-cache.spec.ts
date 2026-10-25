import { test, expect } from '@playwright/test';

test('incremental disk cache survives reopening, isolates endpoints and bridges only proven history ranges', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { cacheKey, readHistoryCache, saveHistoryCache } = await import('../src/historyCache.ts');
    const { completeHistory } = await import('../src/sharedHistory.ts');
    const profile = {
      id: 'cache-test',
      url: 'wss://cache.example/ws',
      fingerprint: 'abc',
      name: 'cache',
      token: '',
      mode: 'remote' as const,
      remember: true,
      autoLogin: true,
    };
    const session = {
      id: crypto.randomUUID(),
      title: 'cached',
      updatedAt: new Date().toISOString(),
    };
    const key = cacheKey(profile, session.id);
    const events = Array.from({ length: 160 }, (_, i) => ({
      sessionId: session.id,
      runId: session.id,
      sequence: i + 1,
      createdAt: session.updatedAt,
      payload: { type: 'native.notice' as const, text: `event ${i + 1}` },
    }));
    await saveHistoryCache(key, '0.4.26', events.slice(0, 50), false);
    await saveHistoryCache(key, '0.4.26', events.slice(39, 100), true);
    const merged = await readHistoryCache(key, '0.4.26');
    await saveHistoryCache(key, '0.4.26', events.slice(149), true);
    const gap = await readHistoryCache(key, '0.4.26');
    const other = await readHistoryCache(
      cacheKey({ ...profile, url: 'wss://other.example/ws' }, session.id),
      '0.4.26',
    );
    const upgraded = await readHistoryCache(key, '0.4.27');
    const requests: unknown[] = [];
    const client = {
      state: {
        connectionId: crypto.randomUUID(),
        status: 'connected',
        service: '0.4.26',
        selectedId: session.id,
        sessions: [session],
        events: {},
        history: {},
      },
      fetch: async (command: unknown) => {
        requests.push(command);
        return {
          session,
          mode: 'append',
          firstSequence: 101,
          lastSequence: 101,
          hasEarlier: false,
          events: [events[100]],
        };
      },
    };
    const all = await completeHistory(
      client as unknown as import('../src/client.ts').ProxyClient,
      session.id,
      () => {},
      profile,
    );
    const saved = await readHistoryCache(key, '0.4.26');
    await saveHistoryCache(key, '0.4.26', events.slice(0, 2), false, true);
    const replaced = await readHistoryCache(key, '0.4.26');
    return {
      merged: merged?.events.length,
      earlier: merged?.hasEarlier,
      gap: gap?.events.length,
      other,
      upgraded,
      requests,
      all: all.length,
      saved: saved?.events.length,
      replaced: replaced?.events.length,
    };
  });
  expect(result.merged).toBe(100);
  expect(result.earlier).toBe(false);
  expect(result.gap).toBe(100);
  expect(result.other).toBeNull();
  expect(result.upgraded).toBeNull();
  expect(result.requests).toHaveLength(1);
  expect(result.requests[0]).toMatchObject({ type: 'session.subscribe', afterSequence: 100 });
  expect(result.all).toBe(101);
  expect(result.saved).toBe(101);
  expect(result.replaced).toBe(2);
});

test('each verified page survives a renderer restart and continuation skips persisted pages', async ({
  page,
}) => {
  await page.goto('/');
  const run = async (stage: 'fail' | 'resume') =>
    page.evaluate(async (stage) => {
      const { cacheKey, progressKey, readHistoryCache, saveHistoryCache } =
        await import('../src/historyCache.ts');
      const { completeHistory } = await import('../src/sharedHistory.ts');
      const profile = {
        id: 'restart',
        url: 'wss://restart.example/ws',
        fingerprint: 'pin',
      } as import('../src/connections.ts').ConnectionProfile;
      const session = { id: 'restart-session', updatedAt: '2026-10-25T00:00:00Z' };
      const event = (sequence: number) => ({
        sessionId: session.id,
        runId: 'run',
        sequence,
        createdAt: session.updatedAt,
        payload: { type: 'native.notice' as const, text: String(sequence) },
      });
      const events = (first: number, last: number) =>
        Array.from({ length: last - first + 1 }, (_, i) => event(i + first));
      const commands: { type: string; beforeSequence?: number; afterSequence?: number }[] = [];
      const client = {
        state: {
          status: 'connected',
          connectionId: crypto.randomUUID(),
          service: '0.4.28',
          selectedId: session.id,
          sessions: [session],
          events: {},
          history: {},
        },
        fetch: async (command: (typeof commands)[number]) => {
          commands.push(command);
          if (stage === 'fail' && command.beforeSequence === 11) throw new Error('interrupted');
          const list =
            command.type === 'session.subscribe'
              ? stage === 'fail'
                ? events(21, 30)
                : [event(31)]
              : command.beforeSequence === 21
                ? events(11, 20)
                : events(1, 10);
          return {
            session,
            mode:
              command.type === 'session.subscribe'
                ? stage === 'fail'
                  ? 'replace'
                  : 'append'
                : 'prepend',
            events: list,
            firstSequence: list[0]!.sequence,
            lastSequence: list.at(-1)!.sequence,
            hasEarlier: stage === 'fail',
          };
        },
      };
      let failure = '';
      let count = 0;
      try {
        count = (
          await completeHistory(
            client as unknown as import('../src/client.ts').ProxyClient,
            session.id,
            () => {},
            profile,
          )
        ).length;
      } catch (error) {
        failure = String(error);
      }
      const progress = await readHistoryCache(progressKey(profile, session.id), '0.4.28');
      const cache = await readHistoryCache(cacheKey(profile, session.id), '0.4.28');
      return {
        commands,
        failure,
        count,
        progress: progress?.events.map((e) => e.sequence) ?? null,
        cache: cache?.events.length,
      };
    }, stage);
  const failed = await run('fail');
  expect(failed.failure).toContain('interrupted');
  expect(failed.progress).toEqual(Array.from({ length: 20 }, (_, i) => i + 11));
  await page.reload(); // Clears the module's WeakMap, retaining only IndexedDB.
  const resumed = await run('resume');
  expect(resumed.failure).toBe('');
  expect(resumed.count).toBe(31);
  expect(resumed.commands).toEqual([
    { type: 'session.subscribe', sessionId: 'restart-session', afterSequence: 30 },
    { type: 'session.history', sessionId: 'restart-session', beforeSequence: 11 },
  ]);
  expect(resumed.cache).toBe(31);
  expect(resumed.progress).toBeNull(); // Promoted once; no second permanent copy.
});

test('idle warmup reads one older page, yields to tasks and foreground reads, rejects stale replies', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { cacheKey, readHistoryCache, saveHistoryCache, warmHistoryCache, holdHistoryWarmup } =
      await import('../src/historyCache.ts');
    const profile = {
      id: 'warm',
      url: 'wss://warm.example/ws',
      fingerprint: 'pin',
    } as import('../src/connections.ts').ConnectionProfile;
    const session = {
      id: 'warm-session',
      updatedAt: '2026-10-25T00:00:00Z',
      activeRun: null as object | null,
    };
    const key = cacheKey(profile, session.id);
    const events = Array.from({ length: 30 }, (_, i) => ({
      sessionId: session.id,
      runId: 'run',
      sequence: i + 1,
      createdAt: session.updatedAt,
      payload: { type: 'native.notice' as const, text: String(i + 1) },
    }));
    await saveHistoryCache(key, '0.4.28', events.slice(20), true);
    let reply: ((value: unknown) => void) | undefined;
    const requests: unknown[] = [];
    const state = {
      status: 'connected',
      connectionId: 'first',
      service: '0.4.28',
      selectedId: session.id,
      sessions: [session],
      events: { [session.id]: events.slice(20) },
      history: { [session.id]: { loading: false, loadingEarlier: false } },
    };
    const client = {
      state,
      fetch: (command: unknown) => {
        requests.push(command);
        return new Promise((resolve) => {
          reply = resolve;
        });
      },
    } as unknown as import('../src/client.ts').ProxyClient;
    const untilReply = async () => {
      while (!reply) await new Promise((r) => setTimeout(r, 1));
    };
    const respond = (first: number, last: number, hasEarlier: boolean) => {
      reply!({
        session: { ...session },
        mode: 'prepend',
        firstSequence: first,
        lastSequence: last,
        hasEarlier,
        events: events.slice(first - 1, last),
      });
      reply = undefined;
    };
    session.activeRun = {};
    await warmHistoryCache(client, profile);
    session.activeRun = null;
    const release = holdHistoryWarmup(client);
    await warmHistoryCache(client, profile);
    release();
    const skipped = requests.length;
    const pending = warmHistoryCache(client, profile);
    await untilReply();
    const busy = await warmHistoryCache(client, profile);
    respond(11, 20, true);
    const first = await pending;
    const cached = await readHistoryCache(key, '0.4.28');
    const stale = warmHistoryCache(client, profile);
    await untilReply();
    state.connectionId = 'reconnected';
    respond(1, 10, false);
    const staleSaved = await stale;
    const afterStale = await readHistoryCache(key, '0.4.28');
    const finish = warmHistoryCache(client, profile);
    await untilReply();
    respond(1, 10, false);
    await finish;
    await warmHistoryCache(client, profile); // Complete cache: no more network reads.
    const full = await readHistoryCache(key, '0.4.28');
    return {
      skipped,
      busy,
      first,
      staleSaved,
      partial: cached?.events.length,
      afterStale: afterStale?.events.length,
      full: full?.events.length,
      hasEarlier: full?.hasEarlier,
      requests,
      selected: state.selectedId,
      visible: state.events[session.id]!.length,
    };
  });
  expect(result.skipped).toBe(0);
  expect(result.busy).toBe('busy');
  expect(result.first).toBe(true);
  expect(result.staleSaved).toBe(false);
  expect(result.partial).toBe(20);
  expect(result.afterStale).toBe(20);
  expect(result.full).toBe(30);
  expect(result.hasEarlier).toBe(false);
  expect(result.requests).toEqual(
    [21, 11, 11].map((beforeSequence) => ({
      type: 'session.history',
      sessionId: 'warm-session',
      beforeSequence,
    })),
  );
  expect(result.selected).toBe('warm-session');
  expect(result.visible).toBe(10);
});

test('background worker spaces pages, backs off errors and stops cleanly', async ({ page }) => {
  await page.goto('/');
  await page.clock.install({ time: new Date('2026-10-25T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-10-25T00:00:01Z'));
  await page.evaluate(async () => {
    const { startHistoryCache } = await import('../src/historyCache.ts');
    const profile = {
      id: 'worker',
      url: 'wss://worker.example/ws',
      fingerprint: 'pin',
    } as import('../src/connections.ts').ConnectionProfile;
    const session = { id: 'worker-session', updatedAt: '2026-10-25T00:00:00Z', activeRun: null };
    const events = Array.from({ length: 30 }, (_, i) => ({
      sessionId: session.id,
      runId: 'run',
      sequence: i + 1,
      createdAt: session.updatedAt,
      payload: { type: 'native.notice' as const, text: String(i + 1) },
    }));
    const requests: { beforeSequence: number }[] = [];
    const state = {
      status: 'connected',
      connectionId: 'connection',
      service: '0.4.28',
      selectedId: session.id,
      sessions: [session],
      events: { [session.id]: events.slice(20) },
      history: {
        [session.id]: {
          loading: false,
          loadingEarlier: false,
          hasEarlier: true,
          firstSequence: 21,
          lastSequence: 30,
        },
      },
    };
    const client = {
      state,
      fetch: async (command: { beforeSequence: number }) => {
        requests.push(command);
        if (requests.length === 1) throw new Error('temporary network failure');
        const first = command.beforeSequence - 10;
        return {
          session,
          mode: 'prepend',
          firstSequence: first,
          lastSequence: command.beforeSequence - 1,
          hasEarlier: first > 1,
          events: events.slice(first - 1, command.beforeSequence - 1),
        };
      },
    } as unknown as import('../src/client.ts').ProxyClient;
    Object.assign(window, { warmWorker: { requests, stop: startHistoryCache(client, profile) } });
  });
  const count = () =>
    page.evaluate(
      () =>
        (window as unknown as { warmWorker: { requests: unknown[] } }).warmWorker.requests.length,
    );
  await page.clock.runFor(5000);
  expect(await count()).toBe(0);
  await page.clock.runFor(5000);
  await expect.poll(count).toBe(1);
  await page.clock.runFor(55000);
  expect(await count()).toBe(1);
  await page.clock.runFor(5000);
  await expect.poll(count).toBe(2);
  await page.clock.runFor(5000);
  expect(await count()).toBe(2);
  await page.evaluate(() =>
    (window as unknown as { warmWorker: { stop: () => void } }).warmWorker.stop(),
  );
  await page.clock.runFor(60000);
  expect(await count()).toBe(2);
});

test('a small newer checkpoint outranks a large older cache and joins it only across a verified gap', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { cacheKey, progressKey, saveHistoryCache } = await import('../src/historyCache.ts');
    const { completeHistory } = await import('../src/sharedHistory.ts');
    const profile = {
      id: 'gap',
      url: 'wss://gap.example/ws',
      fingerprint: 'pin',
    } as import('../src/connections.ts').ConnectionProfile;
    const session = { id: 'gap-session', updatedAt: '2026-10-25T00:00:00Z' };
    const events = Array.from({ length: 220 }, (_, i) => ({
      sessionId: session.id,
      runId: 'run',
      sequence: i + 1,
      createdAt: session.updatedAt,
      payload: { type: 'native.notice' as const, text: String(i + 1) },
    }));
    await saveHistoryCache(cacheKey(profile, session.id), '0.4.28', events.slice(0, 100), false);
    await saveHistoryCache(progressKey(profile, session.id), '0.4.28', events.slice(210), true);
    const requests: { type: string; afterSequence?: number; beforeSequence?: number }[] = [];
    const client = {
      state: {
        status: 'connected',
        connectionId: 'fresh-connection',
        service: '0.4.28',
        selectedId: session.id,
        sessions: [session],
        events: {},
        history: {},
      },
      fetch: async (command: (typeof requests)[number]) => {
        requests.push(command);
        return command.type === 'session.subscribe'
          ? {
              session,
              mode: 'append',
              firstSequence: 0,
              lastSequence: 220,
              hasEarlier: false,
              events: [],
            }
          : {
              session,
              mode: 'prepend',
              firstSequence: 91,
              lastSequence: 210,
              hasEarlier: true,
              events: events.slice(90, 210),
            };
      },
    } as unknown as import('../src/client.ts').ProxyClient;
    const all = await completeHistory(client, session.id, () => {}, profile);
    return { requests, sequences: all.map((e) => e.sequence) };
  });
  expect(result.requests).toEqual([
    { type: 'session.subscribe', sessionId: 'gap-session', afterSequence: 220 },
    { type: 'session.history', sessionId: 'gap-session', beforeSequence: 211 },
  ]);
  expect(result.sequences).toEqual(Array.from({ length: 220 }, (_, i) => i + 1));
});
