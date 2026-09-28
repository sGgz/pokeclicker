[![GitHub package.json version (branch)](https://img.shields.io/github/package-json/v/pokeclicker/pokeclicker/develop?label=dev%20version)](https://github.com/pokeclicker/pokeclicker/tree/develop)<br/>
[![GitHub package.json version (branch)](https://img.shields.io/github/package-json/v/pokeclicker/pokeclicker/master?label=live%20version)](https://www.pokeclicker.com/)<br/>
[![Build Status](https://img.shields.io/travis/com/pokeclicker/pokeclicker?logo=travis)](https://travis-ci.com/pokeclicker/pokeclicker)<br/>
[![Discord](https://img.shields.io/discord/450412847017754644?color=7289DA&label=Discord&logo=discord)](https://discord.gg/a6DFe4p)

# PokéClicker
A game about catching Pokémon, defeating gym leaders, and watching numbers get bigger.

You can try out the current state at https://www.pokeclicker.com/

You can reach out on discord to discuss your ideas and how to implement them: https://discord.gg/a6DFe4p

> [!NOTE]
> PokéClicker is still in development!

## 私人云存档（Cloudflare + GitHub）

本分支增加了个人云存档：Cloudflare 托管网页、游戏专用密码登录和存档 API，GitHub 私有仓库保存进度。Windows 定制客户端可离线运行，联网后与网页共用云档。

- [新手部署与日常使用手册](design/cloud-save-user-guide.md)（按 ggzz.fun 编写）
- [项目架构与云存档设计](design/cloud-save-design.md)
- [实现和验收记录](design/cloud-save-implementation.md)
- [Windows 客户端与开发说明](desktop/README.md)
- [自用玩法实现与兼容说明：优化寻路、固定道具价格、助手服务费 1%](design/private-gameplay-design.md)（源码已实现；使用方法见 Windows 手册，本次未部署网页）

GitHub token 只录入 Worker Secret。先完成手册中的账号配置与验收，再开启自动同步。

**更新源码后打包 Windows 客户端：** 首次在打包电脑安装 Node.js（建议 24 LTS）和 Git，保留本分支云存档功能的完整 Git 项目，然后双击根目录的 **build-windows.cmd**。脚本准备依赖、执行检查并打包；成功后打开 `output/desktop-builds/game-游戏版本_时间-随机后缀/`，双击这个新文件夹里的 **开始游戏.cmd** 即可运行，也可使用其中的 Setup 安装包或完整 ZIP。先关闭正在运行的游戏；普通游玩电脑只需成品，不需安装构建工具。

日常打包不用手输多条命令。脚本只构建本机已有代码，不拉取更新、不自动改版本，也不部署网页；不要把项目覆盖成官方原版或使用 GitHub 源码页的 Download ZIP。已有 Node **18 或更高版本**可以保留；不是 24 时，脚本从官方准备并校验项目内 Node 24，不改全局版本。Node 低于 18 或尚未安装时，先按提示安装 Node 24 LTS。详细首次准备、输出位置和报错处理见[手册第 16.10 节](design/cloud-save-user-guide.md#1610-更新源码后双击打包自己的-windows-客户端)。

# Developer instructions

## Guidelines
- Make sure the build script is a success. We won't test Pull Requests that fail the building script.
- We won't accept balance Pull Requests, unless it's from a developer or Code Contributor (Discord roles).
- Pull Requests adding new translatable content should link to a Pull Request in the [translation repo](https://github.com/pokeclicker/pokeclicker-translations) adding your new strings. See the Developer instructions on that repo for more info.
- Split Pull Requests into smaller Pull Requests when possible. It will make it easier for us to review, and easier for you if something's needs to be changed or is rejected.

## Editor/IDE setup

We have an [EditorConfig](https://editorconfig.org/) and linting configured, to help everyone write similar code. You will find our recommended plugins for VSCode below, however you should be able to find a plugin for other IDEs as well.

* [EditorConfig](https://marketplace.visualstudio.com/items?itemName=EditorConfig.EditorConfig)
* [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)
* [Stylelint](https://marketplace.visualstudio.com/items?itemName=stylelint.vscode-stylelint)

## Building from Source

First make sure you have git and npm available as command-line utilities (so you should install Git and NodeJS if you don't have them already).

Open a command line interface in the directory that contains this README file, and use the following command to install PokéClicker's other dependencies locally:
```cmd
npm run clean
```

Then finally, run the following command in the command line interface to start a browser running PokéClicker.
```cmd
npm start
```

> [!TIP]
> Changes to the sourcecode will automatically cause the browser to refresh. <br/>
> This means you don't need to compile TypeScript yourself. Gulp will do this for you :thumbsup:


## Use Google cloud shell _(alternative)_
[![Google Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.png)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/pokeclicker/pokeclicker&git_branch=develop&page=editor&open_in_editor=README.md)
```cmd
npm clean-install
npm start
```
Click the [Web Preview](https://cloud.google.com/shell/docs/using-web-preview) Button and select port `3001` from the displayed menu.<br/>
Cloud Shell opens the preview URL on its proxy service in a new browser window.

## Deploying a new version to Github Pages
> [!IMPORTANT]
> Before deploying, check that the game compiles and starts up without errors.

Then run the following:
```cmd
npm run website
```
This will populate the `/docs` folder.

After this command completes you can now publish this to your GitHub pages branch using:
```cmd
npm run publish
```
Which by default will push to the `master` branch
