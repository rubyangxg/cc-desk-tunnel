import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient, RequestInterruptedError } from '../src/client.ts';

async function fixture(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const original = globalThis.WebSocket;
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 1;
    sent = [];
    constructor() {
      sockets.push(this);
    }
    send(raw) {
      this.sent.push(JSON.parse(raw));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    message(message) {
      this.onmessage({ data: JSON.stringify(message) });
    }
  }
  globalThis.WebSocket = Socket;
  const client = new ProxyClient();
  let bridges = 0;
  const url = 'ws://127.0.0.1:1/ws';
  client.connect(
    url,
    'test-token-with-enough-characters',
    { id: randomUUID(), name: 'test' },
    true,
    async () => {
      bridges++;
      return url;
    },
  );
  await Promise.resolve();
  const ready = (sessions = []) =>
    sockets.at(-1).message({
      type: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      version: '0.4.17',
      connectionId: randomUUID(),
      adapter: 'claude-code',
      sessions,
    });
  ready();
  t.after(() => {
    client.disconnect();
    globalThis.WebSocket = original;
  });
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
  };
  return { client, sockets, ready, advance, bridges: () => bridges };
}

test('a restarted service is retried with bounded backoff, fresh bridges and no duplicate immediate retry', async (t) => {
  const f = await fixture(t);
  f.sockets.at(-1).message({ type: 'service.update', state: 'restarting', latest: '0.4.17' });
  f.sockets.at(-1).close();
  assert.equal(f.client.state.status, 'reconnecting');
  assert.equal(f.client.state.update.state, 'restarting');
  assert.equal(f.client.state.error, null);
  for (const [index, delay] of [1000, 2000, 4000, 8000, 10000, 10000].entries()) {
    assert.equal(f.client.state.retry.nextAt - Date.now(), delay);
    await f.advance(delay - 1);
    assert.equal(f.bridges(), index + 1);
    await f.advance(1);
    assert.equal(f.bridges(), index + 2);
    assert.deepEqual(f.client.state.retry, { attempt: index + 1, nextAt: null });
    f.client.retryNow(); // A network-online event while connecting must not start a second bridge.
    assert.equal(f.bridges(), index + 2);
    f.sockets
      .at(-1)
      .message({ type: 'connection.error', code: 'connection_lost', message: '服务重启中' });
  }
  f.client.retryNow();
  f.client.retryNow();
  await Promise.resolve();
  assert.equal(f.bridges(), 8);
  f.ready();
  assert.equal(f.client.state.status, 'connected');
  assert.equal(f.client.state.retry, null);
  assert.equal(f.client.state.error, null);
  assert.equal(f.client.state.update, null);
  await f.advance(20000);
  assert.equal(f.bridges(), 8);
  f.sockets.at(-1).close();
  assert.equal(f.client.state.retry.nextAt - Date.now(), 1000);
});

test('reconnection reloads the selected session and terminal task state without replaying an unacknowledged send', async (t) => {
  const f = await fixture(t);
  const now = new Date().toISOString();
  const session = {
    id: randomUUID(),
    title: 'restart',
    projectPath: '/work',
    permissionMode: 'auto',
    createdAt: now,
    updatedAt: now,
    activeRun: null,
  };
  f.client.update({
    sessions: [{ ...session, activeRun: { id: randomUUID(), status: 'running' } }],
  });
  f.client.select(session.id);
  const pending = f.client
    .request({ type: 'message.send', sessionId: session.id, text: 'send once' })
    .catch((error) => error);
  f.sockets.at(-1).close();
  assert.ok((await pending) instanceof RequestInterruptedError);
  await f.advance(1000);
  f.ready([session]);
  const socket = f.sockets.at(-1);
  const subscribe = socket.sent.find((message) => message.type === 'session.subscribe');
  assert.equal(subscribe.sessionId, session.id);
  socket.message({
    type: 'session.snapshot',
    requestId: subscribe.requestId,
    session,
    events: [],
    mode: 'replace',
    firstSequence: 0,
    lastSequence: 0,
    hasEarlier: false,
  });
  socket.message({ type: 'response', requestId: subscribe.requestId, ok: true });
  assert.equal(f.client.state.selectedId, session.id);
  assert.equal(f.client.state.sessions[0].activeRun, null);
  assert.equal(f.client.state.history[session.id].loading, false);
  assert.equal(
    f.sockets.flatMap((socket) => socket.sent).filter((message) => message.type === 'message.send')
      .length,
    1,
  );
});

for (const code of ['unauthorized', 'client_failed', 'version_mismatch']) {
  test(`a ${code} failure after reconnect stops retrying and preserves the reason`, async (t) => {
    const f = await fixture(t);
    f.sockets.at(-1).close();
    await f.advance(1000);
    f.sockets.at(-1).message({ type: 'connection.error', code, message: '需要处理配置' });
    assert.equal(f.client.state.status, 'disconnected');
    assert.equal(f.client.state.retry, null);
    assert.equal(f.client.state.error, '需要处理配置');
    f.client.retryNow();
    await f.advance(60000);
    assert.equal(f.bridges(), 2);
  });
}

test('disconnect cancels retries and ignores a bridge that finishes after cancellation', async (t) => {
  const f = await fixture(t);
  f.sockets.at(-1).close();
  f.client.disconnect();
  await f.advance(60000);
  assert.equal(f.bridges(), 1);
  assert.equal(f.client.state.retry, null);
  let finish;
  f.client.connect(
    'ws://127.0.0.1:1/ws',
    'test-token-with-enough-characters',
    { id: randomUUID(), name: 'test' },
    true,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.client.disconnect();
  finish('ws://127.0.0.1:1/ws');
  await Promise.resolve();
  assert.equal(f.sockets.length, 1);
  assert.equal(f.client.state.status, 'disconnected');
});
