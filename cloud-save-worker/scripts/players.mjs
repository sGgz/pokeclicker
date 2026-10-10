import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename, access } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { stdin, stdout } from 'node:process';
import { createGameCredentials, uploadAuthSecret } from './password.mjs';

const directory = new URL('../../.local/', import.meta.url);
const registryFile = new URL('cloud-players.json', directory);
const pendingFile = new URL('cloud-players.pending.json', directory);
const configFile = new URL('../wrangler.local.json', import.meta.url);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateRegistry(auth) {
    if (auth?.version !== 2 || auth.primaryPlayerId !== 'player' || !Array.isArray(auth.players)
        || !auth.players.length || auth.players.length > 20 || !auth.players.some(player => player.id === 'player')
        || !auth.players.every(player => player && (player.id === 'player' || uuid.test(player.id))
            && uuid.test(player.slotId) && typeof player.name === 'string' && player.name.trim() && player.name.length <= 40
            && /^[a-f0-9]{64}$/.test(player.passwordHash) && /^[A-Za-z0-9_-]{43}$/.test(player.sessionKey))) {
        throw new Error('本地玩家配置无效，请从自己的安全备份恢复，不要重新初始化现有玩家。');
    }
    for (const key of ['id', 'slotId', 'passwordHash', 'sessionKey']) {
        if (new Set(auth.players.map(player => player[key])).size !== auth.players.length) throw new Error('玩家身份、存档位或凭证重复。');
    }
    return auth;
}

export function initializePlayers(slotId, name, existingPassword) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(existingPassword)) throw new Error('请完整输入原来的 32 字符专用密码。');
    const { auth } = createGameCredentials();
    return validateRegistry({ version: 2, primaryPlayerId: 'player', players: [{
        id: 'player', name, slotId, sessionKey: auth.sessionKey,
        passwordHash: createHash('sha256').update(existingPassword, 'utf8').digest('hex'),
    }] });
}

export function changePlayer(registry, name, id) {
    const auth = structuredClone(validateRegistry(registry));
    const { password, auth: credentials } = createGameCredentials();
    const player = id ? auth.players.find(entry => entry.id === id) : undefined;
    if (id && !player) throw new Error('找不到此玩家，请先运行 list 查看玩家 ID。');
    if (player) {
        Object.assign(player, { passwordHash: credentials.passwordHash, sessionKey: credentials.sessionKey });
    } else {
        auth.players.push({ id: randomUUID(), name, slotId: randomUUID(), passwordHash: credentials.passwordHash, sessionKey: credentials.sessionKey });
    }
    return { auth: validateRegistry(auth), password, player: player || auth.players.at(-1) };
}

export async function verifyExistingPassword(password, origin, fetcher = fetch) {
    if (!/^[A-Za-z0-9_-]{32}$/.test(password) || !/^https:\/\/[^/?#]+$/.test(origin || '')) {
        throw new Error('原密码或游戏域名格式无效，未修改云端配置。');
    }
    let response;
    try {
        response = await fetcher(origin + '/auth/login', {
            method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
            headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password, returnTo: '/' }).toString(),
        });
        await response.body?.cancel();
    } catch {
        throw new Error('无法验证原密码，请检查网络后重试；未修改云端配置。');
    }
    if (response.status !== 303 || response.headers.get('Location') !== '/login?returnTo=%2F') {
        throw new Error(response.status === 429 ? '验证尝试过多，请至少等 60 秒再试。' : '原密码未通过云端验证，未修改云端配置。');
    }
}

// Raw input prevents the existing password from being echoed into terminal output.
async function hiddenPassword(input, output) {
    output.write('原来的游戏专用密码（输入隐藏）：');
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    try {
        return await new Promise((resolve, reject) => {
            let value = '';
            const data = chunk => {
                for (const character of chunk.toString('utf8')) {
                    if (character === '\u0003' || character === '\u0004') {
                        input.off('data', data); reject(new Error('已取消。')); return;
                    }
                    if (character === '\r' || character === '\n') {
                        input.off('data', data); resolve(value); return;
                    }
                    if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
                    else if (value.length < 128) value += character;
                }
            };
            input.on('data', data);
        });
    } finally {
        input.setRawMode(Boolean(wasRaw)); input.pause(); output.write('\n');
    }
}

async function exists(file) {
    try { await access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function runPlayers(command, { input = stdin, output = stdout, upload = uploadAuthSecret } = {}) {
    if (!input.isTTY || !output.isTTY) throw new Error('请在本机交互终端运行 cloud:players；请勿重定向输出或通过聊天运行，以免泄露密码。');
    if (!['init', 'add', 'reset', 'list', 'apply'].includes(command)) throw new Error('用法：cloud-windows.cmd players init|add|reset|list|apply（Node 24 环境也可用 npm run cloud:players -- 命令）');
    if (await exists(pendingFile) && command !== 'apply') throw new Error('有尚未确认上传的玩家配置。请先运行 cloud-windows.cmd players apply；新增或重置密码若未显示，需要之后重新 reset。');
    let auth;
    if (command !== 'init' && command !== 'apply') auth = validateRegistry(JSON.parse(await readFile(registryFile, 'utf8')));
    if (command === 'list') {
        auth.players.forEach(player => output.write(`${player.name} | 玩家 ID：${player.id} | 存档位：${player.slotId}\n`));
        return;
    }
    if (command === 'init' && await exists(registryFile)) throw new Error('玩家配置已经存在，请使用 add 或 reset，避免丢失原玩家。');
    let password, changed;
    if (command === 'init') {
        const config = JSON.parse(await readFile(configFile, 'utf8'));
        const existing = await hiddenPassword(input, output);
        await verifyExistingPassword(existing, config.vars.ALLOWED_ORIGIN);
        auth = initializePlayers(config.vars.CLOUD_SLOT_ID, '我', existing);
        output.write('原密码和原云存档位将保留；已有登录会话需要重新登录。\n');
    }
    const rl = createInterface({ input, output });
    try {
        if (command === 'add') {
            const name = (await rl.question('新玩家显示名称（最多 40 字）：')).trim();
            ({ auth, password, player: changed } = changePlayer(auth, name));
        } else if (command === 'reset') {
            auth.players.forEach(player => output.write(`${player.name}：${player.id}\n`));
            const id = (await rl.question('要重置密码的玩家 ID：')).trim();
            ({ auth, password, player: changed } = changePlayer(auth, undefined, id));
        } else if (command === 'apply') {
            auth = validateRegistry(JSON.parse(await readFile(pendingFile, 'utf8')));
        }
        if ((await rl.question('将更新云端玩家配置。输入 y 继续，回车取消：')).trim().toLowerCase() !== 'y') {
            output.write('已取消，没有更新云端玩家配置。\n'); return;
        }
        await mkdir(directory, { recursive: true });
        if (command !== 'apply') await writeFile(pendingFile, JSON.stringify(auth, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        await upload(auth);
        await rename(pendingFile, registryFile);
        output.write('玩家配置已更新。请安全备份 .local/cloud-players.json，它含登录签名密钥，不要提交或分享。\n');
        if (password) {
            output.write(`${changed.name} 的专用密码仅在此显示，请保存到密码管理器：\n\n${password}\n\n`);
            await rl.question('确认已保存密码后，按回车结束：');
        } else if (command === 'apply') output.write('待处理配置已应用。若之前未显示新密码，请对相应玩家运行 reset。\n');
    } finally { rl.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    runPlayers(process.argv[2]).catch(error => {
        // Never print raw secret parsing or subprocess diagnostics.
        console.error(error instanceof SyntaxError ? '配置文件格式错误，请从安全备份恢复。' : error.message);
        process.exitCode = 1;
    });
}
