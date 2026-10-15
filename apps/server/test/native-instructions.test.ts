import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSTRUCTIONS_LIMIT } from '@cc-desk-tunnel/protocol';
import { readInstructions, writeInstructions } from '../src/native-instructions.ts';

test('global instructions are written over the version that was read, and emptied away', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-instructions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'config', 'CLAUDE.md');
  const missing = readInstructions(path);
  assert.equal(missing.text, '', 'A missing file reads as empty');
  const saved = writeInstructions('# 约定\n\n回复用中文。\n', missing.version, path);
  assert.equal(readFileSync(path, 'utf8'), '# 约定\n\n回复用中文。\n');
  assert.equal(saved.text, '# 约定\n\n回复用中文。\n');
  assert.notEqual(saved.version, missing.version);
  // Changed in the terminal meanwhile: the older edit is refused and the file kept.
  writeFileSync(path, '终端里改过\n');
  assert.throws(() => writeInstructions('覆盖', saved.version, path), {
    code: 'instructions_changed',
  });
  assert.equal(readFileSync(path, 'utf8'), '终端里改过\n');
  const emptied = writeInstructions('  \n', readInstructions(path).version, path);
  assert.equal(existsSync(path), false);
  assert.equal(emptied.version, missing.version);
});

test('global instructions longer than can be edited here are left to the terminal', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'proxy-instructions-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'CLAUDE.md');
  writeFileSync(path, 'x'.repeat(INSTRUCTIONS_LIMIT + 1));
  assert.throws(() => readInstructions(path), { code: 'instructions_too_long' });
});
