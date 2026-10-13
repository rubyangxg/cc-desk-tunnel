import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep upstream contributions on their feature branch; only personal integrates upstream updates here.
const root = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
if (process.argv.slice(2).some((arg) => arg !== '--check'))
  throw new Error('只支持 --check：仅检查上游更新，不合并或推送。');
const git = (...args) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const repository = (remote) => {
  const address = git('remote', 'get-url', remote);
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/.exec(
    address,
  );
  return match?.[1];
};

try {
  if (repository('origin') !== 'rubyangxg/cc-desk-tunnel')
    throw new Error('origin 必须指向 rubyangxg/cc-desk-tunnel；未修改远程地址。');
  if (!check && git('status', '--porcelain'))
    throw new Error('请先提交当前改动并解决未完成的合并，再执行同步。');
  if (!git('remote').split('\n').includes('upstream'))
    git('remote', 'add', 'upstream', 'https://github.com/sun168567/cc-desk-tunnel.git');
  if (repository('upstream') !== 'sun168567/cc-desk-tunnel')
    throw new Error('upstream 不是原作者仓库；未修改远程地址。');
  git('fetch', 'upstream', 'main');
  git('fetch', 'origin', 'personal');
  if (check) {
    console.log(
      git('log', '--oneline', 'origin/personal..upstream/main') || '目前没有待同步的上游提交。',
    );
  } else {
    if (!git('branch', '--list', 'personal'))
      git('branch', '--track', 'personal', 'origin/personal');
    git('switch', 'personal');
    git('merge', '--ff-only', 'origin/personal');
    git('merge', '--no-ff', '--no-commit', 'upstream/main');
    const merging = existsSync(resolve(root, git('rev-parse', '--git-path', 'MERGE_HEAD')));
    if (!merging && git('rev-parse', 'HEAD') === git('rev-parse', 'origin/personal')) {
      console.log('personal 已包含上游更新，无需推送或重新打包。');
    } else {
      for (const args of [
        ['ci', '--no-audit', '--no-fund'],
        ['run', 'check'],
        ['run', 'typecheck'],
        ['run', 'format:check'],
        ['test'],
        ['run', 'build'],
      ])
        execFileSync(npm, args, {
          cwd: root,
          stdio: 'inherit',
          windowsHide: true,
          shell: process.platform === 'win32',
        });
      git('diff', '--check');
      git('diff', '--cached', '--check');
      if (merging) git('commit', '-m', '合并上游 main 更新');
      git('push', 'origin', 'personal');
      console.log('已同步并推送 personal；GitHub package 工作流将构建新版本。');
    }
  }
} catch (error) {
  console.error(`同步停止：${error.message}`);
  console.error('当前分支和改动已保留。若存在冲突或测试失败，请先修复；此脚本不会强制覆盖分支。');
  process.exitCode = 1;
}
