import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProjects, saveProjects } from '../src/projects.ts';

function storage(entries) {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
}

test('upgrading merges all old local project lists without changing the originals', () => {
  const originals = {
    'proxy-projects': JSON.stringify(['D:\\Work\\App', '/home/me/App']),
    'proxy-projects:second': JSON.stringify(['d:/work/app/', '/home/me/app', '', null, 42]),
    'proxy-projects:removed-profile': JSON.stringify(['E:\\OldProject']),
    'proxy-projects:broken': '{',
    'proxy-projects:invalid': '{}',
    'proxy-drafts': JSON.stringify({ session: 'private draft' }),
  };
  const store = storage(originals);
  const projects = loadProjects(store);
  assert.deepEqual(projects, ['D:\\Work\\App', '/home/me/App', '/home/me/app', 'E:\\OldProject']);
  saveProjects(store, projects);
  assert.deepEqual(loadProjects(store), projects);
  for (const [key, value] of Object.entries(originals)) assert.equal(store.getItem(key), value);
});

test('after migration, changing or clearing the shared list does not resurrect old paths', () => {
  const store = storage({ 'proxy-projects:second': JSON.stringify(['D:\\Old']) });
  saveProjects(store, loadProjects(store));
  saveProjects(store, ['D:\\New']);
  assert.deepEqual(loadProjects(store), ['D:\\New']);
  saveProjects(store, []);
  assert.deepEqual(loadProjects(store), []);
});

test('a malformed shared list can recover from the retained legacy records', () => {
  const store = storage({
    'proxy-local-projects': '{',
    'proxy-projects:second': JSON.stringify(['D:\\Existing']),
  });
  assert.deepEqual(loadProjects(store), ['D:\\Existing']);
});

test('window-shared projects take precedence without resurrecting migrated service folders', () => {
  const store = storage({
    'proxy-local-projects': JSON.stringify(['D:\\Old']),
    'proxy-projects:second': JSON.stringify(['E:\\Legacy']),
  });
  assert.deepEqual(loadProjects(store, ['D:\\Shared', 'd:/shared/', '', null]), ['D:\\Shared']);
  assert.deepEqual(loadProjects(store, []), []);
  assert.deepEqual(loadProjects(store, undefined), ['D:\\Old']);
  assert.deepEqual(loadProjects(store, {}), ['D:\\Old']);
});
