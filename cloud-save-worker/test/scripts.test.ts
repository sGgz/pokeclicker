import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { EventEmitter } from 'node:events';

const exec = promisify(execFile);
test('backup conversion preserves Unicode, percent signs and both conflict snapshots', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pokeclicker-recovery-test-'));
    try {
        const payload = { player: { trainerId: '123' }, save: { profile: { name: '妙蛙种子🙂 50% café' }, update: { version: '0.10.26' } }, settings: {} };
        const file = path.join(dir, 'backups.json');
        await writeFile(file, JSON.stringify([{ time: '2026-09-20T00:00:00Z', local: [JSON.stringify(payload.player), JSON.stringify(payload.save), '{}'], remote: { envelope: { payload } } }]));
        await exec(process.execPath, [fileURLToPath(new URL('../scripts/recover.mjs', import.meta.url)), file]);
        const output = (await readdir(dir)).find(name => name.includes('-recovered-'))!;
        const saves = await readdir(path.join(dir, output));
        assert.equal(saves.length, 2);
        for (const name of saves) {
            const encoded = await readFile(path.join(dir, output, name), 'utf8');
            assert.deepEqual(JSON.parse(decodeURI(Buffer.from(encoded, 'base64').toString('latin1'))), payload);
        }
        assert.ok(await readFile(file, 'utf8'));
    } finally { await rm(dir, { recursive: true, force: true }); }
});

async function configure(script: string, answers: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const prompts = ['游戏域名', 'GitHub 用户名', '私有存档仓库名', '存档仓库分支'];
        let output = '', index = 0, errors = '';
        const timer = setTimeout(() => { child.kill(); reject(new Error('setup timed out')); }, 15000);
        child.stdout.on('data', chunk => {
            output += chunk.toString();
            if (index < prompts.length && output.includes(prompts[index]) && output.endsWith('：')) {
                child.stdin.write(answers[index++] + '\n'); output = '';
            }
        });
        child.stderr.on('data', chunk => { errors += chunk.toString(); });
        child.on('error', reject);
        child.on('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(errors || 'setup failed')); });
    });
}
test('setup generates only public config and preserves the cloud slot when rerun', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pokeclicker-setup-test-'));
    try {
        await mkdir(path.join(dir, 'scripts'));
        const script = path.join(dir, 'scripts', 'setup.mjs');
        await copyFile(new URL('../scripts/setup.mjs', import.meta.url), script);
        await copyFile(new URL('../wrangler.jsonc', import.meta.url), path.join(dir, 'wrangler.jsonc'));
        await configure(script, ['', 'test-owner', '', '']);
        const config = JSON.parse(await readFile(path.join(dir, 'wrangler.local.json'), 'utf8'));
        assert.equal(config.vars.ALLOWED_ORIGIN, 'https://play.ggzz.fun');
        assert.equal(config.routes[0].custom_domain, true);
        assert.equal(config.workers_dev, false);
        assert.equal(config.vars.GITHUB_SAVE_TOKEN, undefined);
        assert.equal(config.vars.GAME_AUTH, undefined);
        assert.equal(config.vars.ACCESS_TEAM_DOMAIN, undefined);
        assert.equal(config.vars.ACCESS_AUD, undefined);
        assert.equal(config.vars.ALLOWED_EMAIL, undefined);
        assert.match(config.vars.CLOUD_SLOT_ID, /^[0-9a-f-]{36}$/);
        const migrated = structuredClone(config);
        Object.assign(migrated.vars, {
            ACCESS_TEAM_DOMAIN: 'https://old.cloudflareaccess.com', ACCESS_AUD: 'a'.repeat(64),
            ALLOWED_EMAIL: 'owner@example.com', GITHUB_SAVE_TOKEN: 'old-secret-not-to-copy', GAME_AUTH: 'old-auth-not-to-copy',
        });
        await writeFile(path.join(dir, 'wrangler.local.json'), JSON.stringify(migrated));
        await configure(script, ['', '', '', '']);
        const again = JSON.parse(await readFile(path.join(dir, 'wrangler.local.json'), 'utf8'));
        assert.deepEqual(again, config);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

const passwordTools = await import(new URL('../scripts/password.mjs', import.meta.url).href);

test('game credentials use independent random password and signing key, with only a verifier in the Secret', () => {
    const first = passwordTools.createGameCredentials();
    const second = passwordTools.createGameCredentials();
    assert.match(first.password, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(Buffer.from(first.password, 'base64url').length, 24);
    assert.equal(first.auth.version, 1);
    assert.match(first.auth.sessionKey, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(first.auth.sessionKey, 'base64url').length, 32);
    assert.equal(first.auth.passwordHash, createHash('sha256').update(first.password).digest('hex'));
    assert.deepEqual(Object.keys(first.auth).sort(), ['passwordHash', 'sessionKey', 'version']);
    assert.notEqual(first.password, second.password);
    assert.notEqual(first.auth.sessionKey, second.auth.sessionKey);
    assert.ok(!JSON.stringify(first.auth).includes(first.password));
});

test('password upload sends the Secret through stdin, never shell arguments, and hides tool output', async () => {
    const { auth } = passwordTools.createGameCredentials();
    let received = '';
    let invocation: { command: string; args: string[]; options: any } | undefined;
    await passwordTools.uploadAuthSecret(auth, {
        spawnProcess(command: string, args: string[], options: any) {
            invocation = { command, args, options };
            const child = Object.assign(new EventEmitter(), {
                stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            });
            child.stdin.on('data', chunk => { received += chunk.toString(); });
            child.stdin.on('finish', () => {
                child.stdout.end('debug output must not be forwarded: ' + JSON.stringify(auth));
                child.stderr.end(auth.sessionKey);
                setImmediate(() => child.emit('close', 0));
            });
            return child;
        },
    });
    assert.deepEqual(JSON.parse(received), auth);
    assert.equal(invocation!.command, process.execPath);
    assert.deepEqual(invocation!.args.slice(1, 5), ['secret', 'put', 'GAME_AUTH', '--config']);
    assert.equal(invocation!.options.shell, undefined);
    assert.equal(invocation!.options.windowsHide, true);
    assert.deepEqual(invocation!.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.ok(!JSON.stringify(invocation).includes(auth.passwordHash));
    assert.ok(!JSON.stringify(invocation).includes(auth.sessionKey));
});

test('password upload reports a safe failure when Wrangler exits unsuccessfully', async () => {
    const { auth } = passwordTools.createGameCredentials();
    await assert.rejects(passwordTools.uploadAuthSecret(auth, {
        spawnProcess() {
            const child = Object.assign(new EventEmitter(), {
                stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
            });
            child.stdin.on('finish', () => {
                child.stderr.end(auth.sessionKey);
                setImmediate(() => child.emit('close', 1));
            });
            return child;
        },
    }), /上传游戏密码失败/);
});

async function passwordWizard(answers: string[], upload: (auth: any) => Promise<void>, observe: (text: string) => void = () => {}) {
    const dir = await mkdtemp(path.join(tmpdir(), 'pokeclicker-password-test-'));
    const config = path.join(dir, 'wrangler.local.json');
    await writeFile(config, '{}');
    const input = Object.assign(new PassThrough(), { isTTY: true });
    let text = '';
    const output = Object.assign(new Writable({
        write(chunk, _encoding, callback) {
            const value = chunk.toString();
            text += value;
            observe(text);
            if (value.endsWith('：')) setImmediate(() => input.write(answers.shift() + '\n'));
            callback();
        },
    }), { isTTY: true });
    try {
        const result = await passwordTools.runPasswordSetup({ input, output, config, upload });
        return { result, text };
    } finally {
        input.destroy(); output.destroy();
        await rm(dir, { recursive: true, force: true });
    }
}

test('password wizard cancellation performs no upload and prints no generated password', async () => {
    let uploaded = false;
    const result = await passwordWizard([''], async () => { uploaded = true; });
    assert.equal(result.result, false);
    assert.equal(uploaded, false);
    assert.match(result.text, /已取消，没有修改游戏密码/);
    assert.ok(!/^[A-Za-z0-9_-]{32}$/m.test(result.text));
});

test('password wizard displays the new password only after successful upload and asks the user to save it', async () => {
    let uploaded: any;
    const result = await passwordWizard(['y', ''], async auth => { uploaded = auth; }, text => {
        if (/^[A-Za-z0-9_-]{32}$/m.test(text)) assert.ok(uploaded);
    });
    assert.equal(result.result, true);
    const password = result.text.match(/^([A-Za-z0-9_-]{32})$/m)![1];
    assert.equal(createHash('sha256').update(password).digest('hex'), uploaded.passwordHash);
    assert.match(result.text, /密码已更新成功/);
    assert.match(result.text, /确认已保存密码后/);
    assert.ok(!result.text.includes(uploaded.passwordHash));
    assert.ok(!result.text.includes(uploaded.sessionKey));
});

test('password wizard does not reveal an unusable password or success message when upload fails', async () => {
    let text = '';
    await assert.rejects(passwordWizard(['y'], async () => { throw new Error('test upload failed'); }, value => { text = value; }), /test upload failed/);
    assert.ok(!/^[A-Za-z0-9_-]{32}$/m.test(text));
    assert.ok(!text.includes('密码已更新成功'));
});

test('password wizard refuses redirected output before generating or uploading credentials', async () => {
    let uploaded = false;
    await assert.rejects(passwordTools.runPasswordSetup({
        input: { isTTY: false }, output: { isTTY: false }, upload: async () => { uploaded = true; },
    }), /请在自己的 cmd 交互窗口/);
    assert.equal(uploaded, false);
});

test('password CLI refuses non-interactive invocation without displaying credentials', async () => {
    await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../scripts/password.mjs', import.meta.url))]), error => {
        const failure = error as Error & { stdout: string; stderr: string };
        assert.equal(failure.stdout, '');
        assert.match(failure.stderr, /请在自己的 cmd 交互窗口/);
        return true;
    });
});

const playerTools = await import(new URL('../scripts/players.mjs', import.meta.url).href);

test('migration config reports missing worktree config safely and retains the restored slot', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pokeclicker-player-config-test-'));
    const file = path.join(dir, 'wrangler.local.json');
    try {
        await assert.rejects(playerTools.readMigrationConfig(file), /新 worktree 不会复制此本地配置.*保留原 CLOUD_SLOT_ID/);
        await writeFile(file, '{"private":"do-not-print-this-value"');
        await assert.rejects(playerTools.readMigrationConfig(file), error => {
            assert.match((error as Error).message, /本地部署配置格式错误/);
            assert.ok(!(error as Error).message.includes('do-not-print-this-value'));
            return true;
        });
        await writeFile(file, JSON.stringify({ vars: { CLOUD_SLOT_ID: '', ALLOWED_ORIGIN: 'https://game.example' } }));
        await assert.rejects(playerTools.readMigrationConfig(file), /未读取密码或修改云端配置/);
        const config = { vars: { CLOUD_SLOT_ID: '66cf8d51-2bac-4a66-a608-5f08a77ed50a', ALLOWED_ORIGIN: 'https://game.example' } };
        await writeFile(file, JSON.stringify(config));
        assert.deepEqual(await playerTools.readMigrationConfig(file), config);
        assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), config);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

test('multi-player migration retains the original password verifier and cloud slot', () => {
    const { password, auth: old } = passwordTools.createGameCredentials();
    const slot = '66cf8d51-2bac-4a66-a608-5f08a77ed50a';
    const registry = playerTools.initializePlayers(slot, '我', password);
    assert.equal(registry.version, 2);
    assert.equal(registry.players[0].id, 'player');
    assert.equal(registry.players[0].slotId, slot);
    assert.equal(registry.players[0].passwordHash, old.passwordHash);
    assert.ok(!JSON.stringify(registry).includes(password));
    assert.throws(() => playerTools.initializePlayers(slot, '我', 'short'));
});

test('adding and rotating a player preserves every existing identity and does not mutate input', () => {
    const mine = playerTools.initializePlayers('66cf8d51-2bac-4a66-a608-5f08a77ed50a', '我', passwordTools.createGameCredentials().password);
    const added = playerTools.changePlayer(mine, '朋友');
    assert.equal(mine.players.length, 1);
    assert.deepEqual(added.auth.players[0], mine.players[0]);
    assert.notEqual(added.player.slotId, mine.players[0].slotId);
    assert.match(added.password, /^[A-Za-z0-9_-]{32}$/);
    const rotated = playerTools.changePlayer(added.auth, undefined, added.player.id);
    assert.equal(rotated.player.id, added.player.id);
    assert.equal(rotated.player.slotId, added.player.slotId);
    assert.equal(rotated.player.name, '朋友');
    assert.notEqual(rotated.password, added.password);
    assert.notEqual(rotated.player.sessionKey, added.player.sessionKey);
    assert.deepEqual(rotated.auth.players[0], mine.players[0]);
    assert.ok(!JSON.stringify(rotated.auth).includes(rotated.password));
    assert.throws(() => playerTools.changePlayer(mine, ''));
    assert.throws(() => playerTools.changePlayer(mine, undefined, 'missing'));
});

test('player CLI refuses non-interactive execution before reading secrets', async () => {
    await assert.rejects(exec(process.execPath, [fileURLToPath(new URL('../scripts/players.mjs', import.meta.url)), 'add']), error => {
        const failure = error as Error & { stdout: string; stderr: string };
        assert.equal(failure.stdout, '');
        assert.match(failure.stderr, /请在本机交互终端/);
        return true;
    });
});

test('migration validates the old password at the fixed origin without following redirects or retaining the session', async () => {
    const password = passwordTools.createGameCredentials().password;
    await playerTools.verifyExistingPassword(password, 'https://game.example', async (url: string, init: RequestInit) => {
        assert.equal(url, 'https://game.example/auth/login');
        assert.equal(init.redirect, 'manual');
        assert.equal((init.headers as any).Origin, 'https://game.example');
        assert.equal(new URLSearchParams(String(init.body)).get('password'), password);
        return new Response(null, { status: 303, headers: { Location: '/login?returnTo=%2F' } });
    });
    for (const status of [401, 429, 503]) {
        await assert.rejects(playerTools.verifyExistingPassword(password, 'https://game.example', async () => new Response(null, { status })));
    }
    await assert.rejects(playerTools.verifyExistingPassword(password, 'https://game.example', async () => new Response(null, { status: 303, headers: { Location: 'https://evil.example' } })));
});

test('password setup cannot replace a remote registry signing master with single-player credentials', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pokeclicker-remote-password-test-'));
    const config = path.join(dir, 'wrangler.local.json');
    try {
        await writeFile(config, JSON.stringify({ vars: { ALLOWED_ORIGIN: 'https://game.example' } }));
        await assert.rejects(passwordTools.runPasswordSetup({ config, input: { isTTY: true }, output: { isTTY: true },
            fetcher: async () => Response.json({ mode: 'git' }), upload: async () => assert.fail('must not replace signing master'),
        }), /不能覆盖签名主密钥/);
    } finally { await rm(dir, { recursive: true, force: true }); }
});

async function remotePlayerWizard(command: string, answers: string[], fail = false) {
    const dir = await mkdtemp(path.join(tmpdir(), 'pokeclicker-remote-player-test-'));
    const config = path.join(dir, 'wrangler.local.json');
    await writeFile(config, JSON.stringify({ vars: { ALLOWED_ORIGIN: 'https://game.example', CLOUD_SLOT_ID: '66cf8d51-2bac-4a66-a608-5f08a77ed50a' } }));
    const input = Object.assign(new PassThrough(), { isTTY: true });
    let text = '', upload: any, mutation: any;
    const players = [{ id: 'player', name: '我', slotId: '66cf8d51-2bac-4a66-a608-5f08a77ed50a' }];
    const output = Object.assign(new Writable({ write(chunk, _encoding, done) {
        const value = chunk.toString(); text += value;
        if (/^[A-Za-z0-9_-]{32}$/m.test(text)) assert.ok(mutation, 'password must only appear after mutation success');
        if (value.endsWith('：')) setImmediate(() => input.write(answers.shift() + '\n'));
        done();
    } }), { isTTY: true });
    const fetcher = async (url: string, init: RequestInit) => {
        assert.equal(init.redirect, 'manual');
        if (url.endsWith('/auth/login')) return new Response(null, { status: 303, headers: { Location: '/login?returnTo=%2F', 'Set-Cookie': '__Host-pokeclicker_session=test-session; Secure; HttpOnly' } });
        assert.equal((init.headers as any).Cookie, '__Host-pokeclicker_session=test-session');
        if (init.method === 'POST') {
            if (fail) return Response.json({ code: 'PLAYERS_CONFLICT' }, { status: 409 });
            mutation = JSON.parse(String(init.body));
            return Response.json({ players, blobSha: 'a'.repeat(40), activate: command === 'init' });
        }
        return Response.json({ players, blobSha: 'a'.repeat(40) });
    };
    try {
        let error;
        try { await playerTools.runPlayers(command, { input, output, config, fetcher, readPassword: async () => 'p'.repeat(32), upload: async (value: any) => { upload = value; } }); }
        catch (failure) { error = failure; }
        assert.deepEqual(await readdir(dir), ['wrangler.local.json'], 'management must not create a local registry or pending secret file');
        return { text, upload, mutation, error };
    } finally { input.destroy(); output.destroy(); await rm(dir, { recursive: true, force: true }); }
}

test('remote init activates only a signing master and never saves or prints it locally', async () => {
    const result = await remotePlayerWizard('init', ['y']);
    assert.equal(result.error, undefined);
    assert.equal(result.upload.version, 3);
    assert.deepEqual(Object.keys(result.upload).sort(), ['sessionKey', 'version']);
    assert.ok(!result.text.includes(result.upload.sessionKey));
    assert.deepEqual(result.mutation, { command: 'init' });
});

test('remote add displays the generated password only after a successful SHA-checked update', async () => {
    const result = await remotePlayerWizard('add', ['朋友', 'y', '']);
    assert.equal(result.error, undefined);
    const password = result.text.match(/^([A-Za-z0-9_-]{32})$/m)![1];
    assert.equal(result.mutation.passwordHash, createHash('sha256').update(password).digest('hex'));
    assert.equal(result.mutation.baseBlobSha, 'a'.repeat(40));
    assert.equal(result.upload, undefined);
    assert.ok(!result.text.includes(result.mutation.passwordHash));
    assert.equal(result.mutation.sessionKey, undefined);
});

test('remote cancellation and conflict never upload a master or expose an unusable password', async () => {
    const cancelled = await remotePlayerWizard('init', ['']);
    assert.equal(cancelled.mutation, undefined);
    assert.equal(cancelled.upload, undefined);
    const conflict = await remotePlayerWizard('add', ['朋友', 'y'], true);
    assert.match((conflict.error as Error).message, /远端玩家配置已变化/);
    assert.equal(conflict.upload, undefined);
    assert.ok(!/^[A-Za-z0-9_-]{32}$/m.test(conflict.text));
});
