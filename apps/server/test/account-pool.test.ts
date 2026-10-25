import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AccountPool, availableAccount, orderedAccounts } from '../src/account-pool.ts';
import { SessionStore } from '../src/store.ts';
import { poolHandoff, canHandoff } from '../src/pool-handoff.ts';
import { nativeStore } from '../src/native-store.ts';
import type { ServerPoolAccount, SessionEvent } from '@cc-desk-tunnel/protocol';

function fixture(t: TestContext) {
  // macOS temporary directories can be symlinks; SDK project paths use the physical directory.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cc-server-pool-')));
  const store = new SessionStore(dir);
  const options = {
    executable: 'claude',
    environment: {
      CLAUDE_CONFIG_DIR: join(dir, 'original'),
      ANTHROPIC_API_KEY: 'test-provider-secret',
    },
    settingsPath: join(dir, 'provider.json'),
  };
  const pool = new AccountPool(store.database, dir, options);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, pool, options };
}
function quota(pool: AccountPool, id: string, hours: number, utilization = 20) {
  pool.update(id, { loggedIn: true, error: undefined });
  pool.observe(id, {
    available: true,
    measuredAt: new Date().toISOString(),
    windows: [
      {
        name: 'five_hour',
        utilization,
        resetsAt: new Date(Date.now() + hours * 3600_000).toISOString(),
      },
    ],
  });
}

test('server pool preserves the original login and isolates new accounts from provider credentials', (t) => {
  const { pool, store, dir, options } = fixture(t);
  const id = randomUUID();
  pool.add(id, 'B');
  assert.equal(pool.options('default'), options);
  assert.equal(pool.options(id).environment?.ANTHROPIC_API_KEY, undefined);
  assert.equal(pool.options(id).settingsPath, undefined);
  assert.notEqual(pool.configDirectory('default'), pool.configDirectory(id));
  pool.configure({ enabled: true, strategy: 'order', order: [id, 'default'], preferredId: id });
  pool.update(id, { login: { url: 'https://example.com/authorization-only' }, busy: true });
  const restored = new AccountPool(store.database, dir, options);
  assert.deepEqual(restored.settings, pool.settings);
  assert.equal(restored.get(id).login, null);
  assert.equal(restored.get(id).busy, false);
  const metadata = String(store.database.prepare('SELECT data FROM account_pool').get()?.data);
  assert.ok(!metadata.includes('test-provider-secret'));
  assert.ok(!metadata.includes('authorization-only'));
  assert.throws(() => pool.configDirectory('../escape'));
});

test('scheduler respects reset priority, custom order, weekly caps, stale readings and disabled accounts', (t) => {
  const { pool } = fixture(t);
  const second = randomUUID();
  pool.add(second, 'second');
  quota(pool, 'default', 4);
  quota(pool, second, 1);
  pool.configure({ enabled: true });
  assert.equal(pool.choose().id, second);
  pool.locked.add(second);
  assert.equal(
    pool.choose().id,
    'default',
    'logout locks exclude the account before credentials change',
  );
  pool.configure({ enabled: false, preferredId: second });
  assert.throws(() => pool.choose(), /不可用|停用|未登录/);
  pool.configure({ enabled: true });
  pool.locked.clear();
  assert.equal(pool.choose('default').id, 'default');
  pool.configure({ strategy: 'order', order: ['default', second] });
  assert.equal(pool.choose().id, 'default');
  pool.block('default', new Date(Date.now() + 3600_000).toISOString());
  quota(pool, 'default', 4, 0);
  assert.equal(
    pool.choose().id,
    second,
    'an early successful probe does not erase a confirmed quota block',
  );
  pool.update(second, {
    limits: {
      available: true,
      windows: [
        { name: 'five_hour', utilization: 5, resetsAt: null },
        { name: 'seven_day', utilization: 100, resetsAt: null },
      ],
    },
  });
  assert.throws(() => pool.choose(), /暂无可用/);
  quota(pool, second, 1);
  pool.update(second, { checkedAt: Date.now() - 121000 });
  assert.equal(availableAccount(pool.get(second)), false);
  quota(pool, second, 1);
  pool.update(second, { enabled: false });
  assert.deepEqual(orderedAccounts(pool.snapshot()), []);
});

test('an account switch keeps the proxy session, project and history, and never resumes another account native segment', (t) => {
  const { pool, store } = fixture(t);
  const second = randomUUID();
  pool.add(second, 'B');
  const session = store.create(randomUUID(), 'original task', 'D:\\Project', {
    id: randomUUID(),
    name: 'PC',
  });
  const runId = randomUUID();
  store.append(session.id, runId, {
    type: 'message.user',
    messageId: randomUUID(),
    text: 'Keep my task',
    scenario: 'chat',
  });
  store.append(session.id, runId, {
    type: 'native.session',
    nativeSessionId: session.id,
    model: 'test',
    version: 'test',
  });
  assert.equal(store.hasNativeContext(session.id), true);
  const changed = store.selectAccount(session.id, second);
  assert.equal(changed.id, session.id);
  assert.equal(changed.projectPath, 'D:\\Project');
  assert.notEqual(changed.nativeSessionId, session.id);
  assert.equal(store.hasNativeContext(session.id), false);
  assert.equal(changed.accountHandoff, true);
  const nativeId = changed.nativeSessionId!;
  store.append(session.id, runId, {
    type: 'native.session',
    nativeSessionId: nativeId,
    model: 'test',
    version: 'test',
  });
  assert.equal(store.hasNativeContext(session.id), true);
  store.handoffSubmitted(session.id);
  assert.equal(store.get(session.id).session.accountHandoff, false);
  assert.equal(store.snapshot(session.id).events[0].payload.type, 'message.user');
  assert.equal(store.nativeSegments(session.id).length, 2);
  store.selectAccount(session.id, 'default');
  assert.notEqual(
    store.get(session.id).session.nativeSessionId,
    session.id,
    'returning to an account starts with current progress, not stale context',
  );
});

test('handoff omits reasoning, is bounded, and refuses unknown tools and unconfirmed supplemental messages', () => {
  const runId = randomUUID(),
    sessionId = randomUUID();
  const event = (payload: SessionEvent['payload']): SessionEvent => ({
    runId,
    sessionId,
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload,
  });
  const events = [
    event({
      type: 'message.user',
      messageId: randomUUID(),
      text: 'Complete my task',
      scenario: 'chat',
    }),
    event({ type: 'thinking.delta', messageId: randomUUID(), text: 'PRIVATE REASONING' }),
    event({ type: 'text.delta', messageId: randomUUID(), text: 'progress '.repeat(10000) }),
  ];
  assert.ok(poolHandoff(events).includes('Complete my task'));
  assert.ok(!poolHandoff(events).includes('PRIVATE REASONING'));
  assert.ok(poolHandoff(events).length < 16000);
  assert.equal(canHandoff(events, runId), true);
  const supplementalId = randomUUID();
  const supplemental = [
    ...events,
    event({
      type: 'message.user',
      messageId: supplementalId,
      text: 'extra task',
      scenario: 'chat',
    }),
    event({ type: 'message.delivery', messageId: supplementalId, status: 'unconfirmed' }),
  ];
  assert.equal(canHandoff(supplemental, runId), false);
  const continuedId = randomUUID();
  const continued = [
    ...events,
    event({
      type: 'message.user',
      messageId: continuedId,
      text: 'continue',
      scenario: 'chat',
      continued: true,
    }),
    event({ type: 'message.delivery', messageId: continuedId, status: 'unconfirmed' }),
  ];
  assert.equal(canHandoff(continued, runId), true);
  assert.ok(poolHandoff(continued).includes('最近用户任务：Complete my task'));
  assert.equal(canHandoff([...supplemental, ...continued.slice(events.length)], runId), false);
  events.push(
    event({ type: 'tool.requested', toolId: 't', name: 'Bash', input: '{}', target: 'Linux' }),
  );
  assert.equal(canHandoff(events, runId), false);
  events.push(
    event({
      type: 'tool.result',
      toolId: 't',
      status: 'unknown',
      output: 'unknown',
      exitCode: null,
    }),
  );
  assert.equal(canHandoff(events, runId), false);
});

// This fixture writes the Unix CLI's native history layout. The CLI adapter is not hosted on Windows.
test(
  'native SDK history reads run in isolated environments even for concurrent accounts',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { pool, dir } = fixture(t);
    const second = randomUUID();
    pool.add(second, 'B');
    const cwd = join(dir, 'project');
    mkdirSync(cwd);
    const id = randomUUID();
    for (const [account, text] of [
      ['default', 'account A private history'],
      [second, 'account B private history'],
    ]) {
      const project = join(
        pool.configDirectory(account),
        'projects',
        cwd.replace(/[^a-zA-Z0-9]/g, '-'),
      );
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, `${id}.jsonl`),
        JSON.stringify({
          type: 'user',
          uuid: randomUUID(),
          parentUuid: null,
          sessionId: id,
          cwd,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: text },
          isSidechain: false,
        }) + '\n',
      );
    }
    const [a, b] = await Promise.all([
      nativeStore(pool.options('default'), 'messages', id, { dir: cwd }),
      nativeStore(pool.options(second), 'messages', id, { dir: cwd }),
    ]);
    assert.ok(JSON.stringify(a).includes('account A private history'));
    assert.ok(!JSON.stringify(a).includes('account B private history'));
    assert.ok(JSON.stringify(b).includes('account B private history'));
    assert.ok(!JSON.stringify(b).includes('account A private history'));
  },
);

test('reset forecast waits for all exhausted windows and excludes unavailable or unknown accounts', async (t) => {
  const { nextAccountReset } = await import('../src/account-pool.ts');
  const { pool } = fixture(t);
  const id = randomUUID();
  pool.add(id, 'B');
  quota(pool, 'default', 1, 100);
  quota(pool, id, 2, 100);
  assert.equal(nextAccountReset(pool.accounts)?.accountId, 'default');
  pool.get('default').limits!.windows.push({
    name: 'seven_day',
    utilization: 100,
    resetsAt: new Date(Date.now() + 10 * 3600000).toISOString(),
  });
  assert.equal(nextAccountReset(pool.accounts)?.accountId, id);
  pool.get(id).limits!.windows[0].resetsAt = null;
  assert.equal(nextAccountReset(pool.accounts)?.accountId, 'default');
  pool.update('default', { enabled: false });
  assert.equal(nextAccountReset(pool.accounts), null);
  quota(pool, id, 2, 100);
  pool.block(id, new Date(Date.now() + 60000).toISOString());
  assert.ok(
    nextAccountReset(pool.accounts)!.at < Date.now() + 61000,
    'official rejection overrides an older five-hour reading',
  );
  assert.equal(nextAccountReset(pool.accounts, [id]), null);
});

test('server selection uses weekly reset before five-hour reset without interrupting an existing run', (t) => {
  const { pool } = fixture(t);
  const second = randomUUID();
  pool.add(second, 'weekly first');
  quota(pool, 'default', 1);
  quota(pool, second, 4);
  for (const [id, hours] of [
    ['default', 158],
    [second, 11],
  ] as const) {
    const limits = pool.get(id).limits!;
    pool.observe(id, {
      ...limits,
      windows: [
        ...limits.windows,
        {
          name: 'seven_day',
          utilization: 20,
          resetsAt: new Date(Date.now() + hours * 3600_000).toISOString(),
        },
      ],
    });
  }
  pool.configure({ enabled: true, strategy: 'reset' });
  assert.equal(pool.choose().id, second);
  assert.equal(
    pool.choose('default').id,
    'default',
    'an ongoing operation may retain its current account',
  );
  pool.configure({ strategy: 'order', order: ['default', second] });
  assert.equal(pool.choose().id, 'default');
});
