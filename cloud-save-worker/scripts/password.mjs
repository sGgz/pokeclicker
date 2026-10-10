import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stdin, stdout } from 'node:process';

const configUrl = new URL('../wrangler.local.json', import.meta.url);
const wranglerPath = fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));

export function createGameCredentials() {
    const password = randomBytes(24).toString('base64url');
    return {
        password,
        auth: {
            version: 1,
            // This verifier is only for a randomly generated 192-bit password, never a human-chosen password.
            passwordHash: createHash('sha256').update(password, 'utf8').digest('hex'),
            sessionKey: randomBytes(32).toString('base64url'),
        },
    };
}

export async function uploadAuthSecret(auth, { spawnProcess = spawn } = {}) {
    await new Promise((resolve, reject) => {
        const child = spawnProcess(process.execPath, [
            wranglerPath, 'secret', 'put', 'GAME_AUTH', '--config', fileURLToPath(configUrl),
        ], {
            cwd: fileURLToPath(new URL('../', import.meta.url)),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        // Wrangler's output is deliberately not forwarded: even verbose/debug logging must not expose the Secret.
        child.stdout.resume();
        child.stderr.resume();
        child.once('error', () => reject(new Error('无法启动部署工具，请先安装依赖并运行 npm run cloud:login。')));
        child.stdin.on('error', () => reject(new Error('无法向部署工具安全传入密码配置，请重新运行。')));
        child.once('close', code => {
            if (code === 0) resolve();
            else reject(new Error('上传游戏密码失败。请确认已运行 cloud:login 和 cloud:deploy，检查网络后重试；没有显示的新密码不能用于登录。'));
        });
        child.stdin.end(JSON.stringify(auth) + '\n');
    });
}

export async function runPasswordSetup({
    input = stdin, output = stdout, config = configUrl, upload = uploadAuthSecret, fetcher = fetch,
} = {}) {
    if (!input.isTTY || !output.isTTY) {
        throw new Error('请在自己的 cmd 交互窗口运行 npm run cloud:password；请勿重定向输出或通过聊天记录运行，以免泄露游戏密码。');
    }
    for (const file of ['cloud-players.json', 'cloud-players.pending.json']) {
        try {
            await access(new URL('../.local/' + file, typeof config === 'string' ? pathToFileURL(config) : config));
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        throw new Error('已启用多人存档或有待处理玩家配置。请使用 cloud-windows.cmd players reset 单独重置玩家密码；不能覆盖为单人配置。');
    }
    let configuration;
    try { configuration = JSON.parse(await readFile(config, 'utf8')); } catch {
        throw new Error('没有找到本机配置。请先运行 npm run cloud:setup，再按手册完成 cloud:login 和 cloud:deploy。');
    }
    if (configuration.vars?.ALLOWED_ORIGIN) {
        let response;
        try { response = await fetcher(configuration.vars.ALLOWED_ORIGIN + '/auth/config', { redirect: 'manual', signal: AbortSignal.timeout(20000) }); }
        catch { throw new Error('无法确认线上认证模式，未修改密码；请检查网络后重试。'); }
        const mode = await response.json().catch(() => null);
        if (mode?.mode === 'git') throw new Error('已启用远端玩家配置，请使用 cloud-windows.cmd players reset，不能覆盖签名主密钥。');
        if (mode?.mode !== 'legacy' && !(response.status === 503 && mode?.code === 'AUTH_CONFIGURATION')) throw new Error('无法确认线上认证模式，未修改密码；请先更新 Worker。');
    }
    const rl = createInterface({ input, output, terminal: false });
    const ask = prompt => new Promise((resolve, reject) => {
        const onClose = () => reject(new Error('操作已取消。'));
        rl.once('close', onClose);
        rl.question(prompt, answer => {
            rl.off('close', onClose);
            resolve(answer);
        });
    });
    try {
        output.write('此工具生成高强度随机游戏密码，并通过 Cloudflare Secret 保存密码校验值。\n');
        output.write('继续会替换旧游戏密码，并让所有已登录设备重新登录；请准备好密码管理器。\n');
        const confirm = (await ask('输入 y 生成并更新密码；直接回车取消：')).trim().toLowerCase();
        if (confirm !== 'y') {
            output.write('已取消，没有修改游戏密码。\n');
            return false;
        }
        const { password, auth } = createGameCredentials();
        output.write('正在安全上传密码配置，请等待……\n');
        await upload(auth);
        output.write('\n游戏密码已更新成功。请把下面的密码保存到密码管理器，不要发到聊天或写进代码：\n\n');
        output.write(password + '\n\n');
        output.write('密码只在本次窗口显示。以后忘记密码，可重新运行此命令生成新密码，云存档仍会保留。\n');
        await ask('确认已保存密码后，按回车结束：');
        return true;
    } finally {
        rl.close();
    }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    runPasswordSetup().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
