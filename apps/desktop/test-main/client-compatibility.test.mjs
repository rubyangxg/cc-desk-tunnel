import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { ProxyClient } from '../src/client.ts';

async function fixture(t, protocolVersion, { deny = false, refuseAgain = false } = {}) {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket;
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const seen = [];
  const sockets = [];
  server.on('connection', (socket) => {
    sockets.push(socket);
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      seen.push(message);
      if (message.type === 'auth') {
        if (deny || refuseAgain || message.protocolVersion !== protocolVersion) {
          socket.send(
            JSON.stringify({
              type: 'connection.error',
              code: deny ? 'unauthorized' : 'version_mismatch',
              message: 'Connection refused',
              ...(deny
                ? {}
                : {
                    service:
                      protocolVersion === 19
                        ? '0.4.20'
                        : protocolVersion === 18
                          ? '0.4.10'
                          : protocolVersion === 17
                            ? '0.4.9'
                            : '0.3.1',
                  }),
            }),
          );
          socket.close();
        } else {
          socket.send(
            JSON.stringify({
              type: 'ready',
              protocolVersion,
              version: '0.3.1',
              connectionId: randomUUID(),
              adapter: 'simulation',
              sessions: [],
            }),
          );
        }
      } else if (message.requestId) {
        socket.send(
          JSON.stringify({
            type: 'response',
            requestId: message.requestId,
            ok: true,
            sessionId: randomUUID(),
          }),
        );
      }
    });
  });
  const client = new ProxyClient();
  let bridges = 0;
  const url = `ws://127.0.0.1:${server.address().port}/ws`;
  t.after(async () => {
    client.disconnect();
    globalThis.WebSocket = original;
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  const waitFor = async (status) => {
    const until = Date.now() + 3000;
    while (client.state.status !== status && Date.now() < until)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(client.state.status, status, client.state.error);
  };
  client.connect(
    url,
    'test-only-token-with-enough-characters',
    { id: randomUUID(), name: 'test' },
    false,
    async () => {
      bridges++;
      return url;
    },
  );
  return { client, seen, sockets, waitFor, bridges: () => bridges };
}

for (const version of [16, 17, 18, 19]) {
  test(`connects to protocol ${version}, creates a fresh bridge if needed and sends each command once`, async (t) => {
    const f = await fixture(t, version);
    await f.waitFor('connected');
    assert.equal(f.client.state.serviceProtocol, version);
    assert.equal(f.client.state.mismatch, false);
    assert.deepEqual(
      f.seen.filter((m) => m.type === 'auth').map((m) => m.protocolVersion),
      [PROTOCOL_VERSION, version],
    );
    assert.equal(f.bridges(), 2);
    await f.client.request({ type: 'session.create', title: 'test', projectPath: 'D:\\project' });
    assert.equal(f.seen.filter((m) => m.type === 'session.create').length, 1);
    // A protocol error after readiness is not an invitation to restart/replay work.
    f.sockets.at(-1).send(
      JSON.stringify({
        type: 'connection.error',
        code: 'version_mismatch',
        service: '0.3.1',
        message: 'Refused',
      }),
    );
    await f.waitFor('disconnected');
    assert.equal(f.bridges(), 2);
  });
}

for (const [name, version, options, attempts] of [
  ['wrong token', 16, { deny: true }, [PROTOCOL_VERSION]],
  ['unsupported protocol', 15, {}, [PROTOCOL_VERSION, 16]],
  ['repeated version refusal', 16, { refuseAgain: true }, [PROTOCOL_VERSION, 16]],
]) {
  test(`${name} stops authentication without sending session commands`, async (t) => {
    const f = await fixture(t, version, options);
    await f.waitFor('disconnected');
    assert.deepEqual(
      f.seen.filter((m) => m.type === 'auth').map((m) => m.protocolVersion),
      attempts,
    );
    assert.equal(f.bridges(), attempts.length);
    assert.equal(
      f.seen.some((m) => m.requestId),
      false,
    );
    assert.equal(f.client.state.error, 'Connection refused');
  });
}
