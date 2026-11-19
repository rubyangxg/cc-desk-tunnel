import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import type { Session, SessionEvent } from '@cc-desk-tunnel/protocol';

test('simultaneous service caches survive reopening and a reset drops stale newer events', async ({
  page,
}) => {
  const device = { id: randomUUID(), name: 'cache computer', platform: 'linux' as const };
  const createdAt = new Date().toISOString();
  const session: Session = {
    id: randomUUID(),
    title: 'cache',
    autoTitle: false,
    createdAt,
    updatedAt: createdAt,
    permissionMode: 'default',
    model: null,
    effort: null,
    activeRun: null,
    projectPath: '/project',
    device,
  };
  const generations = [randomUUID(), randomUUID()];
  const history = [0, 1].map((n) =>
    Array.from({ length: 5 }, (_, i): SessionEvent => ({
      sessionId: session.id,
      runId: session.id,
      sequence: i + 1,
      createdAt,
      payload: { type: 'native.notice', text: `server ${n}: ${i + 1}` },
    })),
  );
  let reset = false;
  const cursors: { server: number; afterSequence: number; afterCreatedAt?: string }[] = [];
  for (let n = 0; n < 2; n++)
    await page.routeWebSocket(`ws://127.0.0.1:1890${n}/ws`, (route) => {
      const send = (value: unknown) => route.send(JSON.stringify(value));
      route.onMessage((raw) => {
        const command = JSON.parse(String(raw));
        if (command.type === 'auth') {
          send({
            type: 'ready',
            protocolVersion: PROTOCOL_VERSION,
            connectionId: randomUUID(),
            adapter: 'simulation',
            version: '0.4.58',
            historyId: generations[n],
            sessions: [session],
          });
          return;
        }
        if (command.type === 'device' || command.type === 'leave') return;
        if (command.type === 'session.subscribe') {
          cursors.push({
            server: n,
            afterSequence: command.afterSequence,
            afterCreatedAt: command.afterCreatedAt,
          });
          const events =
            reset && n === 0
              ? [{ ...history[n]![0]!, payload: { type: 'native.notice', text: 'replacement' } }]
              : history[n]!.filter((e) => e.sequence > command.afterSequence);
          send({
            type: 'session.snapshot',
            requestId: command.requestId,
            session,
            events,
            mode: command.afterSequence && !(reset && n === 0) ? 'append' : 'replace',
            firstSequence: events[0]?.sequence ?? 0,
            lastSequence: reset && n === 0 ? 1 : 5,
            hasEarlier: false,
            ...(reset && n === 0 ? { reset: true } : {}),
          });
        }
        send({ type: 'response', requestId: command.requestId, ok: true });
      });
    });
  await page.goto('/');
  const open = async () =>
    page.evaluate(
      async ({ device, id }) => {
        const { ProxyClient } = await import('../src/client.ts');
        const clients = [0, 1].map((n) => {
          const client = new ProxyClient();
          client.connect(
            'ws://127.0.0.1/ws',
            'cache-credential-at-least-24-characters',
            device,
            false,
            async () => `ws://127.0.0.1:1890${n}/ws`,
            `remote-profile-${n}`,
          );
          return client;
        });
        for (const client of clients) {
          if (client.state.status !== 'connected')
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(JSON.stringify(client.state))), 5000);
              const off = client.subscribe(() => {
                if (client.state.status === 'connected') {
                  clearTimeout(timer);
                  off();
                  resolve();
                }
              });
            });
          client.select(id);
          await Promise.race([
            client.waitForHistory(id),
            new Promise((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      JSON.stringify({
                        stage: 'history',
                        state: client.state,
                        pending: [...client.pending.values()].map((p) => p.type),
                      }),
                    ),
                  ),
                5000,
              ),
            ),
          ]);
          await client.disk.stats(); // drain preceding IndexedDB writes
        }
        const values = clients.map((c) => c.state.events[id]?.map((e) => e.payload));
        for (const client of clients) client.disconnect();
        return values;
      },
      { device, id: session.id },
    );
  await open();
  cursors.length = 0;
  const reread = await open();
  expect(cursors).toHaveLength(2);
  expect(cursors.every((c) => c.afterSequence === 5 && c.afterCreatedAt === createdAt)).toBe(true);
  expect(reread[0]).toContainEqual({ type: 'native.notice', text: 'server 0: 5' });
  expect(reread[1]).toContainEqual({ type: 'native.notice', text: 'server 1: 5' });
  reset = true;
  const replaced = await open();
  expect(replaced[0]).toEqual([{ type: 'native.notice', text: 'replacement' }]);
  expect(replaced[1]).toHaveLength(5);
});

test('one very long cached run stays bounded and changing history identity invalidates it', async ({
  page,
}) => {
  await page.goto('/');
  const result = await page.evaluate(async () => {
    const { HistoryCache } = await import('../src/historyCache.ts');
    const cache = new HistoryCache(`bounded-cache-${crypto.randomUUID()}`);
    const id = crypto.randomUUID(),
      createdAt = new Date().toISOString();
    cache.use(crypto.randomUUID());
    cache.write(
      id,
      Array.from({ length: 2005 }, (_, i) => ({
        sessionId: id,
        runId: id,
        sequence: i + 1,
        createdAt,
        payload: { type: 'native.notice' as const, text: 'record' },
      })),
      [0, 2005],
    );
    const latest = await cache.latest(id);
    const earlier = await cache.earlier(id, latest!.events[0]!.sequence);
    cache.use(crypto.randomUUID());
    const invalidated = await cache.latest(id);
    return {
      length: latest!.events.length,
      hasEarlier: latest!.hasEarlier,
      earlier: earlier && 'events' in earlier ? earlier.events.length : 0,
      invalidated,
    };
  });
  expect(result.length).toBe(1000);
  expect(result.hasEarlier).toBe(true);
  expect(result.earlier).toBe(1000);
  expect(result.invalidated).toBeNull();
});
