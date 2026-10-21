import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../src/client.ts';
import { completeHistory } from '../src/sharedHistory.ts';

function fixture(t, respond) {
  const original = globalThis.WebSocket;
  const requests = [];
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: 'archive',
    projectPath: '/project',
    permissionMode: 'auto',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  let socket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    constructor() {
      socket = this;
    }
    send(raw) {
      const request = JSON.parse(raw);
      if (request.requestId) {
        requests.push(request);
        queueMicrotask(() => respond(request, f));
      }
    }
    message(value) {
      this.onmessage({ data: JSON.stringify(value) });
    }
    close() {
      this.onclose?.();
    }
  }
  globalThis.WebSocket = Socket;
  const client = new ProxyClient();
  client.connect('ws://127.0.0.1:1/ws', 'offline-test-token-1234567890', {
    id: randomUUID(),
    name: 'test',
  });
  socket.message({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    version: '0.4.17',
    connectionId: randomUUID(),
    adapter: 'simulation',
    sessions: [session],
  });
  // A selected session can be evicted or still loading in the UI. Archive reads must not depend on it.
  const visible = [];
  client.update({
    selectedId: session.id,
    events: { [session.id]: visible },
    history: {
      [session.id]: {
        firstSequence: 0,
        lastSequence: 0,
        loading: true,
        loadingEarlier: true,
        hasEarlier: true,
      },
    },
  });
  t.after(() => {
    client.disconnect();
    globalThis.WebSocket = original;
  });
  const f = {
    client,
    socket,
    session,
    requests,
    visible,
    reply(request, sequences, hasEarlier = false, { ack = true, changed = false } = {}) {
      const events = sequences.map((sequence) => ({
        sessionId: session.id,
        runId: session.id,
        sequence,
        createdAt: now,
        payload: { type: 'native.notice', text: `event ${sequence}` },
      }));
      socket.message({
        type: 'session.snapshot',
        requestId: request.requestId,
        session: changed
          ? { ...session, updatedAt: new Date(Date.parse(now) + 1000).toISOString() }
          : session,
        mode: request.type === 'session.subscribe' ? 'replace' : 'prepend',
        firstSequence: sequences[0] ?? 0,
        lastSequence: sequences.at(-1) ?? 0,
        hasEarlier,
        events,
      });
      if (ack) socket.message({ type: 'response', requestId: request.requestId, ok: true });
    },
  };
  return f;
}

test('full history progresses beyond sixty seconds without touching the visible cache or its loading flags', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const f = fixture(t, (request, f) => {
    t.mock.timers.setTime(Date.now() + 20000);
    const last = (request.beforeSequence ?? 61) - 1;
    f.reply(
      request,
      Array.from({ length: 10 }, (_, i) => last - 9 + i),
      last > 10,
    );
  });
  const progress = [];
  const all = await completeHistory(f.client, f.session.id, (count) => progress.push(count));
  assert.deepEqual(
    all.map((event) => event.sequence),
    Array.from({ length: 60 }, (_, i) => i + 1),
  );
  assert.deepEqual(progress, [10, 20, 30, 40, 50, 60]);
  assert.equal(Date.now(), 1120000);
  assert.equal(f.client.state.events[f.session.id], f.visible);
  assert.equal(f.client.state.history[f.session.id].loading, true);
  assert.equal(f.client.results.size, 0);
});

for (const changed of [false, true])
  test(`an archive refuses ${changed ? 'a changing conversation' : 'a page whose cursor does not move'}`, async (t) => {
    const f = fixture(t, (request, f) => {
      if (request.type === 'session.subscribe') f.reply(request, [10, 11], true);
      else f.reply(request, changed ? [1, 2] : [10, 11], true, { changed });
    });
    await assert.rejects(
      completeHistory(f.client, f.session.id),
      changed ? /会话已改变/ : /分页未前进/,
    );
    assert.equal(f.requests.length, 2);
  });

test('a timed-out archive read is retried, late replies are ignored and no mutation is sent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const f = fixture(t, (request, f) =>
    f.reply(request, [1], false, { ack: f.requests.length > 1 }),
  );
  const result = completeHistory(f.client, f.session.id);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  await flush();
  assert.equal(f.client.results.size, 1);
  t.mock.timers.tick(30000);
  await flush();
  assert.equal(f.client.results.size, 0);
  f.reply(f.requests[0], [999]); // The timed-out request cannot populate the retry's result.
  t.mock.timers.tick(500);
  assert.deepEqual(
    (await result).map((event) => event.sequence),
    [1],
  );
  assert.deepEqual(
    f.requests.map((request) => request.type),
    ['session.subscribe', 'session.subscribe'],
  );
  assert.equal(f.client.results.size, 0);
});

test('a connection change aborts an archive rather than joining two snapshots', async (t) => {
  const f = fixture(t, (request, f) => {
    f.reply(request, [1]);
    f.client.update({ connectionId: randomUUID() });
  });
  await assert.rejects(completeHistory(f.client, f.session.id), /连接已改变/);
  assert.equal(f.requests.length, 1);
});

test('a permanently stalled history read stops after three attempts and releases captured pages', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  const f = fixture(t, (request, f) => f.reply(request, [1], false, { ack: false }));
  const failure = assert.rejects(completeHistory(f.client, f.session.id), /读取会话历史超时/);
  const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    await flush();
    t.mock.timers.tick(30000);
    await flush();
    if (attempt < 2) t.mock.timers.tick(500 * (attempt + 1));
  }
  await failure;
  assert.equal(f.requests.length, 3);
  assert.equal(f.client.results.size, 0);
  assert.equal(f.client.pending.size, 0);
});
