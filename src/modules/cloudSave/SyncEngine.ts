import { CloudApiError } from './api';
import type { SaveApi } from './api';
import { hashPayload, validatePayload } from './protocol';
import type { RemoteSave, SavePayload } from './protocol';
import type { StateStorage, SyncBase, SyncState } from './storage';

export function remoteBase(remote: RemoteSave): SyncBase {
    return {
        blobSha: remote.blobSha, revision: remote.envelope.revision,
        payloadHash: remote.envelope.payloadHash, serverSavedAt: remote.envelope.serverSavedAt,
    };
}

export type StartupDecision = 'local' | 'remote' | 'conflict';
export async function decideStartup(state: SyncState, local: SavePayload | null, remote: RemoteSave | null): Promise<StartupDecision> {
    if (!local) {
        return remote ? 'remote' : 'local';
    }
    const hash = await hashPayload(local);
    if (state.pending && remote?.envelope.snapshotId === state.pending.snapshotId
        && remote.envelope.payloadHash === await hashPayload(state.pending.payload)) {
        return 'local';
    }
    if ((remote?.blobSha ?? null) === (state.base?.blobSha ?? null)) {
        return 'local';
    }
    if (state.base && hash === state.base.payloadHash && remote) {
        return 'remote';
    }
    return 'conflict';
}

export class SyncEngine {
    state: SyncState;
    private persistence: Promise<void> = Promise.resolve();
    private uploadJob: Promise<void> | null = null;

    constructor(private storage: StateStorage, private api: SaveApi, state: SyncState) {
        this.state = state;
    }

    private persist(): Promise<void> {
        const snapshot = JSON.parse(JSON.stringify(this.state)) as SyncState;
        this.persistence = this.persistence.catch(() => {}).then(() => this.storage.saveState(snapshot));
        return this.persistence;
    }

    async capture(payload: SavePayload): Promise<void> {
        validatePayload(payload);
        this.state.latest = payload;
        await this.persist();
    }

    async bind(key: string, slot: string, remote: RemoteSave | null): Promise<void> {
        this.state.localKey = key;
        this.state.autoSync = false;
        this.state.slotId = slot;
        this.state.base = remote ? remoteBase(remote) : null;
        this.state.pending = null;
        this.state.hasConflict = false;
        this.state.remoteConflict = null;
        this.state.latest = remote?.envelope.payload ?? null;
        await this.persist();
    }

    async setAutomatic(enabled: boolean): Promise<void> {
        this.state.autoSync = enabled;
        await this.persist();
    }

    async conflict(remote: RemoteSave | null): Promise<void> {
        this.state.hasConflict = true;
        this.state.remoteConflict = remote;
        this.state.autoSync = false;
        await this.persist();
    }

    async forget(key: string): Promise<void> {
        await this.wait();
        if (this.state.localKey === key) {
            this.state.localKey = null;
            this.state.slotId = null;
            this.state.base = null;
            this.state.latest = null;
            this.state.pending = null;
            this.state.hasConflict = false;
            this.state.remoteConflict = null;
            this.state.autoSync = false;
            await this.persist();
        }
    }

    async acknowledgePending(remote: RemoteSave | null): Promise<void> {
        const pending = this.state.pending;
        if (pending && remote?.envelope.snapshotId === pending.snapshotId
            && remote.envelope.payloadHash === await hashPayload(pending.payload)) {
            this.state.base = remoteBase(remote);
            this.state.pending = null;
            await this.persist();
        }
    }

    async dirty(): Promise<boolean> {
        return !!this.state.latest && await hashPayload(this.state.latest) !== this.state.base?.payloadHash;
    }

    sync(clientBuild: string): Promise<void> {
        if (!this.uploadJob) {
            this.uploadJob = this.upload(clientBuild).finally(() => { this.uploadJob = null; });
        }
        return this.uploadJob;
    }

    async wait(): Promise<void> {
        await this.uploadJob?.catch(() => {});
        await this.persistence;
    }

    private async upload(clientBuild: string): Promise<void> {
        if (!this.state.slotId || !this.state.latest) {
            throw new Error('请先关联当前存档。');
        }
        if (this.state.hasConflict) {
            throw new Error('请先处理云存档冲突。');
        }
        if (!this.state.pending) {
            if (!await this.dirty()) {
                return;
            }
            this.state.pending = {
                baseBlobSha: this.state.base?.blobSha ?? null,
                baseRevision: this.state.base?.revision ?? 0,
                snapshotId: crypto.randomUUID(), deviceId: this.state.deviceId,
                clientSavedAt: new Date().toISOString(), clientBuild,
                payload: JSON.parse(JSON.stringify(this.state.latest)),
            };
        }
        // Persist the exact request BEFORE sending. A retry must not get a new snapshot ID.
        await this.persist();
        const pending = this.state.pending;
        try {
            const remote = await this.api.upload(this.state.slotId, pending);
            if (remote.envelope.payloadHash !== await hashPayload(pending.payload)) {
                throw new Error('云端回执与上传快照不一致。');
            }
            this.state.base = remoteBase(remote);
            this.state.pending = null;
            // latest may have advanced while the network request was in flight.
            await this.persist();
        } catch (error) {
            if (error instanceof CloudApiError && error.status === 409) {
                await this.conflict(error.remote);
            }
            throw error;
        }
    }
}
