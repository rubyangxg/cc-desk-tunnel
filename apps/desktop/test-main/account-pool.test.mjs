import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exhausted, handoffFor, poolCandidates, quotaFailure } from '../src/accountPool.ts';

const now = Date.now();
const profiles = ['a', 'b', 'c'].map((id) => ({
  id,
  name: id,
  mode: 'remote',
  remember: true,
  token: 'test-credential-not-real',
}));
const quota = (utilization, hours, extra = {}) => ({
  checkedAt: now,
  limits: {
    available: true,
    windows: [
      { name: 'five_hour', utilization, resetsAt: new Date(now + hours * 3600_000).toISOString() },
    ],
  },
  ...extra,
});
const settings = { enabled: true, strategy: 'reset', order: [] };

test('pool prioritizes the nearest five-hour reset and honors a custom order', () => {
  const quotas = { a: quota(50, 4), b: quota(99, 1), c: quota(20, 2) };
  assert.deepEqual(
    poolCandidates(profiles, quotas, settings, [], now).map((item) => item.id),
    ['b', 'c', 'a'],
  );
  assert.deepEqual(
    poolCandidates(
      profiles,
      quotas,
      { ...settings, strategy: 'manual', order: ['c', 'a', 'b'] },
      [],
      now,
    ).map((item) => item.id),
    ['c', 'a', 'b'],
  );
  assert.deepEqual(
    poolCandidates(profiles, quotas, settings, ['a', 'b'], now).map((item) => item.id),
    ['c'],
  );
});

test('exhausted, unreachable, stale, unknown and unsaved accounts cannot be selected', () => {
  assert.deepEqual(
    poolCandidates(
      profiles,
      { a: quota(20, 1), b: quota(30, 2) },
      { ...settings, disabled: ['a'] },
      [],
      now,
    ).map((profile) => profile.id),
    ['b'],
    'a successful quota probe must not re-enable a service whose full connection failed',
  );
  for (const snapshot of [
    quota(100, 2),
    quota(100, -1),
    quota(null, 2),
    { checkedAt: now, limits: { available: true, windows: [] } },
    quota(20, 2, { error: 'unreachable' }),
    quota(20, 2, { checkedAt: now - 180_000 }),
    { limits: null, checkedAt: now },
    quota(20, 2, { blockedUntil: now + 1000 }),
  ])
    assert.equal(poolCandidates([profiles[0]], { a: snapshot }, settings, [], now).length, 0);
  assert.equal(
    poolCandidates([{ ...profiles[0], remember: false }], { a: quota(20, 2) }, settings, [], now)
      .length,
    0,
  );
  const weekly = quota(10, 1);
  weekly.limits.windows.push({
    name: 'seven_day',
    utilization: 100,
    resetsAt: new Date(now + 86400_000).toISOString(),
  });
  assert.ok(exhausted(weekly, now));
  assert.equal(
    poolCandidates(
      profiles,
      { a: quota(100, 1), b: quota(100, 1), c: quota(100, 1) },
      settings,
      [],
      now,
    ).length,
    0,
  );
});

test('after a reset an account requires fresh telemetry and no longer keeps the old blocked state', () => {
  assert.equal(exhausted(quota(100, -1), now), false);
  assert.equal(
    poolCandidates(
      [profiles[0]],
      { a: quota(100, -1, { checkedAt: now - 3600_000 }) },
      settings,
      [],
      now,
    ).length,
    0,
  );
  assert.equal(poolCandidates([profiles[0]], { a: quota(0, 5) }, settings, [], now).length, 1);
  assert.equal(
    poolCandidates([profiles[0]], { a: quota(0, 5, { blockedUntil: now - 1 }) }, settings, [], now)
      .length,
    1,
  );
});

test('handoff carries the project, permissions, task and tool progress within the prompt limit', () => {
  const session = {
    title: '测试任务',
    projectPath: '/project',
    permissionMode: 'default',
    model: null,
    effort: 'high',
  };
  const payloads = [
    { type: 'message.user', messageId: 'user', text: '完成用户指定的功能' },
    { type: 'thinking.delta', messageId: 'hidden', text: '不传递的思考' },
    { type: 'tool.requested', toolId: 'tool', name: 'Bash', input: 'git status', target: 'local' },
    {
      type: 'tool.result',
      toolId: 'tool',
      status: 'completed',
      output: 'already changed',
      exitCode: 0,
    },
    { type: 'native.notice', text: 'compacting' },
    { type: 'native.compact', trigger: 'auto', previousTokens: 468496 },
    { type: 'run.error', code: 'quota_five_hour', message: 'quota' },
    { type: 'run.error', code: 'error_during_execution', message: 'generic final result' },
    { type: 'run.status', status: 'failed' },
  ];
  const events = payloads.map((payload, index) => ({
    sessionId: 'session',
    runId: 'run',
    sequence: index + 1,
    createdAt: new Date(now).toISOString(),
    payload,
  }));
  const handoff = handoffFor(session, events, '账号 A', ['a']);
  assert.deepEqual(handoff.session, session);
  assert.deepEqual(handoff.attempted, ['a']);
  assert.match(handoff.prompt, /完成用户指定的功能/);
  assert.match(handoff.prompt, /already changed/);
  assert.match(handoff.prompt, /上下文压缩：已完成，压缩前 468496 tokens/);
  assert.doesNotMatch(handoff.prompt, /compact：undefined/);
  assert.doesNotMatch(handoff.prompt, /不传递的思考/);
  assert.match(handoff.prompt, /不要重复执行/);
  assert.equal(quotaFailure(events).payload.code, 'quota_five_hour');
  events.at(-1).payload.status = 'cancelled';
  assert.equal(quotaFailure(events).payload.code, 'quota_five_hour');
  assert.equal(
    quotaFailure(events.filter((event) => event.payload.code !== 'quota_five_hour')),
    null,
  );
  events[0].payload.text = 'a'.repeat(50000);
  assert.ok(handoffFor(session, events, 'a', []).prompt.length < 15000);
  events.at(-1).payload.status = 'completed';
  assert.equal(quotaFailure(events), null);
});

test('global reset priority spends the soonest weekly allowance across services before five-hour reset', () => {
  const weekly = (fiveHours, weekHours, used = 20) => {
    const value = quota(used, fiveHours);
    value.limits.windows.push({
      name: 'seven_day',
      utilization: 19,
      resetsAt: new Date(now + weekHours * 3600_000).toISOString(),
    });
    return value;
  };
  const quotas = { a: weekly(4.9, 158), b: weekly(2.9, 16, 100), c: weekly(0, 11) };
  quotas.c.limits.windows[0].resetsAt = null;
  assert.deepEqual(
    poolCandidates(profiles, quotas, settings, [], now).map((p) => p.id),
    ['c', 'a'],
  );
  quotas.a.limits.windows[1].resetsAt = quotas.c.limits.windows[1].resetsAt;
  assert.deepEqual(
    poolCandidates(profiles, quotas, settings, [], now).map((p) => p.id),
    ['a', 'c'],
  );
});
