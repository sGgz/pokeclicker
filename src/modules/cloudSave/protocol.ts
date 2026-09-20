export const MAX_SAVE_BYTES = 5 * 1024 * 1024;
export const SYNC_INTERVAL = 10 * 60 * 1000;

export interface SavePayload {
    player: Record<string, unknown>;
    save: Record<string, unknown>;
    settings: Record<string, unknown>;
}

export interface CloudSaveEnvelope {
    schemaVersion: 1;
    slotId: string;
    revision: number;
    snapshotId: string;
    parentSnapshotId: string | null;
    serverSavedAt: string;
    clientSavedAt: string;
    deviceId: string;
    gameVersion: string;
    clientBuild: string;
    payloadHash: string;
    payload: SavePayload;
}

export interface RemoteSave {
    blobSha: string;
    envelope: CloudSaveEnvelope;
}

export interface UploadRequest {
    baseBlobSha: string | null;
    baseRevision: number;
    snapshotId: string;
    deviceId: string;
    clientSavedAt: string;
    clientBuild: string;
    payload: SavePayload;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function isBlobSha(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{40,64}$/i.test(value);
}

// Keep arrays ordered. Do not assign user-controlled property names to another object.
export function canonicalJson(value: unknown, depth = 0): string {
    if (depth > 64) {
        throw new Error('存档层级过深。');
    }
    if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return '[' + value.map((item) => canonicalJson(item, depth + 1)).join(',') + ']';
    }
    if (isRecord(value)) {
        return '{' + Object.keys(value).sort().map((key) => {
            if (['__proto__', 'prototype', 'constructor'].includes(key)) {
                throw new Error('存档包含不支持的属性。');
            }
            return JSON.stringify(key) + ':' + canonicalJson(value[key], depth + 1);
        }).join(',') + '}';
    }
    throw new Error('存档必须是有效的 JSON 数据。');
}

export function payloadVersion(payload: SavePayload): string {
    const update = payload.save.update;
    if (!isRecord(update) || typeof update.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(update.version)) {
        throw new Error('存档缺少有效的游戏版本。');
    }
    return update.version;
}

export function validatePayload(value: unknown): asserts value is SavePayload {
    if (!isRecord(value) || !isRecord(value.player) || !isRecord(value.save) || !isRecord(value.settings)) {
        throw new Error('存档必须包含 player、save 和 settings。');
    }
    const payload = value as unknown as SavePayload;
    payloadVersion(payload);
    if (payload.player._lastSeen !== undefined
        && (typeof payload.player._lastSeen !== 'number' || !Number.isFinite(payload.player._lastSeen) || payload.player._lastSeen < 0)) {
        throw new Error('存档的最后游玩时间无效。');
    }
    const json = canonicalJson(payload);
    if (new TextEncoder().encode(json).byteLength > MAX_SAVE_BYTES) {
        throw new Error('存档超过 5 MiB 上限，请先下载本地备份。');
    }
}

export async function hashPayload(payload: SavePayload): Promise<string> {
    const bytes = new TextEncoder().encode(canonicalJson(payload));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateRemote(value: unknown, slotId: string): Promise<RemoteSave> {
    if (!isRecord(value) || !isBlobSha(value.blobSha) || !isRecord(value.envelope)) {
        throw new Error('云存档响应格式无效。');
    }
    const data = value.envelope;
    if (data.schemaVersion !== 1 || data.slotId !== slotId || !isUuid(data.snapshotId)
        || !(data.parentSnapshotId === null || isUuid(data.parentSnapshotId))
        || !Number.isSafeInteger(data.revision) || (data.revision as number) < 1
        || !isUuid(data.deviceId) || typeof data.clientBuild !== 'string'
        || typeof data.serverSavedAt !== 'string' || !Number.isFinite(Date.parse(data.serverSavedAt))
        || typeof data.clientSavedAt !== 'string' || !Number.isFinite(Date.parse(data.clientSavedAt))) {
        throw new Error('云存档版本或元数据无效，请保留本地备份。');
    }
    validatePayload(data.payload);
    if (data.gameVersion !== payloadVersion(data.payload) || data.payloadHash !== await hashPayload(data.payload)) {
        throw new Error('云存档校验失败，已阻止加载。');
    }
    return value as unknown as RemoteSave;
}

export function compareVersions(left: string, right: string): number {
    return left.localeCompare(right, undefined, { numeric: true });
}
