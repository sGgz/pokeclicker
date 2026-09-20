# Windows 私人云存档客户端

最终用户请使用仓库 `design/cloud-save-user-guide.md` 的第十六节，或客户端内 **帮助 → 操作手册（离线可读）**。安装客户端不需要 Node、Git、Cloudflare CLI 或 GitHub token。

本地游戏资源通过 `pokeclicker://game/` 加载；云端固定连接 `https://play.ggzz.fun`。这是有离线资源的 Electron 应用，游戏逻辑在本机运行。GitHub 私库、槽位及 Worker 认证均沿用现有实现，无需另行部署后台。

## 开发和打包

使用 Windows x64、Node 24，在仓库根目录执行：

```text
npm ci
npm --prefix cloud-save-worker ci
npm run desktop:install
npm run desktop:build
```

`desktop:build` 会构建并检查游戏，再制作安装包和 ZIP，输出至 `output/desktop/`。`desktop:install` 使用锁文件安装 Electron 等构建依赖；不要设置 `ELECTRON_SKIP_BINARY_DOWNLOAD`，本地调试需要 Electron 二进制文件。游戏构建后可用 `npm run desktop:start` 调试。

桌面壳版本在 `desktop/package.json` 中；游戏版本仍在仓库根 `package.json`。升级时保持 `appId`、`PokeclickerCloud` 数据目录名及协议 host 不变。手动安装新版本不会清除 `%APPDATA%\PokeclickerCloud`。不要把用户数据放入安装目录或打包产物。

## 验证

```text
npm run desktop:test
npm --prefix desktop run smoke
```

第二条会运行已打包的 `output/desktop/win-unpacked/PokeclickerCloud.exe`，需要已安装 Microsoft Edge。设置 `PC_BROWSER_CHANNEL=chrome` 可使用 Chrome。`npm --prefix desktop run smoke -- --dev` 可测试开发包；`--exe=绝对路径` 可验证安装后的同一 EXE。

冒烟测试使用 Playwright 的 Electron API、真实游戏和真实 Worker handler，只以本机 fixture 替代 GitHub 存储与网络目标。调试器在隔离测试进程中替换 `globalThis.fetch`；生产包没有测试服务器入口、认证后门或真实密码。测试通过 `--data-dir=绝对路径` 选择隔离目录，不接触默认用户数据，也不访问真实云档。截图和报告位于 `output/playwright/desktop/`，隔离数据位于 `output/desktop-tests/`；两者均被 Git 忽略。

实际两台用户设备间的恢复验收仍按手册完成，测试替身不代表真实 GitHub 写入成功。

## 安全与更新边界

- Renderer 启用 sandbox、context isolation、webSecurity，无 Node；仅固定 IPC 方法可请求云档。
- 主进程同时核对窗口、主 frame、精确 URL，并再次校验云路径、方法、大小；不跟随云端重定向。
- 密码只提交给现有固定 HTTPS 后台。会话使用 Windows DPAPI 的 Electron safeStorage 加密，GitHub token 永不进入客户端。无法加密时仅保留内存并提示用户。
- 关闭窗口先等待本地保存、IndexedDB 备份，再退出；不承诺关机断电时完成同步。设备切换必须等待“同步后换设备”成功。
- 主题和翻译随包，装饰性的远程徽章改为文字、致谢头像用本地占位图；保留作者姓名和链接。Knockout 现有绑定需要 `unsafe-eval`，因此游戏 CSP 保留它，但禁止外网资源、frame、object，UI 登录页使用更严格的 CSP。
- 不自动拉取官方客户端更新。此版本采用人工打包和安装，必须定期升级 Electron 与游戏；未配置发布证书时产物未签名。
