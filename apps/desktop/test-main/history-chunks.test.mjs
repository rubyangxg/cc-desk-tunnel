import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import { ProxyClient, RequestTimeoutError } from '../src/client.ts';

function fixture(t, features = ['chunked-history']) {
  const original = globalThis.WebSocket;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() {
      Socket.current = this;
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
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
  client.connect('ws://127.0.0.1:1/ws', 'offline-test-token-with-enough-characters');
  const socket = Socket.current;
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: 'history',
    projectPath: '/project',
    permissionMode: 'auto',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  socket.message({
    type: 'ready',
    protocolVersion: PROTOCOL_VERSION,
    version: '0.4.44',
    connectionId: randomUUID(),
    adapter: 'simulation',
    features,
    sessions: [session],
  });
  t.after(() => {
    client.disconnect();
    globalThis.WebSocket = original;
  });
  function parts(request, text = '历史🧩'.repeat(20000)) {
    const snapshot = {
      type: 'session.snapshot',
      requestId: request.requestId,
      session,
      events: [
        {
          sessionId: session.id,
          runId: randomUUID(),
          sequence: 1,
          createdAt: now,
          payload: { type: 'native.notice', text },
        },
      ],
      mode: 'replace',
      firstSequence: 1,
      lastSequence: 1,
      hasEarlier: false,
    };
    const raw = JSON.stringify(snapshot);
    // Deliberately split UTF-16 surrogate pairs too; reassembly must preserve the original string.
    const size = 10001;
    return {
      snapshot,
      frames: Array.from({ length: Math.ceil(raw.length / size) }, (_, index) => ({
        type: 'session.snapshot.part',
        requestId: request.requestId,
        sessionId: session.id,
        index,
        total: Math.ceil(raw.length / size),
        data: raw.slice(index * size, (index + 1) * size),
      })),
    };
  }
  return { client, socket, session, parts };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('chunked reads renew the idle timeout as bytes arrive and reconstruct Unicode exactly', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const progress = [];
  const result = f.client.fetch(
    { type: 'session.subscribe', sessionId: f.session.id, afterSequence: 0 },
    (received, total) => progress.push([received, total]),
  );
  const request = f.socket.sent.at(-1);
  assert.equal(request.chunked, true);
  const { snapshot, frames } = f.parts(request);
  for (const frame of frames) {
    t.mock.timers.tick(20000);
    f.socket.message(frame);
    await flush();
  }
  f.socket.message({ type: 'response', requestId: request.requestId, ok: true });
  assert.deepEqual(await result, serverMessageSchema.parse(snapshot));
  assert.equal(progress.length, frames.length);
  assert.equal(f.client.results.size, 0);
  assert.equal(f.client.historyParts.size, 0);
  assert.equal(f.client.pending.size, 0);
});

for (const fault of ['order', 'session', 'body'])
  test(`invalid history ${fault} rejects only the read and leaves the connection usable`, async (t) => {
    const f = fixture(t);
    const result = assert.rejects(
      f.client.fetch({ type: 'session.subscribe', sessionId: f.session.id, afterSequence: 0 }),
      /历史分片/,
    );
    const { frames } = f.parts(f.socket.sent.at(-1));
    if (fault === 'order') f.socket.message(frames[1]);
    if (fault === 'session') f.socket.message({ ...frames[0], sessionId: randomUUID() });
    if (fault === 'body') {
      for (const frame of frames) f.socket.message({ ...frame, data: 'x' });
    }
    await result;
    assert.equal(f.client.state.status, 'connected');
    assert.equal(f.client.historyParts.size, 0);
    assert.equal(f.client.pending.size, 0);
  });

test('a stalled chunk stream expires and late pieces cannot revive it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t);
  const result = assert.rejects(
    f.client.fetch({ type: 'session.subscribe', sessionId: f.session.id, afterSequence: 0 }),
    RequestTimeoutError,
  );
  const request = f.socket.sent.at(-1);
  const { frames } = f.parts(request);
  f.socket.message(frames[0]);
  t.mock.timers.tick(30000);
  await result;
  for (const frame of frames.slice(1)) f.socket.message(frame);
  f.socket.message({ type: 'response', requestId: request.requestId, ok: true });
  assert.equal(f.client.results.size, 0);
  assert.equal(f.client.historyParts.size, 0);
});

test('old servers receive ordinary read commands and mutations never opt in to history transport', async (t) => {
  const f = fixture(t, []);
  const result = f.client.fetch({
    type: 'session.history',
    sessionId: f.session.id,
    beforeSequence: 2,
  });
  const request = f.socket.sent.at(-1);
  assert.equal(request.chunked, undefined);
  f.socket.message(f.parts(request, 'old server').snapshot);
  f.socket.message({ type: 'response', requestId: request.requestId, ok: true });
  await result;
  f.client.update({ features: ['chunked-history'] });
  const write = f.client.request({ type: 'run.cancel', sessionId: f.session.id });
  const stop = f.socket.sent.at(-1);
  assert.equal(stop.chunked, undefined);
  f.socket.message({ type: 'response', requestId: stop.requestId, ok: true });
  await write;
});

test('visible chunked snapshots preserve newer live events and session state received during transfer', async (t) => {
  const f = fixture(t);
  f.client.select(f.session.id);
  const request = f.socket.sent.at(-1);
  const { snapshot, frames } = f.parts(request);
  f.socket.message(frames[0]);
  const newer = {
    ...f.session,
    updatedAt: new Date(Date.parse(f.session.updatedAt) + 1000).toISOString(),
    title: 'new title',
  };
  const event = {
    ...snapshot.events[0],
    sequence: 2,
    payload: { type: 'native.notice', text: 'arrived during transfer' },
  };
  f.socket.message({ type: 'session.updated', session: newer });
  f.socket.message({ type: 'session.event', event });
  for (const frame of frames.slice(1)) f.socket.message(frame);
  f.socket.message({ type: 'response', requestId: request.requestId, ok: true });
  await flush();
  assert.deepEqual(f.client.state.events[f.session.id], [...snapshot.events, event]);
  assert.equal(f.client.state.sessions[0].title, 'new title');
  assert.equal(f.client.state.history[f.session.id].lastSequence, 2);
});
