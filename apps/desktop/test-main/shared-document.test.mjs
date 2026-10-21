import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { LIMIT, documentPath, importFile, load, save } from '../electron/shared-document.cjs';

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'cc-shared-document-'));
  t.after(() => rmSync(base, { force: true, recursive: true }));
  return base;
}
test('a single Markdown file preserves unicode and rejects stale edits without losing either draft', (t) => {
  const base = fixture(t);
  const initial = load(base);
  assert.equal(initial.text, '');
  const first = save(base, '# 共享资料\n\n服务器：192.0.2.1\n备注：测试 🐈\n', initial.version);
  assert.deepEqual(load(base), first);
  assert.equal(readFileSync(documentPath(base), 'utf8'), first.text);
  assert.throws(() => save(base, 'another window', initial.version), /已在别处修改/);
  assert.deepEqual(load(base), first);
  assert.deepEqual(readdirSync(join(base, 'shared')), ['reference.md']);
  if (process.platform !== 'win32') assert.equal(statSync(first.path).mode & 0o777, 0o600);
  // Deleting all text is an intentional save, not an ignored empty value.
  assert.equal(save(base, '', first.version).text, '');
});
test('Markdown import is a bounded UTF-8 copy, with no save or change to the source', (t) => {
  const base = fixture(t);
  const path = join(base, 'reference.MD');
  const original = Buffer.from('\ufeff# 中文\r\nIP: 192.0.2.2\r\n');
  writeFileSync(path, original);
  assert.equal(importFile(path), '# 中文\r\nIP: 192.0.2.2\r\n');
  assert.deepEqual(readFileSync(path), original);
  assert.equal(load(base).text, '');
  assert.throws(() => importFile(join(base, 'file.exe')), /请选择/);
  writeFileSync(path, Buffer.from([0xff, 0xfe, 0x23, 0]));
  assert.throws(() => importFile(path), /UTF-8/);
  writeFileSync(path, '\0');
  assert.throws(() => importFile(path), /UTF-8/);
  writeFileSync(path, 'a'.repeat(LIMIT + 1));
  assert.throws(() => importFile(path), /512 KB/);
  assert.throws(() => save(base, '汉'.repeat(LIMIT / 2), load(base).version), /512 KB/);
  assert.equal(load(base).text, '');
});
test('independent connection processes race to save one version: only one can commit', async (t) => {
  const base = fixture(t);
  const initial = load(base);
  const module = resolve('apps/desktop/electron/shared-document.cjs');
  const worker = join(base, 'writer.cjs');
  writeFileSync(
    worker,
    `const {save}=require(${JSON.stringify(module)});
    process.send('ready'); process.once('message', () => {
      try { save(process.argv[2], process.argv[3], process.argv[4]); process.send('saved'); }
      catch { process.send('rejected'); }
      process.disconnect();
    });`,
  );
  const children = ['first', 'second'].map((text) =>
    fork(worker, [base, text, initial.version], { silent: true }),
  );
  t.after(() => children.forEach((child) => child.kill()));
  await Promise.all(children.map((child) => once(child, 'message')));
  const results = children.map((child) => once(child, 'message'));
  const exits = children.map((child) => once(child, 'exit'));
  children.forEach((child) => child.send('go'));
  assert.deepEqual((await Promise.all(results)).map(([message]) => message).sort(), [
    'rejected',
    'saved',
  ]);
  await Promise.all(exits);
  assert.ok(['first', 'second'].includes(load(base).text));
  assert.deepEqual(readdirSync(join(base, 'shared')), ['reference.md']);
});
