import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, execFile } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

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
        const prompts = ['游戏域名', 'GitHub 用户名', '私有存档仓库名', '存档仓库分支', 'Access 团队地址', 'Access 应用 AUD', '唯一允许登录的邮箱'];
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
        await configure(script, ['', 'test-owner', '', '', 'https://test.cloudflareaccess.com', 'a'.repeat(64), 'owner@example.com']);
        const config = JSON.parse(await readFile(path.join(dir, 'wrangler.local.json'), 'utf8'));
        assert.equal(config.vars.ALLOWED_ORIGIN, 'https://play.ggzz.fun');
        assert.equal(config.routes[0].custom_domain, true);
        assert.equal(config.workers_dev, false);
        assert.equal(config.vars.GITHUB_SAVE_TOKEN, undefined);
        assert.match(config.vars.CLOUD_SLOT_ID, /^[0-9a-f-]{36}$/);
        await configure(script, ['', '', '', '', '', '', '']);
        const again = JSON.parse(await readFile(path.join(dir, 'wrangler.local.json'), 'utf8'));
        assert.deepEqual(again, config);
    } finally { await rm(dir, { recursive: true, force: true }); }
});
