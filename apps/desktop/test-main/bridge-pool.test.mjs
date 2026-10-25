import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgePool } from '../electron/bridge-pool.cjs';

test('parallel services retain independent bridges and scoped reconnect/close', async () => {
  const counts = [];
  const pool = new BridgePool((count) => counts.push(count));
  const closed = [];
  const open = (id) => async () => ({ url: id, close: async () => closed.push(id) });
  const a = await pool.connect('a', open('a1'));
  const b = await pool.connect('b', open('b1'));
  assert.deepEqual(closed, []);
  await pool.connect('a', open('a2'));
  assert.deepEqual(closed, ['a1']);
  assert.equal(pool.entries.get('b'), b);
  assert.notEqual(pool.entries.get('a'), a);
  await pool.disconnect('a');
  assert.equal(pool.entries.size, 1);
  assert.equal(counts.at(-1), 1);
  assert.equal(pool.last.get('b'), b);
  await pool.close();
  assert.equal(pool.entries.size, 0);
  assert.deepEqual(closed, ['a1', 'a2', 'b1']);
});

test('a cancelled in-flight bridge never replaces its successor or another service', async () => {
  const pool = new BridgePool();
  let resolve;
  let started;
  const opening = new Promise((done) => {
    started = done;
  });
  let closed = 0;
  const first = pool.connect('a', async () => {
    started();
    return await new Promise((done) => {
      resolve = done;
    });
  });
  await opening;
  const b = await pool.connect('b', async () => ({ close: async () => {} }));
  const replacement = await pool.connect('a', async () => ({ close: async () => {} }));
  resolve({
    close: async () => {
      closed++;
    },
  });
  await assert.rejects(first, /cancelled/);
  assert.equal(closed, 1);
  assert.equal(pool.entries.get('a'), replacement);
  assert.equal(pool.entries.get('b'), b);
  await pool.close();
});
