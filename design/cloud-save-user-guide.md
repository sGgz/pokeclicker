# PokéClicker 私人云存档操作手册

适用：Windows；域名 **ggzz.fun**；游戏入口计划为 **https://play.ggzz.fun**。编写日期：2026-09-20。

**代码已实现；网站还没有发布到你的账号。** 按本手册完成账号配置和发布后才能从该地址游玩。已有域名不用再买，也不用租服务器。网页由 Cloudflare 托管，存档放你的 GitHub 私有仓库，自己的电脑关机不影响云档保留。

本手册使用命令提示符 **cmd**。每次只复制代码框中的一行，按回车，等它执行完再运行下一行。出现报错先停在该步骤，不要跳过检查继续发布。

## 一、先认清这几样东西

| 名称 | 你可以把它理解为 | 本次填写 |
| --- | --- | --- |
| 域名 | 游戏的网址 | play.ggzz.fun |
| Cloudflare | 放网页、处理登录和存档请求的平台 | 用你自己的账号 |
| GitHub 私有仓库 | 只给你看的存档文件夹，带修改历史 | 建议 pokeclicker-saves |
| GitHub token | Cloudflare 访问这个文件夹的钥匙 | 只录入 Cloudflare Secret |
| Access | 打开游戏前的邮箱验证码门禁 | 只允许你的一个邮箱 |
| 云槽位 ID | 云存档的固定编号 | 配置向导生成，之后保持不变 |

本版本支持一个邮箱、一个云槽位；原游戏最多 9 个本地槽位继续保留，只有你关联的一个槽位会同步。不合并两台设备分别挣的金币、背包和进度。

准备好能登录的 GitHub 账号、Cloudflare 账号、域名管理账号，以及能收到验证码的邮箱。**不要把 GitHub token 发到聊天里、填进游戏网页或提交到代码仓库。**

## 二、先备份原来的游戏

1. 在原来游玩的浏览器、原来的网站打开游戏。
2. 打开游戏的存档菜单，选择 **Download Save / 下载存档**，保存得到的 .txt 文件。
3. 在电脑上另建“宝可梦存档备份”文件夹，把它放进去；也可以额外复制到 U 盘。
4. 在新网址验证导入和同步成功前，保留原网站的数据和这个文件。

浏览器按域名隔离存档，所以原网站的进度不会自动出现在 play.ggzz.fun。不要先清理浏览器缓存或卸载浏览器。

## 三、把 ggzz.fun 的 DNS 接入 Cloudflare

2026-09-20 查询到 ggzz.fun 的域名服务器是 ns1.volcengine-dns.com 和 ns2.volcengine-dns.com，说明当时 DNS 由火山引擎管理；这不能判断域名在哪里买的。play.ggzz.fun 当时没有查到 A 记录。实际操作时以后台最新状态为准。

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，添加现有域名 **ggzz.fun**，选择适合个人使用的计划。
2. **先保留旧 DNS 记录**：到当前 DNS 平台导出记录，或逐项截图。至少核对 A、AAAA、CNAME、MX、TXT、SRV、CAA；邮箱的 SPF、DKIM、DMARC 也要保留。
3. Cloudflare 自动扫描后，逐条对照原记录补齐。扫描可能漏记录，不要只看到“完成”就直接下一步。
4. 为减少迁移变量，已有站点的记录先按原需求设置；不确定的网站 A/CNAME 可先设为 DNS only。邮件服务器相关记录保持 DNS only。不要删除原站点和邮箱记录。
5. 如果原来开了 DNSSEC，先按官方迁移步骤在域名注册商处理旧 DS 记录、关闭旧 DNSSEC。不要带着旧 DS 直接换 NS。
6. Cloudflare 会显示**专属于你账号的两条 nameserver / NS**。复制它们。
7. 登录你购买 ggzz.fun 的平台，找到“域名服务器 / 修改 DNS 服务器”，替换为上一步那两条。不是在 DNS 记录列表里添加两条普通 NS。
8. 回 Cloudflare 等待域名状态变为 **Active / 有效**。传播需要时间；此期间检查旧网站和邮箱仍可使用。
9. 完成迁移后，如果需要 DNSSEC，再在 Cloudflare 开启并把新 DS 填回注册商。
10. play 子域的绑定由后续部署命令创建，不要给它随便填写一个服务器 IP。如果它已经有业务，先换一个未使用的子域，并在 Access 和配置向导中统一修改。

这里迁移的是 DNS 管理，不是转移域名所有权。官方步骤：[Full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)。

## 四、新建专门存档的 GitHub 私有仓库

1. 登录 [GitHub](https://github.com/)，右上角加号 → **New repository**。
2. Owner 选你自己的个人账号，Repository name 填 **pokeclicker-saves**。
3. 可见性选 **Private**。
4. 勾选 **Add a README file**，然后创建。这个勾选让仓库有初始提交和分支；空仓库不能直接使用本方案。
5. 记下你的用户名、仓库名以及分支名（通常为 main，以页面为准）。
6. 这是存档专用仓库，不要把整个游戏源码上传到这里。不要为 main 设置“必须提 PR 才能写入”等会阻止 API 保存的规则。

再创建一把只管此仓库的钥匙：

1. GitHub 头像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**。
2. 名称可填 Pokeclicker Cloud Save；选择到期时间，并在你自己的日历记下更新日期。
3. Resource owner 选你自己。
4. Repository access 选 **Only select repositories**，只勾 **pokeclicker-saves**。
5. Repository permissions 中将 **Contents** 设置为 **Read and write**；Metadata 的默认读取权限保留，其余不额外开放。
6. 创建后妥善保存在自己的密码管理器里，稍后录入 Cloudflare。离开页面后通常不能再次看到完整 token。

使用个人拥有的仓库可避免组织审批步骤。官方说明：[管理 fine-grained token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

## 五、配置只允许你登录的邮箱门禁

这一节先于部署，避免网站刚发布时没有门禁。界面会变化，中文和英文按钮名称可能不同。

1. 进入 Cloudflare 的 **Zero Trust / Cloudflare One**，按界面创建团队，记下形如 **https://你的团队名.cloudflareaccess.com** 的团队地址。
2. 到 **Integrations → Identity providers**，添加 **One-time PIN** 登录方式。如果已存在，直接使用。
3. 到 **Access controls → Applications → Create new application**，选 **Self-hosted and private**（旧界面可能叫 Self-hosted）。
4. 添加 **public hostname**：子域填 play，根域选 ggzz.fun。最终必须是 **play.ggzz.fun**，路径留空，保护整个网站，包括 /api/。
5. 应用名称可填“我的 Pokeclicker”，会话时长可先用 24 小时。
6. 建立 Allow 策略。Include 规则选 **Emails**，只填你的完整邮箱，例如 your-name@example.com。不要选择 Everyone、整个邮箱域或 Bypass。
7. 登录方式选择 **One-time PIN**，保存应用。
8. 打开应用详情，找到 **Application Audience (AUD)** 并复制。它是一串较长的标识，不是应用名称，也不是团队名。

记下两项：完整团队地址和应用 AUD。后面向导会询问。Worker 还会独立验证 Access 签名、有效期、AUD 和邮箱；只填请求头里的邮箱不能绕过验证。

官方入口：[创建 Access 应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)、[邮箱验证码登录](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)。

## 六、准备电脑上的工具与代码

1. 安装 [Node.js](https://nodejs.org/en/download) 的 **24.x** 版本，Windows Installer 选默认安装步骤。此项目要求 Node 24；本次检查发现电脑原有 Node 25，运行下列命令时需确保已经切到 24。
2. 若没有 Git，安装 [Git for Windows](https://git-scm.com/downloads/win)，默认选项即可。
3. 安装完关闭旧命令窗口，再打开。
4. 用资源管理器打开本项目目录，点击地址栏，输入 **cmd**，按回车。它会打开位于项目目录的命令提示符。

本次代码目录是：

```text
D:\work\code\tideng_worktree_dir\54b7\pokeclicker
```

可以在命令提示符里手动进入：

```bat
cd /d D:\work\code\tideng_worktree_dir\54b7\pokeclicker
```

然后逐行检查：

```bat
node --version
npm --version
git --version
```

第一行应显示 v24.x.x。如果仍是 v25，关闭窗口后重开；仍不对可用 where node 查看安装路径，先处理版本，不要用强制忽略版本参数。

这里使用的是**本次已修改的项目**。不要重新下载上游原版替换它，否则云存档功能也会被换掉。无需先把整个源码上传到 GitHub 才能部署。

## 七、安装、填写配置与检查

在项目目录逐行执行，第一次下载依赖可能较慢：

```bat
npm ci
npm --prefix cloud-save-worker ci
npm run cloud:setup
```

向导会依次询问：

| 提示 | 填写内容 |
| --- | --- |
| 游戏域名 | 默认 play.ggzz.fun，直接回车 |
| GitHub 用户名 | 第四节仓库拥有者 |
| 私有存档仓库名 | 默认 pokeclicker-saves |
| 存档仓库分支 | 通常 main |
| Access 团队地址 | 第五节完整 https://xxx.cloudflareaccess.com |
| Access 应用 AUD | 第五节复制的那一串 |
| 唯一允许登录的邮箱 | 必须与第五节 Allow 中完全一致 |

向导不需要 token。结果保存在 **cloud-save-worker/wrangler.local.json**，已加入 Git 忽略。**把该文件另存一份备份**：其中 CLOUD_SLOT_ID 是云档编号，重装或换电脑部署时保持不变。重复运行向导会保留现有编号。

继续逐行执行：

```bat
npm run cloud:check
npm run cloud:build
npm run cloud:preview
```

检查含义：

- cloud:check：验证云 API、签名、冲突和恢复逻辑。
- cloud:build：初始化已锁定版本的翻译资源，运行原游戏检查并生成网页。docs 目录是生成物，构建会清空，不要在里面放自己的文档或备份。
- cloud:preview：只检查发布包，不会把网站发布出去；结尾应出现 dry-run 退出提示。它不是本地试玩服务器。

如果首次安装网络中断，网络恢复后重新运行对应命令。npm 提示旧包或审计信息不等于构建失败，以命令最终是否成功结束为准；不要直接执行 npm audit fix --force 改动整套依赖。

## 八、登录并正式发布

确认第三节域名 Active、第五节 Access 应用已保存、上一节检查通过。

```bat
npm run cloud:login
```

它会打开浏览器，让你登录并授权 Wrangler 管理 Cloudflare。选择拥有 ggzz.fun 的那个账号。完成后回命令窗口。

```bat
npm run cloud:deploy
```

该命令上传游戏网页和 Worker，并绑定 play.ggzz.fun。自定义域由 Workers 创建，不需要自己买服务器或填服务器 IP。首次发布时 token 尚未录入，存档 API 会明确显示配置未完成。

最后安全录入 token：

```bat
npm run cloud:secret
```

出现输入提示后粘贴第四节的 GitHub token，按回车。输入内容可能被隐藏，这是正常的。不要把 token 拼到命令末尾，不要把它写进 wrangler.local.json。命令成功后 Secret 即可用于已部署 Worker。

如果命令表示找不到 Worker，说明 cloud:deploy 没有成功，先回头处理部署错误，不要手工创建不同名称的项目。

发布后在 Cloudflare Workers & Pages 找到 **pokeclicker-cloud-save**，核对：

- Custom Domain 是 play.ggzz.fun，HTTPS 证书已就绪。
- workers.dev 和 Preview URLs 都关闭（本项目配置已关闭它们）。
- Variables 中公开字段完整；Secret 中存在 GITHUB_SAVE_TOKEN。
- Access 应用保护 play.ggzz.fun 的全部路径。
- 没有给 /api/cloud-save 建立缓存规则或把它排除在 Access 外。

官方说明：[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 九、第一次验收：先成功同步一次，再开启自动同步

1. 打开 **https://play.ggzz.fun**。应先看到邮箱登录页面。
2. 输入允许的邮箱，收验证码并登录。若无痕窗口不登录也直接进游戏，先检查 Access 是否保护了正确域名。
3. 展开页面顶部“云存档”，点 **检查连接**，应显示连接成功。
4. 在选档页点击 **Import Save**，选择第二节备份的 .txt；页面刷新后选择导入的存档。原版按钮仍可能是英文。
5. 核对训练家名称、地区、宝可梦和主要进度是否正确。
6. 点 **上传 / 立即同步**，首次询问关联时确认。等到“云端已确认保存”；失败不能视为已上云。
7. 打开 GitHub 私有仓库，应出现 saves 文件夹和一个以云槽位 ID 命名的 JSON 文件；查看提交时间。
8. 点 **同步后换设备**，等到明确提示“同步成功，可以关闭此页面并换设备”。这个按钮会暂停本页游戏，防止确认后又产生新进度。继续玩需刷新。
9. 用另一台电脑或手机打开同一网址、登录，展开云存档；本地槽位选“恢复云档时新建本地槽位”，点 **下载云档到本机**，确认备份并恢复。
10. 页面刷新后选恢复的卡片进入游戏，核对进度。离线收益仍按原游戏规则结算。
11. 两台设备都核对成功后，才按需要开启 **每 10 分钟自动同步**。它默认关闭，跟随这个浏览器中的关联配置，不会自动给所有设备打开。

正常电脑与目标手机都做一次。这里没有代替你操作真实账号，实际邮件、DNS、GitHub 权限、移动端兼容性和延迟须在你上线后确认。

## 十、平时怎么玩

**每次换设备：旧设备点“同步后换设备”并等成功 → 关闭旧页面 → 新设备进入游戏。** 这是最省心的习惯。

本地约每 10 秒自动保存，云端自动同步约每 10 分钟尝试一次。后台休眠、网络故障或游戏内关闭自动保存会影响它，关闭网页不会保证再补传一次。游戏内关闭自动保存时，云端自动同步也停止；手动同步仍会主动保存一次。

如果提示“上一份快照已确认，但仍有更新的本地进度”，说明刚确认的是之前网络不确定的请求。按提示等待至少 15 秒再同步；**看到可换设备的成功提示之前不要切换**。快速重复写入和故障重试还可能要求更长等待，以页面提示为准。

同一浏览器只能一个标签页运行游戏。看到“另一个标签页打开”，先关闭旧页，再在当前页重试。不同设备之间靠云档版本检查防止互相覆盖，不支持同时玩后自动合并。

定期点击“导出本地备份”额外保存 .txt。浏览器本地恢复副本也在浏览器里，清站点数据会一起丢失，下载到电脑的文件才是独立副本。

## 十一、出现冲突怎么选

冲突意味着本地和云端各有变化，并不代表文件损坏。自动同步会暂停，页面显示两份的名称、游戏时间和云端保存时间。

- 想继续另一台设备已经上传的进度：点 **使用这份云端进度**，系统先留恢复副本，再刷新载入。
- 确定当前本地更值得保留：点 **使用本地进度覆盖云端**。系统先备份双方，再尝试提交；若另一台又上传了，会再次拒绝覆盖。
- 不确定：先点 **导出本地备份** 和 **下载恢复备份包** 保存文件，再核对两台设备。不要靠刷新反复碰运气。

处理冲突针对已关联槽位。游戏内正在玩另一个槽位时，需要刷新回选档页再处理。

## 十二、误覆盖、旧历史和恢复备份包

### 从 GitHub 找回旧进度

1. 先把当前本地存档导出。
2. GitHub 私有仓库 → saves → 你的 JSON 文件 → History。
3. 选择误操作前的提交，查看当时文件，用 Raw / Download raw file 保存 JSON。不要保存 GitHub 网页的 HTML。
4. 游戏选档页用 Import Save 导入这个 JSON（也支持原版 .txt），建议新建本地槽位后核对。
5. 历史 JSON 按“本地导入档”处理，不继承旧的远端版本号。确认要用它后点击上传，已有云档会先显示冲突，再由你选择覆盖。这样以新提交恢复旧进度，原历史保留。

### 从“下载恢复备份包”找回进度

在项目命令窗口运行：

```bat
npm run cloud:recover
```

按提示把下载的 pokeclicker-recovery-backups.json 拖入窗口，按回车。工具在原文件旁边新建 recovered 文件夹，把每份有效存档转成原游戏支持的 .txt。文件名含时间，local 表示当时本地，cloud 表示当时云端；空的新槽位副本不会生成文件。

在选档页用 Import Save 导入其中一份核对。此工具只生成文件，不会直接修改浏览器或 GitHub。它也能转换从 GitHub 下载的单个存档 JSON。不要清理原备份包，直到核对完成。

若浏览器提示恢复中断或空间不足，先保留原文件并下载能导出的备份；先关闭其他游戏页；如果电脑磁盘已满，释放磁盘空间后刷新重试。如果是本站本地存档占满浏览器额度，先导出其他本地档，再在选档页的三点菜单中删除不需要的本地槽位，删除本地槽位不会删除 GitHub 云档。恢复日志会保留到本地数据和同步信息都写完为止。不要用“清除此站点数据”来释放空间，那会删除恢复日志和本地档。

## 十三、常见问题

| 现象 | 处理 |
| --- | --- |
| node 版本错误 / EBADDEVENGINES | 使用 Node 24.x，重开 cmd 后检查 node --version |
| 域名打不开 / 证书尚未就绪 | 检查 ggzz.fun 是否 Active、NS 是否换对、Workers Custom Domain 是否成功绑定，等待传播和证书 |
| 收不到验证码 | 确认输入邮箱与 Allow 一致，检查垃圾邮件；不在名单内也可能看到“已发送”的通用提示 |
| 进入网站没登录页面 | 用无痕窗口确认；核对 Access 主机名和空路径，不能只保护首页 |
| 云服务尚未启用或登录已过期 | 先导出本地备份，再刷新登录；确认已发布 Worker API |
| 配置未完成 | 对照向导和 Worker Secret；执行 cloud:secret 后再检查 |
| GitHub 凭据失效或权限不足 | 检查 token 到期、指定仓库、Contents Read and write；按下一节轮换 |
| 无法访问仓库或分支 | 检查 owner/repo/main 是否填对、仓库是否勾 README 初始化 |
| 等待后重试 / 请求频率受限 | 按提示等待，不要连续点；本地继续保存 |
| 云端来自更新版本 | 更新游戏代码；不要用旧客户端覆盖较新版本档 |
| 存档超过 5 MiB | 先导出备份；本版拒绝超限云档，需要后续改为对象存储或调整方案 |
| 云同步停止 / 模块载入失败 | 先导出当前备份，保留恢复包，再检查控制台错误；不要强制覆盖云档 |
| 另一个标签页已打开 | 关闭同网址其他游戏页，再重试；同浏览器只保留一个运行页 |

出问题可以提供**不含 token 的报错文字和步骤**。不要公开整个存档或私有仓库权限截图中的密钥。

## 十四、更新密钥与游戏

token 快到期时：在 GitHub 创建同权限的新 token → 在项目目录运行 npm run cloud:secret → 粘贴新 token → 网页检查连接并成功同步一次 → 再撤销旧 token。

更新游戏前先“同步后换设备”、关闭其他页面并下载备份。拿到保留本项目云存档改动的新代码后运行：

```bat
npm ci
npm --prefix cloud-save-worker ci
npm run cloud:check
npm run cloud:build
npm run cloud:preview
npm run cloud:deploy
```

保留 wrangler.local.json 和 CLOUD_SLOT_ID，不需每次生成新的 token。不要将旧版源码直接覆盖新版存档；游戏版本降级可能无法载入，云端也会阻止降级写入。要撤回一次有问题的网页发布，可在 Cloudflare Worker 的 Deployments 中选上一版 Rollback；这只回退代码，不能回退存档，也不能解决旧代码不认识新存档的问题。

## 十五、费用与边界

无需租用 VPS，但域名续费、Cloudflare/Access 套餐及服务额度以你的账号界面为准。本方案不承诺永久零费用。个人低频读写通常很少，较大存档的 JSON 校验和编码仍可能受 Worker CPU 额度限制；实际上线后在 Workers Metrics 查看，必要时调整套餐或改存储方案。

GitHub 会积累保存历史，10 分钟一次、全天开启理论上每天可新增 144 次提交。首版不自动清理历史，避免误删备份；长期体积增长明显时应再评估降低频率或将高频存档迁至 R2。

本次交付的检查记录见 [实现与验收记录](cloud-save-implementation.md)，方案原理见 [设计文档](cloud-save-design.md)。真实账号首次验收以第九节为准。
