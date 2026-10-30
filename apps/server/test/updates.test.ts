import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { ServiceUpdate } from '@cc-desk-tunnel/protocol';
import { ServiceUpdates, isNewer, prebuiltPackage, serviceVersion } from '../src/updates.ts';

// A stand-in for the GitHub releases API: one latest release with a manifest and an installer.
async function feed(t: TestContext, version: string, runtime = 1) {
  const installer = Buffer.from(`installer ${version}`);
  const name = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
  const manifest = {
    version,
    runtime,
    files: [
      {
        name,
        size: installer.length,
        sha256: createHash('sha256').update(installer).digest('hex'),
      },
    ],
  };
  const requests: { url: string; authorization?: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url!, authorization: request.headers.authorization });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (/^\/repos\/owner\/name\/releases\/(latest|tags\/v[\d.]+)$/.test(request.url!))
      response.end(
        JSON.stringify({
          assets: [
            { name: 'release.json', url: `${base}/assets/1` },
            { name, url: `${base}/assets/2` },
          ],
        }),
      );
    else if (request.url === '/assets/1') response.end(JSON.stringify(manifest));
    else if (request.url === '/assets/2') response.end(installer);
    else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-updates-'));
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const states: ServiceUpdate[] = [];
  const updates = (options: { runtimeLevel?: number; repository?: string } = {}) => {
    if (options.runtimeLevel) writeFileSync(join(directory, 'level'), `${options.runtimeLevel}\n`);
    return new ServiceUpdates(
      {
        repository: options.repository ?? 'owner/name',
        token: 'read-only-token',
        api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        programDir: options.runtimeLevel ? join(directory, 'program') : undefined,
        runtimeDir: options.runtimeLevel ? directory : undefined,
        clientDir: join(directory, 'client'),
        restart: () => undefined,
      },
      (state) => states.push(state),
    );
  };
  return { directory, name, installer, manifest, requests, states, updates };
}

test('version comparison is numeric', () => {
  assert.equal(isNewer('0.10.0', '0.9.9'), true);
  assert.equal(isNewer('1.0.0', '1.0.0'), false);
  assert.equal(isNewer('0.2.1', '0.2.10'), false);
});

test('a newer release is installable only where the runtime is recent enough', async (t) => {
  const f = await feed(t, '99.0.0', 2);
  const reported = f.updates();
  await reported.check();
  assert.deepEqual(
    f.states.map((state) => state.state),
    ['checking', 'manual'],
  );
  assert.equal(reported.state.latest, '99.0.0');
  assert.ok(f.requests.every((request) => request.authorization === 'Bearer read-only-token'));
  assert.throws(() => reported.install('99.0.0'));

  const outdated = f.updates({ runtimeLevel: 1 });
  await outdated.check();
  assert.equal(outdated.state.state, 'manual');
  const current = f.updates({ runtimeLevel: 2 });
  await current.check();
  assert.equal(current.state.state, 'available');
  assert.throws(() => current.install('98.0.0'));
});

test('the same or an older release, or an unreachable page, offers nothing', async (t) => {
  const f = await feed(t, serviceVersion());
  const updates = f.updates({ runtimeLevel: 1 });
  await updates.check();
  assert.equal(updates.state.state, 'idle');
  assert.ok(updates.state.checkedAt);
  const missing = f.updates({ repository: 'owner/absent' });
  await missing.check();
  assert.equal(missing.state.state, 'failed');
  assert.match(missing.state.detail!, /404/);
});

test('the installer of the running version is fetched for clients and checked against the manifest', async (t) => {
  const f = await feed(t, serviceVersion());
  const updates = f.updates();
  updates.start();
  t.after(() => updates.stop());
  const target = join(f.directory, 'client', f.name);
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      assert.deepEqual(readFileSync(target), f.installer);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assert.fail('The installer was not downloaded.');
});

test('an installer download that slows to a halt is continued on new connections, and tried again after the page fails', async (t) => {
  const version = serviceVersion();
  const installer = Buffer.from(Array.from({ length: 20_000 }, (_, index) => index % 251));
  const name = `CC-Desk-Tunnel-Setup-${version}-x64.exe`;
  const manifest = {
    version,
    runtime: 1,
    files: [
      {
        name,
        size: installer.length,
        sha256: createHash('sha256').update(installer).digest('hex'),
      },
    ],
  };
  const ranges: (string | undefined)[] = [];
  let pages = 0;
  const server = createServer((request, response) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    if (request.url === `/repos/owner/name/releases/tags/v${version}`) {
      // The release page is out of reach the first time it is asked.
      if (++pages === 1) return void response.writeHead(503).end();
      response.end(
        JSON.stringify({
          assets: [
            { name: 'release.json', url: `${base}/assets/1` },
            { name, url: `${base}/assets/2` },
          ],
        }),
      );
    } else if (request.url === '/assets/1') response.end(JSON.stringify(manifest));
    else if (request.url === '/assets/2') {
      ranges.push(request.headers.range);
      const start = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
      // The second connection delivers nothing at all; every other one sends 6,000 bytes and then goes quiet
      // without closing.
      response.writeHead(start ? 206 : 200, { 'Content-Type': 'application/octet-stream' });
      response.flushHeaders();
      if (ranges.length !== 2) response.write(installer.subarray(start, start + 6000));
      if (start + 6000 >= installer.length && ranges.length !== 2) response.end();
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-updates-'));
  let arrived = 0;
  const updates = new ServiceUpdates(
    {
      repository: 'owner/name',
      api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      clientDir: join(directory, 'client'),
      restart: () => undefined,
      installed: () => arrived++,
      download: { stretch: 2000, stall: 60, attempts: 3, retry: 50 },
    },
    () => undefined,
  );
  t.after(() => {
    updates.stop();
    server.closeAllConnections();
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  updates.start();
  const target = join(directory, 'client', name);
  let seen = 0;
  for (let attempt = 0; attempt < 500 && !existsSync(target); attempt++) {
    // The last bytes may have arrived while the file is still being checked, which is not "on its way".
    const received = updates.preparing?.received ?? 0;
    if (received < installer.length) seen = Math.max(seen, received);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(readFileSync(target), installer);
  assert.equal(pages, 2);
  assert.deepEqual(ranges, [
    undefined,
    'bytes=6000-',
    'bytes=6000-',
    'bytes=12000-',
    'bytes=18000-',
  ]);
  // While it was on its way, clients could be told how far it was; nothing is left to tell afterwards.
  assert.ok(seen >= 6000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updates.preparing, undefined);
  assert.equal(existsSync(`${target}.part`), false);
  assert.equal(arrived, 1);
});

test('a download whose connections keep delivering nothing is given up, and one that is not the announced file is discarded', async (t) => {
  const f = await feed(t, serviceVersion());
  f.manifest.files[0].sha256 = '0'.repeat(64);
  const updates = f.updates();
  updates.start();
  t.after(() => updates.stop());
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.deepEqual(readdirSync(join(f.directory, 'client')), []);
});

test('starting clears the programs of other versions and unfinished downloads, and nothing else', async (t) => {
  const f = await feed(t, serviceVersion());
  const program = join(f.directory, 'program');
  const client = join(f.directory, 'client');
  const kept = [
    join(program, serviceVersion(), 'apps'),
    join(program, 'current'),
    join(program, 'notes'),
    join(client, 'CC-Desk-Tunnel-Setup-0.0.1-x64.exe'),
    join(client, 'readme.txt'),
  ];
  const stale = [
    join(program, '0.0.1', 'apps'),
    join(program, '9.9.9.new', 'apps'),
    join(program, '9.9.9.tar.gz'),
    join(client, 'CC-Desk-Tunnel-Setup-0.0.1-x64.exe.part'),
  ];
  for (const path of [...kept, ...stale]) {
    mkdirSync(join(path, '..'), { recursive: true });
    if (path.endsWith('apps')) mkdirSync(path);
    else writeFileSync(path, 'x');
  }
  const updates = f.updates({ runtimeLevel: 1 });
  updates.start();
  t.after(() => updates.stop());
  // The installer of this version arrives after the clearing, which is how the end of it is told.
  for (let attempt = 0; !existsSync(join(client, f.name)); attempt++) {
    assert.ok(attempt < 500, 'the installer did not arrive');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(
    stale.filter((path) => existsSync(path)),
    [],
  );
  assert.deepEqual(
    kept.filter((path) => !existsSync(path)),
    [],
  );
});

// A release of a newer program: the plain package, and the ones built for this machine described by `prebuilt`.
async function programFeed(
  t: TestContext,
  prebuilt: {
    meta?: object;
    files?: Record<string, string>;
    announced?: string;
    published?: boolean;
  },
) {
  const version = '99.0.0';
  const directory = mkdtempSync(join(tmpdir(), 'cc-desk-tunnel-program-'));
  const pack = (name: string, files: Record<string, string>) => {
    const source = join(directory, `source-${name}`);
    for (const [path, content] of Object.entries({
      'scripts/install-linux.sh': '#!/usr/bin/env bash\n',
      'apps/server/src/main.ts': '',
      ...files,
    })) {
      mkdirSync(join(source, path, '..'), { recursive: true });
      writeFileSync(join(source, path), content);
    }
    execFileSync('tar', ['-czf', join(directory, name), '-C', source, '.']);
    return readFileSync(join(directory, name));
  };
  const entry = (name: string, data: Buffer) => ({
    name,
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
  });
  const generic = `cc-desk-tunnel-server-${version}.tar.gz`;
  const native = prebuiltPackage(version)!;
  const packages = new Map([
    [generic, pack(generic, { 'apps/server/package.json': '{}' })],
    [
      native,
      pack(native, {
        'apps/server/package.json': '{}',
        'node_modules/ws/index.js': '',
        'prebuilt.json': JSON.stringify(
          prebuilt.meta ?? {
            platform: process.platform,
            arch: process.arch,
            modules: process.versions.modules,
            native: [],
          },
        ),
        ...prebuilt.files,
      }),
    ],
  ]);
  const files = [...packages].map(([name, data]) => entry(name, data));
  if (prebuilt.announced) files[1].sha256 = prebuilt.announced;
  const manifest = { version, runtime: 1, files };
  const fetched: string[] = [];
  const server = createServer((request, response) => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const names = [...packages.keys()].filter(
      (name) => prebuilt.published !== false || name === generic,
    );
    if (request.url === '/repos/owner/name/releases/latest')
      response.end(
        JSON.stringify({
          assets: [
            { name: 'release.json', url: `${base}/assets/release.json` },
            ...names.map((name) => ({ name, url: `${base}/assets/${name}` })),
          ],
        }),
      );
    else if (request.url === '/assets/release.json') response.end(JSON.stringify(manifest));
    else if (packages.has(request.url!.slice(8))) {
      fetched.push(request.url!.slice(8));
      response.end(packages.get(request.url!.slice(8)));
    } else response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  });
  writeFileSync(join(directory, 'level'), '1\n');
  const installs: string[][] = [];
  const states: ServiceUpdate[] = [];
  let restarted = false;
  const updates = new ServiceUpdates(
    {
      repository: 'owner/name',
      api: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      programDir: join(directory, 'program'),
      runtimeDir: directory,
      clientDir: join(directory, 'client'),
      restart: () => (restarted = true),
      npm: async (args) => installs.push(args),
    },
    (state) => states.push(state),
  );
  await updates.check();
  assert.equal(updates.state.state, 'available');
  updates.install(version);
  for (let attempt = 0; !restarted && (updates.state.state as string) !== 'failed'; attempt++) {
    assert.ok(attempt < 1000, 'the upgrade did not end');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const program = join(directory, 'program', version);
  return { generic, native, fetched, installs, states, updates, program };
}

test('only Linux on x64 or arm64 has a prebuilt program package', () => {
  assert.equal(
    prebuiltPackage('1.2.3', 'linux', 'x64'),
    'cc-desk-tunnel-server-1.2.3-linux-x64.tar.gz',
  );
  assert.equal(
    prebuiltPackage('1.2.3', 'linux', 'arm64'),
    'cc-desk-tunnel-server-1.2.3-linux-arm64.tar.gz',
  );
  assert.equal(prebuiltPackage('1.2.3', 'linux', 'ia32'), undefined);
  assert.equal(prebuiltPackage('1.2.3', 'win32', 'x64'), undefined);
});

test('the package built for this machine is installed without installing dependencies', async (t) => {
  if (!prebuiltPackage('1.0.0')) return t.skip('no prebuilt package for this machine');
  const f = await programFeed(t, {});
  assert.equal(f.updates.state.state, 'restarting');
  assert.deepEqual(f.fetched, [f.native]);
  assert.deepEqual(f.installs, []);
  assert.ok(existsSync(join(f.program, 'node_modules/ws/index.js')));
  assert.ok(!f.states.some((state) => state.detail === '安装依赖'));
});

test('without a usable prebuilt package the plain one is installed with its dependencies', async (t) => {
  if (!prebuiltPackage('1.0.0')) return t.skip('no prebuilt package for this machine');
  const cases = {
    unpublished: { published: false },
    'not the announced file': { announced: '0'.repeat(64) },
    'built for another Node': {
      meta: { platform: process.platform, arch: process.arch, modules: '1', native: [] },
    },
    'a native module that does not load': {
      meta: {
        platform: process.platform,
        arch: process.arch,
        modules: process.versions.modules,
        native: ['./broken.cjs'],
      },
      files: { 'apps/server/broken.cjs': 'throw new Error("not for this machine")' },
    },
  };
  for (const [label, prebuilt] of Object.entries(cases)) {
    const f = await programFeed(t, prebuilt);
    assert.equal(f.updates.state.state, 'restarting', label);
    assert.equal(f.fetched.at(-1), f.generic, label);
    assert.equal(f.installs.length, 1, label);
    assert.equal(f.installs[0][0], 'ci', label);
    assert.ok(!existsSync(join(f.program, 'node_modules')), label);
    assert.ok(!existsSync(join(f.program, 'prebuilt.json')), label);
    assert.ok(
      f.states.some((state) => state.detail === '安装依赖'),
      label,
    );
  }
});
