import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { createProxyServer } from '../src/server.ts';
import { nativeDirectory } from '../src/claude.ts';
import { nativeStore } from '../src/native-store.ts';

for (const mode of ['prefix', 'not-persisted', 'rotated', 'finishes'] as const)
  test(
    `active native fork ${mode} keeps only completed history and leaves source running`,
    { skip: process.platform === 'win32' },
    async (t) => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-running-fork-')));
      const config = join(dir, 'config');
      const token = randomUUID();
      const claude = { executable: process.execPath, environment: { CLAUDE_CONFIG_DIR: config } };
      const server = createProxyServer({
        token,
        dataDir: dir,
        reverseProxy: true,
        tunnel: { probe: async () => {} },
        claude,
      });
      const url = await server.listen(0);
      const socket = new WebSocket(url.replace('http', 'ws') + '/ws');
      t.after(async () => {
        socket.terminate();
        await server.close();
        rmSync(dir, { recursive: true, force: true });
      });
      const device = { id: randomUUID(), name: 'fork device', platform: 'linux' as const };
      const messages: Array<Record<string, any>> = [];
      socket.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      const wait = async (type: string, requestId?: string) => {
        for (const until = Date.now() + 10000; Date.now() < until;) {
          const at = messages.findIndex(
            (message) => message.type === type && (!requestId || message.requestId === requestId),
          );
          if (at >= 0) return messages.splice(at, 1)[0]!;
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        throw new Error('Response timeout');
      };
      await new Promise<void>((resolve) => socket.once('open', resolve));
      socket.send(
        JSON.stringify({
          type: 'auth',
          token,
          protocolVersion: PROTOCOL_VERSION,
          deviceName: device.name,
        }),
      );
      const ready = await wait('ready');
      assert.ok(ready.features.includes('running-session-fork'));
      socket.send(JSON.stringify({ type: 'device', id: device.id, platform: device.platform }));
      const source = server.store.create(randomUUID(), 'Original', '/project', device);
      server.store.selectAccount(source.id, 'default');
      const oldRun = randomUUID(),
        activeRun = randomUUID(),
        connectionId = randomUUID();
      const first = randomUUID(),
        answer = randomUUID(),
        incoming = randomUUID();
      const cwd = nativeDirectory(dir, source.nativeRoot ?? source.id);
      const project = join(config, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(project, { recursive: true });
      const file = join(project, `${source.id}.jsonl`);
      const rows =
        [
          {
            type: 'user',
            uuid: first,
            parentUuid: null,
            message: { role: 'user', content: 'completed question' },
          },
          {
            type: 'assistant',
            uuid: answer,
            parentUuid: first,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'completed answer' }],
              stop_reason: 'end_turn',
            },
          },
          ...(mode === 'not-persisted'
            ? []
            : [
                {
                  type: 'user',
                  uuid: incoming,
                  parentUuid: answer,
                  message: { role: 'user', content: 'unfinished question' },
                },
                {
                  type: 'assistant',
                  uuid: randomUUID(),
                  parentUuid: incoming,
                  message: {
                    role: 'assistant',
                    content: [
                      {
                        type: 'tool_use',
                        id: 'pending',
                        name: 'Bash',
                        input: { command: 'sleep 100' },
                      },
                    ],
                  },
                },
              ]),
        ]
          .map((row) =>
            JSON.stringify({
              ...row,
              sessionId: source.id,
              cwd,
              timestamp: new Date().toISOString(),
              isSidechain: false,
            }),
          )
          .join('\n') + '\n';
      writeFileSync(file, rows);
      server.store.append(source.id, oldRun, {
        type: 'message.user',
        messageId: first,
        text: 'completed question',
        scenario: 'chat',
      });
      server.store.append(source.id, oldRun, {
        type: 'native.session',
        nativeSessionId: mode === 'rotated' ? randomUUID() : source.id,
        model: 'test',
        version: 'test',
      });
      server.store.append(source.id, oldRun, {
        type: 'text.delta',
        messageId: answer,
        text: 'completed answer',
      });
      server.store.append(source.id, oldRun, {
        type: 'run.status',
        status: 'completed',
        connectionId,
      });
      server.store.append(source.id, activeRun, {
        type: 'message.user',
        messageId: incoming,
        text: 'unfinished question',
        scenario: 'chat',
      });
      server.store.append(source.id, activeRun, {
        type: 'native.session',
        nativeSessionId: source.id,
        model: 'test',
        version: 'test',
      });
      server.store.append(source.id, activeRun, {
        type: 'run.status',
        status: 'running',
        connectionId,
        waiting: 'background',
      });
      server.store.append(source.id, activeRun, {
        type: 'native.tasks',
        tasks: [{ id: 'pending-task', kind: 'local_bash', description: 'still running' }],
      });
      server.store.enqueue(source.id, {
        id: randomUUID(),
        text: 'pending queue',
        scenario: 'chat',
        createdAt: new Date().toISOString(),
      });
      server.store.continuationContext(source.id, 'completed progress');
      const before = server.store.snapshot(source.id);
      const requestId = randomUUID();
      const command = JSON.stringify({ type: 'session.fork', sessionId: source.id, requestId });
      socket.send(command);
      const finishing =
        mode === 'finishes'
          ? new Promise<void>((resolve) =>
              setTimeout(() => {
                server.store.append(source.id, activeRun, {
                  type: 'run.status',
                  status: 'completed',
                  connectionId,
                });
                server.store.selectAccount(source.id, randomUUID());
                resolve();
              }, 30),
            )
          : Promise.resolve();
      const reply = await wait('response', requestId);
      await finishing;
      assert.equal(readFileSync(file, 'utf8'), rows, 'source native file is untouched');
      if (mode !== 'finishes')
        assert.deepEqual(
          server.store.snapshot(source.id),
          before,
          'source state and run controls are untouched',
        );
      if (mode === 'not-persisted') {
        assert.equal(reply.ok, false);
        assert.equal(reply.code, 'fork_not_ready');
        assert.equal(server.store.list().length, 1);
        return;
      }
      assert.ok(reply.ok && reply.sessionId);
      const copy = server.store.snapshot(reply.sessionId);
      assert.equal(copy.session.activeRun, null);
      assert.equal(copy.session.messageQueue, undefined);
      assert.ok(!copy.events.some((event) => event.runId === activeRun));
      assert.ok(JSON.stringify(copy.events).includes('completed answer'));
      assert.ok(!JSON.stringify(copy.events).includes('unfinished question'));
      if (mode === 'prefix' || mode === 'finishes') {
        assert.equal(copy.session.accountId, 'default');
        assert.equal(server.store.continuationContext(copy.session.id), 'completed progress');
        assert.equal(copy.session.nativeSessionId, copy.session.id);
        const native = await nativeStore(claude, 'messages', copy.session.id, { dir: cwd });
        assert.equal(native.length, 2);
        assert.ok(JSON.stringify(native).includes('completed answer'));
        assert.ok(!JSON.stringify(native).includes('unfinished question'));
      } else {
        assert.equal(copy.session.nativeSessionId, undefined);
        assert.equal(copy.session.accountHandoff, true);
      }
      socket.send(command);
      const repeat = await wait('response', requestId);
      assert.equal(repeat.sessionId, reply.sessionId);
      assert.equal(server.store.list().length, 2);
    },
  );
