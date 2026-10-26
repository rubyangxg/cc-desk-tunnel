# Android 手机端

Android 8.0 及以上可安装发布页的 `CC-Desk-Tunnel-版本号-android.apk`。这是手机遥控端；执行电脑项目时，项目电脑和桌面客户端必须保持在线。手机关屏、退出或断网不会主动停止电脑任务；同服额度恢复由服务端处理，跨服务器接力继续由电脑端协调。

## 开始使用

1. 安装 APK，允许当前下载应用安装未知来源应用。
2. 打开「设置 → 添加服务器」。填写电脑端已有的名称、`wss://.../ws` 地址、SHA256 证书指纹和服务凭据 `PROXY_TOKEN`。服务凭据不是 SSH 密码，也不是 Claude 登录密码。不要把真实凭据发到 issue 或发布说明。
3. 每台服务器分别添加一次。应用同时连接它们，自动汇总会话与账号；点击会话直接查看和操作，不用切换代理。
4. 在会话中发消息、选择排队或直接发送、停止、继续、设置 `/goal`，或回答 Claude 的审批和提问。账号授权与跨服务器调度设置沿用电脑端。

兼容服务端 0.4.30（协议 21）的已有会话操作。升级服务端到 0.4.31 后，可通过右上角「+」从已有电脑项目新建会话。选择「服务器工作区」会在 VPS 创建独立会话，命令也在 VPS 执行；它不是你的电脑项目。

连接失败时保留草稿，并自动重连、补齐历史。消息确认丢失时明确提示，**不自动重发**；请先确认会话记录，避免重复执行。证书指纹改变时应从可信渠道核实新指纹后编辑连接，应用不会跳过 TLS 校验。公网可信证书可以不填指纹；自签名证书必须填。

## 通知与数据

「设置 → 任务通知」需授予 Android 通知权限。应用保持连接时，会提示任务结束或需要确认。系统限制后台运行或结束应用后，不能保证实时通知；首版不使用外部推送平台，也不保持常驻前台服务。任务本身仍在电脑/服务器上运行。

连接配置由 Android Keystore 的密钥加密，禁止云备份和设备迁移；卸载会清除手机连接配置，需重新填写。聊天内容只保留在页面内存中，不另行落盘。WebView 只加载安装包内资源，禁止访问本地文件、远程脚本及聊天中嵌入的远程图片。

## 开发、验证与打包

需要 Node 24、JDK 17、Android SDK Platform 35 / Build Tools 35.0.0。

```bash
npm ci
npm run typecheck
npm run test:mobile
npm run build:mobile
cd apps/mobile/android
./gradlew testDebugUnitTest lintRelease connectedDebugAndroidTest
cd ../../..
npm run package:android
```

设置 `ANDROID_HOME` 指向 SDK。`connectedDebugAndroidTest` 需要启动 Android 模拟器或连接测试设备。`GRADLE` 可指定本机 Gradle 8.11.1，否则使用校验了下载 SHA256 的 wrapper。

打包生成 `artifacts/android/CC-Desk-Tunnel-版本号-android.apk`，固定私有签名默认存放于 `.local/android-signing/`。**私下备份该目录中的密钥和口令文件**；丢失后不能用新的签名覆盖安装旧版。仓库只保存公开证书指纹，打包时验证签名一致；缺少私钥会停止，不会悄悄生成新签名。密钥禁止提交或上传公开发布页。也可以用 `ANDROID_RELEASE_KEYSTORE` 与 `ANDROID_RELEASE_PASSWORD_FILE` 指向已有签名。

正式发布：`npm run release -- --android --publish`。已有 Actions 工作流构建 Windows、服务端和 Android；Android 先运行 TLS 单元测试、Lint 和模拟器上的启动/加密存储检查，再上传未签名 APK。发布机使用私有签名签名，验证签名和文件 SHA256，把 APK 与更新后的 `release.json`、`SHA256SUMS` 一起附到草稿，全部完成后才正式发布。普通发布不加 `--android` 时仍只打 Windows 和服务端，不打 macOS/Linux。

云环境模拟器和模拟服务回归不代表已在用户真机、真实 Claude 账号或 VPS 上实测。
