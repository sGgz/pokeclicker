'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveRuntime, childEnvironment, writeShims } = require('../../desktop/scripts/build-windows.cjs');

const ROOT = path.resolve(__dirname, '../..');
const COMMANDS = ['players', 'setup', 'login', 'secret', 'password', 'recover', 'check', 'build', 'preview', 'deploy'];

function runInteractive(node, args, options, spawnProcess = spawn) {
    return new Promise((resolve, reject) => {
        // Credentials stay in the user's terminal: no pipes, capture, or log file.
        const child = spawnProcess(node, args, { ...options, shell: false, windowsHide: true, stdio: 'inherit' });
        child.once('error', () => reject(new Error('无法启动 Node.js 24 云存档命令，请检查本机运行环境后重试。')));
        child.once('close', code => resolve(Number.isInteger(code) ? code : 1));
    });
}

async function main(args = process.argv.slice(2), {
    root = ROOT, prepareRuntime = resolveRuntime, execute = runInteractive, env = process.env,
    output = process.stdout, platform = process.platform, arch = process.arch,
} = {}) {
    if (!args.length || (args.length === 1 && ['--help', '-h'].includes(args[0]))) {
        output.write('Windows 云存档管理入口（自动选择 Node.js 24）\n'
            + '首次迁移：cloud-windows.cmd players init\n'
            + '新增玩家：cloud-windows.cmd players add\n'
            + '查看玩家：cloud-windows.cmd players list\n'
            + '重置密码：cloud-windows.cmd players reset\n'
            + '其他命令：' + COMMANDS.join('、') + '；version 查看所选 Node/npm 版本。\n'
            + 'CMD 中直接运行；Git Bash 的 mintty 窗口可用 winpty node cloud-save-worker/scripts/windows.cjs players init。\n');
        return 0;
    }
    const [command, ...forwarded] = args;
    if (!COMMANDS.includes(command) && !(command === 'version' && !forwarded.length)) {
        throw new Error('不支持的云存档命令，请运行 cloud-windows.cmd --help。');
    }
    if (platform !== 'win32' || arch !== 'x64') throw new Error('此入口仅支持 Windows x64。');
    const buildDirectory = path.join(root, '.desktop-build');
    await fs.mkdir(buildDirectory, { recursive: true });
    const runtime = await prepareRuntime(buildDirectory, text => output.write(text));
    const shimDirectory = path.join(buildDirectory, 'bin');
    await writeShims(shimDirectory, runtime);
    for (const name of ['tmp', 'npm-cache', 'electron-cache', 'builder-cache']) {
        await fs.mkdir(path.join(buildDirectory, name), { recursive: true });
    }
    const childEnv = childEnvironment(env, runtime, buildDirectory, shimDirectory);
    const options = { cwd: root, env: childEnv };
    if (command === 'version') {
        const nodeResult = await execute(runtime.node, ['--version'], options);
        return nodeResult || execute(runtime.node, [runtime.npm, '--version'], options);
    }
    output.write('已选择项目 Node.js 24 环境，正在运行云存档命令。\n');
    return execute(runtime.node, [runtime.npm, 'run', 'cloud:' + command, ...(forwarded.length ? ['--', ...forwarded] : [])], options);
}

module.exports = { main, runInteractive };
if (require.main === module) {
    main().then(code => { process.exitCode = code; }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
