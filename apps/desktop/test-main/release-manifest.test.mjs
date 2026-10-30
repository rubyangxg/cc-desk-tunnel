import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { releaseFiles } from '../../../scripts/release-manifest.mjs';

// These manifests are consumed by the existing desktop downloader and server upgrader.
for (const { target, android } of [
  { target: 'windows-server', android: false },
  { target: 'all', android: false },
  { target: 'windows-server', android: true },
]) {
  test(`${target}${android ? ' Android' : ''} release requires the selected packages and hashes every published byte`, (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'release-manifest-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const version = JSON.parse(readFileSync(resolve('apps/desktop/package.json'), 'utf8')).version;
    const names = releaseFiles(version, target, android);
    assert.equal(names.length, (target === 'all' ? 5 : 4) + (android ? 1 : 0));
    assert.equal(
      names.some((name) => name.endsWith('.apk')),
      android,
    );
    assert.ok(!names.some((name) => name.endsWith('.dmg')));
    assert.equal(
      names.some((name) => name.endsWith('.deb')),
      target === 'all',
    );
    assert.ok(names.some((name) => name.endsWith('.exe')));
    assert.ok(names.some((name) => name.endsWith('.tar.gz')));
    const build = () =>
      execFileSync(process.execPath, ['scripts/release-manifest.mjs', directory], {
        env: {
          ...process.env,
          RELEASE_TARGET: target,
          RELEASE_ANDROID: android ? '1' : '0',
          GITHUB_SHA: 'test-commit',
        },
        stdio: 'pipe',
      });
    for (const name of names.slice(0, -1)) writeFileSync(join(directory, name), name);
    assert.throws(build, /Expected/); // A missing server bundle must prevent publication.
    writeFileSync(join(directory, names.at(-1)), names.at(-1));
    writeFileSync(join(directory, 'unexpected.dmg'), 'extra');
    assert.throws(build, /Expected/); // Cannot silently publish an unselected platform.
    rmSync(join(directory, 'unexpected.dmg'));
    build();
    const manifest = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
    assert.equal(manifest.version, version);
    assert.equal(manifest.commit, 'test-commit');
    assert.deepEqual(
      manifest.files.map((file) => file.name),
      names,
    );
    for (const file of manifest.files) {
      assert.equal(file.size, Buffer.byteLength(file.name));
      assert.equal(file.sha256, createHash('sha256').update(file.name).digest('hex'));
      assert.ok(
        readFileSync(join(directory, 'SHA256SUMS'), 'utf8').includes(
          `${file.sha256}  ${file.name}\n`,
        ),
      );
    }
  });
}

test('default releases keep the server updater and reject unknown package targets', () => {
  assert.deepEqual(releaseFiles('1.2.3'), [
    'CC-Desk-Tunnel-Setup-1.2.3-x64.exe',
    'cc-desk-tunnel-server-1.2.3.tar.gz',
    'cc-desk-tunnel-server-1.2.3-linux-x64.tar.gz',
    'cc-desk-tunnel-server-1.2.3-linux-arm64.tar.gz',
  ]);
  assert.throws(() => releaseFiles('1.2.3', 'unknown'), /Unknown release target/);
});
