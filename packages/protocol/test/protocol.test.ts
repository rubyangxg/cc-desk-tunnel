import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  PROTOCOL_HISTORY,
  PROTOCOL_VERSION,
  clientServerMessageSchema,
  serverMessageSchema,
  fallbackServerProtocol,
  authSchema,
  commandSchema,
  eventSchema,
  terminalControlSchema,
} from '../src/index.ts';

test('only clients accept the audited v0.3.1 protocol and retry its version refusal once', () => {
  const ready = {
    type: 'ready',
    protocolVersion: 16,
    version: '0.3.1',
    connectionId: randomUUID(),
    adapter: 'claude-code',
    sessions: [],
  };
  assert.equal(clientServerMessageSchema.safeParse(ready).success, true);
  assert.equal(serverMessageSchema.safeParse(ready).success, false);
  for (const protocolVersion of [15, PROTOCOL_VERSION + 1, 9999])
    assert.equal(clientServerMessageSchema.safeParse({ ...ready, protocolVersion }).success, false);
  const refusal = {
    type: 'connection.error' as const,
    code: 'version_mismatch',
    service: '0.3.1',
    message: 'Incompatible protocol',
  };
  assert.equal(
    clientServerMessageSchema.safeParse({ ...ready, protocolVersion: 17 }).success,
    true,
  );
  assert.equal(serverMessageSchema.safeParse({ ...ready, protocolVersion: 17 }).success, false);
  assert.equal(fallbackServerProtocol(refusal, PROTOCOL_VERSION), 16);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.9' }, PROTOCOL_VERSION), 17);
  assert.equal(
    clientServerMessageSchema.safeParse({ ...ready, protocolVersion: 18 }).success,
    true,
  );
  assert.equal(serverMessageSchema.safeParse({ ...ready, protocolVersion: 18 }).success, false);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.10' }, PROTOCOL_VERSION), 18);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.10' }, 18), null);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.20' }, PROTOCOL_VERSION), 19);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.20' }, 19), null);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.29' }, PROTOCOL_VERSION), 20);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.34' }, PROTOCOL_VERSION), 21);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.4.34' }, 21), null);
  assert.equal(
    clientServerMessageSchema.safeParse({ ...ready, protocolVersion: 21 }).success,
    true,
  );
  assert.equal(serverMessageSchema.safeParse({ ...ready, protocolVersion: 21 }).success, false);
  assert.equal(fallbackServerProtocol(refusal, 17), 16);
  assert.equal(fallbackServerProtocol(refusal, 16), null);
  assert.equal(fallbackServerProtocol({ ...refusal, service: '0.2.13' }, 17), null);
  assert.equal(fallbackServerProtocol({ ...refusal, code: 'unauthorized' }, 17), null);
});

test('handoff recovery requires an explicit bounded queue snapshot', () => {
  const command = {
    type: 'session.handoff.cancel',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    queueIds: [randomUUID()],
  };
  assert.ok(commandSchema.safeParse(command).success);
  for (const queueIds of [
    undefined,
    [],
    ['invalid'],
    Array.from({ length: 21 }, () => randomUUID()),
  ])
    assert.equal(commandSchema.safeParse({ ...command, queueIds }).success, false);
  const handoff = { ...command, type: 'session.handoff', confirmedMessageIds: [randomUUID()] };
  assert.ok(commandSchema.safeParse(handoff).success);
  assert.equal(
    commandSchema.safeParse({ ...handoff, confirmedMessageIds: ['invalid'] }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({ ...handoff, type: 'run.handoff', runId: randomUUID() }).success,
    false,
  );
});

test('protocol validates UTF-8 text, IDs and bounded input', () => {
  const command = {
    type: 'message.send',
    requestId: randomUUID(),
    sessionId: randomUUID(),
    text: ' 检查 D:\\工作\\测试 ',
  };
  const parsed = commandSchema.parse(command);
  assert.equal(parsed.type, 'message.send');
  if (parsed.type === 'message.send') assert.equal(parsed.text, '检查 D:\\工作\\测试');
  assert.equal(commandSchema.safeParse({ ...command, text: ' ' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, text: 'a'.repeat(16001) }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, sessionId: 'not-an-id' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, token: 'unexpected' }).success, false);
});

test('the protocol history ends with the current version', () => {
  assert.equal(Object.values(PROTOCOL_HISTORY).at(-1), PROTOCOL_VERSION);
});
test('authentication version and event ordering are explicit', () => {
  const auth = {
    type: 'auth',
    protocolVersion: PROTOCOL_VERSION,
    token: 'x'.repeat(32),
    deviceName: '开发机',
  };
  assert.equal(authSchema.safeParse(auth).success, true);
  // Another version still authenticates, so that the service can answer with how to upgrade.
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 9999 }).success, true);
  assert.equal(authSchema.safeParse({ ...auth, protocolVersion: 0 }).success, false);
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload: { type: 'run.status', status: 'running', connectionId: randomUUID() },
  };
  assert.equal(eventSchema.safeParse(event).success, true);
  assert.equal(eventSchema.safeParse({ ...event, sequence: 0 }).success, false);
});

test('terminal control frames are explicitly scoped and bounded without request caches', () => {
  const frame = {
    type: 'terminal.input',
    sessionId: randomUUID(),
    terminalId: randomUUID(),
    data: '中文\r',
  };
  assert.equal(terminalControlSchema.safeParse(frame).success, true);
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, data: 'x'.repeat(8193) }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({ ...frame, requestId: randomUUID() }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.ack',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      bytes: -1,
    }).success,
    false,
  );
  assert.equal(
    terminalControlSchema.safeParse({
      type: 'terminal.resize',
      sessionId: frame.sessionId,
      terminalId: frame.terminalId,
      cols: 0,
      rows: 30,
    }).success,
    false,
  );
});

test('a run waiting only for background tasks, its task list and the request to end one are valid', () => {
  const event = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
  };
  const status = { type: 'run.status', status: 'running', connectionId: randomUUID() };
  assert.ok(
    eventSchema.safeParse({ ...event, payload: { ...status, waiting: 'background' } }).success,
  );
  assert.ok(
    eventSchema.safeParse({
      ...event,
      payload: {
        type: 'native.tasks',
        tasks: [{ id: 'b1', kind: 'local_bash', description: '渲染' }],
      },
    }).success,
  );
  const stop = {
    type: 'run.task.stop',
    requestId: randomUUID(),
    sessionId: event.sessionId,
    runId: event.runId,
    taskId: 'b1',
  };
  assert.ok(commandSchema.safeParse(stop).success);
  assert.equal(commandSchema.safeParse({ ...stop, taskId: '' }).success, false);
  const background = {
    type: 'run.task.background',
    requestId: randomUUID(),
    sessionId: event.sessionId,
    runId: event.runId,
    toolId: 'call-1',
  };
  assert.ok(commandSchema.safeParse(background).success);
  assert.equal(commandSchema.safeParse({ ...background, toolId: '' }).success, false);
  assert.ok(
    eventSchema.safeParse({
      ...event,
      payload: { type: 'tool.task', toolId: 'call-1', taskId: 'b1' },
    }).success,
  );
});

test('a session report is asked for by session and answers with its figures', () => {
  const requestId = randomUUID();
  const sessionId = randomUUID();
  assert.ok(commandSchema.safeParse({ type: 'session.stats', requestId, sessionId }).success);
  assert.equal(commandSchema.safeParse({ type: 'session.stats', requestId }).success, false);
  const stats = {
    type: 'session.stats',
    requestId,
    sessionId,
    turns: 2,
    requests: 4,
    inputTokens: 40,
    outputTokens: 1000,
    cacheReadTokens: 4000,
    cacheCreationTokens: 200,
    modelMs: 11500,
    ttftMs: null,
    outputPerSecond: null,
    firstRecordAt: null,
  };
  assert.equal(serverMessageSchema.safeParse(stats).success, true);
  assert.equal(serverMessageSchema.safeParse({ ...stats, turns: -1 }).success, false);
  assert.equal(
    serverMessageSchema.safeParse({ ...stats, firstRecordAt: 'yesterday' }).success,
    false,
  );
});

test('a turn report names the message it answered, or none for a turn a background task started', () => {
  const stats = {
    type: 'turn.stats',
    requests: 3,
    inputTokens: 10,
    outputTokens: 200,
    cacheReadTokens: 1000,
    cacheCreationTokens: 50,
    modelMs: 5500,
    ttftMs: null,
    outputPerSecond: null,
    partial: false,
  };
  const event = (payload: object) => ({
    sessionId: randomUUID(),
    runId: randomUUID(),
    sequence: 1,
    createdAt: new Date().toISOString(),
    payload,
  });
  assert.equal(eventSchema.safeParse(event({ ...stats, messageId: randomUUID() })).success, true);
  assert.equal(eventSchema.safeParse(event(stats)).success, true);
  assert.equal(eventSchema.safeParse(event({ ...stats, requests: -1 })).success, false);
  assert.equal(eventSchema.safeParse(event({ ...stats, partial: undefined })).success, false);
});
