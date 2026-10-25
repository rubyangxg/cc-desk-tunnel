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
