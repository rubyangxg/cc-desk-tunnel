import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { EventPayload } from '@cc-desk-tunnel/protocol';
import { ClaudeStream } from '../src/claude-stream.ts';

test('only a rejected five-hour quota with no allowed overage produces a pool exhaustion signal', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  for (const rate_limit_info of [
    { status: 'allowed_warning', rateLimitType: 'five_hour' },
    { status: 'rejected', rateLimitType: 'seven_day' },
    { status: 'rejected', rateLimitType: 'five_hour', overageStatus: 'allowed' },
  ])
    stream.accept({ type: 'rate_limit_event', rate_limit_info });
  assert.equal(events.length, 0);
  stream.accept({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2000000000 },
  });
  assert.deepEqual(events, [
    {
      type: 'run.error',
      code: 'quota_five_hour',
      message: 'Claude 5 小时额度已耗尽。',
      resetsAt: new Date(2000000000000).toISOString(),
    },
  ]);
});

test('native partial text/thinking are not duplicated by complete assistant events', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    claude_code_version: '2.1.286',
  });
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '' } },
  });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '公开推理' } },
  });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'thinking', thinking: '公开推理' }] },
  });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '实际增量' } },
  });
  stream.accept({ type: 'assistant', message: { content: [{ type: 'text', text: '实际增量' }] } });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: '实际增量' });
  assert.equal(events.filter((event) => event.type === 'text.delta').length, 1);
  assert.equal(events.filter((event) => event.type === 'thinking.delta').length, 1);
  assert.equal(stream.result?.failed, false);
});
test('native Bash input, permission identity and unmodified tool results remain correlated', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  const toolId = 'call_native_not_uuid';
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: 'Bash', input: {} },
    },
  });
  stream.accept({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"command":"ssh -F config windows"}' },
    },
  });
  stream.accept({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: toolId,
          name: 'Bash',
          input: { command: 'ssh -F config windows' },
        },
      ],
    },
  });
  assert.equal(stream.tool('Bash', { command: 'ssh -F config windows' }, toolId).id, toolId);
  stream.accept({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolId,
          is_error: true,
          content: 'D:\\中文\nExit code 5',
        },
      ],
    },
  });
  assert.equal(events.filter((event) => event.type === 'tool.requested').length, 1);
  const result = events.find((event) => event.type === 'tool.result');
  assert.ok(result?.type === 'tool.result');
  assert.equal(result.toolId, toolId);
  assert.equal(result.exitCode, null);
  assert.equal(result.status, 'failed');
  assert.match(result.output, /D:\\中文/);
});
test('native denials and upstream failures are represented without inventing a policy', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'example' }, 'native-tool').denied = true;
  stream.accept({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'native-tool',
          is_error: true,
          content: 'Permission denied',
        },
      ],
    },
  });
  assert.ok(events.some((event) => event.type === 'tool.result' && event.status === 'denied'));
  stream.accept({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['Upstream failed'],
  });
  assert.equal(stream.result?.failed, true);
  assert.ok(
    events.some((event) => event.type === 'run.error' && event.message === 'Upstream failed'),
  );
});
test('identical concurrent native calls keep their IDs and progress uses real SDK events', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.tool('Bash', { command: 'same' }, 'call-1');
  stream.tool('Bash', { command: 'same' }, 'call-2');
  assert.equal(stream.tools.size, 2);
  stream.accept({ type: 'tool_progress', tool_use_id: 'call-2', elapsed_time_seconds: 3 });
  assert.ok(
    events.some(
      (event) =>
        event.type === 'tool.progress' && event.toolId === 'call-2' && event.elapsedSeconds === 3,
    ),
  );
  stream.accept({ type: 'system', subtype: 'informational', content: 'Native notice' });
  assert.ok(
    events.some((event) => event.type === 'native.notice' && event.text === 'Native notice'),
  );
});
test('requested and effective native approval modes remain distinct', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event), 'auto');
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    permissionMode: 'default',
  });
  const init = events.find((event) => event.type === 'native.session');
  assert.ok(init?.type === 'native.session');
  assert.equal(init.requestedPermissionMode, 'auto');
  assert.equal(init.permissionMode, 'default');
  assert.ok(
    events.some((event) => event.type === 'native.notice' && event.text.includes('default')),
  );
});

test('native compact metadata and effective effort are forwarded without local summarization', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event), 'plan', 'high');
  stream.accept({
    type: 'system',
    subtype: 'init',
    session_id: randomUUID(),
    model: 'test',
    permissionMode: 'plan',
    effort: 'medium',
  });
  stream.accept({
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'manual', pre_tokens: 5432 },
  });
  const session = events.find((event) => event.type === 'native.session');
  assert.ok(session?.type === 'native.session');
  assert.equal(session.requestedEffort, 'high');
  assert.equal(session.effort, 'medium');
  assert.ok(
    events.some(
      (event) =>
        event.type === 'native.compact' &&
        event.previousTokens === 5432 &&
        event.trigger === 'manual',
    ),
  );
});

test('the model requests of a turn are counted from their start events', () => {
  const stream = new ClaudeStream(() => {});
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({ type: 'stream_event', event: { type: 'message_stop' } });
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(stream.requests, 2);
  stream.requests = 0;
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  assert.equal(stream.requests, 1);
});

test('local slash-command output and native goal updates are visible without becoming model output', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({ type: 'system', subtype: 'local_command_output', content: 'Goal configured' });
  stream.accept({
    type: 'active_goal',
    value: { condition: 'All tests pass', last_reason: 'Two failures remain' },
  });
  stream.accept({ type: 'active_goal', value: null });
  assert.deepEqual(events, [
    {
      type: 'text.delta',
      messageId: (events[0] as { messageId: string }).messageId,
      text: '```text\nGoal configured\n```',
    },
    { type: 'native.notice', text: '当前目标：All tests pass\nTwo failures remain' },
    { type: 'native.notice', text: '目标已完成或清除。' },
  ]);
});

test('what a local command printed becomes a reply of its own, without terminal colours', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({
    type: 'system',
    subtype: 'local_command_output',
    content: '\u001b[1mContext\u001b[0m 12%',
    uuid: randomUUID(),
    session_id: randomUUID(),
  });
  assert.equal(events.length, 1);
  assert.ok(events[0].type === 'text.delta');
  assert.equal(events[0].text, '```text\nContext 12%\n```');
});

test('a local command that prints plain text is shown as printed, its dollars no formula', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  const usage =
    'Total cost:            $0.0919 (costs may be inaccurate)\nUsage by model:\n  gpt-5.6-terra:  16.2k input ($0.0919)';
  stream.accept({ type: 'assistant', message: { content: [{ type: 'text', text: usage }] } });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: usage });
  // A reply of the model that is plain text stays as it came.
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '$x$ 是变量' }] },
  });
  const texts = events.flatMap((event) => (event.type === 'text.delta' ? [event.text] : []));
  assert.deepEqual(texts, ['```text\n' + usage + '\n```', '$x$ 是变量']);
});

test('a local command answered after a streamed reply is shown as a reply of its own', () => {
  const events: EventPayload[] = [];
  const stream = new ClaudeStream((event) => events.push(event));
  stream.accept({ type: 'stream_event', event: { type: 'message_start' } });
  stream.accept({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '模型的回答' } },
  });
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '模型的回答' }] },
  });
  stream.accept({ type: 'result', subtype: 'success', is_error: false, result: '模型的回答' });
  // Claude Code 2.1.293 answers /context and /usage with a whole message, and no model request before it.
  stream.accept({
    type: 'assistant',
    message: { content: [{ type: 'text', text: '## Context Usage' }] },
  });
  stream.accept({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '## Context Usage',
  });
  const texts = events.filter((event) => event.type === 'text.delta');
  assert.deepEqual(
    texts.map((event) => event.text),
    ['模型的回答', '## Context Usage'],
  );
  assert.notEqual(texts[0].messageId, texts[1].messageId);
});
