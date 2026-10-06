# Windows 私人云存档客户端

最终用户请使用仓库 `design/cloud-save-user-guide.md` 的第十六节，或客户端内 **帮助 → 操作手册（离线可读）**。安装客户端不需要 Node、Git、Cloudflare CLI 或 GitHub token。

本地游戏资源通过 `pokeclicker://game/` 加载；云端固定连接 `https://play.ggzz.fun`。这是有离线资源的 Electron 应用，游戏逻辑在本机运行。GitHub 私库、槽位及 Worker 认证均沿用现有实现，无需另行部署后台。

当前桌面程序版本为 **1.0.4**，游戏版本为 **0.10.26**。本次新增普通任务按类型独立刷新、自动领奖续接，将原整批奖励计入单条奖励，并新增维生素标签筛选、修复最小化计时。继续包含 Magic Ball 后期经验调整、Rocky Helmet 30 级、可配置的 4/8/12/16 孵化槽上限和独立的外部宝可梦列表筛选；详细操作见随包离线手册第九节。新任务循环存档需配套使用本版网页与客户端，避免经旧端写回丢失新字段。

## 打开优化寻路和固定价格

这三项已在项目源码中实现，并于 **2026-09-28 发布到 play.ggzz.fun**。电脑上需要使用包含本次修改的新版客户端。**打包 EXE 不会自动更新网页**，本次网页已另外完成发布；没有读取或修改用户真实云档，真实两台设备往返仍需按下文核对。

1. 先在现在使用的游戏里打开 **云存档 → 导出本地备份**，保存得到的 `.txt`。也可用 **Start Menu → Save / Enter Code → Download Save**。备份保留到新版确认正常之后。
2. 关闭旧客户端，打开新版，点击自己的训练家卡片进入游戏。
3. 点 **Start Menu → Settings → Gameplay**，找到页面上方的 **自用玩法**。
4. 将 **地牢助手寻路** 从“官方寻路”改为“优化寻路”。这只调整选路方式，保留每位助手的速度、解锁条件和能力，不会自动开始刷地牢。
5. 将 **道具价格** 从“官方动态价格”改为“固定基础价（购买不涨价）”。已涨价的普通商店道具也按基础价购买；单买、批量与 Max 使用同一报价。
6. 核对 **地牢助手服务费**。默认已是“原价的 1%（门票原价）”，无需再打开；想恢复时选“官方原价”。助手正在执行已付费任务时，这一项不可修改，等任务结束后再调即可。
7. 按原方式雇用地牢助手。先看本批服务费、门票和总价，再点开始。配置会跟随当前训练家的存档保存，路径和正在运行的任务不会随云档恢复。

**原价的 1% = 0.1 折，不是 1 折。** 例如原服务费为 10,000 金币，新服务费为 100 金币；每项原本为正的服务费至少收 1 个对应货币，地牢门票仍按原价支付。费用仍是整批预付，手动 Fire 通常不退剩余费用，刷新也不能恢复剩余任务。

优化寻路和固定价格默认都关闭，可分别切回官方模式。固定价期间旧涨价倍率保留但冻结；切回官方价格后恢复旧倍率，不补扣省下的钱，也不退过去的差价。按固定价买过维生素后，该存档不能再使用旧的 `refund-vitamins` 退款码，切回官方价格也不会解除限制。

**两台电脑或网页一起用时，先更新所有端，再同步：** 从最新进度导出备份并完成一次确认上传，暂停各旧端自动同步；用同一份源码更新网页和所有 Windows 客户端，关闭旧网页标签和旧 EXE，再用新版接续云档。先手动完成一次“桌面 → 网页 → 桌面”，核对三个玩法选项和进度，再恢复自动同步。云端目前不会自动阻止同游戏版本的旧客户端覆盖新设置；官方客户端也可能在保存时丢弃自用设置，不能拿它当中转。

如果 Settings 里看不到“自用玩法”，当前打开的仍是旧版，先检查本次打包目录或网页是否已更新。实现细节、存档边界及官方更新检查项见[自用玩法说明](../design/private-gameplay-design.md)。

## 更新源码后双击打包

在打包电脑首次安装 [Node.js](https://nodejs.org/en/download)（建议 Windows x64 的 **24 LTS**）和 [Git for Windows](https://git-scm.com/downloads/win)，之后日常只需双击项目根目录的 **build-windows.cmd**。已有 Node **18 或更高版本**可以保留，由脚本准备本项目的 Node 24；低于 18 或未安装时，脚本会提示先安装 24 LTS。安装工具时采用默认选项，完成后重新打开脚本。仅运行成品客户端的其他电脑不需要这些工具。

使用保留本项目云存档功能的**完整 Git 项目**，在原项目中更新，或通过 Git 获取对应分支；不要覆盖成官方原版，也不要用 GitHub 源码页的 Download ZIP 代替 Git 项目。翻译子模块与代码提交记录需要 Git。脚本构建的是当前本机代码，不执行 `git pull`，不自动合并上游、不修改源码版本号，也不发布 Cloudflare 网页或存档。

先备份进度并关闭正在运行的游戏，再双击 `build-windows.cmd`。脚本按顺序完成：

1. 准备 Node 24。CMD 入口先检查现有 Node 是否至少为 18；符合条件但不是 24 时，自动从 Node.js 官方下载 **v24.21.0**，核对固定 SHA-256 后放在项目 `.desktop-build/runtime/`；只供本次项目构建使用，不改系统全局 Node。
2. 对根项目、`cloud-save-worker`、`desktop` 三份依赖分别执行 `npm ci`，按锁文件重新准备，再显式执行 Electron 官方安装脚本下载运行文件。下载缓存复用，仍应保持联网；npm、Electron、打包缓存与临时文件都在项目 `.desktop-build/`。
3. 执行桌面测试、Worker 检查，以及包含游戏测试和检查的生产构建。
4. 生成 Windows x64 EXE、NSIS 安装包和完整 ZIP，检查必需文件及包内版本，写出校验值与本次构建记录。
5. 成功后自动打开本次独立输出目录：`output/desktop-builds/game-游戏版本_时间-随机后缀/`。

新输出目录中的 **开始游戏.cmd** 可直接运行同目录 `win-unpacked` 中的客户端；该启动脚本在**输出目录**，不在项目根目录。向另一台电脑交付时，可复制 Setup 安装包，或复制完整 ZIP 后全部解压运行。不要只复制 `win-unpacked` 内的 EXE，程序需要配套文件。

每次输出使用唯一目录，即使版本号相同也不会把旧包当成本次成功产物。`打包成功.txt` 记录游戏版本、外壳版本、代码提交、完成时间和日志位置；`SHA256SUMS.txt` 提供安装包和 ZIP 的校验值；`output/desktop-builds/最近一次成功打包.txt` 可定位最近一次成功目录。仍带 `打包中.txt` 或 `打包失败.txt` 的目录不能当作完成的新版交付。

失败时窗口保留报错，不会立刻消失；日志在项目 `.desktop-build/logs/`。正常退出会释放构建锁，强行关闭窗口可能留下 `.desktop-build/build.lock`。只有确认其他构建都已停止后，才删除这一个锁文件并重试；不要因此删除游戏存档目录。脚本不读取、删除或上传用户真实存档，应用身份与 `%APPDATA%\PokeclickerCloud` 数据目录保持不变。

自动化环境可从项目根目录运行 `build-windows.cmd --ci`；它执行相同构建，结束时不暂停等待按键，也不打开资源管理器。脚本运行检查的通过情况以该次输出和日志为准；本节描述操作流程，不代替实际验收记录。

## 开发命令

使用 Windows x64、Node 24，在仓库根目录执行：

```text
npm ci
npm --prefix cloud-save-worker ci
npm run desktop:install
node desktop/node_modules/electron/install.js
npm run desktop:build
```

这是供开发人员使用的手动命令。`desktop:build` 会构建并检查游戏，再制作安装包和 ZIP，默认输出至 `output/desktop/`；上面的双击脚本另外执行依赖安装和完整检查，并将每次成品放在 `output/desktop-builds/` 的唯一目录。`desktop:install` 使用锁文件安装 Electron 等构建依赖；当前 Electron 包不会通过 postinstall 自动下载运行文件，因此首次手动安装或重装依赖后，还需执行上述 `node desktop/node_modules/electron/install.js`。双击脚本已代为完成这一步。不要设置 `ELECTRON_SKIP_BINARY_DOWNLOAD`，本地调试需要 Electron 二进制文件。游戏构建后可用 `npm run desktop:start` 调试。

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
