import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conversation } from '../src/transcript.ts';

let sequence = 0;
const at = (second) => new Date(Date.UTC(2026, 9, 26, 12, 0, second)).toISOString();
const event = (runId, second, payload) => ({
  sessionId: 'session',
  runId,
  sequence: ++sequence,
  createdAt: at(second),
  payload,
});
const said = (runId, second, messageId, text) =>
  event(runId, second, { type: 'text.delta', messageId, text });

test('an automatic compaction is one mark among the steps, with what came after it under it', () => {
  const turns = conversation([
    event('run', 0, { type: 'message.user', messageId: 'question', text: '做事' }),
    said('run', 1, 'before', '压缩前'),
    event('run', 2, { type: 'native.notice', text: 'compacting' }),
    event('run', 3, { type: 'native.notice', text: 'compacting' }),
    event('run', 4, { type: 'native.notice', text: 'compacting' }),
    event('run', 5, { type: 'native.notice', text: 'status' }),
    event('run', 6, { type: 'native.compact', trigger: 'auto', previousTokens: 468496 }),
    said('run', 7, 'after', '压缩后'),
  ]);
  assert.equal(turns.length, 1);
  assert.deepEqual(
    turns[0].steps.map((step) => step.kind),
    ['assistant', 'compact', 'assistant'],
  );
  const mark = turns[0].steps[1];
  assert.equal(mark.at, at(2));
  assert.equal(mark.endedAt, at(6));
  assert.equal(mark.previousTokens, 468496);
  assert.deepEqual(turns[0].notices, []);
});

test('"continue" takes the stopped turn up again instead of starting one of its own', () => {
  const stats = (messageId, outputTokens, outputPerSecond) => ({
    type: 'turn.stats',
    messageId,
    requests: 1,
    inputTokens: 1,
    outputTokens,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    modelMs: 1000,
    ttftMs: 100,
    outputPerSecond,
    partial: false,
  });
  const turns = conversation([
    event('first', 0, { type: 'message.user', messageId: 'question', text: '做事' }),
    said('first', 1, 'one', '第一段'),
    event('first', 2, { type: 'run.status', status: 'cancelled', reason: '用户停止' }),
    event('first', 2, stats('question', 100, 100)),
    event('second', 62, {
      type: 'message.user',
      messageId: 'again',
      text: '继续',
      continued: true,
    }),
    event('second', 62, { type: 'message.delivery', messageId: 'again', status: 'received' }),
    said('second', 63, 'two', '第二段'),
    event('second', 64, { type: 'run.status', status: 'completed' }),
    event('second', 64, stats('again', 300, 100)),
  ]);
  assert.equal(turns.length, 1);
  const [turn] = turns;
  assert.equal(turn.question.text, '做事');
  assert.deepEqual(
    turn.steps.map((step) => step.kind),
    ['assistant', 'notice', 'note'],
  );
  assert.equal(turn.steps[2].text, '继续 · 原生已接收');
  assert.equal(turn.answer.text, '第二段');
  assert.equal(turn.outcome, undefined);
  assert.equal(turn.pausedMs, 60000);
  assert.equal(turn.stats.outputTokens, 400);
  assert.equal(turn.stats.outputPerSecond, 100);
});
