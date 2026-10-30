import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  classifyProbeFailure,
  describeError,
  probeFailureMessages,
  redact,
  statusFailure,
  trackTask,
} from '../src/diagnostics.ts';

test('a tracked task that fails is logged and leaves the group, without an unhandled rejection', async () => {
  const group = new Set<Promise<unknown>>();
  const logged: [string, unknown][] = [];
  let unhandled = 0;
  const count = () => unhandled++;
  process.on('unhandledRejection', count);
  try {
    const failure = new Error('boom');
    const settled = trackTask(group, Promise.reject(failure), 'probe', (context, error) =>
      logged.push([context, error]),
    );
    assert.equal(group.size, 1);
    await settled;
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(logged, [['probe', failure]]);
    assert.equal(group.size, 0);
    assert.equal(unhandled, 0);
  } finally {
    process.off('unhandledRejection', count);
  }
});

test('a process tracking a failing task keeps running', () => {
  const script = `
    import { trackTask } from ${JSON.stringify(new URL('../src/diagnostics.ts', import.meta.url).href)};
    trackTask(new Set(), Promise.reject(new Error('boom')), 'probe', () => {});
    setTimeout(() => console.log('alive'), 20);
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /alive/);
});

test('a successful tracked task is not logged', async () => {
  const group = new Set<Promise<unknown>>();
  const logged: unknown[] = [];
  await trackTask(group, Promise.resolve(1), 'ok', (_, error) => logged.push(error));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(logged, []);
  assert.equal(group.size, 0);
});

test('account check failures are told apart', () => {
  const auth = [
    Object.assign(new Error('Request failed'), { status: 401 }),
    new Error('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'),
    new Error('Invalid API key · Please run /login'),
    new Error('OAuth token has expired. Please obtain a new token or refresh your existing token.'),
    new Error('403 Forbidden'),
  ];
  for (const error of auth) assert.equal(classifyProbeFailure(error), 'auth', error.message);
  const timeout = [
    Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    Object.assign(new Error('claude auth status timed out'), { code: 'ETIMEDOUT' }),
    new Error('Request timed out'),
    new Error('OAuth request timed out'),
  ];
  for (const error of timeout) assert.equal(classifyProbeFailure(error), 'timeout', error.message);
  const spawn = [
    Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' }),
    new Error('Claude Code executable not found at /usr/bin/claude'),
    Object.assign(new Error('could not start'), { code: 'EACCES' }),
  ];
  for (const error of spawn) assert.equal(classifyProbeFailure(error), 'spawn', error.message);
  assert.equal(classifyProbeFailure(new SyntaxError('Unexpected end of JSON input')), 'unknown');
  assert.equal(classifyProbeFailure(undefined), 'unknown');
  assert.equal(probeFailureMessages.unknown, '检测失败，请检查此账号的登录状态与服务网络');
  assert.notEqual(probeFailureMessages.auth, probeFailureMessages.timeout);
});

test('a status command that printed nothing is reported by why it failed', () => {
  const missing = statusFailure({ code: null, failure: { code: 'ENOENT', killed: false } });
  assert.equal(classifyProbeFailure(missing), 'spawn');
  const slow = statusFailure({ code: null, failure: { killed: true } });
  assert.equal(classifyProbeFailure(slow), 'timeout');
  assert.equal(classifyProbeFailure(statusFailure({ code: 2 })), 'unknown');
});

test('credentials are masked in what is logged', () => {
  const secrets = [
    // Built from parts so the repository's own secret check does not take the sample for a real key.
    ['sk', 'ant-oat01-abcdefghijklmnopqrstuvwxyz0123456789'].join('-'),
    'gho_abcdefghijklmnopqrstuvwxyz0123456789',
    'eyJhbGciOiJIUzI1NiJ9abc.eyJzdWIiOiIxMjM0NTY3ODkwIn0abc.c2lnbmF0dXJl',
    'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2Nzg5YWJjZGVm',
  ];
  for (const secret of secrets) assert.ok(!redact(`failed with ${secret}`).includes(secret));
  const message = describeError(
    new Error(
      'refresh failed {"accessToken":"opaque-value-1","refresh_token":"opaque-value-2"} Authorization: Bearer opaque-value-3',
    ),
  );
  for (const value of ['opaque-value-1', 'opaque-value-2', 'opaque-value-3'])
    assert.ok(!message.includes(value), message);
  assert.match(message, /^Error: refresh failed/);
  assert.equal(describeError(new Error('word '.repeat(200))).length, 501);
});
