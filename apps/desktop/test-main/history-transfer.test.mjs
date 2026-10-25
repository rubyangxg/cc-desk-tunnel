import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PROTOCOL_VERSION, eventSchema } from '@cc-desk-tunnel/protocol';
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
    reply(
      request,
      sequences,
      hasEarlier = false,
      { ack = true, changed = false, mode, lastSequence } = {},
    ) {
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
        mode: mode ?? (request.type === 'session.subscribe' ? 'replace' : 'prepend'),
        firstSequence: sequences[0] ?? 0,
        lastSequence: lastSequence ?? sequences.at(-1) ?? 0,
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

function seed(f, sequences, hasEarlier = false) {
  const events = sequences.map((sequence) =>
    eventSchema.parse({
      sessionId: f.session.id,
      runId: f.session.id,
      sequence,
      createdAt: f.session.createdAt,
      payload: { type: 'native.notice', text: `event ${sequence}` },
    }),
  );
  f.client.update({
    events: { [f.session.id]: events },
    history: {
      [f.session.id]: {
        firstSequence: sequences[0],
        lastSequence: sequences.at(-1),
        hasEarlier,
        loading: false,
        loadingEarlier: false,
      },
    },
  });
  return events;
}
const range = (first, last) => Array.from({ length: last - first + 1 }, (_, i) => first + i);

test('a warm complete transcript downloads only new events and leaves the visible cache unchanged', async (t) => {
  const f = fixture(t, (request, f) => f.reply(request, [101, 102], false, { mode: 'append' }));
  const visible = seed(f, range(1, 100));
  const events = await completeHistory(f.client, f.session.id);
  assert.equal(events.length, 102);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].afterSequence, 100);
  assert.equal(f.client.state.events[f.session.id], visible);
});

test('a partial visible cache fetches missing old pages without redownloading its middle', async (t) => {
  const f = fixture(t, (request, f) =>
    request.type === 'session.subscribe'
      ? f.reply(request, [41], false, { mode: 'append' })
      : f.reply(request, range(1, 20)),
  );
  seed(f, range(21, 40), true);
  assert.equal((await completeHistory(f.client, f.session.id)).length, 41);
  assert.deepEqual(
    f.requests.map((r) => r.afterSequence ?? r.beforeSequence),
    [40, 21],
  );
});

test('a large delta pages until verified overlap, including nonconsecutive sequence numbers', async (t) => {
  const f = fixture(t, (r, f) =>
    f.reply(r, r.type === 'session.subscribe' ? range(61, 70) : range(31, 60), true),
  );
  seed(
    f,
    range(1, 40).filter((n) => n !== 5),
  );
  const events = await completeHistory(f.client, f.session.id);
  assert.deepEqual(
    events.map((e) => e.sequence),
    range(1, 70).filter((n) => n !== 5),
  );
  assert.equal(f.requests.length, 2);
});

test('a successful archive checkpoint makes the next read incremental even when the UI was never loaded', async (t) => {
  const f = fixture(t, (r, f) =>
    f.requests.length === 1
      ? f.reply(r, range(1, 50))
      : f.reply(r, [], false, { mode: 'append', lastSequence: 50 }),
  );
  await completeHistory(f.client, f.session.id);
  await completeHistory(f.client, f.session.id);
  assert.deepEqual(
    f.requests.map((r) => r.afterSequence),
    [0, 50],
  );
  assert.equal(f.client.state.events[f.session.id], f.visible);
});

test('an invalid incremental cursor falls back to a complete read without mixing stale history', async (t) => {
  const f = fixture(t, (r, f) => {
    if (r.afterSequence)
      f.socket.message({
        type: 'response',
        requestId: r.requestId,
        ok: false,
        code: 'invalid_cursor',
        message: '历史游标超出范围。',
      });
    else f.reply(r, [1, 2]);
  });
  seed(f, range(1, 100));
  assert.deepEqual(
    (await completeHistory(f.client, f.session.id)).map((e) => e.sequence),
    [1, 2],
  );
  assert.deepEqual(
    f.requests.map((r) => r.afterSequence),
    [100, 0],
  );
});

test('changed overlapping content is never replaced with a stale cached tool result', async (t) => {
  const f = fixture(t, (r, f) =>
    f.reply(
      r,
      r.type === 'session.subscribe' ? range(31, 60) : range(1, 30),
      r.type === 'session.subscribe',
    ),
  );
  const stale = seed(f, range(1, 40));
  stale.at(-1).payload.text = 'outdated';
  const events = await completeHistory(f.client, f.session.id);
  assert.equal(events.length, 60);
  assert.equal(events.find((e) => e.sequence === 40).payload.text, 'event 40');
  assert.equal(f.requests.length, 2);
});

test('retry after a failed older page reuses verified pages and fetches only the missing range', async (t) => {
  let fail = true;
  const f = fixture(t, (r, f) => {
    if (r.type === 'session.subscribe') {
      if (r.afterSequence) f.reply(r, [31], false, { mode: 'append' });
      else f.reply(r, range(21, 30), true);
    } else if (fail) {
      f.socket.message({
        type: 'response',
        requestId: r.requestId,
        ok: false,
        code: 'unavailable',
        message: 'retry later',
      });
    } else f.reply(r, range(1, 20));
  });
  await assert.rejects(completeHistory(f.client, f.session.id), /retry later/);
  fail = false;
  const events = await completeHistory(f.client, f.session.id);
  assert.deepEqual(
    events.map((e) => e.sequence),
    range(1, 31),
  );
  assert.deepEqual(
    f.requests.map((r) => r.afterSequence ?? r.beforeSequence),
    [0, 21, 30, 21],
  );
});
