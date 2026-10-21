import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:https';
import { WebSocketServer } from 'ws';
import { PROTOCOL_VERSION } from '@cc-desk-tunnel/protocol';
import { probeQuota } from '../electron/quota-probe.mjs';

test(
  'quota probe pins TLS before authentication and queries status without creating a device or running a prompt',
  {
    skip:
      process.platform === 'win32'
        ? 'This TLS fixture uses the system OpenSSL on Linux/macOS.'
        : false,
  },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'cc-quota-probe-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const key = join(directory, 'key.pem');
    const cert = join(directory, 'cert.pem');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-subj',
        '/CN=localhost',
        '-days',
        '1',
      ],
      { stdio: 'ignore' },
    );
    const certificate = readFileSync(cert);
    const server = createServer({ key: readFileSync(key), cert: certificate });
    const wss = new WebSocketServer({ server });
    const token = randomBytes(32).toString('hex');
    const seen = [];
    const protocols = [];
    let serviceProtocol = PROTOCOL_VERSION;
    let refuseAllVersions = false;
    let multiAccount = false;
    const backupId = randomUUID();
    const sessionId = randomUUID();
    const limits = {
      available: true,
      measuredAt: new Date().toISOString(),
      windows: [
        {
          name: 'five_hour',
          utilization: 42,
          resetsAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
    };
    wss.on('connection', (socket) =>
      socket.on('message', (raw) => {
        const message = JSON.parse(raw);
        seen.push(message.type);
        if (message.type === 'auth') {
          assert.equal(message.token, token);
          protocols.push(message.protocolVersion);
          if (refuseAllVersions || message.protocolVersion !== serviceProtocol) {
            socket.send(
              JSON.stringify({
                type: 'connection.error',
                code: 'version_mismatch',
                service: '0.3.1',
                message: 'Incompatible protocol',
              }),
            );
            socket.close();
            return;
          }
          socket.send(
            JSON.stringify({
              type: 'ready',
              protocolVersion: serviceProtocol,
              version: '0.3.1',
              connectionId: randomUUID(),
              adapter: 'claude-code',
              features: multiAccount ? ['account-pool'] : [],
              sessions: [
                {
                  id: randomUUID(),
                  title: 'idle',
                  projectPath: '/project',
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  activeRun: null,
                },
                {
                  id: sessionId,
                  title: 'existing',
                  projectPath: '/project',
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  activeRun: {
                    id: randomUUID(),
                    connectionId: randomUUID(),
                    status: 'running',
                    surface: 'chat',
                  },
                },
              ],
            }),
          );
        } else if (message.type === 'pool.status') {
          const pool = {
            type: 'pool.state',
            settings: {
              enabled: true,
              strategy: 'order',
              order: ['default', backupId],
              preferredId: 'default',
            },
            accounts: ['default', backupId].map((id) => ({
              id,
              name: id,
              enabled: true,
              loggedIn: true,
              login: null,
              busy: false,
              checkedAt: Date.now(),
              blockedUntil: null,
              limits:
                id === backupId
                  ? limits
                  : {
                      ...limits,
                      windows: [{ name: 'five_hour', utilization: 100, resetsAt: null }],
                    },
            })),
          };
          socket.send(JSON.stringify({ ...pool, refreshing: false }));
          socket.send(JSON.stringify({ ...pool, refreshing: true }));
          socket.send(JSON.stringify({ type: 'response', requestId: message.requestId, ok: true }));
          socket.send(JSON.stringify({ ...pool, refreshing: false }));
        } else if (message.type === 'session.subscribe') {
          assert.equal(
            message.sessionId,
            sessionId,
            'subscribe to the running CLI that will emit quota',
          );
          socket.send(
            JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, sessionId }),
          );
        } else if (message.type === 'session.status') {
          assert.equal(message.sessionId, sessionId);
          socket.send(
            JSON.stringify({
              type: 'session.event',
              event: {
                sessionId,
                runId: message.requestId,
                sequence: 1,
                createdAt: new Date().toISOString(),
                payload: { type: 'native.metrics', context: null, usage: null, rateLimits: limits },
              },
            }),
          );
          socket.send(
            JSON.stringify({ type: 'response', requestId: message.requestId, ok: true, sessionId }),
          );
        }
      }),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    });
    const config = {
      url: `wss://127.0.0.1:${server.address().port}/ws`,
      fingerprint: new X509Certificate(certificate).fingerprint256,
      token,
    };
    await assert.rejects(probeQuota({ ...config, fingerprint: 'AA'.repeat(32) }), /指纹不匹配/);
    assert.deepEqual(seen, []);
    await assert.rejects(probeQuota({ ...config, fingerprint: '' }), /证书/);
    assert.deepEqual(seen, []);
    assert.deepEqual(await probeQuota(config), limits);
    assert.deepEqual(seen, ['auth', 'session.subscribe', 'session.status']);
    multiAccount = true;
    seen.length = 0;
    assert.deepEqual(await probeQuota(config), limits);
    assert.deepEqual(seen, ['auth', 'pool.status']);
    multiAccount = false;
    serviceProtocol = 16;
    seen.length = 0;
    protocols.length = 0;
    assert.deepEqual(await probeQuota(config), limits);
    assert.deepEqual(protocols, [PROTOCOL_VERSION, 16]);
    assert.deepEqual(seen, ['auth', 'auth', 'session.subscribe', 'session.status']);
    refuseAllVersions = true;
    protocols.length = 0;
    await assert.rejects(probeQuota(config), /Incompatible protocol/);
    assert.deepEqual(protocols, [PROTOCOL_VERSION, 16], 'a refusal after fallback must not loop');
  },
);
