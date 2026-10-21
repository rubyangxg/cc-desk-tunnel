import { test } from 'node:test';
import assert from 'node:assert/strict';
import { otherSessions, sessionSource } from '../src/sessionCatalog.ts';

test('catalog scopes UUIDs by endpoint, removes unconfigured sources, and never stores tokens', () => {
  const a = sessionSource({
    id: 'a',
    name: 'A',
    url: 'wss://a.example/ws',
    fingerprint: 'AA:BB',
    token: 'secret',
  });
  const b = sessionSource({ id: 'b', name: 'B', url: 'wss://b.example/ws', fingerprint: '' });
  const alias = { ...b, id: 'alias' };
  const session = {
    id: 'same',
    title: 'shared UUID',
    updatedAt: '2026-10-21',
    activeRun: { id: 'running' },
  };
  const entries = [a, b, alias].map((source) => ({ source, sessions: [session], checkedAt: 1 }));
  assert.equal(JSON.stringify(a).includes('secret'), false);
  const fromA = otherSessions(entries, a, [a, b, alias]);
  assert.equal(fromA.length, 1, 'duplicate server connections are deduplicated');
  assert.equal(fromA[0].source.id, 'b');
  assert.equal(fromA[0].display.activeRun, null, 'cached metadata never claims a live run');
  assert.equal(fromA[0].session.id, 'same', 'routing keeps the original UUID');
  assert.notEqual(fromA[0].display.id, otherSessions(entries, b, [a, b])[0].display.id);
  assert.deepEqual(
    otherSessions([...entries, { source: alias, sessions: [], checkedAt: 2 }], a, [a, b, alias]),
    [],
    'a newer empty alias cannot resurrect deleted sessions',
  );
  assert.deepEqual(otherSessions(entries, a, [a]), []);
  assert.deepEqual(otherSessions(entries, a, [a, { ...b, fingerprint: 'changed' }]), []);
});
