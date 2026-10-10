'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const { childEnvironment, finishRelease, run, writeShims } = require('../scripts/build-windows.cjs');
const { main: cloudMain, runInteractive } = require('../../cloud-save-worker/scripts/windows.cjs');

const TEST_ROOT = path.resolve(__dirname, '../../output/desktop-tests');
const GAME = { version: '0.10.26' };
const DESKTOP = { version: '1.0.0' };
const INSTALLER = `PokeclickerCloud-Setup-${DESKTOP.version}.exe`;
const ZIP = `PokeclickerCloud-${DESKTOP.version}-win-x64.zip`;

test('Windows packaging uses an accessible binary mirror and retains explicit download overrides', () => {
    const runtime = { node: 'C:\\node24\\node.exe', npm: 'C:\\node24\\npm-cli.js' };
    const buildDirectory = path.resolve(__dirname, '../../.desktop-build');
    const shimDirectory = path.join(buildDirectory, 'bin');
    const defaultEnv = childEnvironment({ PATH: 'system-node' }, runtime, buildDirectory, shimDirectory);
    assert.equal(defaultEnv.ELECTRON_BUILDER_BINARIES_MIRROR, 'https://npmmirror.com/mirrors/electron-builder-binaries/');
    for (const key of ['ELECTRON_BUILDER_BINARIES_MIRROR', 'npm_config_electron_builder_binaries_mirror']) {
        const env = childEnvironment({ PATH: 'system-node', [key]: 'https://example.com/binaries/' }, runtime, buildDirectory, shimDirectory);
        assert.equal(env.ELECTRON_BUILDER_BINARIES_MIRROR, 'https://example.com/binaries/');
    }
    const env = childEnvironment({ PATH: 'system-node', ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL: 'https://example.com/custom' }, runtime, buildDirectory, shimDirectory);
    assert.equal(env.ELECTRON_BUILDER_BINARIES_DOWNLOAD_OVERRIDE_URL, 'https://example.com/custom');
    assert.equal(env.ELECTRON_BUILDER_BINARIES_ALLOW_HTTP, undefined);
});

test('Windows cloud entry is reachable without npm rejecting the bootstrap Node version', async () => {
    const root = path.resolve(__dirname, '../..');
    const { stdout, stderr } = await promisify(execFile)(process.env.ComSpec || 'cmd.exe',
        ['/d', '/c', 'cloud-windows.cmd --help'], { cwd: root, windowsHide: true, encoding: 'utf8' });
    assert.match(stdout, /cloud-windows\.cmd players init/);
    assert.ok(!stderr.includes('EBADDEVENGINES'));
});

test('cloud entry invokes npm with the selected Node and preserves player arguments in Chinese paths', async t => {
    const root = await workspace(t);
    const selected = { node: 'C:\\selected-node-24\\node.exe', npm: 'C:\\selected-node-24\\node_modules\\npm\\bin\\npm-cli.js' };
    let prepared = 0, executed = 0;
    const result = await cloudMain(['players', 'reset'], {
        root, env: { PATH: 'C:\\system-node-25', APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', npm_node_execpath: 'wrong-node' },
        output: { write() {} }, platform: 'win32', arch: 'x64',
        prepareRuntime: async directory => {
            assert.equal(directory, path.join(root, '.desktop-build'));
            prepared++;
            return selected;
        },
        execute: async (node, args, options) => {
            executed++;
            assert.equal(node, selected.node);
            assert.deepEqual(args, [selected.npm, 'run', 'cloud:players', '--', 'reset']);
            assert.equal(options.cwd, root);
            assert.equal(options.env.npm_node_execpath, selected.node);
            assert.equal(options.env.APPDATA, 'C:\\Users\\tester\\AppData\\Roaming');
            assert.ok(options.env.PATH.startsWith(path.join(root, '.desktop-build', 'bin') + path.delimiter + path.dirname(selected.node)));
            assert.match(await fs.readFile(path.join(root, '.desktop-build', 'bin', 'npm.cmd'), 'utf8'), /selected-node-24/);
            return 17;
        },
    });
    assert.equal(prepared, 1);
    assert.equal(executed, 1);
    assert.equal(result, 17);
});

test('interactive cloud execution inherits the terminal and preserves the command exit code', async () => {
    const result = await runInteractive('selected-node', ['selected-npm', 'run', 'cloud:players', '--', 'init'], { cwd: 'project' },
        (node, args, options) => {
            assert.equal(node, 'selected-node');
            assert.equal(args.at(-1), 'init');
            assert.equal(options.stdio, 'inherit');
            assert.equal(options.shell, false);
            assert.equal(options.windowsHide, true);
            const child = new EventEmitter();
            setImmediate(() => child.emit('close', 23));
            return child;
        });
    assert.equal(result, 23);
});

test('invalid cloud commands are rejected before preparing a runtime or executing npm', async () => {
    await assert.rejects(cloudMain(['arbitrary-command'], {
        prepareRuntime: async () => { assert.fail('must not prepare runtime'); },
        execute: async () => { assert.fail('must not execute npm'); },
    }), /不支持的云存档命令/);
});

async function workspace(t) {
    await fs.mkdir(TEST_ROOT, { recursive: true });
    const directory = await fs.mkdtemp(path.join(TEST_ROOT, '一键构建 路径-'));
    t.after(async () => {
        // Delete only this test's generated directory, after checking the real filesystem boundary.
        const [root, target] = await Promise.all([fs.realpath(TEST_ROOT), fs.realpath(directory)]);
        const relative = path.relative(root, target);
        assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        await fs.rm(target, { recursive: true, force: true });
    });
    return directory;
}

async function writeFile(file, content) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
}

async function releaseFixture(t) {
    const directory = await workspace(t);
    const output = path.join(directory, '本次 产物');
    const artifacts = [INSTALLER, ZIP, 'win-unpacked/PokeclickerCloud.exe', 'win-unpacked/resources/app.asar'];
    for (const artifact of artifacts) await writeFile(path.join(output, artifact), 'test fixture: ' + artifact);
    await writeFile(path.join(output, 'win-unpacked/resources/game/desktop-build.json'), JSON.stringify({
        gameVersion: GAME.version, desktopVersion: DESKTOP.version,
    }));
    await writeFile(path.join(output, '打包中.txt'), 'This release has not passed validation.');
    const logFile = path.join(directory, 'build.log');
    return { directory, output, logFile };
}

async function assertMissing(file) {
    await assert.rejects(fs.access(file), { code: 'ENOENT' });
}

test('finishRelease rejects a missing packaged runtime without publishing success or replacing the old index', async t => {
    const { directory, output, logFile } = await releaseFixture(t);
    const index = path.join(directory, '最近一次成功打包.txt');
    await fs.writeFile(index, 'previous validated release');
    await fs.rm(path.join(output, 'win-unpacked/resources/app.asar'));

    await assert.rejects(finishRelease(output, GAME, DESKTOP, '1234567890', logFile), { code: 'ENOENT' });
    await assertMissing(path.join(output, '打包成功.txt'));
    await assertMissing(path.join(output, 'SHA256SUMS.txt'));
    await fs.access(path.join(output, '打包中.txt'));
    assert.equal(await fs.readFile(index, 'utf8'), 'previous validated release');
});

test('finishRelease rejects an empty installer before marking the output successful', async t => {
    const { output, logFile } = await releaseFixture(t);
    await fs.writeFile(path.join(output, INSTALLER), '');

    await assert.rejects(finishRelease(output, GAME, DESKTOP, '1234567890', logFile), /缺少打包产物/);
    await assertMissing(path.join(output, '打包成功.txt'));
    await assertMissing(path.join(output, 'SHA256SUMS.txt'));
    await fs.access(path.join(output, '打包中.txt'));
});

for (const field of ['gameVersion', 'desktopVersion']) {
    test(`finishRelease rejects stale bundled ${field} without marking success`, async t => {
        const { directory, output, logFile } = await releaseFixture(t);
        await fs.writeFile(path.join(output, 'win-unpacked/resources/game/desktop-build.json'), JSON.stringify({
            gameVersion: GAME.version, desktopVersion: DESKTOP.version, [field]: '0.0.1',
        }));

        await assert.rejects(finishRelease(output, GAME, DESKTOP, '1234567890', logFile), /包内版本与当前源码不一致/);
        await assertMissing(path.join(output, '打包成功.txt'));
        await assertMissing(path.join(directory, '最近一次成功打包.txt'));
        await fs.access(path.join(output, '打包中.txt'));
    });
}

test('finishRelease retains a verified success when the optional latest-release index cannot be written', async t => {
    const { directory, output, logFile } = await releaseFixture(t);
    // A directory at the index path fails writes reliably on Windows, including administrator accounts.
    await fs.mkdir(path.join(directory, '最近一次成功打包.txt'));

    assert.equal(await finishRelease(output, GAME, DESKTOP, '1234567890', logFile), false);
    const success = await fs.readFile(path.join(output, '打包成功.txt'), 'utf8');
    assert.match(success, /游戏版本：0\.10\.26/);
    assert.match(success, /代码提交：1234567890/);
    await assertMissing(path.join(output, '打包中.txt'));
    await assertMissing(path.join(output, '打包失败.txt'));
    const expectedHashes = await Promise.all([INSTALLER, ZIP].map(async name => {
        const content = await fs.readFile(path.join(output, name));
        return createHash('sha256').update(content).digest('hex') + '  ' + name;
    }));
    assert.equal(await fs.readFile(path.join(output, 'SHA256SUMS.txt'), 'utf8'), expectedHashes.join('\r\n') + '\r\n');
    assert.match(await fs.readFile(path.join(output, '开始游戏.cmd'), 'utf8'), /"%~dp0win-unpacked\\PokeclickerCloud\.exe"/);
});

test('run rejects a nonzero child exit and preserves the diagnostic output', async t => {
    const directory = await workspace(t);
    let output = '';
    await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("intentional build failure\\n"); process.exitCode = 23;'], {
        cwd: directory, env: process.env,
    }, chunk => { output += chunk; }), /退出码 23/);
    assert.match(output, /intentional build failure/);
});

test('npm and npx shims execute the selected Node and preserve arguments in Chinese and spaced paths', {
    skip: process.platform !== 'win32' && 'Windows CMD integration requires Windows',
}, async t => {
    const directory = await workspace(t);
    const cliDirectory = path.join(directory, '运行时 中文 空格', 'npm bin');
    const runtime = { node: process.execPath, npm: path.join(cliDirectory, 'npm-cli.js') };
    const shimDirectory = path.join(directory, '命令 shim 空格');
    const cli = 'process.stdout.write(JSON.stringify({ node: process.execPath, version: process.versions.node, script: require("node:path").basename(__filename), args: process.argv.slice(2) }) + "\\n");\n';
    await writeFile(runtime.npm, cli);
    await writeFile(path.join(cliDirectory, 'npx-cli.js'), cli);
    await writeShims(shimDirectory, runtime);
    const env = childEnvironment(process.env, runtime, directory, shimDirectory);
    const command = process.env.ComSpec || path.join(process.env.SystemRoot, 'System32', 'cmd.exe');
    const expectedArgs = ['--sample=value with spaces', '中文 参数', 'literal&value'];

    for (const name of ['npm', 'npx']) {
        let output = '';
        const launcher = `invoke-${name}.cmd`;
        // Match build-windows.cmd: its UTF-8 code page is inherited by all nested npm scripts.
        await fs.writeFile(path.join(directory, launcher), '@echo off\r\nsetlocal DisableDelayedExpansion\r\nchcp 65001 >nul\r\n'
            + `call ${name}.cmd ${expectedArgs.map(value => '"' + value + '"').join(' ')}\r\nexit /b %errorlevel%\r\n`);
        await run(command, ['/d', '/s', '/c', launcher], {
            cwd: directory, env,
        }, chunk => { output += chunk; }).catch(error => { throw new Error(error.message + '\n' + output); });
        const actual = JSON.parse(output.trim());
        assert.equal(path.resolve(actual.node).toLowerCase(), path.resolve(runtime.node).toLowerCase());
        assert.equal(actual.version, process.versions.node);
        assert.equal(actual.script, name + '-cli.js');
        assert.deepEqual(actual.args, expectedArgs);
    }
});
