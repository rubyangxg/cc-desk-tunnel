import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectQuotaSettings } from '../src/project-quota.ts';

test('project quota settings persist, normalize Windows paths, and isolate projects and devices', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-project-quota-'));
  let db = new DatabaseSync(join(dir, 'test.sqlite'));
  try {
    let settings = new ProjectQuotaSettings(db);
    assert.equal(settings.enabled('device-a', 'D:\\Work'), false);
    settings.set('device-a', 'D:\\Work\\', true);
    assert.equal(settings.enabled('device-a', 'd:/work'), true);
    assert.equal(settings.enabled('device-b', 'd:/work'), false);
    assert.equal(settings.enabled('device-a', 'd:/other'), false);
    settings.set('device-a', '/Work', true);
    assert.equal(settings.enabled('device-a', '/work'), false);
    db.close();
    db = new DatabaseSync(join(dir, 'test.sqlite'));
    settings = new ProjectQuotaSettings(db);
    assert.equal(settings.enabled('device-a', 'D:/Work'), true);
    settings.set('device-a', 'd:/work/', false);
    assert.equal(settings.enabled('device-a', 'D:\\Work'), false);
    assert.equal(settings.list().length, 1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
