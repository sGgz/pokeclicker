import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { stdin, stdout } from 'node:process';
import { createGameCredentials, uploadAuthSecret } from './password.mjs';

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

export async function readMigrationConfig(file = configFile) {
    let config;
    try {
        config = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('缺少 cloud-save-worker/wrangler.local.json。新 worktree 不会复制此本地配置；请从原部署目录或安全备份恢复，保留原 CLOUD_SLOT_ID，不要重新生成存档位。');
        }
        if (error instanceof SyntaxError) throw new Error('本地部署配置格式错误，请从原部署目录或安全备份恢复。');
        throw error;
    }
    if (!uuid.test(config?.vars?.CLOUD_SLOT_ID || '') || !/^https:\/\/[^/?#]+$/.test(config?.vars?.ALLOWED_ORIGIN || '')) {
        throw new Error('本地部署配置缺少有效的 CLOUD_SLOT_ID 或 ALLOWED_ORIGIN，请恢复原部署配置；未读取密码或修改云端配置。');
    }
    return config;
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
export async function hiddenPassword(input, output) {
    output.write('主玩家的游戏专用密码（输入隐藏）：');
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

export async function adminSession(password, origin, fetcher = fetch) {
    let response;
    try {
        response = await fetcher(origin + '/auth/login', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
            headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ password, returnTo: '/' }).toString() });
        await response.body?.cancel();
    } catch { throw new Error('无法连接游戏登录接口，请检查网络后重试。'); }
    const cookies = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
    const cookie = cookies.find(value => value.startsWith('__Host-pokeclicker_session='))?.split(';')[0];
    if (response.status !== 303 || response.headers.get('Location') !== '/login?returnTo=%2F' || !cookie) throw new Error('主玩家密码未通过验证，或登录尝试过多；未更新玩家配置。');
    return cookie;
}

export async function adminRequest(origin, cookie, body, fetcher = fetch) {
    let response;
    try {
        response = await fetcher(origin + '/api/cloud-save/admin/players', {
            method: body ? 'POST' : 'GET', redirect: 'manual', signal: AbortSignal.timeout(30000),
            headers: { Origin: origin, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
    } catch { throw new Error('玩家管理连接中断；更新可能已完成，请重新运行 list 确认，不要盲目重复新增。'); }
    const result = await response.json().catch(() => null);
    if (!response.ok) {
        const messages = { ADMIN_REQUIRED: '只有主玩家可以管理其他玩家。', PLAYERS_CONFLICT: '远端玩家配置已变化或拒绝更新，请重新读取后再操作。',
            PLAYERS_NOT_INITIALIZED: '请先执行 players init。', PLAYERS_MISSING: '远端玩家配置缺失，请恢复仓库历史，不要重新初始化。',
            PRIVATE_REPOSITORY_REQUIRED: '存档仓库必须是私有仓库。', LOGIN_REQUIRED: '登录已过期，请重新运行命令。' };
        throw new Error(messages[result?.code] || '玩家管理失败，请确认已发布新版 Worker、仓库权限正常后重试。');
    }
    if (!result || !Array.isArray(result.players)) throw new Error('玩家管理返回格式无效，未显示生成的密码。');
    return result;
}

export async function runPlayers(command, { input = stdin, output = stdout, upload = uploadAuthSecret, fetcher = fetch, config = configFile, readPassword = hiddenPassword } = {}) {
    if (!input.isTTY || !output.isTTY) throw new Error('请在本机交互终端运行 cloud:players；请勿重定向输出或通过聊天运行，以免泄露密码。');
    if (!['init', 'add', 'reset', 'list'].includes(command)) throw new Error('用法：cloud-windows.cmd players init|add|reset|list；apply 已停用，操作以远端配置为准。');
    const configuration = await readMigrationConfig(config);
    const origin = configuration.vars.ALLOWED_ORIGIN;
    const cookie = await adminSession(await readPassword(input, output), origin, fetcher);
    const show = result => result.players.forEach(player => output.write(`${player.name} | 玩家 ID：${player.id} | 存档位：${player.slotId}\n`));
    if (command === 'list') { show(await adminRequest(origin, cookie, undefined, fetcher)); return; }
    let snapshot;
    if (command !== 'init') snapshot = await adminRequest(origin, cookie, undefined, fetcher);
    const rl = createInterface({ input, output });
    try {
        if (command === 'add') {
            const name = (await rl.question('新玩家显示名称（最多 40 字）：')).trim();
            if (!name || name.length > 40) throw new Error('玩家名称必须为 1 至 40 字。');
            snapshot.change = { command, name };
        } else if (command === 'reset') {
            show(snapshot);
            const id = (await rl.question('要重置密码的玩家 ID：')).trim();
            if (!snapshot.players.some(player => player.id === id)) throw new Error('找不到此玩家。');
            snapshot.change = { command, playerId: id };
        }
        if ((await rl.question('将更新云端玩家配置。输入 y 继续，回车取消：')).trim().toLowerCase() !== 'y') {
            output.write('已取消，没有更新云端玩家配置。\n'); return;
        }
        if (command === 'init') {
            const result = await adminRequest(origin, cookie, { command }, fetcher);
            if (result.activate) {
                const { auth } = createGameCredentials();
                await upload({ version: 3, sessionKey: auth.sessionKey });
                output.write('远端玩家配置已启用，密码、玩家 ID 和存档位保留；全部设备需要重新登录。\n');
            } else output.write('远端玩家配置已经启用，无需重复迁移。\n');
            show(result);
        } else {
            const { password, auth } = createGameCredentials();
            const result = await adminRequest(origin, cookie, { ...snapshot.change, baseBlobSha: snapshot.blobSha, passwordHash: auth.passwordHash }, fetcher);
            output.write(`玩家配置已更新。专用密码仅在此显示，请保存到密码管理器：\n\n${password}\n\n`);
            show(result);
            await rl.question('确认已保存密码后，按回车结束：');
        }
    } finally { rl.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    runPlayers(process.argv[2]).catch(error => {
        // Never print raw secret parsing or subprocess diagnostics.
        console.error(error instanceof SyntaxError ? '配置文件格式错误，请从安全备份恢复。' : error.message);
        process.exitCode = 1;
    });
}
