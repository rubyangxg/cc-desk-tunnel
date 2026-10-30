import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prebuiltServers, releaseFiles } from './release-manifest.mjs';

// Releases the version in apps/desktop/package.json from what the personal branch on GitHub holds. Nothing is
// built on this computer: the `package` workflow on GitHub builds the selected files from that commit, starts each
// client as a check, and attaches them to a draft release this script made, with release.json and
// SHA256SUMS. The release stays a draft unless --publish is given; --prerelease marks it as a preview, which
// the service does not offer as an update. Windows and server packages are the default; --all-platforms adds
// Linux. macOS packages are excluded from releases. --resume continues a draft from the same commit. --dry-run only writes the notes. Needs gh (or GH pointing at
// it), signed in.
const root = fileURLToPath(new URL('..', import.meta.url));
const dryRun = process.argv.includes('--dry-run');
const publish = process.argv.includes('--publish');
const prerelease = process.argv.includes('--prerelease');
const android = process.argv.includes('--android');
const resume = process.argv.includes('--resume');
const target = process.argv.includes('--all-platforms') ? 'all' : 'windows-server';
// A word this script does not know is a mistake, not something to release past: `--help` would otherwise publish.
const unknown = process.argv
  .slice(2)
  .filter(
    (word) =>
      ![
        '--dry-run',
        '--publish',
        '--prerelease',
        '--all-platforms',
        '--resume',
        '--android',
      ].includes(word),
  );
if (unknown.length)
  throw new Error(
    `Unknown argument ${unknown.join(' ')}. Use --dry-run, --prerelease, --publish, --all-platforms, --resume, --android.`,
  );
const repositoryName = 'rubyangxg/cc-desk-tunnel';
const releaseBranch = 'personal';
const gh = process.env.GH ?? 'gh';
const run = (file, args, options = {}) =>
  execFileSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GH_REPO: repositoryName },
    ...options,
  });
const git = (...args) => run('git', args).trim();

const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
const tag = `v${version}`;
const section = new RegExp(
  `^## ${version.replaceAll('.', '\\.')}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`,
  'm',
)
  .exec(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'))?.[1]
  .trim();
if (!section) throw new Error(`CHANGELOG.md has no section "## ${version}".`);
const repository = `https://github.com/${repositoryName}`;
const [installer, server, ...rest] = releaseFiles(version, target);
// The prebuilt server packages are what a running server upgrades from; the rest are Linux clients.
const prebuilt = prebuiltServers(version);
const others = rest.filter((name) => !prebuilt.includes(name));
const androidName = `CC-Desk-Tunnel-${version}-android.apk`;
// Every release reads the same way: what the project is, this version's section of the change log with its
// headings one level up, then how to get and upgrade to it. A preview carries the same text, so that making
// it the release later changes nothing a reader has seen.
const notes = [
  '> 用桌面客户端驱动云端的 Claude Code，经反向隧道在你自己的电脑上执行。',
  '',
  // The change log links to files beside it; on the release page those links need the whole address.
  section
    .replace(/^### /gm, '## ')
    .replace(/\]\((?![a-z]+:|#)([^)]+)\)/g, `](${repository}/blob/${releaseBranch}/$1)`),
  '',
  '---',
  '',
  '## 下载与升级',
  '',
  '- **已在使用**：可在客户端的“设置 → 关于与更新”里检查更新；升级顺序与兼容版本以本版“升级说明”为准。',
  `- **Windows 客户端**：下载 \`${installer}\` 并安装。安装包没有代码签名，SmartScreen 与杀毒软件的提示见[说明](${repository}#杀毒软件与-smartscreen)。`,
  `- **服务端**：新部署按[快速开始](${repository}#快速开始)用一条命令安装；\`${server}\` 是它下载的程序包；\`${prebuilt.join('`、`')}\` 是带好依赖的同一程序，已部署的服务端在应用内升级时按架构选用，省去安装依赖。`,
  ...(others.length
    ? [
        `- **Linux 客户端（实验性）**：${others.map((name) => `\`${name}\``).join('、')}。没有签名，也不带应用内更新，升级时重新下载安装；安装与首次打开见 [Linux 说明](${repository}/blob/${releaseBranch}/docs/linux.md)。`,
      ]
    : []),
  ...(android
    ? [
        `- **Android 手机端**：下载 \`${androidName}\` 安装（Android 8.0+）。配置已有服务器连接后查看、操作会话，详见 [手机端说明](${repository}/blob/${releaseBranch}/docs/android.md)。`,
      ]
    : []),
  '- **校验**：各文件的 SHA256 在 `SHA256SUMS` 与 `release.json` 中。',
  '',
  `文档：[部署手册](${repository}/blob/${releaseBranch}/deploy/README.md) · [变更记录](${repository}/blob/${releaseBranch}/CHANGELOG.md) · [安全须知](${repository}#安全须知)`,
].join('\n');
const output = join(root, 'artifacts/release');
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'notes.md'), notes + '\n');

if (dryRun) {
  console.log(
    `The notes of ${tag} are in ${join(output, 'notes.md')}; nothing was sent to GitHub.`,
  );
} else {
  // A release is cut from exactly what the personal branch on GitHub holds, so the tag matches the files.
  const commit = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain')) throw new Error('Commit or discard local changes first.');
  const remote = run(gh, [
    'api',
    `repos/${repositoryName}/commits/${releaseBranch}`,
    '--jq',
    '.sha',
  ]).trim();
  if (remote !== commit)
    throw new Error('Check out the current personal branch from GitHub first.');
  let existing;
  try {
    existing = JSON.parse(
      run(gh, ['release', 'view', tag, '--json', 'url,isDraft,targetCommitish,assets'], {
        stdio: 'pipe',
      }),
    );
  } catch {
    if (resume) throw new Error(`Cannot read draft ${tag} to resume it.`);
  }
  if (existing && (!resume || !existing.isDraft || existing.targetCommitish !== commit))
    throw new Error(
      `Release ${tag} already exists; --resume requires a draft from the current commit.`,
    );
  if (
    existing &&
    existing.assets.some(
      (asset) =>
        ![...releaseFiles(version, target, android), 'release.json', 'SHA256SUMS'].includes(
          asset.name,
        ),
    )
  )
    throw new Error(
      `Draft ${tag} has files outside the selected target; inspect it before resuming.`,
    );
  if (existing) run(gh, ['release', 'edit', tag, '--notes-file', join(output, 'notes.md')]);

  // Always a draft first: what is published is complete.
  let url = existing?.url;
  try {
    if (!existing)
      url = run(gh, [
        'release',
        'create',
        tag,
        '--draft',
        ...(prerelease ? ['--prerelease', '--latest=false'] : []),
        '--target',
        commit,
        '--title',
        `CC Desk Tunnel ${version}`,
        '--notes-file',
        join(output, 'notes.md'),
      ]).trim();
  } catch (error) {
    // gh has reported a failure after GitHub had made the draft; it is looked for before giving up, or the
    // next attempt would stop at a release that "already exists".
    let made;
    try {
      made = JSON.parse(
        run(gh, ['release', 'view', tag, '--json', 'url,isDraft'], { stdio: 'pipe' }),
      );
    } catch {
      throw error;
    }
    if (!made.isDraft) throw error;
    console.log(`gh reported an error, but the draft of ${tag} was made; going on with it.`);
    url = made.url;
  }
  try {
    const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const runs = () =>
      JSON.parse(
        run(gh, [
          'run',
          'list',
          '--workflow',
          'package.yml',
          '--event',
          'workflow_dispatch',
          '--commit',
          commit,
          '--json',
          'databaseId,status,conclusion,displayTitle',
        ]),
      );
    const previous = runs();
    const before = new Set(previous.map((item) => item.databaseId));
    let started = resume
      ? previous.find((item) => item.displayTitle === `${tag} · ${target}`)
      : undefined;
    if (!started && previous.some((item) => item.status !== 'completed'))
      throw new Error(
        'Another package run for this commit is still active; inspect it before starting a release.',
      );
    if (!started)
      run(gh, [
        'workflow',
        'run',
        'package.yml',
        '--ref',
        releaseBranch,
        '-f',
        `release=${tag}`,
        '-f',
        `target=${target}`,
        '-f',
        `android=${android}`,
      ]);
    for (let attempt = 0; !started && attempt < 30; attempt++) {
      wait(5_000);
      started = runs().find((item) => !before.has(item.databaseId));
    }
    if (!started) throw new Error('The package workflow did not start on GitHub.');
    console.log(`GitHub run ${started.databaseId} builds the files of ${tag}.`);
    // Fails when the run does: a release does not go out with a package that did not start. The jobs
    // download Electron and other files, which now and then times out; what failed is tried once more.
    const watch = () =>
      run(gh, ['run', 'watch', String(started.databaseId), '--exit-status', '--interval', '30'], {
        stdio: 'inherit',
      });
    let rerun = false;
    for (let attempt = 0; ; attempt++) {
      try {
        watch();
        break;
      } catch (error) {
        if (attempt >= 3) throw error;
        const status = JSON.parse(
          run(gh, ['run', 'view', String(started.databaseId), '--json', 'status,conclusion']),
        );
        if (status.status === 'completed') {
          if (status.conclusion === 'success') break;
          if (rerun || status.conclusion !== 'failure') throw error;
          console.log('The run failed; running its failed jobs once more.');
          run(gh, ['run', 'rerun', String(started.databaseId), '--failed']);
          rerun = true;
        } else console.log('Watching was interrupted; continuing to watch the existing run.');
        wait(15_000);
      }
    }
    if (android) {
      const staging = mkdtempSync(join(output, 'android-'));
      const input = join(staging, 'unsigned');
      const files = join(staging, 'files');
      mkdirSync(input);
      mkdirSync(files);
      run(gh, [
        'run',
        'download',
        String(started.databaseId),
        '--name',
        'android-unsigned',
        '--dir',
        input,
      ]);
      run(
        process.execPath,
        ['scripts/package-android.mjs', '--unsigned', join(input, 'app-release-unsigned.apk')],
        { stdio: 'inherit' },
      );
      for (const name of releaseFiles(version, target))
        run(gh, ['release', 'download', tag, '--pattern', name, '--dir', files]);
      copyFileSync(join(root, 'artifacts/android', androidName), join(files, androidName));
      run(process.execPath, ['scripts/release-manifest.mjs', files], {
        env: { ...process.env, RELEASE_TARGET: target, RELEASE_ANDROID: '1' },
        stdio: 'inherit',
      });
      run(gh, [
        'release',
        'upload',
        tag,
        join(files, androidName),
        join(files, 'release.json'),
        join(files, 'SHA256SUMS'),
        '--clobber',
      ]);
    }
    const attached = JSON.parse(run(gh, ['release', 'view', tag, '--json', 'assets'])).assets.map(
      (asset) => asset.name,
    );
    const missing = [
      ...releaseFiles(version, target, android),
      'release.json',
      'SHA256SUMS',
    ].filter((name) => !attached.includes(name));
    if (missing.length) throw new Error(`The draft ${tag} lacks ${missing.join(', ')}.`);
  } catch (error) {
    console.log(
      `The draft ${url} is left as it is. Inspect the existing run, then use --resume to continue it.`,
    );
    throw error;
  }
  if (publish) run(gh, ['release', 'edit', tag, '--draft=false']);
  console.log(`${publish ? 'Published' : 'Draft'} release: ${url}`);
}
