import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from 'node:fs';
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

// The fixture CLI polls its state file during a run, so the file is replaced whole: written beside it, then renamed
// over it. A plain write can be read half-done and fail the run.
function writeFixture(file: string, data: string) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, file);
}

async function fixture(t: TestContext, fail = 'quota') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-pool-integration-')));
  const config = join(dir, 'original');
  mkdirSync(config);
  writeFixture(
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
  writeFixture(
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
    assert.ok(calls[1].prompt.endsWith('\n\ncontinue'));
    const resumed = f.server.store.snapshot(sessionId).events;
    const continues = resumed.filter(
      ({ payload }) => payload.type === 'message.user' && payload.continued,
    );
    assert.equal(continues.length, 1, 'one visible continue is sent after the account switch');
    const continuation = continues[0].payload;
    assert.ok(continuation.type === 'message.user');
    assert.equal(continuation.text, 'continue');
    assert.deepEqual(
      resumed.flatMap(({ payload }) =>
        payload.type === 'message.delivery' && payload.messageId === continuation.messageId
          ? [payload.status]
          : [],
      ),
      ['submitted', 'queued', 'received'],
    );
    assert.ok(
      resumed.some(
        ({ payload }) => payload.type === 'text.delta' && payload.text.includes('b@example.test'),
      ),
      'the second account actually answers without another click or message',
    );
    // A visible session keeps the totals of every account segment after rotating.
    const insertUsage = f.server.store.database.prepare(`INSERT INTO api_requests
      (at, session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
       cost_usd, duration_ms, ttft_ms, source, request_id, prompt_id)
      VALUES (?, ?, 'test-model', 10, ?, 100, 0, 0.1, 1000, 100, 'sdk', ?, ?)`);
    for (const [id, output] of [
      [calls[0].sessionId, 200],
      [calls[1].sessionId, 300],
      [randomUUID(), 9000],
    ] as const)
      insertUsage.run(Date.now(), id, output, randomUUID(), randomUUID());
    await f.request({ type: 'session.stats', sessionId });
    const stats = await f.wait((m) => m.type === 'session.stats' && m.sessionId === sessionId);
    assert.ok(stats.type === 'session.stats');
    assert.equal(stats.requests, 2);
    assert.equal(stats.turns, 2);
    assert.equal(stats.outputTokens, 500, 'both accounts count, unrelated sessions do not');
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
    assert.equal(events.filter((event) => event.payload.type === 'message.user').length, 3);
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
            writeFixture(
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
            writeFixture(
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
    assert.ok(
      f.server.store
        .snapshot(sessionId!)
        .events.some(
          ({ payload }) =>
            payload.type === 'native.notice' &&
            payload.text.includes('自动接力已暂停：工具执行结果未确认'),
        ),
    );
    const pool = await f.request({ type: 'pool.status' });
    assert.ok(pool.ok);
    await f.wait(
      (message) =>
        message.type === 'pool.state' &&
        message.accounts.some(
          (account) => account.id === 'default' && (account.blockedUntil ?? 0) > Date.now(),
        ),
    );
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
    writeFixture(
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
    writeFixture(file, JSON.stringify({ loggedIn: true, email: 'a@example.test' }));
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

nativeTest(
  'project quota reset resumes the same native session once and supports enabling during a run',
  { timeout: 60000 },
  async (t) => {
    for (const late of [false, true])
      await t.test(late ? 'enable after rejection' : 'enable before run', async (t) => {
        const f = await fixture(t);
        await f.request({ type: 'pool.configure', values: { enabled: false } });
        const configFile = join(f.config, 'fixture.json');
        writeFixture(
          configFile,
          JSON.stringify({ ...JSON.parse(readFileSync(configFile, 'utf8')), resetSeconds: 2 }),
        );
        const projectPath = '/local/resume-project';
        if (!late) await f.request({ type: 'project.quotaResume', projectPath, enabled: true });
        const { sessionId } = await f.request({
          type: 'session.create',
          title: 'resume later',
          projectPath,
        });
        await f.request({ type: 'message.send', sessionId, text: 'finish the task' });
        await f.wait(
          (message) =>
            message.type === 'session.event' &&
            message.event.payload.type === 'run.error' &&
            message.event.payload.code === 'quota_five_hour',
        );
        if (late) await f.request({ type: 'project.quotaResume', projectPath, enabled: true });
        const waiting = await f.wait(
          (message) =>
            message.type === 'session.event' &&
            message.event.payload.type === 'native.notice' &&
            message.event.payload.text.includes('随后自动发送 continue'),
        );
        assert.ok(waiting);
        const rejection = f.server.store
          .snapshot(sessionId!)
          .events.find(
            (event) =>
              event.payload.type === 'run.error' && event.payload.code === 'quota_five_hour',
          )!;
        const reset =
          rejection.payload.type === 'run.error' ? Date.parse(rejection.payload.resetsAt!) : 0;
        assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
        writeFixture(configFile, JSON.stringify({ loggedIn: true, email: 'a@example.test' }));
        await f.wait(
          (message) =>
            message.type === 'session.event' &&
            message.event.sessionId === sessionId &&
            message.event.payload.type === 'run.status' &&
            message.event.payload.status === 'completed',
        );
        assert.ok(Date.now() >= reset);
        const calls = readFileSync(f.log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.equal(calls.length, 2);
        assert.equal(calls[1].prompt, 'continue');
        assert.ok(calls[1].at >= reset + 1000);
        assert.equal(calls[1].sessionId, calls[0].sessionId);
        assert.equal(calls[1].directory, calls[0].directory);
        assert.ok(
          calls[1].args.includes('--resume=' + calls[0].sessionId) ||
            calls[1].args.includes('--resume'),
        );
        assert.equal(f.server.store.get(sessionId!).session.accountId, 'default');
        const continued = f.server.store
          .snapshot(sessionId!)
          .events.filter(
            (event) => event.payload.type === 'message.user' && event.payload.text === 'continue',
          );
        assert.equal(continued.length, 1);
      });
  },
);

nativeTest(
  'project quota waiting can be cancelled by its switch or stop without sending continue',
  { timeout: 60000 },
  async (t) => {
    for (const action of ['disable', 'stop'])
      await t.test(action, async (t) => {
        const f = await fixture(t);
        await f.request({ type: 'pool.configure', values: { enabled: false } });
        const projectPath = '/local/cancel-project';
        await f.request({ type: 'project.quotaResume', projectPath, enabled: true });
        const { sessionId } = await f.request({
          type: 'session.create',
          title: 'cancel wait',
          projectPath,
        });
        await f.request({ type: 'message.send', sessionId, text: 'finish later' });
        await f.wait(
          (message) =>
            message.type === 'session.event' &&
            message.event.payload.type === 'native.notice' &&
            message.event.payload.text.includes('随后自动发送 continue'),
        );
        if (action === 'disable')
          await f.request({ type: 'project.quotaResume', projectPath, enabled: false });
        else
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
        assert.equal(f.server.store.get(sessionId!).session.activeRun, null);
        assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
      });
  },
);

nativeTest(
  'project auto continue does not resume unrelated projects or unknown tool results',
  { timeout: 60000 },
  async (t) => {
    for (const unsafe of [false, true])
      await t.test(unsafe ? 'unknown tool result' : 'different project', async (t) => {
        const f = await fixture(t, unsafe ? 'unknown' : 'quota-result');
        await f.request({ type: 'pool.configure', values: { enabled: false } });
        await f.request({
          type: 'project.quotaResume',
          projectPath: '/local/enabled',
          enabled: true,
        });
        const { sessionId } = await f.request({
          type: 'session.create',
          title: 'do not retry',
          projectPath: unsafe ? '/local/enabled' : '/local/disabled',
        });
        await f.request({ type: 'message.send', sessionId, text: 'do work once' });
        await f.wait(
          (message) =>
            message.type === 'session.event' &&
            message.event.payload.type === 'run.status' &&
            message.event.payload.status === 'failed',
        );
        assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
        assert.equal(f.server.store.get(sessionId!).session.activeRun, null);
      });
  },
);

nativeTest(
  'a project switch wakes an existing account-pool quota wait',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    await f.request({ type: 'pool.account.update', accountId: f.id, enabled: false });
    const projectPath = '/local/enable-while-waiting';
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'waiting pool',
      projectPath,
    });
    await f.request({ type: 'message.send', sessionId, text: 'continue after quota' });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'native.notice' &&
        message.event.payload.text.includes('任务已暂停'),
    );
    await f.request({ type: 'project.quotaResume', projectPath, enabled: true });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'native.notice' &&
        message.event.payload.text.includes('随后自动发送 continue'),
      2000,
    );
    await f.request({ type: 'project.quotaResume', projectPath, enabled: false });
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
  'slash commands reach the native CLI unchanged and publish command output and updated catalogs',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, '');
    await f.request({ type: 'pool.configure', values: { enabled: false } });
    const file = join(f.config, 'fixture.json');
    writeFixture(
      file,
      JSON.stringify({
        loggedIn: true,
        email: 'a@example.test',
        commands: [
          { name: 'goal', description: 'Set goal', argumentHint: '<condition>' },
          { name: 'exit', description: 'Exit', argumentHint: '' },
        ],
        terminalCommands: ['exit'],
        commandOutput: 'Goal configured',
        changedCommands: [
          { name: 'goal', description: 'Set goal', argumentHint: '<condition>' },
          { name: 'review', description: 'Review code', argumentHint: '' },
        ],
      }),
    );
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'commands',
      projectPath: '/local/project',
    });
    const text = '/goal 所有测试通过，并修复现有错误';
    await f.request({ type: 'message.send', sessionId, text });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
    );
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].prompt, text);
    assert.equal(
      calls[1].prompt,
      '/goal',
      'completion probes native state without another model turn',
    );
    const events = f.server.store.snapshot(sessionId!).events;
    assert.ok(
      events.some(
        (event) =>
          event.payload.type === 'text.delta' && event.payload.text.includes('Goal configured'),
      ),
    );
    assert.ok(
      events.some(
        (event) =>
          event.payload.type === 'native.notice' && event.payload.text.startsWith('当前目标：'),
      ),
    );
    const catalog = events.findLast(
      (event) => event.payload.type === 'native.capabilities',
    )!.payload;
    assert.equal(catalog.type, 'native.capabilities');
    if (catalog.type === 'native.capabilities') {
      assert.deepEqual(catalog.commands, ['goal', 'review']);
      assert.deepEqual(catalog.terminalCommands, ['exit']);
      assert.equal(catalog.commandDetails?.[0].argumentHint, '<condition>');
    }
    await f.request({ type: 'session.account', sessionId, accountId: f.id });
    const requestId = randomUUID();
    f.socket.send(
      JSON.stringify({ type: 'message.send', sessionId, requestId, text: '/goal keep context' }),
    );
    const rejected = await f.wait(
      (message) => message.type === 'response' && message.requestId === requestId,
    );
    assert.ok(
      rejected.type === 'response' && !rejected.ok && rejected.code === 'command_context_changed',
    );
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 2);
  },
);

nativeTest(
  'pool countdown targets earliest recovery even with project resume enabled and resumes once',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const backup = join(f.dir, 'accounts', f.id, 'config', 'fixture.json');
    const at = Date.now() + 5000;
    writeFixture(
      backup,
      JSON.stringify({
        loggedIn: true,
        email: 'b@example.test',
        blocked: true,
        resetsAt: new Date(at).toISOString(),
      }),
    );
    const projectPath = '/local/earliest';
    await f.request({ type: 'project.quotaResume', projectPath, enabled: true });
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'earliest recovery',
      projectPath,
    });
    await f.request({ type: 'message.send', sessionId, text: 'finish earliest' });
    const waiting = await f.wait(
      (m) =>
        m.type === 'pool.state' &&
        m.quotaWaits?.some((w) => w.sessionId === sessionId && w.accountId === f.id) === true,
    );
    assert.ok(waiting.type === 'pool.state');
    assert.equal(waiting.quotaWaits![0].at, at);
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
    // A successful quota observation is available when the scheduled check fires.
    writeFixture(
      backup,
      JSON.stringify({
        loggedIn: true,
        email: 'b@example.test',
        resetsAt: new Date(at).toISOString(),
      }),
    );
    await f.wait(
      (m) =>
        m.type === 'session.event' &&
        m.event.sessionId === sessionId &&
        m.event.payload.type === 'run.status' &&
        m.event.payload.status === 'completed',
    );
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.ok(calls[1].at >= at + 1000);
    assert.equal(calls[1].directory, join(f.dir, 'accounts', f.id, 'config'));
    assert.match(calls[1].prompt, /finish earliest/);
    assert.notEqual(calls[1].sessionId, calls[0].sessionId);
    assert.equal(
      f.server.store
        .snapshot(sessionId!)
        .events.filter((e) => e.payload.type === 'message.user' && e.payload.text === 'continue')
        .length,
      1,
    );
    f.messages.splice(0);
    await f.request({ type: 'pool.status' });
    const done = await f.wait((m) => m.type === 'pool.state');
    assert.ok(done.type === 'pool.state');
    assert.deepEqual(done.quotaWaits, []);
  },
);

nativeTest('global instructions are isolated by account', async (t) => {
  const f = await fixture(t);
  writeFileSync(join(f.config, 'CLAUDE.md'), 'Default account instructions');
  await f.request({ type: 'instructions.get', accountId: f.id });
  const state = await f.wait((m) => m.type === 'instructions.state');
  assert.ok(state.type === 'instructions.state');
  assert.equal(state.text, '');
  await f.request({
    type: 'instructions.update',
    accountId: f.id,
    text: 'Second account instructions',
    version: state.version,
  });
  await f.wait((m) => m.type === 'instructions.state');
  assert.equal(
    readFileSync(join(f.dir, 'accounts', f.id, 'config', 'CLAUDE.md'), 'utf8'),
    'Second account instructions',
  );
  await f.request({ type: 'instructions.get' });
  const original = await f.wait((m) => m.type === 'instructions.state');
  assert.ok(original.type === 'instructions.state');
  assert.equal(original.text, 'Default account instructions');
  assert.equal(readFileSync(join(f.config, 'CLAUDE.md'), 'utf8'), original.text);
});

nativeTest(
  'queued messages wait through account rotation, then start once on the selected account',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const file = join(f.config, 'fixture.json');
    writeFixture(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pauseBeforeQuota: true }),
    );
    const created = await f.request({
      type: 'session.create',
      title: 'queued rotation',
      projectPath: '/local/project',
    });
    const sessionId = created.sessionId!;
    await f.request({ type: 'message.send', sessionId, text: 'first task' });
    await f.wait(
      (message) =>
        message.type === 'session.event' && message.event.payload.type === 'native.session',
    );
    await f.request({ type: 'message.enqueue', sessionId, text: 'queued follow-up' });
    assert.equal(f.server.store.get(sessionId).session.messageQueue?.items.length, 1);
    writeFixture(
      file,
      JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), pauseBeforeQuota: false }),
    );
    for (let i = 0; i < 2; i++)
      await f.wait(
        (message) =>
          message.type === 'session.event' &&
          message.event.payload.type === 'run.status' &&
          message.event.payload.status === 'completed',
      );
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 3);
    assert.ok(calls[1].prompt.endsWith('\n\ncontinue'));
    assert.equal(calls[2].prompt, 'queued follow-up');
    assert.equal(calls[2].directory, calls[1].directory);
    assert.equal(f.server.store.get(sessionId).session.messageQueue?.items.length, 0);
    const messages = f.server.store
      .snapshot(sessionId)
      .events.flatMap(({ payload }) => (payload.type === 'message.user' ? [payload.text] : []));
    assert.deepEqual(messages, ['first task', 'continue', 'queued follow-up']);
  },
);

nativeTest(
  'moving a project carries its quota-resume switch and retains the pending message queue',
  async (t) => {
    const f = await fixture(t);
    const from = '/local/project';
    const to = '/local/renamed';
    const created = await f.request({ type: 'session.create', title: 'move', projectPath: from });
    const sessionId = created.sessionId!;
    await f.request({ type: 'project.quotaResume', projectPath: from, enabled: true });
    await f.request({ type: 'message.queue.pause', sessionId, paused: true });
    await f.request({ type: 'message.enqueue', sessionId, text: 'pending' });
    await f.request({ type: 'project.move', from, to });
    await f.wait(
      (message) =>
        message.type === 'pool.state' &&
        !!message.quotaResumeProjects?.some((project) => project.projectPath === to),
    );
    const session = f.server.store.get(sessionId).session;
    assert.equal(session.projectPath, to);
    assert.equal(session.messageQueue?.items[0].text, 'pending');
    assert.equal(session.messageQueue?.paused, true);
  },
);

for (const queued of [false, true])
  nativeTest(
    `cross-server handoff ${queued ? 'with queue' : 'without queue'} releases only an acknowledged quota wait and rejects a duplicate or stale run`,
    { timeout: 30000 },
    async (t) => {
      const f = await fixture(t);
      writeFixture(
        join(f.dir, 'accounts', f.id, 'config', 'fixture.json'),
        JSON.stringify({ loggedIn: true, email: 'b@example.test', blocked: true }),
      );
      const { sessionId } = await f.request({
        type: 'session.create',
        title: 'cross server',
        projectPath: '/local/transfer',
      });
      await f.request({ type: 'message.send', sessionId, text: 'unfinished task' });
      await f.wait(
        (m) =>
          m.type === 'pool.state' && !!m.quotaWaits?.some((wait) => wait.sessionId === sessionId),
      );
      const runId = f.server.store.get(sessionId!).session.activeRun!.id;
      const wrong = randomUUID();
      f.socket.send(
        JSON.stringify({ type: 'run.handoff', sessionId, runId: randomUUID(), requestId: wrong }),
      );
      const rejected = await f.wait((m) => m.type === 'response' && m.requestId === wrong);
      assert.ok(
        rejected.type === 'response' && !rejected.ok && rejected.code === 'handoff_unavailable',
      );
      assert.equal(f.server.store.get(sessionId!).session.activeRun?.id, runId);
      if (queued) {
        await f.request({ type: 'message.enqueue', sessionId, text: 'queued first' });
        await f.request({ type: 'message.enqueue', sessionId, text: 'queued second' });
        for (const queueIds of [undefined, [randomUUID()]]) {
          const requestId = randomUUID();
          f.socket.send(
            JSON.stringify({ type: 'run.handoff', sessionId, runId, queueIds, requestId }),
          );
          const rejected = await f.wait((m) => m.type === 'response' && m.requestId === requestId);
          assert.ok(
            rejected.type === 'response' && !rejected.ok && rejected.code === 'handoff_blocked',
          );
          assert.equal(f.server.store.get(sessionId!).session.activeRun?.id, runId);
        }
      }
      const queueIds = f.server.store
        .get(sessionId!)
        .session.messageQueue?.items.map((item) => item.id);
      await f.request({ type: 'run.handoff', sessionId, runId, ...(queued ? { queueIds } : {}) });
      await f.wait(
        (m) =>
          m.type === 'session.event' &&
          m.event.sessionId === sessionId &&
          m.event.payload.type === 'run.status' &&
          m.event.payload.status === 'cancelled',
      );
      assert.equal(f.server.store.get(sessionId!).session.activeRun, null);
      if (queued) {
        const queue = f.server.store.get(sessionId!).session.messageQueue!;
        assert.deepEqual(queue.handoff, { paused: false });
        assert.equal(queue.paused, true);
        assert.deepEqual(
          queue.items.map((item) => item.text),
          ['queued first', 'queued second'],
        );
        for (const command of [
          { type: 'message.queue.pause', paused: false },
          { type: 'message.queue.remove', messageId: queue.items[0].id },
          { type: 'message.enqueue', text: 'new' },
          { type: 'message.send', text: 'continue' },
          { type: 'session.handoff', queueIds },
        ]) {
          const requestId = randomUUID();
          f.socket.send(JSON.stringify({ ...command, sessionId, requestId }));
          const rejected = await f.wait((m) => m.type === 'response' && m.requestId === requestId);
          assert.ok(rejected.type === 'response' && !rejected.ok);
        }
        assert.deepEqual(f.server.store.get(sessionId!).session.messageQueue!.items, queue.items);
      }
      const duplicate = randomUUID();
      f.socket.send(
        JSON.stringify({ type: 'run.handoff', sessionId, runId, requestId: duplicate }),
      );
      const reply = await f.wait((m) => m.type === 'response' && m.requestId === duplicate);
      assert.ok(reply.type === 'response' && !reply.ok);
      if (queued) {
        const queue = f.server.store.get(sessionId!).session.messageQueue!;
        const rejectedId = randomUUID();
        f.socket.send(
          JSON.stringify({
            type: 'session.handoff.cancel',
            sessionId,
            queueIds: [randomUUID()],
            requestId: rejectedId,
          }),
        );
        const rejected = await f.wait((m) => m.type === 'response' && m.requestId === rejectedId);
        assert.ok(rejected.type === 'response' && !rejected.ok);
        assert.ok(f.server.store.get(sessionId!).session.messageQueue!.handoff);
        const originalDevice = f.server.store.get(sessionId!).session.device!;
        f.socket.send(JSON.stringify({ type: 'device', id: randomUUID(), platform: 'linux' }));
        const foreignId = randomUUID();
        f.socket.send(
          JSON.stringify({
            type: 'session.handoff.cancel',
            sessionId,
            queueIds,
            requestId: foreignId,
          }),
        );
        const foreign = await f.wait((m) => m.type === 'response' && m.requestId === foreignId);
        assert.ok(foreign.type === 'response' && !foreign.ok && foreign.code === 'handoff_device');
        f.socket.send(JSON.stringify({ type: 'device', id: originalDevice.id, platform: 'linux' }));
        await f.request({ type: 'session.handoff.cancel', sessionId, queueIds });
        const recovered = f.server.store.get(sessionId!).session.messageQueue!;
        assert.deepEqual(recovered.items, queue.items);
        assert.equal(recovered.paused, true);
        assert.equal(recovered.handoff, undefined);
        assert.equal(recovered.reasonCode, undefined);
        assert.equal(f.server.store.get(sessionId!).session.activeRun, null);
        f.server.store.append(sessionId!, runId, {
          type: 'native.tasks',
          tasks: [{ id: 'old-build', kind: 'local_bash', description: 'historical build' }],
        });
        const blockedId = randomUUID();
        f.socket.send(
          JSON.stringify({ type: 'session.handoff', sessionId, queueIds, requestId: blockedId }),
        );
        const blocked = await f.wait((m) => m.type === 'response' && m.requestId === blockedId);
        assert.ok(blocked.type === 'response' && !blocked.ok && blocked.code === 'handoff_blocked');
        assert.equal(f.server.store.get(sessionId!).session.messageQueue!.handoff, undefined);
        await f.request({
          type: 'session.handoff',
          sessionId,
          queueIds,
          confirmedTaskIds: ['old-build'],
        });
        assert.ok(f.server.store.get(sessionId!).session.messageQueue!.handoff);
        await f.request({ type: 'session.handoff.cancel', sessionId, queueIds });
        await f.request({ type: 'message.queue.remove', sessionId, messageId: queue.items[0].id });
        assert.deepEqual(f.server.store.get(sessionId!).session.messageQueue!.items, [
          queue.items[1],
        ]);
      }
      assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
    },
  );

nativeTest(
  'server-hosted sessions rotate pool accounts without requiring a desktop SSH seat',
  { timeout: 60000 },
  async (t) => {
    const f = await fixture(t);
    const created = await f.request({
      type: 'server.session.create',
      title: 'server pool handoff',
    });
    const sessionId = created.sessionId!;
    await f.request({ type: 'message.send', sessionId, text: 'continue the server task' });
    await f.wait(
      (message) =>
        message.type === 'session.event' &&
        message.event.sessionId === sessionId &&
        message.event.payload.type === 'run.status' &&
        message.event.payload.status === 'completed',
    );
    assert.equal(f.server.store.get(sessionId).session.accountId, f.id);
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.ok(calls[1].prompt.endsWith('\n\ncontinue'));
    assert.equal(
      f.server.store
        .snapshot(sessionId)
        .events.filter(({ payload }) => payload.type === 'message.user' && payload.continued)
        .length,
      1,
    );
  },
);

nativeTest(
  'idle queued quota rejection stays unsent, is marked for automatic handoff, and explicit pause clears eligibility',
  async (t) => {
    const f = await fixture(t);
    for (const directory of [f.config, join(f.dir, 'accounts', f.id, 'config')]) {
      const file = join(directory, 'fixture.json');
      writeFixture(
        file,
        JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), blocked: true }),
      );
    }
    await f.request({ type: 'pool.status', refresh: true });
    await f.wait(
      (m) =>
        m.type === 'pool.state' &&
        !m.refreshing &&
        m.accounts.every((a) =>
          a.limits?.windows.some((w) => w.name === 'five_hour' && w.utilization === 100),
        ),
    );
    const created = await f.request({
      type: 'session.create',
      title: 'idle quota queue',
      projectPath: '/local/project',
    });
    const sessionId = created.sessionId!;
    await f.request({ type: 'message.enqueue', sessionId, text: 'next task' });
    const session = f.server.store.get(sessionId).session;
    assert.equal(session.activeRun, null);
    assert.equal(session.messageQueue?.reasonCode, 'pool_unavailable');
    assert.equal(session.messageQueue?.paused, true);
    assert.equal(session.messageQueue?.items.length, 1);
    assert.equal(
      f.server.store.userMessage(sessionId, session.messageQueue!.items[0].id),
      undefined,
    );
    await f.request({ type: 'message.queue.pause', sessionId, paused: true });
    assert.equal(f.server.store.get(sessionId).session.messageQueue?.reasonCode, undefined);
    assert.equal(f.server.store.get(sessionId).session.messageQueue?.reason, undefined);
  },
);

nativeTest(
  'manual account priority is honored on the next run and falls back when exhausted',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, '');
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'manual choice',
      projectPath: '/local/project',
    });
    const send = async () => {
      await f.request({ type: 'message.send', sessionId, text: 'continue the task' });
      await f.wait(
        (message) =>
          message.type === 'session.event' &&
          message.event.sessionId === sessionId &&
          message.event.payload.type === 'run.status' &&
          message.event.payload.status === 'completed',
      );
    };
    await send();
    assert.equal(f.server.store.get(sessionId!).session.accountId, 'default');
    await f.request({
      type: 'pool.configure',
      values: { enabled: true, strategy: 'order', order: [f.id, 'default'] },
    });
    await send();
    assert.equal(f.server.store.get(sessionId!).session.accountId, f.id);
    const backup = join(f.dir, 'accounts', f.id, 'config', 'fixture.json');
    writeFixture(
      backup,
      JSON.stringify({ loggedIn: true, email: 'b@example.test', blocked: true, hours: 2 }),
    );
    await f.request({ type: 'pool.status', refresh: true });
    await f.wait(
      (message) =>
        message.type === 'pool.state' &&
        !message.refreshing &&
        message.accounts.some(
          (account) =>
            account.id === f.id &&
            account.limits?.windows.some(
              (window) => window.name === 'five_hour' && window.utilization === 100,
            ),
        ),
    );
    await send();
    assert.equal(f.server.store.get(sessionId!).session.accountId, 'default');
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 3);
  },
);

nativeTest(
  'weekly exhaustion waits for both windows, then continues once; manual stop cancels recovery',
  { timeout: 120000 },
  async (t) => {
    for (const goal of [false, true])
      for (const stop of [false, true])
        await t.test(
          `${goal ? 'goal ' : ''}${stop ? 'manual stop' : 'automatic continue'}`,
          async (t) => {
            const f = await fixture(t);
            await f.request({ type: 'pool.account.update', accountId: f.id, enabled: false });
            const file = join(f.config, 'fixture.json');
            const fiveAt = Date.now() + 5000;
            writeFixture(
              file,
              JSON.stringify({
                loggedIn: true,
                email: 'a@example.test',
                fail: 'quota',
                quotaWindow: 'seven_day',
                resetSeconds: 1,
                weeklyBlocked: true,
                weeklyResetsAt: new Date(Date.now() + 1000).toISOString(),
                blocked: true,
                resetsAt: new Date(fiveAt).toISOString(),
              }),
            );
            const { sessionId } = await f.request({
              type: 'session.create',
              title: 'overnight weekly',
              projectPath: '/local/weekly',
            });
            await f.request({
              type: 'message.send',
              sessionId,
              text: goal ? '/goal finish overnight' : 'finish overnight',
            });
            await f.wait(
              (m) =>
                m.type === 'session.event' &&
                m.event.payload.type === 'run.error' &&
                m.event.payload.code === 'quota_weekly',
            );
            const waiting = await f.wait(
              (m) =>
                m.type === 'pool.state' &&
                m.quotaWaits?.some((w) => w.sessionId === sessionId && w.at === fiveAt) === true,
            );
            assert.ok(waiting);
            const calls = () =>
              readFileSync(f.log, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line))
                .filter((call) => call.prompt !== '/goal');
            assert.equal(calls().length, 1);
            // Weekly quota recovers first. The five-hour quota must still prevent execution.
            writeFixture(
              file,
              JSON.stringify({
                loggedIn: true,
                email: 'a@example.test',
                blocked: true,
                resetsAt: new Date(fiveAt).toISOString(),
              }),
            );
            await f.request({ type: 'pool.status', refresh: true });
            assert.equal(calls().length, 1);
            if (stop)
              await f.request({
                type: 'run.cancel',
                sessionId,
                runId: f.server.store.get(sessionId!).session.activeRun!.id,
              });
            writeFixture(file, JSON.stringify({ loggedIn: true, email: 'a@example.test' }));
            if (stop) {
              await delay(5500);
              await f.request({ type: 'pool.status', refresh: true });
              assert.equal(calls().length, 1);
              if (goal) assert.equal(f.server.store.get(sessionId!).session.goal?.status, 'paused');
            } else {
              await f.wait(
                (m) =>
                  m.type === 'session.event' &&
                  m.event.sessionId === sessionId &&
                  m.event.payload.type === 'run.status' &&
                  m.event.payload.status === 'completed',
              );
              assert.equal(calls().length, 2);
              assert.equal(calls()[1].prompt, 'continue');
              assert.equal(calls()[1].sessionId, calls()[0].sessionId);
              assert.ok(calls()[1].at >= fiveAt);
            }
          },
        );
  },
);

nativeTest(
  'goal survives quota rotation with native confirmation and one continuation',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const { sessionId } = await f.request({
      type: 'session.create',
      title: 'goal rotation',
      projectPath: '/local/project',
    });
    await f.request({ type: 'message.send', sessionId, text: '/goal 完成所有回归再提交' });
    await f.wait(
      (m) =>
        m.type === 'session.event' &&
        m.event.sessionId === sessionId &&
        m.event.payload.type === 'run.status' &&
        m.event.payload.status === 'completed',
    );
    const session = f.server.store.get(sessionId!).session;
    assert.equal(session.accountId, f.id);
    assert.equal(session.goal?.condition, '完成所有回归再提交');
    assert.equal(session.goal?.status, 'active');
    const calls = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => call.prompt),
      ['/goal 完成所有回归再提交', '/goal 完成所有回归再提交', '/goal'],
    );
    assert.notEqual(calls[0].sessionId, calls[1].sessionId);
    assert.ok(
      calls[1].appendSystemPrompt.includes('continuation below') &&
        calls[1].appendSystemPrompt.includes('continue'),
    );
    const events = f.server.store.snapshot(sessionId!).events;
    const received = events.filter(
      (e) => e.payload.type === 'message.delivery' && e.payload.status === 'received',
    );
    assert.equal(
      received.length,
      1,
      'only the target model acknowledges its continuation; local probes do not',
    );
    assert.ok(
      events.filter((e) => e.payload.type === 'native.goal' && e.payload.goal.status === 'active')
        .length >= 2,
    );
    const context = f.server.store.continuationContext(sessionId!);
    assert.ok(context?.includes('continue'));
    await f.request({ type: 'pool.configure', values: { enabled: false } });
    await f.request({ type: 'run.continue', sessionId });
    await f.wait(
      (m) =>
        m.type === 'session.event' &&
        m.event.sessionId === sessionId &&
        m.event.payload.type === 'run.status' &&
        m.event.payload.status === 'completed',
    );
    const resumed = readFileSync(f.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .slice(calls.length);
    assert.equal(
      resumed.filter((call) => call.prompt.startsWith('/goal ')).length,
      0,
      'same native segment retains its hook',
    );
    assert.ok(
      resumed.every((call) => call.appendSystemPrompt.includes(context)),
      'the original handoff context survives later native resumes',
    );
    writeFixture(
      join(f.config, 'fixture.json'),
      JSON.stringify({ loggedIn: true, email: 'a@example.test', hours: 1 }),
    );
    await f.request({ type: 'pool.configure', values: { enabled: true } });
    await f.request({ type: 'pool.status', refresh: true });
    const nativeId = f.server.store.get(sessionId!).session.nativeSessionId;
    await f.request({ type: 'message.send', sessionId, text: '/goal' });
    await f.wait(
      (m) =>
        m.type === 'session.event' &&
        m.event.sessionId === sessionId &&
        m.event.payload.type === 'run.status' &&
        m.event.payload.status === 'completed',
    );
    assert.equal(
      f.server.store.get(sessionId!).session.nativeSessionId,
      nativeId,
      'status queries stay with the goal even when another account has higher priority',
    );
    assert.equal(f.server.store.get(sessionId!).session.goal?.condition, '完成所有回归再提交');
  },
);

nativeTest(
  'goal completion, clear and manual stop stay stopped across later messages',
  { timeout: 60000 },
  async (t) => {
    for (const ending of ['finished', 'cleared', 'paused'] as const)
      await t.test(ending, async (t) => {
        const f = await fixture(t, '');
        await f.request({ type: 'pool.configure', values: { enabled: false } });
        const file = join(f.config, 'fixture.json');
        const config = {
          loggedIn: true,
          email: 'a@example.test',
          finishGoal: ending === 'finished',
          pauseBeforeQuota: ending === 'paused',
        };
        writeFixture(file, JSON.stringify(config));
        const { sessionId } = await f.request({
          type: 'session.create',
          title: 'goal lifecycle',
          projectPath: '/local/project',
        });
        const ended = () =>
          f.wait(
            (m) =>
              m.type === 'session.event' &&
              m.event.sessionId === sessionId &&
              m.event.payload.type === 'run.status' &&
              ['completed', 'cancelled'].includes(m.event.payload.status),
          );
        await f.request({ type: 'message.send', sessionId, text: '/goal 检查完毕' });
        if (ending === 'paused') {
          await f.wait(
            (m) =>
              m.type === 'session.event' &&
              m.event.payload.type === 'native.goal' &&
              m.event.payload.goal.status === 'active',
          );
          await f.request({
            type: 'run.cancel',
            sessionId,
            runId: f.server.store.get(sessionId!).session.activeRun!.id,
          });
        }
        await ended();
        writeFixture(file, JSON.stringify({ ...config, pauseBeforeQuota: false }));
        if (ending === 'cleared') {
          await f.request({ type: 'message.send', sessionId, text: '/goal clear' });
          await ended();
        }
        assert.equal(f.server.store.get(sessionId!).session.goal?.status, ending);
        await f.request({ type: 'message.send', sessionId, text: '只报告当前状态' });
        await ended();
        assert.equal(f.server.store.get(sessionId!).session.goal?.status, ending);
        const calls = readFileSync(f.log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.equal(calls.filter((call) => call.prompt === '/goal 检查完毕').length, 1);
        assert.equal(calls.at(-1).prompt, '只报告当前状态');
        if (ending === 'paused')
          assert.deepEqual(
            calls.slice(-3).map((call) => call.prompt),
            ['/goal', '/goal clear', '只报告当前状态'],
          );
        const nativeGoal = JSON.parse(
          readFileSync(join(f.config, `goal-${calls[0].sessionId}.json`), 'utf8'),
        );
        assert.equal(nativeGoal, null);
      });
  },
);

nativeTest(
  'imported goal is restored separately from a long excerpt; refusal never falls back to plain continue',
  { timeout: 60000 },
  async (t) => {
    for (const rejectGoal of [false, true])
      await t.test(rejectGoal ? 'refused' : 'restored', async (t) => {
        const f = await fixture(t, '');
        await f.request({ type: 'pool.configure', values: { enabled: false } });
        writeFixture(
          join(f.config, 'fixture.json'),
          JSON.stringify({ loggedIn: true, email: 'a@example.test', rejectGoal, finishGoal: true }),
        );
        const { sessionId } = await f.request({
          type: 'session.create',
          title: 'imported goal',
          projectPath: '/local/project',
        });
        const goal = {
          condition: '最初约定的验收条件',
          status: 'active',
          iterations: 8,
          lastReason: '还有两项测试',
          updatedAt: new Date().toISOString(),
        };
        await f.request({ type: 'session.configure', sessionId, permissionMode: 'auto', goal });
        const text = `continue\n参考历史：${'很长的历史记录'.repeat(1500)}\n上一操作已完成，不可重复。`;
        await f.request({ type: 'message.send', sessionId, text });
        await f.wait(
          (m) =>
            m.type === 'session.event' &&
            m.event.sessionId === sessionId &&
            m.event.payload.type === 'run.status' &&
            m.event.payload.status === (rejectGoal ? 'failed' : 'completed'),
        );
        const calls = readFileSync(f.log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        assert.equal(calls[0].prompt, `/goal ${goal.condition}`);
        assert.ok(
          calls[0].appendSystemPrompt.includes(text),
          'context is present before /goal starts working',
        );
        assert.equal(
          calls.filter((call) => call.prompt === text || call.prompt === 'continue').length,
          0,
        );
        if (rejectGoal) {
          assert.equal(calls.length, 1);
          const events = f.server.store.snapshot(sessionId!).events;
          assert.ok(
            events.some(
              (e) =>
                e.payload.type === 'run.error' && e.payload.code === 'goal_restore_unconfirmed',
            ),
          );
          assert.equal(
            events.filter(
              (e) => e.payload.type === 'message.delivery' && e.payload.status === 'received',
            ).length,
            0,
          );
        } else assert.equal(f.server.store.get(sessionId!).session.goal?.status, 'finished');
      });
  },
);
