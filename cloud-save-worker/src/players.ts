import { ApiError, GithubStore, readLimited, type GithubConfig } from './github';
import { parseAuth, players, type AuthConfig } from './auth';
import { isBlobSha, isUuid } from '../../src/modules/cloudSave/protocol';

export interface PlayerRecord {
    id: string;
    name: string;
    slotId: string;
    passwordHash: string;
    credentialVersion: string;
}
export interface PlayerRegistry { version: 1; primaryPlayerId: 'player'; players: PlayerRecord[] }
export interface RegistrySnapshot { registry: PlayerRegistry; blobSha: string }
export interface RegistryStore {
    readRegistry(): Promise<RegistrySnapshot | null>;
    writeRegistry(registry: PlayerRegistry, sha: string | null): Promise<RegistrySnapshot>;
}
const LIMIT = 64 * 1024;
const FILE = '/contents/config/players.json';

export function validatePlayers(value: unknown): PlayerRegistry {
    const registry = value as PlayerRegistry;
    if (!registry || registry.version !== 1 || registry.primaryPlayerId !== 'player'
        || Object.keys(registry).some(key => !['version', 'primaryPlayerId', 'players'].includes(key))
        || !Array.isArray(registry.players) || !registry.players.length || registry.players.length > 20
        || !registry.players.some(player => player.id === 'player')
        || !registry.players.every(player => player && Object.keys(player).every(key => ['id', 'name', 'slotId', 'passwordHash', 'credentialVersion'].includes(key))
            && (player.id === 'player' || isUuid(player.id)) && isUuid(player.slotId) && isUuid(player.credentialVersion)
            && typeof player.name === 'string' && !!player.name.trim() && player.name.length <= 40
            && /^[a-f0-9]{64}$/.test(player.passwordHash))) {
        throw new ApiError(503, 'PLAYERS_CONFIGURATION', '远端玩家配置无效，请恢复正确配置，不能重新初始化覆盖已有玩家。');
    }
    for (const field of ['id', 'slotId', 'passwordHash', 'credentialVersion'] as const) {
        if (new Set(registry.players.map(player => player[field])).size !== registry.players.length) {
            throw new ApiError(503, 'PLAYERS_CONFIGURATION', '远端玩家身份或凭证重复。');
        }
    }
    return registry;
}

export class GithubPlayersStore extends GithubStore implements RegistryStore {
    constructor(private config: GithubConfig, fetcher?: typeof fetch) { super(config, fetcher); }

    private async assertPrivate(): Promise<void> {
        const response = await this.call('');
        if (!response.ok) throw new ApiError(503, 'GITHUB_AUTH', '无法确认存档仓库权限。');
        const repository = JSON.parse(await readLimited(response, LIMIT));
        if (repository.private !== true) throw new ApiError(503, 'PRIVATE_REPOSITORY_REQUIRED', '玩家配置只能存入私有存档仓库。');
    }

    async readRegistry(): Promise<RegistrySnapshot | null> {
        await this.assertPrivate();
        const response = await this.call(FILE + '?ref=' + encodeURIComponent(this.config.GITHUB_SAVE_BRANCH));
        if (response.status === 404) { await this.assertAvailable(); return null; }
        if (!response.ok) throw new ApiError(503, 'PLAYERS_READ', '读取远端玩家配置失败。');
        try {
            const metadata = JSON.parse(await readLimited(response, LIMIT * 2));
            if (metadata.type !== 'file' || !isBlobSha(metadata.sha) || !Number.isSafeInteger(metadata.size)
                || metadata.size < 0 || metadata.size > LIMIT || metadata.encoding !== 'base64' || typeof metadata.content !== 'string') throw new Error('Invalid metadata');
            const bytes = Uint8Array.from(atob(metadata.content.replace(/\s/g, '')), character => character.charCodeAt(0));
            if (bytes.length > LIMIT) throw new Error('Oversized registry');
            const registry = validatePlayers(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
            return { registry, blobSha: metadata.sha };
        } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(503, 'PLAYERS_CONFIGURATION', '远端玩家配置格式错误，未修改任何玩家。');
        }
    }

    async writeRegistry(value: PlayerRegistry, sha: string | null): Promise<RegistrySnapshot> {
        const registry = validatePlayers(value);
        await this.assertPrivate();
        const bytes = new TextEncoder().encode(JSON.stringify(registry, null, 2) + '\n');
        if (bytes.length > LIMIT) throw new ApiError(413, 'TOO_LARGE', '玩家配置超过大小限制。');
        const response = await this.call(FILE, {
            method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: 'Update player registry', branch: this.config.GITHUB_SAVE_BRANCH,
                content: btoa(String.fromCharCode(...bytes)), ...(sha ? { sha } : {}) }),
        });
        if (response.status === 409 || response.status === 422) throw new ApiError(409, 'PLAYERS_CONFLICT', '玩家配置已变化或仓库拒绝更新，请重新读取后再操作。');
        if (!response.ok) throw new ApiError(503, 'PLAYERS_WRITE', '远端玩家配置更新失败，请重新读取确认结果。');
        const result = await response.json() as { content?: { sha?: string } };
        if (!isBlobSha(result.content?.sha)) throw new ApiError(503, 'PLAYERS_UNKNOWN_RESULT', '更新结果待确认，请重新读取玩家列表。');
        return { registry, blobSha: result.content.sha };
    }
}

export function migratePlayers(config: AuthConfig): PlayerRegistry {
    return validatePlayers({ version: 1, primaryPlayerId: 'player', players: players(config).map(player => ({
        id: player.id, name: player.name, slotId: player.slotId, passwordHash: player.passwordHash, credentialVersion: crypto.randomUUID(),
    })) });
}

export async function resolvePlayerAuth(config: AuthConfig, registry: PlayerRegistry): Promise<AuthConfig> {
    const secret = parseAuth(config);
    if (secret.version !== 3) return config;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret.sessionKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const entries = await Promise.all(validatePlayers(registry).players.map(async player => {
        const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key,
            new TextEncoder().encode(JSON.stringify(['pokeclicker-player-session-v3', player.id, player.slotId, player.credentialVersion]))));
        const sessionKey = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
        return { id: player.id, name: player.name, slotId: player.slotId, passwordHash: player.passwordHash, sessionKey };
    }));
    return { ...config, GAME_AUTH: JSON.stringify({ version: 2, primaryPlayerId: 'player', players: entries }) };
}

export class RegistryCache {
    private cached?: { key: string; until: number; value: Promise<RegistrySnapshot> };
    clear(): void { this.cached = undefined; }
    async read(config: GithubConfig & AuthConfig, store: RegistryStore, now: number): Promise<RegistrySnapshot> {
        const key = JSON.stringify([config.GITHUB_OWNER, config.GITHUB_SAVE_REPO, config.GITHUB_SAVE_BRANCH, config.GITHUB_SAVE_TOKEN, config.GAME_AUTH]);
        if (this.cached?.key === key && this.cached.until > now) return this.cached.value;
        const value = store.readRegistry().then(snapshot => {
            if (!snapshot) throw new ApiError(503, 'PLAYERS_MISSING', '远端玩家配置缺失，请恢复仓库历史，不能重新初始化。');
            return snapshot;
        });
        const entry = { key, until: now + 15000, value };
        this.cached = entry;
        try { return await value; } catch (error) { if (this.cached === entry) this.clear(); throw error; }
    }
}

export function publicPlayers(snapshot: RegistrySnapshot) {
    return { blobSha: snapshot.blobSha, players: snapshot.registry.players.map(({ id, name, slotId, credentialVersion }) => ({ id, name, slotId, credentialVersion })) };
}

export async function managePlayers(request: Request, config: AuthConfig, store: RegistryStore): Promise<unknown> {
    if (request.method === 'GET') {
        const snapshot = await store.readRegistry();
        if (!snapshot) throw new ApiError(404, 'PLAYERS_NOT_INITIALIZED', '请先运行 players init。');
        return publicPlayers(snapshot);
    }
    let body;
    try { body = JSON.parse(await readLimited(request, 4096)); }
    catch { throw new ApiError(422, 'INVALID_REQUEST', '玩家管理请求格式错误。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(422, 'INVALID_REQUEST', '玩家管理请求格式错误。');
    const snapshot = await store.readRegistry();
    if (body.command === 'init') {
        const secret = parseAuth(config);
        if (secret.version === 3) {
            if (!snapshot) throw new ApiError(503, 'PLAYERS_MISSING', '远端玩家配置缺失，请恢复仓库历史。');
            return { ok: true, activate: false, ...publicPlayers(snapshot) };
        }
        const migrated = migratePlayers(config);
        if (snapshot) {
            const same = migrated.players.length === snapshot.registry.players.length && migrated.players.every(player =>
                snapshot.registry.players.some(other => ['id', 'name', 'slotId', 'passwordHash'].every(field => player[field as keyof PlayerRecord] === other[field as keyof PlayerRecord])));
            if (!same) throw new ApiError(409, 'PLAYERS_CONFLICT', '仓库已有不同的玩家配置，未覆盖；请核对迁移状态。');
        }
        const result = snapshot || await store.writeRegistry(migrated, null);
        return { ok: true, activate: true, ...publicPlayers(result) };
    }
    if (parseAuth(config).version !== 3 || !snapshot) throw new ApiError(409, 'PLAYERS_NOT_INITIALIZED', '请先完成 players init。');
    if (!['add', 'reset'].includes(body.command) || !isBlobSha(body.baseBlobSha) || !/^[a-f0-9]{64}$/.test(body.passwordHash || '')) throw new ApiError(422, 'INVALID_REQUEST', '玩家管理请求格式错误。');
    if (body.baseBlobSha !== snapshot.blobSha) throw new ApiError(409, 'PLAYERS_CONFLICT', '玩家配置已变化，请重新读取后再操作。');
    const registry = structuredClone(snapshot.registry);
    if (body.command === 'add') {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 40 || registry.players.length >= 20) throw new ApiError(422, 'INVALID_PLAYER', '玩家名称无效或已达到 20 人限制。');
        registry.players.push({ id: crypto.randomUUID(), name: body.name.trim(), slotId: crypto.randomUUID(), passwordHash: body.passwordHash, credentialVersion: crypto.randomUUID() });
    } else {
        const player = registry.players.find(entry => entry.id === body.playerId);
        if (!player) throw new ApiError(404, 'PLAYER_NOT_FOUND', '找不到此玩家。');
        player.passwordHash = body.passwordHash;
        player.credentialVersion = crypto.randomUUID();
    }
    return { ok: true, ...publicPlayers(await store.writeRegistry(registry, snapshot.blobSha)) };
}
