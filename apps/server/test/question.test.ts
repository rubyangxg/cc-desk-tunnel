import assert from 'node:assert/strict';
import test from 'node:test';
import { inOrder, questionTally } from '../src/question.ts';

const turn = (requests: number, outputTokens: number, promptIds: string[], messageId?: string) => ({
  messageId,
  startedAt: requests * 1000,
  requests,
  outputTokens,
  promptIds,
});

test('a question that took one turn is reported as that turn', () => {
  const tally = questionTally();
  assert.deepEqual(tally(turn(2, 300, ['p1'], 'm1')), turn(2, 300, ['p1'], 'm1'));
});

test('a turn a background task started carries on the question before it', () => {
  const tally = questionTally();
  tally({ ...turn(2, 222, ['p1'], 'm1'), startedAt: 100 });
  // Each later turn has a prompt of its own and no user message; the question keeps its message and its start.
  const second = tally({ ...turn(1, 46, ['p2']), startedAt: 200 });
  assert.deepEqual(second, {
    messageId: 'm1',
    startedAt: 100,
    requests: 3,
    outputTokens: 268,
    promptIds: ['p1', 'p2'],
  });
  const third = tally({ ...turn(1, 66, ['p3']), startedAt: 300 });
  assert.deepEqual(third, {
    messageId: 'm1',
    startedAt: 100,
    requests: 4,
    outputTokens: 334,
    promptIds: ['p1', 'p2', 'p3'],
  });
});

test('the next user message starts a question of its own, without the ones before it', () => {
  const tally = questionTally();
  tally(turn(2, 222, ['p1'], 'm1'));
  tally(turn(1, 46, ['p2']));
  assert.deepEqual(tally(turn(1, 10, ['p3'], 'm2')), turn(1, 10, ['p3'], 'm2'));
  // A turn after it belongs to it.
  assert.deepEqual(tally(turn(1, 5, ['p4'])).promptIds, ['p3', 'p4']);
  assert.equal(tally(turn(1, 5, ['p5'])).messageId, 'm2');
});

test('a run that resumed on a turn from a background task has no message until one is sent', () => {
  const tally = questionTally();
  const first = tally(turn(1, 4, ['p1']));
  assert.equal(first.messageId, undefined);
  assert.equal(tally(turn(1, 4, ['p2'])).requests, 2);
  assert.equal(tally(turn(1, 4, ['p3'], 'm1')).requests, 1);
});

test('the figures given out are copies: later turns do not change what was reported', () => {
  const tally = questionTally();
  const first = tally(turn(2, 222, ['p1'], 'm1'));
  tally(turn(1, 46, ['p2']));
  assert.deepEqual(first.promptIds, ['p1']);
  assert.equal(first.requests, 2);
});

test('a turn without prompts adds only its requests and output', () => {
  const tally = questionTally();
  tally(turn(2, 222, ['p1'], 'm1'));
  const next = tally(turn(1, 4, []));
  assert.deepEqual(next.promptIds, ['p1']);
  assert.equal(next.requests, 3);
  assert.equal(next.outputTokens, 226);
});

test('tasks run one after another in the order given, however long each takes', async () => {
  const run = inOrder();
  const done: string[] = [];
  const task = (name: string, ms: number) => async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    done.push(name);
  };
  await Promise.all([run(task('slow', 40)), run(task('fast', 1)), run(task('middle', 10))]);
  assert.deepEqual(done, ['slow', 'fast', 'middle']);
});

test('a task starts only once the one before it has finished', async () => {
  const run = inOrder();
  let running = 0;
  let most = 0;
  const task = async () => {
    most = Math.max(most, ++running);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running--;
  };
  await Promise.all([run(task), run(task), run(task)]);
  assert.equal(most, 1);
});

test('a task that fails does not hold back the next one, and the failure is not thrown', async () => {
  const run = inOrder();
  const done: string[] = [];
  await run(async () => {
    throw new Error('no figures');
  });
  await run(async () => {
    done.push('next');
  });
  assert.deepEqual(done, ['next']);
});
