import { hashPayload, validatePayload, validateRemote } from './protocol';
import type { RemoteSave, SavePayload, UploadRequest } from './protocol';

export interface SyncBase {
    blobSha: string;
    revision: number;
    payloadHash: string;
    serverSavedAt: string;
}

export interface SyncState {
    deviceId: string;
    localKey: string | null;
    slotId: string | null;
    base: SyncBase | null;
    autoSync: boolean;
    latest: SavePayload | null;
    pending: UploadRequest | null;
    hasConflict: boolean;
    remoteConflict: RemoteSave | null;
}

export type RawSave = [string | null, string | null, string | null];
export interface InstallJournal {
    key: string;
    before: RawSave;
    after: RawSave;
    remote: RemoteSave | null;
}

export function emptyState(): SyncState {
    return {
        deviceId: crypto.randomUUID(), localKey: null, slotId: null, base: null,
        autoSync: false, latest: null, pending: null, hasConflict: false, remoteConflict: null,
    };
}

export function readLocal(key: string, storage: Storage = localStorage): RawSave {
    return ['player', 'save', 'settings'].map((prefix) => storage.getItem(prefix + key)) as RawSave;
}

export function writeLocal(key: string, raw: RawSave, storage: Storage = localStorage): void {
    ['player', 'save', 'settings'].forEach((prefix, index) => {
        if (raw[index] === null) {
            storage.removeItem(prefix + key);
        } else {
            storage.setItem(prefix + key, raw[index]);
        }
    });
}

export function rawPayload(raw: RawSave): SavePayload | null {
    if (!raw[0] || !raw[1]) {
        return null;
    }
    return { player: JSON.parse(raw[0]), save: JSON.parse(raw[1]), settings: JSON.parse(raw[2] || '{}') };
}

export function payloadRaw(payload: SavePayload): RawSave {
    return [JSON.stringify(payload.player), JSON.stringify(payload.save), JSON.stringify(payload.settings)];
}

export interface StateStorage {
    getState(): Promise<SyncState>;
    saveState(state: SyncState): Promise<void>;
}

export class CloudStorage implements StateStorage {
    private database: Promise<IDBDatabase>;

    constructor(profile?: string) {
        this.database = new Promise((resolve, reject) => {
            const request = indexedDB.open('pokeclicker-cloud-save' + (profile ? ':' + profile : ''), 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore('kv');
                request.result.createObjectStore('backups', { autoIncrement: true });
            };
            request.onsuccess = () => {
                request.result.onversionchange = () => request.result.close();
                resolve(request.result);
            };
            request.onerror = () => reject(new Error('无法打开浏览器备份空间，请检查隐私模式和存储权限。'));
            request.onblocked = () => reject(new Error('请先关闭其他游戏标签页，再重试。'));
        });
    }

    private async get<T>(key: string): Promise<T | undefined> {
        const database = await this.database;
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('kv', 'readonly');
            const request = transaction.objectStore('kv').get(key);
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    private async mutate(stores: string[], action: (transaction: IDBTransaction) => void): Promise<void> {
        const database = await this.database;
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(stores, 'readwrite');
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(new Error('浏览器备份写入失败，请先下载存档并释放空间。'));
            transaction.onabort = transaction.onerror;
            try {
                action(transaction);
            } catch (error) {
                transaction.abort();
                reject(error);
            }
        });
    }

    async getState(): Promise<SyncState> {
        return (await this.get<SyncState>('state')) || emptyState();
    }

    saveState(state: SyncState): Promise<void> {
        return this.mutate(['kv'], (transaction) => transaction.objectStore('kv').put(state, 'state'));
    }

    getJournal(): Promise<InstallJournal | undefined> {
        return this.get<InstallJournal>('journal');
    }

    stageInstall(journal: InstallJournal): Promise<void> {
        return this.mutate(['kv', 'backups'], (transaction) => {
            transaction.objectStore('backups').add({ time: new Date().toISOString(), reason: 'before-install', local: journal.before });
            transaction.objectStore('kv').put(journal, 'journal');
        });
    }

    clearJournal(): Promise<void> {
        return this.mutate(['kv'], (transaction) => transaction.objectStore('kv').delete('journal'));
    }

    backup(local: RawSave, remote: RemoteSave | null, reason: string): Promise<void> {
        return this.mutate(['backups'], (transaction) => {
            transaction.objectStore('backups').add({ time: new Date().toISOString(), reason, local, remote });
        });
    }

    async allBackups(): Promise<unknown[]> {
        const database = await this.database;
        return new Promise((resolve, reject) => {
            const transaction = database.transaction('backups', 'readonly');
            const request = transaction.objectStore('backups').getAll();
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
        });
    }

    getProfile(): Promise<string | undefined> {
        return this.get<string>('activeProfile');
    }

    // Called with the origin-wide writer lock held, before the game reads localStorage.
    // The durable journal can replay a switch interrupted by quota failure or process exit.
    async selectProfile(id: string, primaryId: string, local: Storage = localStorage): Promise<void> {
        type Values = Record<string, string>;
        type Journal = { id: string; values: Values };
        const replace = (values: Values) => {
            const keys = Array.from({ length: local.length }, (_, index) => local.key(index));
            keys.filter((key) => key !== null).forEach((key) => local.removeItem(key));
            Object.entries(values).forEach(([key, value]) => local.setItem(key, value));
        };
        const finish = async (journal: Journal) => {
            replace(journal.values);
            await this.mutate(['kv'], (transaction) => {
                const store = transaction.objectStore('kv');
                store.put(journal.id, 'activeProfile');
                store.delete('profileJournal');
            });
        };
        const journal = await this.get<Journal>('profileJournal');
        if (journal) {
            await finish(journal);
        }
        const active = await this.getProfile() || primaryId;
        if (active === id) {
            await this.mutate(['kv'], (transaction) => transaction.objectStore('kv').put(id, 'activeProfile'));
            return;
        }
        const before: Values = {};
        for (let index = 0; index < local.length; index++) {
            const key = local.key(index);
            if (key !== null) {
                const value = local.getItem(key);
                if (value !== null) {
                    before[key] = value;
                }
            }
        }
        const next: Journal = { id, values: await this.get<Values>('profile:' + id) || {} };
        await this.mutate(['kv'], (transaction) => {
            const store = transaction.objectStore('kv');
            store.put(before, 'profile:' + active);
            store.put(next, 'profileJournal');
        });
        await finish(next);
    }
}


// Replay is idempotent: leave the journal in place until both local data and sync metadata are durable.
export async function recoverInstall(
    storage: CloudStorage,
    commitState: (journal: InstallJournal) => Promise<void>,
    local: Storage = localStorage,
): Promise<boolean> {
    const journal = await storage.getJournal();
    if (!journal) {
        return false;
    }
    const payload = rawPayload(journal.after);
    validatePayload(payload);
    if (journal.remote) {
        await validateRemote(journal.remote, journal.remote.envelope.slotId);
        if (await hashPayload(payload) !== journal.remote.envelope.payloadHash) {
            throw new Error('恢复数据与云端快照不一致，请保留备份并检查。');
        }
    }
    try {
        writeLocal(journal.key, journal.after, local);
    } catch (error) {
        // If rollback also fails, the durable before/after copies still allow recovery after space is freed.
        writeLocal(journal.key, journal.before, local);
        throw error;
    }
    await commitState(journal);
    await storage.clearJournal();
    return true;
}
