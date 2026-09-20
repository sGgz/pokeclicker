# GitHub 私有仓库云存档：实现与验收记录

日期：2026-09-20。游戏版本：0.10.26。目标地址：play.ggzz.fun。

## 交付状态

第一版代码、配置工具、操作手册和本地验证已完成。**尚未创建或修改用户的 Cloudflare/GitHub 资源，没有发布到 play.ggzz.fun。** 正式上线按 [新手手册](cloud-save-user-guide.md) 操作；真实账号登录、DNS、私有仓库权限及目标手机浏览器由上线验收确认。

本地测试使用独立临时浏览器资料和生成的测试存档，没有读取或替换用户真实进度。

## 已实现的行为

| 功能 | 实际行为 |
| --- | --- |
| 托管 | Cloudflare Worker 与 Static Assets 同源，Wrangler 上传生产构建的 docs 目录 |
| 登录 | Access 邮箱验证码；API 验证 RS256 签名、issuer、audience、有效期和唯一允许邮箱 |
| 凭据 | 仅服务端 GITHUB_SAVE_TOKEN Secret；网页不接收 token，公开配置与 Secret 分开 |
| 存档结构 | 原版 player/save/settings 完整快照，附 schemaVersion、revision、snapshotId、设备和时间等元数据 |
| 冲突 | GitHub blob SHA + revision 条件更新，失败返回双方进度；用户明确选择，禁止金币背包自动合并 |
| 重试 | IndexedDB 先保存确切请求再发送；相同 snapshotId 和内容的重放识别已成功写入 |
| 上传期间继续玩 | 回执只确认对应快照，新产生的进度保持待同步 |
| 本地保存 | 保留原游戏自动保存；三段序列化后再写，写入失败尝试恢复旧值并阻止云上传 |
| 恢复 | 替换前备份，IndexedDB 原子保存恢复副本和安装日志；刷新后完成三段数据安装及同步元数据，再清日志 |
| 启动 | 加载游戏对象、版本迁移及离线结算前比较云档；干净本地可恢复更新云档，分叉则等待选择 |
| 多标签 | Web Locks 锁覆盖同域游戏写入；另一页不能并行运行，关闭持锁页后可重试 |
| 切设备 | 保存最后快照、停止游戏循环及后台 worker、禁止卸载覆盖；回执确认后提示可以切换 |
| 自动同步 | 默认关闭，勾选后约每 10 分钟尝试；受浏览器后台节流影响；尊重游戏内关闭自动保存的设置 |
| 导入导出 | 原版 Unicode/Base64 .txt；另支持 payload JSON 和 GitHub 历史 envelope JSON，历史导入不继承旧 SHA |
| 删除 | 本地删除前备份并解除关联，不删除 GitHub 云档 |
| 体积与频率 | 完整云文件上限 5 MiB；写入至少间隔 15 秒；上游限流/网络异常退避 |
| 版本 | 拒绝用较旧游戏版本覆盖较新云档；本地恢复前检查版本；模块载入异常禁止上传 |

一次只支持一个云槽位和一个允许邮箱。本地最多 9 个槽位仍沿用原版。每次重新关联槽位关闭自动同步，需再次明确开启。

## 文件职责

| 文件 | 职责 |
| --- | --- |
| src/modules/cloudSave/protocol.ts | 前后端共享快照结构、校验、确定性 JSON 和 SHA-256 |
| src/modules/cloudSave/SyncEngine.ts | 同步状态机、持久请求、回执、冲突与启动决策 |
| src/modules/cloudSave/storage.ts | IndexedDB 状态、恢复副本和可重放安装事务 |
| src/modules/cloudSave/api.ts | 同源请求、超时、云档回执校验 |
| src/modules/cloudSave/CloudSave.ts | 旧游戏与新模块协调、标签锁、UI、导入恢复 |
| src/components/cloudSave.html | 选档页和游戏中的中文云存档面板 |
| cloud-save-worker/src/auth.ts | Cloudflare Access JWT 验证 |
| cloud-save-worker/src/github.ts | GitHub Contents API 条件写入、超过 1 MB 文件按不可变 blob SHA 读取 |
| cloud-save-worker/src/index.ts | API 路由、来源校验、单槽位、幂等与冲突 |
| cloud-save-worker/scripts/setup.mjs | 询问公开信息，生成被忽略的 wrangler.local.json，保留云槽位 ID |
| cloud-save-worker/scripts/recover.mjs | 将本地恢复包或云端 JSON 转成原版 .txt |
| .github/workflows/build.yml | 在原 CI 中增加独立 Worker 类型及测试任务 |

对原项目的接入集中在启动、Save.store/loadFromFile/delete、模块载入异常和 Game.stop。没有改战斗、奖励、掉落或经济规则。App 统一移除选档页并移动云面板，避免原全屏选档层遮住云存档按钮。

## 自动验证结果

使用 Node **v24.19.0**，遵守项目 Node 24 要求；未改用户系统默认 Node 版本。依赖按 lockfile 安装。翻译子模块为已锁定提交 47195e47e419b7bcbe9f9cdfad09065b00a55bb8。

| 检查 | 结果 |
| --- | --- |
| npm run cloud:build | 通过，含下方原游戏检查与生产构建 |
| 原游戏 Gulp TypeScript/Webpack 编译 | 通过 |
| 原游戏 Vitest | 4 个测试文件，54 项通过 |
| 原游戏 ESLint / Stylelint | 通过 |
| npm run cloud:check | strict TypeScript 通过；28 项测试通过 |
| npm --prefix cloud-save-worker run deploy:check | Wrangler dry-run 通过；未实际部署 |
| git diff --check | 通过 |

云存档 28 项测试涵盖：实际密钥签名的 JWT、过期和非允许身份、同源限制、缺配置关闭、并发首建、旧 SHA 冲突、丢回执重试、快照 ID 复用、旧版本拒绝、体积和写频率限制、GitHub 权限与 422 错误分类、大文件 blob 读取、入库失败不发送、刷新后重试、上传中的新进度、启动分叉、冲突停自动、绑定切换、哈希稳定、恢复中断重放、跨键 quota 回滚、IndexedDB 事务中止、损坏恢复数据拒绝、Unicode/百分号备份转换、向导重复执行保持配置和槽位。

生产构建统计：**8,523 个实际文件，约 84.5 MiB，总体最大单文件约 3.92 MiB**。Wrangler 扫描提示 8,604 个条目；此提示与实际文件统计口径不同。Worker 打包约 54.31 KiB，gzip 约 15.03 KiB。

构建仍有上游依赖的弃用、旧 Browserslist 数据提示；CNAME 未设置是原 GitHub Pages 构建提示，本部署由 Wrangler Custom Domain 管理域名。均未导致检查失败。

## 浏览器验收

使用 Playwright CLI 驱动本机 Chrome，访问生产构建资源。临时测试 API 复用实际 Worker handler 和内存仓库，测试环境注入认证，仅监听 127.0.0.1；该测试服务不在发布代码中，也不是生产绕过开关。

已实际操作：

1. 选档页展开面板、检查连接、新建游戏并完成初始战斗。
2. 首次确认关联 → 上传 → 云端回执 → “同步后换设备”暂停并关闭写入。
3. 打开第二标签页，验证无法启动；关闭旧页后重试，正常进入游戏。
4. 模拟另一设备修改云档，本地上传进入冲突并关闭自动同步；明确选择本地后，备份双方并生成新 revision。
5. 全新浏览器下载云档 → 确认 → 刷新安装 → 出现训练家卡片 → 游戏启动和离线收益结算。
6. 临时上游 503：显示失败，不显示成功，本地保存仍可用。
7. 浏览器 IndexedDB 不可用：云功能提示停止，本地 New Save 仍能启动。
8. GitHub 历史 JSON 和原版 .txt 均通过文件选择器导入；历史导入 base/关联为空，不继承旧版本。
9. 1280 像素桌面和 390 像素窄屏检查。修复原主题下次要按钮颜色与背景相同的问题，最终按钮可读、面板未横向越界。

本地截图在 output/playwright/cloud-save-desktop-final.png 和 cloud-save-mobile-final.png，属于忽略的验收产物，不提交测试存档。浏览器原项目的翻译回退存在 zh/zh-CN 404；初次空云槽位 404、模拟冲突 409 和模拟故障 503 是预期响应。浏览器验收不等于真实 Access、GitHub、手机 Safari 或长期挂机性能验收。

## 上线前仍需用户完成

- ggzz.fun 接入 Cloudflare，先保存并核对旧 DNS 记录。
- 创建专用 GitHub 私有仓库与仅该仓库 Contents 读写的 token。
- 创建精确邮箱 Access 策略，保存团队地址与应用 AUD。
- 运行配置向导、检查、部署，再通过 Secret 输入 token。
- 按手册在真实两台设备完成首次上传、恢复和切换，确认后再开启自动同步。

尚未实现多人账户、多云槽位、游戏内历史版本浏览、服务端挂机或自动合并。恢复副本不自动清理；GitHub 历史长期增长需要观察。较大真实存档的 Worker CPU、费用和实际网络延迟需部署后测量。
