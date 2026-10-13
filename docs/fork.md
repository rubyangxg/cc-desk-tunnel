# 个人分支维护

此 fork 的自用分支是 `rubyangxg/cc-desk-tunnel:personal`，上游是 `sun168567/cc-desk-tunnel:main`。保留上游许可与作者信息。

| 分支 | 用途 |
| --- | --- |
| `main` | 跟随上游；可在 GitHub 使用 Sync fork |
| `dev/multi-account-connections` | 向原作者提交账号池功能，继续修改此分支会更新对应 PR |
| `personal` | 自用账号池、fork 发布配置，以及以后合入的上游功能 |

## 下载自用安装包

进入[本 fork 的 Actions](https://github.com/rubyangxg/cc-desk-tunnel/actions/workflows/package.yml)，如提示工作流被禁用，先启用。每次推送 `personal` 会触发 `package`，也可使用 Run workflow 并选择 `personal`；`release` 留空。

成功后从该次运行的 Artifacts 下载 `windows-x64`、`macos-arm64`、`macos-x64`、`linux-x64` 和 `server`。构建产物保留 30 天；GitHub 自动检查打包客户端能否启动。客户端与服务端应取同一次构建并一起升级，详见[部署说明](../deploy/README.md)。构建产物不会自动成为正式 Release，也不会自动安装到服务器。

## 同步原作者更新

在本 fork 的本地仓库执行（需要 Node.js 24、Git 和 npm）：

```bash
npm run sync:upstream -- --check
npm run sync:upstream
```

第一条只拉取并列出尚未合入的上游提交。第二条要求工作区干净，切换到 `personal`、拉取远端进展，然后合并上游 `main`。安装依赖、清单检查、类型检查、格式检查、测试和构建全部通过后，才提交合并并推送 `personal`，触发打包。它不修改远端 `main`、贡献功能分支或原作者的仓库，也不使用强制推送。

发生冲突时保留现场。修改冲突文件后用 `git add` 暂存，完成检查后 `git commit`，再运行同步命令。若决定放弃这次尚未提交的合并，可使用 `git merge --abort`。不能通过测试时不会推送；先修复或排除本机环境问题，再继续。

合并上游时检查个人版本号、发布地址和 `package` 工作流是否仍正确。以后新增个人功能可使用单独分支，再通过 PR 合入 `personal`。

## 发布到自己的 Releases

`personal` 的客户端直接下载地址、服务器默认更新源和安装脚本默认仓库均为 `rubyangxg/cc-desk-tunnel`。已有部署如果在 `config/service.env` 显式设置了 `PROXY_RELEASE_REPO`，需将其改为 `rubyangxg/cc-desk-tunnel` 并按部署说明重启服务；环境变量会覆盖代码默认值。

发布前更新 `apps/desktop/package.json` 和 `package-lock.json` 中的桌面版本号，以及 `CHANGELOG.md` 的对应小节。现有协议只支持 `x.y.z` 三段数字发布版本；建议两端取同一次构建。不要重复使用本 fork 已发布的版本标签。

显示版本与通信协议是两个独立字段：正式 `v0.3.1` 标签使用协议 16，之后的上游 `main` 曾在显示版本仍为 0.3.1 时改用协议 17。个人 v0.3.3 客户端支持两者，遇到正式 v0.3.1 的协议拒绝时自动重连一次；因此不需要把个人发布版本改回 0.3.1。旧服务端可连接、查询额度和手动切换，但缺少每轮统计及明确的额度拒绝通知，自动续接可能无法触发；完整账号池功能仍建议配套升级服务端。

将提交推送到 `personal`，确认 GitHub CLI 已登录并有本 fork 的 Actions 和 Releases 权限，然后执行：

```bash
npm run release -- --dry-run
npm run release
```

发布脚本固定操作本 fork，并校验当前提交与远端 `personal` 一致；从这个提交构建所有安装包和服务端，附上 `release.json` 与 `SHA256SUMS`，最后保留为草稿 Release。检查草稿后在 GitHub 发布，才会作为普通用户可下载和升级的正式版本。也可使用原有的 `--publish`、`--prerelease` 参数，具体约定见[开发说明](development.md#发布)。

本分支的自动切换已通过模拟测试，真实订阅耗尽后的多服务器联调仍见[路线与现状](roadmap.md)。
