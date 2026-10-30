import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Describes the files of a release, which the `package` workflow has gathered in one directory: release.json
// is what programs read, SHA256SUMS the same hashes for `sha256sum -c`. A release has exactly the files
// selected by its target; one missing or one too many stops it.
const root = fileURLToPath(new URL('..', import.meta.url));
const directory = resolve(process.argv[2] ?? 'artifacts/release');
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
export const prebuiltServers = (version) =>
  ['x64', 'arm64'].map((arch) => `cc-desk-tunnel-server-${version}-linux-${arch}.tar.gz`);
export const releaseFiles = (version, target = 'windows-server', android = false) => {
  if (!['windows-server', 'all'].includes(target))
    throw new Error(`Unknown release target: ${target}`);
  const files = [`CC-Desk-Tunnel-Setup-${version}-x64.exe`];
  files.push(`cc-desk-tunnel-server-${version}.tar.gz`);
  // The same program with its dependencies installed, one per server architecture: a running server upgrades
  // from these without npm. Servers from before them read only the plain package above.
  files.push(...prebuiltServers(version));
  if (target === 'all') files.push(`CC-Desk-Tunnel-${version}-linux-amd64.deb`);
  if (android) files.push(`CC-Desk-Tunnel-${version}-android.apk`);
  return files;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const protocol = Number(
    /PROTOCOL_VERSION = (\d+)/.exec(
      readFileSync(join(root, 'packages/protocol/src/index.ts'), 'utf8'),
    )[1],
  );
  // Raised whenever the image must be rebuilt for a release to run; see deploy/docker/runtime-level.
  const runtime = Number(readFileSync(join(root, 'deploy/docker/runtime-level'), 'utf8'));
  const commit =
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const names = releaseFiles(
    version,
    process.env.RELEASE_TARGET,
    process.env.RELEASE_ANDROID === '1',
  );
  const found = readdirSync(directory).sort();
  if (found.join() !== [...names].sort().join())
    throw new Error(`Expected ${names.join(', ')} in ${directory}; found ${found.join(', ')}.`);
  const files = names.map((name) => ({
    name,
    size: statSync(join(directory, name)).size,
    sha256: createHash('sha256')
      .update(readFileSync(join(directory, name)))
      .digest('hex'),
  }));
  writeFileSync(
    join(directory, 'release.json'),
    JSON.stringify({ version, protocol, runtime, commit, files }, null, 2) + '\n',
  );
  writeFileSync(
    join(directory, 'SHA256SUMS'),
    files.map((file) => `${file.sha256}  ${file.name}\n`).join(''),
  );
  for (const file of files) console.log(`${file.sha256}  ${file.name}  (${file.size} bytes)`);
}
