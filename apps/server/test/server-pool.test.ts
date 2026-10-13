import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION, serverMessageSchema } from '@cc-desk-tunnel/protocol';
import type { ServerMessage } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';

// The deployed CLI adapter runs on Unix; Windows is a desktop client in this architecture.
const nativeTest = process.platform === 'win32' ? test.skip : test;

async function fixture(t: TestContext, fail = 'quota') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-pool-integration-')));
  const config = join(dir, 'original');
  mkdirSync(config);
  writeFileSync(
    join(config, 'fixture.json'),
    JSON.stringify({ loggedIn: true, email: 'a@example.test', fail, hours: 1 }),
  );
  const token = randomUUID();
  const log = join(dir, 'calls.jsonl');
  const server = createProxyServer({
    token,
    dataDir: dir,
    reverseProxy: true,
    tunnel: { probe: async () => {} },
    claude: {
      executable: resolve('apps/server/test/fixtures/pool-cli.mjs'),
      environment: {
        CLAUDE_CONFIG_DIR: config,
        POOL_TEST_LOG: log,
        ANTHROPIC_API_KEY: 'offline-provider-key',
      },
    },
  });
  const url = (await server.listen(0)).replace('http', 'ws') + '/ws';
  const socket = new WebSocket(url);
  const messages: ServerMessage[] = [];
  socket.on('message', (raw) =>
    messages.push(serverMessageSchema.parse(JSON.parse(raw.toString()))),
  );
  t.after(async () => {
    socket.terminate();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const wait = async (predicate: (message: ServerMessage) => boolean, timeout = 20000) => {
    for (let i = 0; i < timeout / 10; i++) {
      const found = messages.findIndex(predicate);
      if (found >= 0) return messages.splice(found, 1)[0];
      await delay(10);
    }
    throw new Error(`Timed out: ${JSON.stringify(messages.slice(-5))}`);
  };
  const request = async (command: object) => {
    const requestId = randomUUID();
    socket.send(JSON.stringify({ ...command, requestId }));
    const reply = await wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    );
    assert.ok(reply.type === 'response' && reply.ok, JSON.stringify(reply));
    return reply as Extract<ServerMessage, { type: 'response' }>;
  };
  await once(socket, 'open');
  socket.send(
    JSON.stringify({
      type: 'auth',
      protocolVersion: PROTOCOL_VERSION,
      token,
      deviceName: 'pool test',
      tunnel: true,
    }),
  );
  socket.send(JSON.stringify({ type: 'device', id: randomUUID(), platform: 'linux' }));
  const ready = await wait((message) => message.type === 'ready');
  assert.equal(ready.type, 'ready');
  assert.ok(ready.type === 'ready' && ready.features?.includes('account-pool'));
  const offer = await wait((message) => message.type === 'tunnel.offer');
  socket.send(
    JSON.stringify({
      type: 'tunnel.credentials',
      connectionId: offer.type === 'tunnel.offer' && offer.connectionId,
      username: 'test',
      privateKey: 'unused offline test key',
      hostPublicKey: 'ssh-ed25519 AAAA',
    }),
  );
  await wait((message) => message.type === 'tunnel.ready');
  await request({ type: 'pool.add', name: 'B' });
  const added = await wait(
    (message) => message.type === 'pool.state' && message.accounts.length === 2,
  );
  assert.equal(added.type, 'pool.state');
  const id = added.type === 'pool.state' ? added.accounts[1].id : '';
  writeFileSync(
    join(dir, 'accounts', id, 'config', 'fixture.json'),
    JSON.stringify({ loggedIn: true, email: 'b@example.test', hours: 2 }),
  );
  await request({ type: 'pool.configure', values: { enabled: true } });
  await request({ type: 'pool.status', refresh: true });
  await wait(
    (message) =>
      message.type === 'pool.state' &&
      !message.refreshing &&
      message.accounts.every((account) => account.limits?.available),
  );
  return { dir, config, server, socket, messages, request, wait, id, log };
}

nativeTest(
  'one connection rotates isolated CLI accounts inside the same session and resumes the new native history',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await f.request({ type: 'settings.update', accountId: f.id, values: { language: 'chinese' } });
    await f.request({ type: 'settings.get', accountId: f.id });
    await f.wait(
      (message) => message.type === 'settings.state' && message.values.language === 'chinese',
    );
    await f.request({ type: 'settings.get', accountId: 'default' });
    await f.wait(
      (message) => message.type === 'settings.state' && message.values.language === null,
    );
    const created = await f.request({
      type: 'session.create',
      title: 'one task',
      projectPath: '/local/project',
    });
    const sessionId = created.sessionId!;
    await f.request({
      type: 'message.send',
      sessionId,
      text: 'finish this task without repeating completed edits',
    });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.sessionId === sessionId &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
    );
    const session = f.server.store.get(sessionId).session;
    assert.equal(session.accountId, f.id);
    assert.equal(f.server.store.list().length, 1);
    assert.equal(session.projectPath, '/local/project');
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].directory, calls[1].directory);
    assert.equal(calls[1].apiKeyPresent, false);
    assert.ok(calls[1].prompt.includes('账号池续接'));
    assert.ok(calls[1].prompt.includes('finish this task'));
    const nativeId = calls[1].sessionId;
    await f.request({ type: 'message.send', sessionId, text: 'another turn' });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
    );
    const last = JSON.parse(readFileSync(f.log, 'utf8').trim().split('\n').at(-1)!);
    assert.equal(last.sessionId, nativeId, JSON.stringify(last));
    assert.equal(last.prompt, 'another turn');
    const events = f.server.store.snapshot(sessionId).events;
    assert.equal(events.filter((event) => event.payload.type === 'message.user').length, 2);
    assert.ok(
      events.some(
        (event) =>
          event.payload.type === 'native.notice' && event.payload.text.includes('账号池续接'),
      ),
    );
  },
);

nativeTest(
  'enabling the pool during a running task applies before and after quota rejection',
  { timeout: 60000 },
  async (t) => {
    for (const alreadyRejected of [false, true]) {
      await t.test(
        alreadyRejected ? 'already waiting for quota' : 'before quota is rejected',
        async (t) => {
          const f = await fixture(t);
          await f.request({ type: 'pool.configure', values: { enabled: false } });
          const file = join(f.config, 'fixture.json');
          if (!alreadyRejected)
            writeFileSync(
              file,
              JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pauseBeforeQuota: true }),
            );
          const { sessionId } = await f.request({
            type: 'session.create',
            title: 'enable while running',
            projectPath: '/local/project',
          });
          await f.request({ type: 'message.send', sessionId, text: 'finish this task' });
          await f.wait(
            (message) =>
              message.type === 'session.event' &&
              (alreadyRejected
                ? message.event.payload.type === 'run.error' &&
                  message.event.payload.code === 'quota_five_hour'
                : message.event.payload.type === 'native.session'),
          );
          await f.request({ type: 'pool.configure', values: { enabled: true } });
          if (!alreadyRejected)
            writeFileSync(
              file,
              JSON.stringify({
                ...JSON.parse(readFileSync(file, 'utf8')),
                pauseBeforeQuota: false,
              }),
            );
          await f.wait(
            (message) =>
              message.type === 'session.event' &&
              message.event.payload.type === 'run.status' &&
              message.event.payload.status === 'completed',
            10000,
          );
          assert.equal(f.server.store.get(sessionId!).session.accountId, f.id);
          assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 2);
        },
      );
    }
  },
);

nativeTest(
  'an unknown tool result blocks automatic cross-account replay',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t, 'unknown');
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'uncertain task',
      projectPath: '/local/project',
    });
    await f.request({ type: 'message.send', sessionId, text: 'do work once' });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'failed',
    );
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
    assert.equal(f.server.store.get(sessionId!).session.accountId, 'default');
  },
);

nativeTest(
  'all exhausted accounts pause and stopping the task cancels the wait',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await f.request({ type: 'pool.account.update', accountId: f.id, enabled: false });
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'wait task',
      projectPath: '/local/project',
    });
    await f.request({ type: 'message.send', sessionId, text: 'finish later' });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'native.notice' &&
        message.event.payload.text.includes('任务已暂停'),
    );
    await f.request({
      type: 'run.cancel',
      sessionId,
      runId: f.server.store.get(sessionId!).session.activeRun!.id,
    });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'cancelled',
      2000,
    );
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
  },
);

nativeTest(
  'an exhausted account resumes its existing native context after quota recovery',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    await f.request({ type: 'pool.account.update', accountId: f.id, enabled: false });
    const file = join(f.config, 'fixture.json');
    writeFileSync(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), resetSeconds: 1 }),
    );
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'recover task',
      projectPath: '/local/project',
    });
    await f.request({ type: 'message.send', sessionId, text: 'finish after reset' });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'native.notice' &&
        message.event.payload.text.includes('任务已暂停'),
    );
    writeFileSync(file, JSON.stringify({ loggedIn: true, email: 'a@example.test' }));
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
      45000,
    );
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    assert.equal(f.server.store.get(sessionId!).session.accountId, 'default');
  },
);
