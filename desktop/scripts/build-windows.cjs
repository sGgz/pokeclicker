'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const https = require('node:https');
const { createHash, randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

// Verified against https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.
const NODE_VERSION = 'v24.21.0';
const NODE_ZIP_SHA256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const NODE_FOLDER = `node-${NODE_VERSION}-win-x64`;
const ROOT = path.resolve(__dirname, '../..');

function timestamp(now = new Date()) {
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function inside(parent, target) {
    const relative = path.relative(path.resolve(parent), path.resolve(target));
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

async function sha256(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}

function batchQuote(value) {
    if (/[\r\n"]/u.test(value)) throw new Error('目录名称包含不支持的字符。请将项目放在普通的本地文件夹。');
    return '"' + value.replaceAll('%', '%%') + '"';
}

function childEnvironment(base, runtime, buildDirectory, shimDirectory) {
    const env = { ...base };
    let originalPath = '';
    for (const key of Object.keys(env)) {
        if (key.toLowerCase() === 'path') { originalPath = env[key]; delete env[key]; }
        if (/^(npm_config_|electron_skip_binary_download$|electron_run_as_node$|node_options$|node_env$|npm_node_execpath$|npm_execpath$|playwright_skip_browser_download$)/i.test(key)) delete env[key];
    }
    env.PATH = [shimDirectory, path.dirname(runtime.node), originalPath].join(path.delimiter);
    env.TEMP = path.join(buildDirectory, 'tmp');
    env.TMP = env.TEMP;
    env.npm_config_cache = path.join(buildDirectory, 'npm-cache');
    env.ELECTRON_CACHE = path.join(buildDirectory, 'electron-cache');
    env.ELECTRON_BUILDER_CACHE = path.join(buildDirectory, 'builder-cache');
    env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
    // npm scripts must use the selected Node even if the system's global npm belongs to Node 25/26.
    env.npm_node_execpath = runtime.node;
    env.npm_execpath = runtime.npm;
    return env;
}

function run(executable, args, options, log) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false,
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', chunk => log(chunk.toString()));
        child.stderr.on('data', chunk => log(chunk.toString()));
        child.on('error', error => reject(new Error(`无法运行 ${path.basename(executable)}：${error.message}`)));
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} 执行失败，退出码 ${code}。请查看上方第一条错误或构建日志。`)));
    });
}

async function downloadNode(destination, log) {
    const url = `https://nodejs.org/dist/${NODE_VERSION}/${NODE_FOLDER}.zip`;
    log(`正在从 Node.js 官方网站下载 ${NODE_VERSION}，下载后会核对 SHA-256。\n`);
    await new Promise((resolve, reject) => {
        const request = https.get(url, { timeout: 60000 }, response => {
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`Node.js 下载失败：HTTP ${response.statusCode}。请检查网络，或自行安装 Node.js 24 LTS 后重试。`));
                return;
            }
            let bytes = 0;
            response.on('data', chunk => { bytes += chunk.length; if (bytes > 100 * 1024 * 1024) response.destroy(new Error('Node.js 下载超出预期大小。')); });
            pipeline(response, fs.createWriteStream(destination, { flags: 'wx' })).then(resolve, reject);
        });
        request.on('timeout', () => request.destroy(new Error('Node.js 下载超时，请检查网络后重试。')));
        request.on('error', reject);
    });
    if (await sha256(destination) !== NODE_ZIP_SHA256) throw new Error('Node.js 文件校验失败，已停止；请检查网络后重新打包。');
}

async function resolveRuntime(buildDirectory, log) {
    const local = path.join(buildDirectory, 'runtime', NODE_FOLDER);
    const candidates = [path.join(local, 'node.exe')];
    if (Number(process.versions.node.split('.')[0]) === 24) candidates.push(process.execPath);
    for (const node of candidates) {
        const npm = path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js');
        if (!fs.existsSync(node) || !fs.existsSync(npm)) continue;
        const result = spawnSync(node, ['-p', 'process.versions.node'], { windowsHide: true, encoding: 'utf8' });
        if (result.status === 0 && result.stdout.trim().startsWith('24.')) return { node, npm };
    }
    if (path.resolve(process.execPath).toLowerCase() === path.join(local, 'node.exe').toLowerCase()) {
        throw new Error('项目内的 Node.js 缓存不完整。请关闭本窗口，删除项目 .desktop-build\\runtime 文件夹，再安装或保留系统 Node.js 24 后重新双击。不能在运行中替换当前 node.exe。');
    }
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (!fs.existsSync(tar)) throw new Error('找不到 Windows 自带的 tar.exe。请先安装 Node.js 24 LTS，再重新双击脚本。');
    const temporary = await fsp.mkdtemp(path.join(buildDirectory, 'runtime-download-'));
    try {
        const archive = path.join(temporary, NODE_FOLDER + '.zip');
        await downloadNode(archive, log);
        await run(tar, ['-xf', archive, '-C', temporary], { cwd: ROOT, env: process.env }, log);
        const extracted = path.join(temporary, NODE_FOLDER);
        if (!fs.existsSync(path.join(extracted, 'node.exe')) || !fs.existsSync(path.join(extracted, 'node_modules/npm/bin/npm-cli.js'))) {
            throw new Error('Node.js 解压不完整，已停止。请检查磁盘空间后重试。');
        }
        // Only the verified generated runtime is replaced; source files and game profiles are never targets.
        if (!inside(path.join(buildDirectory, 'runtime'), local)) throw new Error('Invalid runtime directory');
        await fsp.mkdir(path.dirname(local), { recursive: true });
        await fsp.rm(local, { recursive: true, force: true });
        await fsp.rename(extracted, local);
        return { node: path.join(local, 'node.exe'), npm: path.join(local, 'node_modules/npm/bin/npm-cli.js') };
    } finally {
        if (!inside(buildDirectory, temporary)) throw new Error('Invalid temporary directory');
        await fsp.rm(temporary, { recursive: true, force: true });
    }
}

async function writeShims(directory, runtime) {
    await fsp.mkdir(directory, { recursive: true });
    for (const [name, file] of [['npm', runtime.npm], ['npx', path.join(path.dirname(runtime.npm), 'npx-cli.js')]]) {
        await fsp.writeFile(path.join(directory, name + '.cmd'), `@echo off\r\nsetlocal DisableDelayedExpansion\r\n${batchQuote(runtime.node)} ${batchQuote(file)} %*\r\n`, 'utf8');
    }
}

async function finishRelease(output, game, desktop, gitRevision, logFile) {
    const names = [`PokeclickerCloud-Setup-${desktop.version}.exe`, `PokeclickerCloud-${desktop.version}-win-x64.zip`];
    const required = [...names, 'win-unpacked/PokeclickerCloud.exe', 'win-unpacked/resources/app.asar'];
    for (const name of required) {
        const stat = await fsp.stat(path.join(output, name));
        if (!stat.isFile() || stat.size === 0) throw new Error(`缺少打包产物：${name}。本次未标记成功。`);
    }
    const bundled = readJson(path.join(output, 'win-unpacked/resources/game/desktop-build.json'));
    if (bundled.gameVersion !== game.version || bundled.desktopVersion !== desktop.version) throw new Error('包内版本与当前源码不一致，本次未标记成功。');
    const hashes = await Promise.all(names.map(async name => `${await sha256(path.join(output, name))}  ${name}`));
    await fsp.writeFile(path.join(output, 'SHA256SUMS.txt'), hashes.join('\r\n') + '\r\n');
    await fsp.writeFile(path.join(output, '开始游戏.cmd'), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nstart "" "%~dp0win-unpacked\\PokeclickerCloud.exe"\r\n');
    const success = `打包成功\r\n\r\n游戏版本：${game.version}\r\n桌面程序版本：${desktop.version}\r\n代码提交：${gitRevision}\r\n完成时间：${new Date().toLocaleString('zh-CN')}\r\n\r\n在这台电脑马上玩：双击同目录的“开始游戏.cmd”。\r\n安装到另一台电脑：复制 ${names[0]}。\r\n免安装转移程序：复制完整 ZIP，在另一台电脑完整解压后运行游戏。\r\n程序文件与存档分开保存；本次没有读取、删除或上传你的存档。\r\n已有安装版请先关闭，再启动新程序。更新后使用原来的本机进度和游戏密码。\r\n桌面程序版本不自动递增；本文件夹中的包来自本次代码构建，以游戏版本和代码提交辨认。\r\n\r\n构建日志：${logFile}\r\n`;
    await fsp.rm(path.join(output, '打包中.txt'), { force: true });
    await fsp.writeFile(path.join(output, '打包成功.txt'), '\uFEFF' + success);
    // This shortcut index is optional: failure to update it cannot invalidate a finished release.
    try {
        await fsp.writeFile(path.join(path.dirname(output), '最近一次成功打包.txt'), '\uFEFF' + output + '\r\n\r\n' + success);
        return true;
    } catch { return false; }
}

async function main() {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('此脚本仅支持 Windows x64。请在 64 位 Intel/AMD Windows 电脑运行。');
    const args = process.argv.slice(2);
    if (args.some(value => value !== '--ci')) throw new Error('不支持的参数。双击 build-windows.cmd 即可；自动化环境可传 --ci。');
    const buildDirectory = path.join(ROOT, '.desktop-build');
    await fsp.mkdir(path.join(buildDirectory, 'logs'), { recursive: true });
    const id = timestamp() + '-' + randomUUID().slice(0, 6);
    const logFile = path.join(buildDirectory, 'logs', `build-${id}.log`);
    const logHandle = fs.openSync(logFile, 'wx');
    let logError;
    const log = text => {
        process.stdout.write(text);
        if (logError) return;
        try { fs.writeSync(logHandle, text); }
        catch (error) {
            // Never throw from a child's asynchronous output handler or leave an unhandled stream error.
            logError = error;
            process.stderr.write('构建日志写入失败，请检查磁盘空间和目录权限。本次不会标记为成功。\n');
        }
    };
    let lock;
    let output;
    try {
        const lockFile = path.join(buildDirectory, 'build.lock');
        try { lock = await fsp.open(lockFile, 'wx'); await lock.writeFile(String(process.pid)); }
        catch { throw new Error('已有打包任务，或上次窗口被强行关闭。请先关闭其他打包窗口；确认没有任务后，删除项目 .desktop-build\\build.lock，再重新双击。'); }
        log('=== Pokeclicker Windows 一键打包 ===\n请保持联网，关闭正在运行的游戏；首次准备依赖可能需要几分钟。\n');
        log(`项目目录：${ROOT}\n构建日志：${logFile}\n\n`);
        const git = spawnSync('git', ['--version'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
        if (git.status !== 0) throw new Error('没有找到 Git。请从 https://git-scm.com/downloads/win 安装 Git for Windows，使用默认选项，然后重新打开脚本。');
        const revision = spawnSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
        if (revision.status !== 0) throw new Error('这个目录不是完整的 Git 项目。请使用 git clone 下载本分支（或在原项目中更新），不要直接使用 GitHub 的 Download ZIP。翻译子模块也需要 Git。');
        const gitStatus = spawnSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: ROOT, windowsHide: true, encoding: 'utf8' });
        if (gitStatus.status !== 0) throw new Error('无法检查本地代码状态，请确认项目目录和 Git 可用后重试。');
        const sourceRevision = revision.stdout.trim() + (gitStatus.stdout.trim() ? '（包含本机未提交改动）' : '');
        const game = readJson(path.join(ROOT, 'package.json'));
        const desktop = readJson(path.join(ROOT, 'desktop/package.json'));
        if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(game.version) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(desktop.version)) throw new Error('游戏或桌面 package.json 版本格式无效。');
        log('[1/7] 准备 Node.js 24（不会更改全局 Node.js）\n');
        const runtime = await resolveRuntime(buildDirectory, log);
        const shimDirectory = path.join(buildDirectory, 'bin');
        await writeShims(shimDirectory, runtime);
        for (const name of ['tmp', 'npm-cache', 'electron-cache', 'builder-cache']) await fsp.mkdir(path.join(buildDirectory, name), { recursive: true });
        const env = childEnvironment(process.env, runtime, buildDirectory, shimDirectory);
        const checkLog = () => { if (logError) throw new Error(`构建日志写入失败：${logError.message}`); };
        const npm = async (args, cwd = ROOT) => {
            await run(runtime.node, [runtime.npm, ...args], { cwd, env }, log);
            checkLog();
        };
        output = path.join(ROOT, 'output/desktop-builds', `game-${game.version}_${id}`);
        await fsp.mkdir(output, { recursive: true });
        await fsp.writeFile(path.join(output, '打包中.txt'), '本次构建尚未成功。请等待控制台显示“打包成功”，不要把部分文件当成新版。\r\n');
        const projects = [ROOT, path.join(ROOT, 'cloud-save-worker'), path.join(ROOT, 'desktop')];
        for (let index = 0; index < projects.length; index++) {
            log(`\n[${index + 2}/7] 安装${['游戏', '云存档检查', '桌面打包'][index]}依赖（按锁文件，缓存会复用）\n`);
            await npm(['ci', '--include=dev', '--ignore-scripts=false', '--no-audit', '--no-fund'], projects[index]);
        }
        // Electron's locked package supplies install.js without a postinstall hook.
        // Run its own installer explicitly; do not depend on npm lifecycle policy.
        log('\n准备 Electron 运行文件（已有下载缓存会复用）\n');
        await run(runtime.node, [path.join(ROOT, 'desktop/node_modules/electron/install.js')], { cwd: path.join(ROOT, 'desktop'), env }, log);
        if (!fs.existsSync(path.join(ROOT, 'desktop/node_modules/electron/dist/electron.exe'))) throw new Error('Electron 下载不完整，请检查网络后重新打包。');
        log('\n[5/7] 检查桌面桥接与云存档协议\n');
        await npm(['run', 'desktop:test']);
        await npm(['run', 'cloud:check']);
        log('\n[6/7] 检查并构建游戏资源\n');
        await npm(['run', 'cloud:build']);
        log('\n[7/7] 生成 Windows EXE、安装包和 ZIP\n');
        await npm(['run', 'package', '--', '--config.directories.output=' + output], path.join(ROOT, 'desktop'));
        checkLog();
        const indexWritten = await finishRelease(output, game, desktop, sourceRevision, logFile);
        log(`\n===== 打包成功 =====\n输出文件夹：${output}\n立即游玩：双击里面的“开始游戏.cmd”。\n安装到另一台电脑：使用里面的 Setup 安装包。\n详细记录：打包成功.txt\n`);
        if (!indexWritten) log('未能更新“最近一次成功打包.txt”索引；新包已完成，请使用上面的输出文件夹。\n');
        if (!args.includes('--ci')) {
            const explorer = spawn('explorer.exe', [output], { detached: true, stdio: 'ignore', windowsHide: true });
            explorer.on('error', () => process.stdout.write('无法自动打开文件夹，请按上面的路径手动打开。\n'));
            explorer.unref();
        }
    } catch (error) {
        log(`\n===== 本次打包失败，尚未生成经过检查的新版 =====\n${error.message}\n日志：${logFile}\n已有安装包和游戏存档保留。修复报错后重新双击即可。\n`);
        if (output) {
            await fsp.rm(path.join(output, '打包成功.txt'), { force: true }).catch(() => {});
            await fsp.writeFile(path.join(output, '打包失败.txt'), '\uFEFF' + error.message + '\r\n日志：' + logFile).catch(() => {});
        }
        process.exitCode = 1;
    } finally {
        try {
            if (lock) { await lock.close(); await fsp.rm(path.join(buildDirectory, 'build.lock'), { force: true }); }
        } finally { fs.closeSync(logHandle); }
    }
}

module.exports = { NODE_VERSION, NODE_ZIP_SHA256, timestamp, inside, batchQuote, childEnvironment, writeShims, finishRelease, run };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
