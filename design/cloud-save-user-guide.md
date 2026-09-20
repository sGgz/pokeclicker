# PokéClicker 私人云存档操作手册

适用：Windows；**域名 ggzz.fun 购买于火山引擎**；游戏入口计划为 **https://play.ggzz.fun**。更新日期：2026-09-20。

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

先在桌面新建一个“游戏上线资料”文件夹，用来保存旧 DNS 记录、存档备份和后面生成的配置文件。再在其中建一个普通文本文件“配置记录.txt”，逐步记录以下内容，**这里不记录 token**：

```text
游戏网址：https://play.ggzz.fun
GitHub 用户名：稍后填写
存档仓库：pokeclicker-saves
仓库分支：稍后确认，通常是 main
允许登录的完整邮箱：填写你自己能收信的邮箱
Cloudflare Access 团队地址：稍后填写
Cloudflare Access 应用 AUD：稍后填写
```

下面有些操作在浏览器里做，有些在黑色的 cmd 窗口里做。只有标成命令的代码框需要粘贴到 cmd；网址在浏览器地址栏打开。按钮的中文翻译可能略有不同，以旁边的英文名称帮助定位。

## 二、先备份原来的游戏

1. 在原来游玩的浏览器、原来的网站打开游戏。
2. 点 **Start Menu → Save / Enter Code → Download Save**，保存得到的 .txt 文件。若你停在选档页，也可点存档卡片左上角 **⋮ → Download (backup)**。不要点 DELETE SAVE。
3. 在电脑上另建“宝可梦存档备份”文件夹，把它放进去；也可以额外复制到 U 盘。
4. 在新网址验证导入和同步成功前，保留原网站的数据和这个文件。

浏览器按域名隔离存档，所以原网站的进度不会自动出现在 play.ggzz.fun。不要先清理浏览器缓存或卸载浏览器。

## 三、把 ggzz.fun 的 DNS 接入 Cloudflare

2026-09-20 查询到 ggzz.fun 的域名服务器是 ns1.volcengine-dns.com 和 ns2.volcengine-dns.com；你也已确认域名购买于火山引擎。以下按火山引擎操作。域名仍在火山引擎续费，只把 DNS 管理交给 Cloudflare。

**3.1 先在火山引擎备份旧解析记录。**

1. 打开 [火山引擎控制台](https://console.volcengine.com/)，登录购买域名的账号。
2. 在顶部产品搜索中找 **云解析 DNS**，进入后点 **公网域名管理**。
3. 找到并点击 **ggzz.fun**，打开 **记录管理**。
4. 点击记录列表右侧的 **导出**，格式选 **xlsx**，点击 **确认导出**，把下载的文件保存到“游戏上线资料”。这是手工导出，不需要购买自动备份服务。
5. 同时把现有记录截个图；如果有多页，每页都保存。记录类型、主机记录、记录值、MX 优先级都要能看清。TXT 值可能很长，导出文件用于保存完整内容。
6. 若列表没有自建记录，就记录“目前没有业务解析记录”；不要为凑齐记录而新增内容。

**完成标志：** 你手里已有旧记录文件或完整截图。官方入口说明：[导出解析记录](https://www.volcengine.com/docs/6758/155158?lang=zh)。

**3.2 在 Cloudflare 添加 ggzz.fun。**

1. 打开 [Cloudflare 控制台](https://dash.cloudflare.com/)。没有账号就点 Sign up 注册，并完成邮箱验证；已有账号直接登录。
2. 在 **Domains / 域名** 页面点 **Onboard a domain / 添加域名**；旧界面可能显示 Add a site。
3. 输入 **ggzz.fun**，不带 https://，也不填 play.ggzz.fun；继续。
4. 本次选择 **Free / 免费** 计划，继续。
5. 扫描现有 DNS 后，对照刚才导出的文件逐项核对。缺记录时点 **Add record / 添加记录**，照旧记录填写 Type、Name、Content、TTL；MX 还要核对 Priority。不要自行猜 IP。
6. 保留原有网站和邮箱所需的 A、AAAA、CNAME、MX、TXT、SRV、CAA 等记录。旧平台默认的根域 NS、SOA 不需要当业务记录搬过去。邮件主机的 A/CNAME 使用 **DNS only / 仅 DNS**；有特殊线路解析的记录不能机械照搬，需要先核对用途。
7. 对已有网站暂不改变其代理需求；原先直接解析、没有经过 Cloudflare 的网站可先使用 DNS only，减少迁移变量。
8. 如果旧域名已启用 **DNSSEC**，先在注册商关闭旧 DNSSEC／移除旧 DS，并按平台提示等待生效再换服务器；已关闭则跳过。不要带着旧 DS 直接切换。
9. 继续到 **nameservers / 名称服务器** 页面，把 Cloudflare 实际分配的两条地址复制到“配置记录.txt”。通常以 ns.cloudflare.com 结尾，**必须用你页面上的两条**。

**3.3 回火山引擎修改域名服务器。**

1. 回到 [火山引擎控制台](https://console.volcengine.com/)，这次在产品搜索里找 **域名服务**。
2. 进入 **域名列表**，找到 **ggzz.fun**，点击这一行的 **管理**。
3. 在域名管理页面找到 **域名服务 → DNS服务器 → 修改**。
4. 选择 **自定义DNS**，把旧服务器地址替换为 Cloudflare 分配的两条。每个输入框填一条服务器名称，不带 https://。不要同时保留旧服务器。
5. 点 **提交**；如果要求短信或身份验证，按火山引擎页面完成。
6. 回 Cloudflare 的 ggzz.fun 页面，若有“我已更新名称服务器 / 检查名称服务器”就点击，然后等待状态成为 **Active / 有效**。

这里改的是“域名服务器”，**不是在“记录管理”里新增两条 NS 解析记录**，也不需要点“域名转出”。火山引擎官方路径见[配置域名 DNS](https://www.volcengine.com/docs/6758/1472583?lang=zh)；[DNS 修改说明](https://www.volcengine.com/docs/6568/81326)提示全球生效可能最长需要 72 小时，以 Cloudflare 的实际状态为准。

**完成标志：** Cloudflare 显示 ggzz.fun 为 Active；如果原来有网站、域名邮箱，它们仍可正常使用。等待期间可以继续建 GitHub 仓库，正式部署前应已 Active。

play 子域由后面的发布命令创建，无需现在填写 IP。若 play 已被其他业务使用，先核对，不直接覆盖。迁移后如果要重新开启 DNSSEC，使用 Cloudflare 新生成的 DS 配回注册商。完整迁移依据：[Cloudflare Full setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)。

## 四、新建专门存档的 GitHub 私有仓库

1. 登录 [GitHub](https://github.com/)，再打开 [新建仓库页面](https://github.com/new)。没有账号先注册并验证邮箱。
2. Owner 选你自己的个人账号，Repository name 填 **pokeclicker-saves**。
3. 可见性选 **Private**。
4. 勾选 **Add a README file**，然后创建。这个勾选让仓库有初始提交和分支；空仓库不能直接使用本方案。
5. 记下你的用户名、仓库名以及分支名（通常为 main，以页面为准）。
6. 这是存档专用仓库，不要把整个游戏源码上传到这里。不要为 main 设置“必须提 PR 才能写入”等会阻止 API 保存的规则。

例如浏览器地址栏是 https://github.com/abc123/pokeclicker-saves，那么 GitHub 用户名就是 abc123，不是个人资料里的中文昵称或邮箱。把实际用户名、仓库名、左上方分支按钮显示的分支写进“配置记录.txt”。

**完成标志：** 仓库页面显示 **Private**，文件列表里有 **README.md**，能看到 main 或你的实际分支名。此时先不创建 token，第八节临近录入密钥时再创建。官方说明：[创建仓库](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)。

## 五、配置只允许你登录的邮箱门禁

这一节先于部署，避免网站刚发布时没有门禁。界面会变化，中文和英文按钮名称可能不同。

**5.1 开通团队。**

1. 回 [Cloudflare 控制台](https://dash.cloudflare.com/)，打开 **Zero Trust / Cloudflare One**，使用接入 ggzz.fun 的同一个账号。
2. 第一次进入按提示创建团队。团队名可尝试 ggzz-game；若被占用就另选一个。只有你页面接受的实际名字才有效。
3. 选择 **Free** 计划。官方当前开通流程可能仍要求付款资料；核对所选计划和页面金额，Free 计划本身不收费，不要误选付费套餐。账号实际要求以页面为准。
4. 记下完整团队地址，例如当实际团队名是 ggzz-game 时，地址是 https://ggzz-game.cloudflareaccess.com。可以在 **Zero Trust → Settings** 核对团队名。

这个地址与游戏地址不同。官方开通说明：[Get started](https://developers.cloudflare.com/cloudflare-one/setup/)。

**5.2 添加邮箱验证码登录。**

1. 在 Zero Trust 左侧点 **Integrations → Identity providers**。
2. 若已有 **One-time PIN**，直接保留；没有就点 **Add new identity provider → One-time PIN**，按页面保存。

验证码由 Cloudflare 发送，不需要自己设置邮件服务器。官方说明：[邮箱验证码](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)。

**5.3 为游戏建立访问规则。**

1. 左侧 **Access controls → Applications → Create new application**。
2. 类型选 **Self-hosted and private**；旧版可能叫 **Self-hosted**。本项目不需要创建 Tunnel。
3. 应用名称填 **My Pokeclicker**；Session duration 可先选 **24 hours**。
4. 点 **Add public hostname**，Subdomain 填 **play**，Domain 选 **ggzz.fun**，**Path 留空**。如界面只有一个完整域名框，填 play.ggzz.fun。
5. 找到 **Policies**，添加一条策略（按钮可能是 Add a policy 或 Create new policy），名称填 **Only me**，Action 选 **Allow**。
6. 在 **Include** 规则中，Selector 选 **Emails**，Value 填你自己的完整邮箱。只填这一个邮箱，不要照抄示例邮箱，不选 Everyone、Emails ending in 或 Bypass。
7. 保存策略，并确认它已关联到此应用。在应用的登录方式中选 **One-time PIN**；若有 Accept all available identity providers，可关闭后仅选 One-time PIN。
8. 完成余下页面，点击 **Save / Create** 保存整个应用。列表里应能看到 My Pokeclicker 和 play.ggzz.fun。

官方操作依据：[创建 Access 应用](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)。

**5.4 复制应用 AUD。**

1. 在 **Access controls → Applications** 列表找到 My Pokeclicker，打开 **Configure / 配置**。
2. 进入 **Additional settings / 其他设置**，找到 **Application Audience (AUD) Tag**。
3. 点击复制，保存到“配置记录.txt”。向导要求 64 位十六进制标识，**不要复制 Application ID**。
4. 一并检查团队地址已记录为完整的 https://实际团队名.cloudflareaccess.com，末尾不加斜杠。

**完成标志：** 应用保护 play.ggzz.fun，路径为空；Allow 里只有你的完整邮箱；记录好了邮箱、团队地址和 AUD。官方 AUD 位置：[Validate JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)。

## 六、准备电脑上的工具与代码

此项目要求 Node **24.x**。之前检查发现电脑原有 Node 25，下面使用单独解压的 Node 24，只在本次命令窗口切换，不需要卸载原有版本。

**6.1 准备 Node 24。**

1. 打开 [Node.js 官方下载页](https://nodejs.org/en/download)，版本选 **24.x / LTS**，系统选 **Windows**。
2. 普通 Intel/AMD 的 64 位电脑选 **x64**；若 Windows“设置 → 系统 → 系统信息”明确写 ARM，则选 ARM64。
3. 下载 **Standalone Binary (.zip) / 独立二进制压缩包**。不要复制网页上的 Docker 等安装命令。
4. 打开下载文件夹，右键 zip → **全部解压**。打开解压后的目录，进入能直接看到 **node.exe**、**npm.cmd**、**node_modules** 的那一级。
5. 在 D 盘新建 tools 文件夹，再在里面新建 node24 文件夹。把上一步目录里的全部内容复制到 **D:\tools\node24**。
6. 确认现在 **D:\tools\node24\node.exe** 真实存在。不要多套一层 node-v24... 文件夹。如果此目录已有其他内容，先核对，不覆盖未知文件。

**6.2 打开本项目的命令窗口。**

1. 按键盘 **Win + E** 打开资源管理器。
2. 点击上方地址栏，粘贴下面的项目目录，按回车。
3. 确认能看到 package.json、src、cloud-save-worker 等文件或文件夹。
4. 再点击地址栏，输入 **cmd**，按回车。会打开命令提示符窗口。

本次代码目录是：

```text
D:\work\code\tideng_worktree_dir\54b7\pokeclicker
```

可以在命令提示符里手动进入：

```bat
cd /d D:\work\code\tideng_worktree_dir\54b7\pokeclicker
```

在这个 cmd 窗口逐行运行。set 命令通常没有输出，这是正常的：

```bat
set "PATH=D:\tools\node24;%PATH%"
node --version
npm --version
git --version
```

node 应显示 **v24.x.x**；npm 显示版本号；Git 显示 git version 开头的版本号。如果 node 仍是 v25，核对 node.exe 的位置及 set 命令。不要用强制忽略版本参数。如果提示 git 不是内部或外部命令，安装 [Git for Windows](https://git-scm.com/downloads/win)，默认选项即可，然后重新打开 cmd，再运行 cd、set 和版本检查。

**每次关闭后重新打开 cmd，都要重新执行 cd 和 set 命令。** PATH 只在这个窗口生效，不会永久改系统设置。后面所有 npm 命令都在同一个项目根目录窗口运行，无需进入 cloud-save-worker 子文件夹。

这里使用的是**本次已修改的项目**。不要重新下载上游原版替换它，否则云存档功能也会被换掉。无需先把整个源码上传到 GitHub 才能部署。

## 七、安装、填写配置与检查

在第六节打开的 cmd 窗口执行，第一次下载依赖可能较慢。每条完成后会再次出现 D:\work\code\tideng_worktree_dir\54b7\pokeclicker> 提示符；如果出现 ERROR 等失败提示，先停下处理。不要一次粘贴所有命令。

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
| Access 团队地址 | 第五节完整 https://实际团队名.cloudflareaccess.com；带 https://，末尾不带 / |
| Access 应用 AUD | 第五节复制的那一串，完整粘贴，不加引号 |
| 唯一允许登录的邮箱 | 必须与第五节 Allow 中完全一致 |

每回答一个问题按回车；方括号内是默认值，直接回车就采用它。**完成标志：** 窗口出现“已保存：...”和“云槽位 ID：...”。

向导不需要 token。结果保存在 **cloud-save-worker/wrangler.local.json**，已加入 Git 忽略。用资源管理器打开项目里的 cloud-save-worker 文件夹，把 **wrangler.local.json** 复制到桌面“游戏上线资料”备份。其中 CLOUD_SLOT_ID 是云档编号，重装或换电脑部署时保持不变。不要删除原配置后重新生成不同编号。已有配置时重复运行向导会保留现有编号。

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

确认第三节域名 Active、第五节 Access 应用已保存、上一节检查通过。浏览器和 cmd 都保持打开。

**8.1 登录 Cloudflare。**

```bat
npm run cloud:login
```

它会打开浏览器，让你登录并授权 Wrangler 管理 Cloudflare。选择拥有 ggzz.fun 的那个账号，按提示点 **Allow / 允许**。看到授权成功后回命令窗口，等命令结束。如果浏览器没有自动打开，复制命令窗口给出的授权网址到浏览器。

**8.2 发布网页。**

```bat
npm run cloud:deploy
```

该命令上传游戏网页和 Worker，并绑定 play.ggzz.fun。自定义域由 Workers 创建，不需要自己买服务器或填服务器 IP。首次发布时 token 尚未录入，存档 API 会明确显示配置未完成。

如果询问使用哪个 Cloudflare 账号，选有 ggzz.fun 的账号。若询问确认绑定域名，核对显示的是 play.ggzz.fun 再按提示确认。出现同名 DNS 记录冲突时先核对已有用途，不盲目删除。

**完成标志：** 发布命令成功结束，输出包含 play.ggzz.fun 的绑定信息；Cloudflare **Workers & Pages** 列表里能看到 **pokeclicker-cloud-save**。本流程由命令创建项目，无需另外用 Git 导入建立 Pages 项目。

**8.3 现在创建 GitHub token，并立即录入。**

1. 浏览器打开 [GitHub Fine-grained tokens](https://github.com/settings/personal-access-tokens)，点 **Generate new token**。如要求密码或二次验证，正常完成。
2. 若从菜单进入，路径是 GitHub 头像 → Settings → Developer settings → Personal access tokens → Fine-grained tokens。
3. **Token name** 填 **pokeclicker-cloud-save**。
4. **Expiration** 选一个明确的到期时间，例如界面提供的 **90 days**；在个人日历上记下提前更新的日期。
5. **Resource owner** 选你自己。
6. **Repository access** 选 **Only select repositories**，只选择刚建的 **pokeclicker-saves**。
7. 在 **Repository permissions** 找到 **Contents**，设为 **Read and write**。新版界面可能需要先点 Add permissions 添加 Contents。Metadata 的默认只读权限保留，其他不用额外开启。
8. 核对后点 **Generate token**。新页面显示一长串 token，**先别关这一页**。它通常只展示这一次；等下一步 cmd 准备好接收密钥后再复制。
9. 回到 cmd，运行下面的命令：

```bat
npm run cloud:secret
```

10. 等 cmd 出现要求输入 secret 的提示后，**再回到 GitHub token 页面点击 token 旁的复制按钮**，然后切回 cmd，按 **Ctrl + V** 粘贴，按回车；旧版 cmd 也可右键粘贴。这个顺序避免复制命令时覆盖剪贴板中的 token。输入可能显示星号或不显示字符，这是正常的，别因此重复粘贴。
11. 等到明确的创建／上传 Secret 成功提示。不要把 token 拼到命令末尾，也不要把它写进 wrangler.local.json 或“配置记录.txt”。如需长期保存，使用密码管理器。
12. 成功后可以关闭 token 页面。如果已经关了、又没有保存完整 token，重新创建一把并再次录入；GitHub 不会再次展示原字符串。

这把钥匙只录入名为 **GITHUB_SAVE_TOKEN** 的 Cloudflare Secret。本步骤不需要 SSH 私钥，也不需要额外手工创建 Cloudflare API token。官方依据：[GitHub fine-grained token](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)。

如果命令表示找不到 Worker，说明 cloud:deploy 没有成功，先回头处理部署错误，不要手工创建不同名称的项目。

命令输入不方便时，也可在 Cloudflare **Workers & Pages → pokeclicker-cloud-save → Settings → Variables and Secrets → Add** 中录入：Type 选 **Secret**，Variable name 填 **GITHUB_SAVE_TOKEN**，Value 粘贴 token，按页面 **Save / Deploy** 保存发布。不要把 Type 选成普通 Text。

发布后在 Cloudflare Workers & Pages 找到 **pokeclicker-cloud-save**，核对：

- Custom Domain 是 play.ggzz.fun，HTTPS 证书已就绪。
- workers.dev 和 Preview URLs 都关闭（本项目配置已关闭它们）。
- Variables 中公开字段完整；Secret 中存在 GITHUB_SAVE_TOKEN。
- Access 应用保护 play.ggzz.fun 的全部路径。
- 没有给 /api/cloud-save 建立缓存规则或把它排除在 Access 外。

官方说明：[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)、[Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

## 九、第一次验收：先成功同步一次，再开启自动同步

1. 在普通浏览器窗口打开 **https://play.ggzz.fun**。首次访问应先看到邮箱登录页面。正式游玩使用普通窗口，无痕窗口只用来检查门禁，不用于保留本地存档。
2. 输入允许的邮箱，收验证码并登录。若无痕窗口不登录也直接进游戏，先检查 Access 是否保护了正确域名。
3. 点 **云存档 · 本地模式** 展开面板，点 **检查连接**，应显示“连接成功，可以上传本地进度或下载云档。”
4. 在选档页点击 **Import Save**，选择第二节备份的 .txt；页面刷新后选择导入的存档。原版按钮仍可能是英文。
5. 核对训练家名称、地区、宝可梦和主要进度是否正确。
6. 点 **上传 / 立即同步**，首次弹出“关联云存档”时点 **关联此存档**。等到“云端已确认保存。”；“正在同步”或失败都不能视为已上云。如果这是已经有云档的仓库，可能提示冲突，先按第十一节核对。
7. 打开 GitHub 私有仓库，应出现 saves 文件夹和一个以云槽位 ID 命名的 JSON 文件；查看提交时间。
8. 先等至少 **15 秒**，再点 **同步后换设备**。若页面要求更久，按提示等待后重试，直到看到“同步成功，可以关闭此页面并换设备。当前游戏已暂停；继续游玩请刷新页面。”，然后关闭旧设备的游戏页面。暂停是预期行为，不是卡死；只有暂停但尚未同步成功时不能切换。
9. 用另一台电脑或手机的普通浏览器打开同一网址、登录，保持在选档页，先不要点 New Save。展开云存档；在“选择本地存档”中选 **恢复云档时新建本地槽位**，点 **下载云档到本机**；弹出“恢复云存档”后点 **备份并恢复**。此按钮把云档装进浏览器，不是在下载文件夹生成文件。
10. 页面刷新后选恢复的卡片进入游戏，核对进度。离线收益仍按原游戏规则结算。
11. 在第二台设备玩一小会儿后，点 **同步后换设备**，等成功并关闭，再回第一台刷新进入已关联存档，验证可以接着玩。如果出现冲突，先比较两份进度；要接着第二台玩的，就选 **使用这份云端进度**，不要直接用第一台旧档覆盖。
12. 来回切换都核对成功后，才按需要开启 **每 10 分钟自动同步（完成首次手动验证后再开启）**。它默认关闭，跟随这个浏览器中的关联配置，不会自动给所有设备打开。

正常电脑与目标手机都做一次。这里没有代替你操作真实账号，实际邮件、DNS、GitHub 权限、移动端兼容性和延迟须在你上线后确认。

## 十、平时怎么玩

**每次换设备：旧设备点“同步后换设备”并等成功 → 关闭旧页面 → 新设备打开或刷新网站 → 进入已关联的存档。** 新设备第一次使用按第九节恢复；之后若提示冲突，核对并选择刚上传的云端进度。无法确认云档时先返回选档页处理连接，避免把旧本地档当成最新进度。

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
4. 建议先按下面的 cloud:recover 步骤把 JSON 转为 .txt，再在游戏选档页用 Import Save 导入并核对。解析器也支持直接导入历史 JSON，但文件选择框默认只显示 .txt，直接导入时需在 Windows 文件类型中切换“所有文件”。
5. 历史 JSON 按“本地导入档”处理，不继承旧的远端版本号。确认要用它后点击上传，已有云档会先显示冲突，再由你选择覆盖。这样以新提交恢复旧进度，原历史保留。

### 从“下载恢复备份包”找回进度

在项目命令窗口运行；如果是重新打开的 cmd，先按第六节执行 cd 和 set：

```bat
npm run cloud:recover
```

按提示把下载的 pokeclicker-recovery-backups.json 拖入窗口，按回车。工具在原文件旁边新建 recovered 文件夹，把每份有效存档转成原游戏支持的 .txt。文件名含时间，local 表示当时本地，cloud 表示当时云端；空的新槽位副本不会生成文件。

在选档页用 Import Save 导入其中一份核对。此工具只生成文件，不会直接修改浏览器或 GitHub。它也能转换从 GitHub 下载的单个存档 JSON。不要清理原备份包，直到核对完成。

若浏览器提示恢复中断或空间不足，先保留原文件并下载能导出的备份；先关闭其他游戏页；如果电脑磁盘已满，释放磁盘空间后刷新重试。如果是本站本地存档占满浏览器额度，先导出其他本地档，再在选档页的三点菜单中删除不需要的本地槽位，删除本地槽位不会删除 GitHub 云档。恢复日志会保留到本地数据和同步信息都写完为止。不要用“清除此站点数据”来释放空间，那会删除恢复日志和本地档。

## 十三、常见问题

| 现象 | 处理 |
| --- | --- |
| node 版本错误 / EBADDEVENGINES | 使用第六节 Node 24；重开 cmd 后先执行 cd 和 set，再检查 node --version |
| 域名打不开 / 证书尚未就绪 | 检查 ggzz.fun 是否 Active、NS 是否换对、Workers Custom Domain 是否成功绑定，等待传播和证书 |
| 收不到验证码 | 确认输入邮箱与 Allow 一致，检查垃圾邮件；不在名单内也可能看到“已发送”的通用提示 |
| 进入网站没登录页面 | 用无痕窗口确认；核对 Access 主机名和空路径，不能只保护首页 |
| 云服务尚未启用或登录已过期 | 先导出本地备份，再刷新登录；确认已发布 Worker API |
| 配置未完成 | 对照向导和 Worker Secret；执行 cloud:secret 后再检查 |
| GitHub 凭据失效或权限不足 | 检查 token 到期、指定仓库、Contents Read and write；按下一节轮换 |
| 无法访问仓库或分支 | 检查 owner/repo/main 是否填对、仓库是否勾 README 初始化 |
| 等待后重试 / 请求频率受限 | 按提示等待，不要连续点；进度保留，若游戏已暂停，重试同步成功后再换设备 |
| 云端来自更新版本 | 更新游戏代码；不要用旧客户端覆盖较新版本档 |
| 存档超过 5 MiB | 先导出备份；本版拒绝超限云档，需要后续改为对象存储或调整方案 |
| 云同步停止 / 模块载入失败 | 先导出当前备份，保留恢复包，再检查控制台错误；不要强制覆盖云档 |
| 另一个标签页已打开 | 关闭同网址其他游戏页，再重试；同浏览器只保留一个运行页 |

出问题可以提供**不含 token 的报错文字和步骤**。不要公开整个存档或私有仓库权限截图中的密钥。

## 十四、更新密钥与游戏

token 快到期时：在 GitHub 创建同权限的新 token 并保持页面打开 → 在项目目录运行 npm run cloud:secret → 出现密钥输入提示后再回 GitHub 复制新 token 并粘贴到 cmd → 网页检查连接并成功同步一次 → 再撤销旧 token。

重新打开 cmd 时，先按第六节执行 cd 和 set。更新游戏前先“同步后换设备”、关闭其他页面并下载备份。拿到保留本项目云存档改动的新代码后运行：

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
