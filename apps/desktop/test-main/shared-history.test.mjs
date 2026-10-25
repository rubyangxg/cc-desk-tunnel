import assert from 'node:assert/strict';
import { test } from 'node:test';
import { historyKey, joinedHistory, transferBlock } from '../src/sharedHistory.ts';
import { poolQuota } from '../electron/quota-probe.mjs';
const events = (payloads) =>
  payloads.map((payload, sequence) => ({
    sessionId: 'same-session',
    runId: 'same-run',
    sequence: sequence + 1,
    createdAt: new Date().toISOString(),
    payload,
  }));
const question = (text) => ({
  type: 'message.user',
  messageId: 'same-message',
  text,
  scenario: 'chat',
});
const session = { id: 'same-session', activeRun: null };

test('joined history retains original messages, namespaces collisions and masks only the initial handoff prompt', () => {
  const original = events([
    question('original task'),
    { type: 'text.delta', messageId: 'answer', text: 'completed step' },
    { type: 'run.status', status: 'completed' },
  ]);
  const current = events([
    question('continue with context'),
    { type: 'text.delta', messageId: 'answer', text: 'next step' },
    question('continue with context'),
  ]);
  const archive = {
    segments: [{ key: 'server-a', service: 'A', account: 'account A', session, events: original }],
    prompt: 'continue with context',
  };
  const joined = joinedHistory(archive, current);
  assert.equal(joined[0].payload.text, '执行来源：A · 交接时账号：account A');
  const questions = joined.filter((e) => e.payload.type === 'message.user');
  assert.deepEqual(
    questions.map((e) => e.payload.text),
    ['original task', 'continue', 'continue with context'],
  );
  assert.notEqual(questions[0].payload.messageId, questions[1].payload.messageId);
  assert.notEqual(questions[0].runId, questions[1].runId);
  assert.equal(original[0].payload.messageId, 'same-message');
  assert.equal(current[0].payload.text, 'continue with context');
  assert.deepEqual(
    joined.map((e) => e.sequence),
    joined.map((_, i) => i + 1),
  );
  assert.notEqual(
    historyKey({ id: 'a', url: 'wss://one' }, 's'),
    historyKey({ id: 'a', url: 'wss://two' }, 's'),
  );
});

test('transfer refuses active tasks, queued messages, unknown tools, background work and unconfirmed messages', () => {
  const end = { type: 'run.status', status: 'failed' };
  assert.ok(transferBlock({ activeRun: { id: 'run' } }, []));
  assert.ok(transferBlock({ ...session, messageQueue: { items: [{}] } }, []));
  assert.ok(transferBlock(session, events([{ type: 'tool.requested', toolId: 'tool' }, end])));
  assert.ok(
    transferBlock(
      session,
      events([{ type: 'tool.result', toolId: 'tool', status: 'unknown' }, end]),
    ),
  );
  assert.ok(transferBlock(session, events([{ type: 'native.tasks', tasks: [{}] }, end])));
  assert.ok(
    transferBlock(session, events([{ type: 'message.delivery', status: 'unconfirmed' }, end])),
  );
  assert.equal(
    transferBlock(
      session,
      events([
        { type: 'tool.requested', toolId: 'tool' },
        { type: 'tool.result', toolId: 'tool', status: 'completed' },
        end,
      ]),
    ),
    null,
  );
});

test('multi-account telemetry finds B when A is exhausted, honors fixed account and rejects stale weekly limits', () => {
  const now = Date.now();
  const account = (id, utilization) => ({
    id,
    enabled: true,
    loggedIn: true,
    checkedAt: now,
    limits: {
      available: true,
      measuredAt: new Date(now).toISOString(),
      windows: [{ name: 'five_hour', utilization }],
    },
  });
  const state = {
    serverTime: now,
    settings: { enabled: true, order: ['a', 'b'], strategy: 'order', preferredId: 'a' },
    accounts: [account('a', 100), account('b', 20)],
  };
  assert.equal(poolQuota(state), state.accounts[1].limits);
  assert.equal(poolQuota({ ...state, settings: { ...state.settings, enabled: false } }), null);
  state.accounts[1].limits.windows.push({ name: 'seven_day', utilization: 100 });
  assert.equal(poolQuota(state), null);
  state.accounts[1] = { ...account('b', 20), checkedAt: now - 121000 };
  assert.equal(poolQuota(state), null);
});

test('background pool probe advertises the weekly-first usable account', () => {
  const now = Date.now();
  const accounts = [158, 11].map((hours, index) => ({
    id: String(index),
    enabled: true,
    loggedIn: true,
    login: null,
    error: null,
    checkedAt: now,
    limits: {
      available: true,
      windows: [
        {
          name: 'five_hour',
          utilization: 10,
          resetsAt: index ? null : new Date(now + 3600000).toISOString(),
        },
        {
          name: 'seven_day',
          utilization: 20,
          resetsAt: new Date(now + hours * 3600000).toISOString(),
        },
      ],
    },
  }));
  const state = {
    serverTime: now,
    settings: { enabled: true, strategy: 'reset', order: ['0', '1'] },
    accounts,
  };
  assert.equal(poolQuota(state), accounts[1].limits);
  accounts[1].limits.windows[0].utilization = 100;
  assert.equal(poolQuota(state), accounts[0].limits);
});
