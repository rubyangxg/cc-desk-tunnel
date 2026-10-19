import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../src/store.ts';

const desktop = { id: randomUUID(), name: '台式机' };
const laptop = { id: randomUUID(), name: '笔记本' };
const mac = { id: randomUUID(), name: 'MacBook', platform: 'darwin' as const };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-roots-'));
  let store = new SessionStore(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    reopen() {
      store.close();
      return (store = new SessionStore(directory));
    },
  };
}
const create = (store: SessionStore, path: string, device = desktop) =>
  store.create(randomUUID(), '会话', path, device);
// What a first native run leaves behind: a native session to resume.
function ran(store: SessionStore, sessionId: string) {
  store.append(sessionId, randomUUID(), {
    type: 'native.session',
    nativeSessionId: sessionId,
    model: 'test',
    version: 'test',
  });
}
const root = (store: SessionStore, sessionId: string) => store.get(sessionId).session.nativeRoot;

test('the sessions of a project share its directory, as written in any form of the same path', (t) => {
  const { store } = fixture(t);
  const first = create(store, 'D:\\项目\\甲').nativeRoot;
  assert.ok(first);
  assert.equal(create(store, 'd:/项目/甲/').nativeRoot, first);
  assert.equal(create(store, 'D:\\项目\\甲\\\\').nativeRoot, first);
  // Another project, the same path on another computer, and each folder of a session without a project are
  // places of their own.
  const others = [
    create(store, 'D:\\项目\\乙').nativeRoot,
    create(store, 'D:\\项目\\甲', laptop).nativeRoot,
    create(store, 'D:\\Documents\\CC Desk Tunnel\\2026-10-19\\101500').nativeRoot,
    create(store, 'D:\\Documents\\CC Desk Tunnel\\2026-10-19\\101502').nativeRoot,
  ];
  assert.equal(new Set([first, ...others]).size, 5);
  // A POSIX path is taken as written, letter case included.
  const posix = create(store, '/Users/me/项目', mac).nativeRoot;
  assert.equal(create(store, '/Users/me/项目/', mac).nativeRoot, posix);
  assert.notEqual(create(store, '/Users/me/项目'.toUpperCase(), mac).nativeRoot, posix);
});

test('a session from before projects had a directory keeps its own, also when it moves', (t) => {
  const made = fixture(t);
  const session = create(made.store, 'D:\\项目\\甲');
  ran(made.store, session.id);
  made.store.database.exec("UPDATE sessions SET metadata = json_remove(metadata, '$.nativeRoot')");
  const store = made.reopen();
  assert.equal(root(store, session.id), undefined);
  store.move(session.id, 'D:\\项目\\乙', desktop);
  assert.equal(root(store, session.id), undefined);
});

test('a session takes the directory of the project it moves to until it has history, and keeps it after', (t) => {
  const { store } = fixture(t);
  const target = create(store, 'D:\\项目\\乙').nativeRoot;
  const fresh = create(store, 'D:\\项目\\甲');
  assert.equal(store.move(fresh.id, 'D:\\项目\\乙', desktop).nativeRoot, target);
  const talked = create(store, 'D:\\项目\\甲');
  ran(store, talked.id);
  assert.equal(store.move(talked.id, 'D:\\项目\\乙', desktop).nativeRoot, talked.nativeRoot);
  assert.equal(store.move(talked.id, 'D:\\项目\\甲', laptop).nativeRoot, talked.nativeRoot);
});

test('a fork with history stays beside its source; one without takes the directory of where it goes', (t) => {
  const { store } = fixture(t);
  const source = create(store, 'D:\\项目\\甲');
  const place = { device: laptop, projectPath: 'E:\\别处' };
  const empty = store.fork(randomUUID(), source.id, randomUUID(), '分叉', false, place);
  assert.equal(empty.nativeRoot, create(store, 'E:\\别处', laptop).nativeRoot);
  ran(store, source.id);
  const native = store.fork(randomUUID(), source.id, randomUUID(), '分叉', true, place);
  assert.equal(native.nativeRoot, source.nativeRoot);
});

test('a project moved to another folder takes its directory along, with all its sessions', (t) => {
  const { store } = fixture(t);
  const talked = create(store, 'D:\\项目\\甲');
  ran(store, talked.id);
  const fresh = create(store, 'd:/项目/甲');
  const elsewhere = create(store, 'D:\\项目\\甲', laptop);
  const moved = store.moveProject('D:\\项目\\甲', 'E:\\新家\\甲', desktop);
  assert.deepEqual(moved.map(({ id }) => id).sort(), [talked.id, fresh.id].sort());
  assert.ok(moved.every(({ projectPath }) => projectPath === 'E:\\新家\\甲'));
  // Memory stays with the project: what was its directory is now that of the new folder.
  assert.equal(root(store, fresh.id), talked.nativeRoot);
  assert.equal(create(store, 'E:\\新家\\甲').nativeRoot, talked.nativeRoot);
  // The old folder is a new place, and the other computer's project is untouched.
  assert.notEqual(create(store, 'D:\\项目\\甲').nativeRoot, talked.nativeRoot);
  assert.equal(store.get(elsewhere.id).session.projectPath, 'D:\\项目\\甲');
  assert.equal(root(store, elsewhere.id), elsewhere.nativeRoot);
});

test('a project moved onto a folder that has a directory keeps the history of its sessions where it is', (t) => {
  const { store } = fixture(t);
  const target = create(store, 'D:\\项目\\乙').nativeRoot;
  const talked = create(store, 'D:\\项目\\甲');
  ran(store, talked.id);
  const fresh = create(store, 'D:\\项目\\甲');
  store.moveProject('D:\\项目\\甲', 'D:\\项目\\乙', desktop);
  assert.equal(root(store, talked.id), talked.nativeRoot);
  assert.equal(root(store, fresh.id), target);
});

test('a project with a running session does not move', (t) => {
  const { store } = fixture(t);
  const session = create(store, 'D:\\项目\\甲');
  store.append(session.id, randomUUID(), {
    type: 'run.status',
    status: 'running',
    connectionId: randomUUID(),
  });
  assert.throws(() => store.moveProject('D:\\项目\\甲', 'E:\\甲', desktop), /正在运行/);
  assert.equal(store.get(session.id).session.projectPath, 'D:\\项目\\甲');
  assert.equal(create(store, 'D:\\项目\\甲').nativeRoot, session.nativeRoot);
});

test('project memory is shared within an account and isolated across accounts, including moves and restart', (t) => {
  const f = fixture(t);
  const a = create(f.store, 'D:\\项目\\甲');
  const b = create(f.store, 'd:/项目/甲/');
  const c = create(f.store, 'D:\\项目\\甲');
  const account = randomUUID();
  const first = f.store.selectAccount(a.id, account);
  const second = f.store.selectAccount(b.id, account);
  assert.equal(first.nativeRoot, second.nativeRoot);
  assert.notEqual(first.nativeRoot, c.nativeRoot);
  const originalId = first.nativeSessionId;
  const other = f.store.selectAccount(a.id, randomUUID());
  assert.notEqual(other.nativeRoot, first.nativeRoot);
  const returned = f.store.selectAccount(a.id, account);
  assert.equal(returned.nativeRoot, first.nativeRoot);
  assert.notEqual(
    returned.nativeSessionId,
    originalId,
    'switching back still makes a new conversation segment',
  );
  ran(f.store, a.id);
  f.store.moveProject('D:\\项目\\甲', 'E:\\新家', desktop);
  const store = f.reopen();
  const next = create(store, 'E:\\新家');
  assert.equal(store.selectAccount(next.id, account).nativeRoot, first.nativeRoot);
  assert.equal(next.nativeRoot, c.nativeRoot);
  const segments = store.nativeSegments(a.id);
  assert.equal(segments.length, 4);
  assert.equal(segments.find((segment) => segment.id === originalId)?.root, first.nativeRoot);
  assert.equal(
    segments.find((segment) => segment.id === other.nativeSessionId)?.root,
    other.nativeRoot,
  );
});

test('moving an unused account segment updates its root index before its first real run', (t) => {
  const { store } = fixture(t);
  const a = create(store, 'D:\\甲');
  const account = randomUUID();
  const selected = store.selectAccount(a.id, account);
  const moved = store.move(a.id, 'D:\\乙', desktop);
  assert.notEqual(moved.nativeRoot, selected.nativeRoot);
  store.selectAccount(a.id, account);
  assert.equal(
    store.nativeSegments(a.id).find((segment) => segment.id === selected.nativeSessionId)?.root,
    moved.nativeRoot,
  );
  const fork = store.fork(randomUUID(), a.id, randomUUID(), 'fork', false, { device: desktop });
  assert.equal(fork.nativeRoot, moved.nativeRoot);
});
