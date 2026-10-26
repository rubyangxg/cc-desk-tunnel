import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { NativeGoal, goalReply, goalStatus, probeGoal } from '../src/native-goal.ts';
import { NativeInput } from '../src/native-input.ts';
import { SessionStore } from '../src/store.ts';

const local = (args: string, text: string) =>
  ({
    type: 'assistant',
    parent_tool_use_id: null,
    local_command_source: `<local-command-stdout>${text}</local-command-stdout>`,
    local_command_run: { command: 'goal', args },
    message: { model: '<synthetic>', content: [{ type: 'text', text }] },
  }) as unknown as SDKMessage;

test('goal acknowledgements require native provenance and preserve multiline conditions', () => {
  const text = 'Goal set: 完成第 1 项\n再验证（A）';
  const command = local('完成第 1 项\n再验证（A）', text);
  assert.equal(goalReply(command)?.text, text);
  assert.equal(goalReply({ ...command, local_command_run: undefined }), undefined);
  assert.equal(goalReply({ ...command, parent_tool_use_id: randomUUID() }), undefined);
  assert.equal(
    goalReply({ ...command, message: { model: 'real-model', content: [{ type: 'text', text }] } }),
    undefined,
  );
  assert.deepEqual(goalStatus('Goal active: 第一行 (x)\n第二行 (3 turns)\nLast check: 尚未通过'), {
    condition: '第一行 (x)\n第二行',
    iterations: 3,
    lastReason: '尚未通过',
  });
  assert.throws(() => goalStatus('unknown command'));
});

test('goal state is durable independently of history excerpts and forks are paused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-goal-store-'));
  let store = new SessionStore(dir);
  try {
    const session = store.create(randomUUID(), 'goal', '/project', {
      id: randomUUID(),
      name: 'test',
      platform: 'linux',
    });
    const events: EventPayload[] = [];
    const goal = new NativeGoal(undefined, (payload) => {
      events.push(payload);
      store.append(session.id, randomUUID(), payload);
    });
    goal.observe(local('验收条件', 'Goal set: 验收条件'));
    const state = store.get(session.id).session.goal;
    assert.equal(state?.status, 'active');
    store.continuationContext(session.id, '完成第 1 项，请继续第 2 项');
    store.close();
    store = new SessionStore(dir);
    assert.deepEqual(store.get(session.id).session.goal, state);
    assert.equal(store.continuationContext(session.id), '完成第 1 项，请继续第 2 项');
    assert.ok(
      !JSON.stringify(store.list()).includes('完成第 1 项'),
      'private context is not sent in session lists',
    );
    const nativeFork = store.fork(randomUUID(), session.id, randomUUID(), 'native fork', true, {
      device: { id: randomUUID(), name: 'test', platform: 'linux' },
    });
    assert.equal(store.continuationContext(nativeFork.id), '完成第 1 项，请继续第 2 项');
    store.selectAccount(session.id, randomUUID());
    assert.equal(
      store.continuationContext(session.id),
      undefined,
      'another native segment needs a fresh handoff excerpt',
    );
    assert.deepEqual(store.get(session.id).session.goal, state);
    const fork = store.fork(randomUUID(), session.id, randomUUID(), 'fork', false, {
      device: { id: randomUUID(), name: 'test', platform: 'linux' },
    });
    assert.equal(fork.goal?.status, 'paused');
    goal.observe(local('clear', 'Goal cleared: 验收条件'));
    assert.equal(store.get(session.id).session.goal?.status, 'cleared');
    assert.equal(events.filter((event) => event.type === 'native.goal').length, 2);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  'official CLI local goal probes work without a model request',
  { skip: !process.env.NATIVE_GOAL_TEST_CLI, timeout: 30000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-native-goal-'));
    const input = new NativeInput(randomUUID(), () => {});
    input.hold();
    const session = query({
      prompt: input.stream(),
      options: {
        cwd: dir,
        pathToClaudeCodeExecutable: process.env.NATIVE_GOAL_TEST_CLI,
        persistSession: false,
        env: {
          ...process.env,
          HOME: dir,
          CLAUDE_CONFIG_DIR: dir,
          ANTHROPIC_API_KEY: 'offline-goal-probe',
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      },
    });
    try {
      await session.initializationResult();
      const messages = session[Symbol.asyncIterator]();
      assert.equal(await probeGoal(session, messages, input), null);
      assert.equal(await probeGoal(session, messages, input, true), null);
    } finally {
      input.close();
      session.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
