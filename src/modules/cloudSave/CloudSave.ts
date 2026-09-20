import CloudApi, { CloudApiError } from './api';
import { SyncEngine, decideStartup } from './SyncEngine';
import {
    CloudStorage, payloadRaw, rawPayload, readLocal, recoverInstall,
} from './storage';
import type { RawSave } from './storage';
import {
    compareVersions, isRecord, payloadVersion, SYNC_INTERVAL, validatePayload, validateRemote,
} from './protocol';
import type { RemoteSave, SavePayload } from './protocol';
import Notifier from '../notifications/Notifier';
import SaveSelector from '../SaveSelector';
import Settings from '../settings';

export default class CloudSave {
    private static storage: CloudStorage;
    private static api = new CloudApi();
    private static engine: SyncEngine;
    private static initialization: Promise<void>;
    private static writer = false;
    private static writerRequest: Promise<boolean>;
    private static activeKey: string | null = null;
    private static running = false;
    private static blocked = '';
    private static busy = false;
    private static gameVersion = '';
    private static serverSlot: string | null = null;
    private static lastAttempt = 0;
    private static retryAt = 0;
    private static failures = 0;
    private static captureQueue: Promise<void> = Promise.resolve();
    private static stopped = false;
    private static loginRequired = false;

    static initialize(version?: string): Promise<void> {
        if (version) {
            this.gameVersion = version;
        }
        if (!this.initialization) {
            this.initialization = this.setup();
        }
        return this.initialization;
    }

    private static async setup(): Promise<void> {
        document.querySelectorAll<HTMLButtonElement>('[data-cloud-action]').forEach((button) => {
            button.addEventListener('click', () => {
                void this.action(button.dataset.cloudAction);
            });
        });
        document.getElementById('cloud-save-auto')?.addEventListener('change', () => {
            void this.action('automatic');
        });
        try {
            this.storage = new CloudStorage();
            this.engine = new SyncEngine(this.storage, this.api, await this.storage.getState());
            const journal = await this.storage.getJournal();
            if (journal) {
                await this.requireWriter();
                await recoverInstall(this.storage, async (install) => {
                    if (install.remote) {
                        await this.engine.bind(install.key, install.remote.envelope.slotId, install.remote);
                    } else {
                        await this.engine.forget(install.key);
                    }
                });
                localStorage.removeItem('pcCloud:install');
                this.message('存档已恢复到本机。请在下面选择存档开始游戏。');
            } else {
                localStorage.removeItem('pcCloud:install');
                this.message('本地保存可正常使用。需要跨设备时，请先检查连接并上传存档。');
            }
            this.render();
            this.refreshLocalChoices();
            window.setInterval(() => {
                if (this.running && !this.stopped && !this.blocked && !this.busy && !this.loginRequired
                    && this.engine?.state.autoSync && !this.engine.state.hasConflict
                    && this.engine.state.localKey === this.activeKey
                    && Settings.getSetting('disableAutoSave').value === false
                    && Date.now() >= Math.max(this.lastAttempt + SYNC_INTERVAL, this.retryAt)) {
                    void this.action('sync');
                }
            }, 15000);
        } catch (error) {
            this.blockUploads(this.errorMessage(error));
        }
    }

    private static message(message: string): void {
        const element = document.getElementById('cloud-save-status');
        if (element) {
            element.textContent = message;
        }
    }

    private static errorMessage(error: unknown): string {
        return error instanceof Error ? error.message : '云同步失败，请先导出本地存档。';
    }

    private static render(): void {
        const state = this.engine?.state;
        const summary = document.getElementById('cloud-save-summary');
        if (summary) {
            summary.textContent = this.blocked ? '需要处理' : state?.hasConflict ? '进度冲突' : state?.localKey !== null && state?.localKey !== undefined ? '已关联' : '本地模式';
        }
        const pending = document.getElementById('cloud-save-pending');
        if (pending) {
            pending.textContent = state?.latest
                ? '本机最近保存：' + new Date(Number(state.latest.player._lastSeen) || Date.now()).toLocaleString()
                    + '。是否可以换设备，请以“同步后换设备”的结果为准。'
                : '';
        }
        const time = document.getElementById('cloud-save-time');
        if (time) {
            time.textContent = state?.base?.serverSavedAt ? new Date(state.base.serverSavedAt).toLocaleString() : '尚未同步';
        }
        const checkbox = document.getElementById('cloud-save-auto') as HTMLInputElement;
        if (checkbox) {
            checkbox.checked = state?.autoSync ?? false;
            checkbox.disabled = !state?.base || !!this.blocked || !!state?.hasConflict || this.loginRequired;
        }
        const logout = document.querySelector<HTMLButtonElement>('[data-cloud-action="logout"]');
        if (logout) {
            logout.disabled = this.busy || this.serverSlot === null;
        }
        const conflict = document.getElementById('cloud-save-conflict');
        if (conflict) {
            conflict.hidden = !state?.hasConflict;
        }
        const comparison = document.getElementById('cloud-save-comparison');
        if (comparison && state?.hasConflict) {
            const remote = state.remoteConflict;
            comparison.textContent = remote
                ? '云端：' + this.describe(remote.envelope.payload) + '；保存于 ' + new Date(remote.envelope.serverSavedAt).toLocaleString()
                    + '。本地：' + (state.latest ? this.describe(state.latest) : '尚未加载')
                : '云端存档已被删除或移走。本地进度已保留，请先确认仓库状态。';
        }
    }

    private static describe(payload: SavePayload): string {
        const profile = payload.save.profile;
        const statistics = payload.save.statistics;
        const name = isRecord(profile) && typeof profile.name === 'string' ? profile.name : 'Trainer';
        const seconds = isRecord(statistics) && typeof statistics.secondsPlayed === 'number' ? statistics.secondsPlayed : 0;
        return name + '，游戏时间 ' + Math.floor(seconds / 60) + ' 分钟，版本 ' + payloadVersion(payload);
    }

    private static refreshLocalChoices(): void {
        const select = document.getElementById('cloud-save-local') as HTMLSelectElement;
        if (!select) {
            return;
        }
        select.replaceChildren();
        Object.keys(localStorage).filter((key) => key.startsWith('save')).forEach((key) => {
            const localKey = key.slice(4);
            try {
                const payload = rawPayload(readLocal(localKey));
                if (payload) {
                    const option = document.createElement('option');
                    option.value = localKey;
                    option.textContent = this.describe(payload);
                    select.appendChild(option);
                }
            } catch {
                // A corrupt local save must remain available to the original recovery tools.
            }
        });
        const option = document.createElement('option');
        option.value = '__new__';
        option.textContent = '恢复云档时新建本地槽位';
        select.appendChild(option);
        if (this.activeKey !== null) {
            if (!Array.from(select.options).some((item) => item.value === this.activeKey)) {
                const active = document.createElement('option');
                active.value = this.activeKey;
                active.textContent = '当前正在游玩的存档';
                select.appendChild(active);
            }
            select.value = this.activeKey;
            select.disabled = true;
        } else if (this.engine && this.engine.state.localKey !== null) {
            select.value = this.engine.state.localKey;
            if (select.selectedIndex < 0) {
                select.value = '__new__';
            }
        }
    }

    private static selectedKey(allowNew = false): string {
        if (this.activeKey !== null) {
            return this.activeKey;
        }
        const select = document.getElementById('cloud-save-local') as HTMLSelectElement;
        if (select.value !== '__new__') {
            return select.value;
        }
        if (!allowNew) {
            throw new Error('请先选择或创建一个本地存档。');
        }
        if (Object.keys(localStorage).filter((key) => key.startsWith('save')).length >= SaveSelector.MAX_SAVES) {
            throw new Error('本地已有 9 个存档，请先备份并腾出一个槽位。');
        }
        return crypto.randomUUID();
    }

    private static async requireWriter(): Promise<void> {
        const alreadyHeld = this.writer;
        if (!navigator.locks) {
            throw new Error('此浏览器不支持安全的多标签协调，请使用新版 Chrome、Edge、Firefox 或 Safari 进行云同步。');
        }
        if (!this.writerRequest) {
            this.writerRequest = new Promise((resolve, reject) => {
                void navigator.locks.request('pokeclicker-writer', { ifAvailable: true }, (lock) => {
                    if (!lock) {
                        resolve(false);
                        return undefined;
                    }
                    this.writer = true;
                    resolve(true);
                    // Keep the origin-wide writer lock until this page is unloaded.
                    return new Promise<void>(() => {});
                }).catch(reject);
            });
        }
        if (!await this.writerRequest) {
            this.writerRequest = null;
            throw new Error('游戏已在另一个标签页打开。请先关闭那个标签，再重试。');
        }
        if (!alreadyHeld && this.engine) {
            this.engine = new SyncEngine(this.storage, this.api, await this.storage.getState());
        }
    }

    static async prepareStart(key: string, version: string): Promise<boolean> {
        if (this.busy) {
            this.message('请先完成当前云存档操作。');
            return false;
        }
        this.busy = true;
        try {
            return await this.prepare(key, version);
        } catch (error) {
            this.reportError(this.errorMessage(error));
            return false;
        } finally {
            this.busy = false;
        }
    }

    private static async prepare(key: string, version: string): Promise<boolean> {
        await this.initialize();
        if (!this.engine && !localStorage.getItem('pcCloud:install')) {
            if (navigator.locks) {
                await this.requireWriter();
            }
            this.activeKey = key;
            return true;
        }
        if (this.blocked) {
            throw new Error(this.blocked);
        }
        this.gameVersion = version;
        if (navigator.locks) {
            await this.requireWriter();
            this.engine = new SyncEngine(this.storage, this.api, await this.storage.getState());
        } else if (this.engine.state.localKey === key) {
            throw new Error('当前浏览器不支持云存档锁，请换用新版浏览器。');
        }
        if (this.engine.state.localKey !== key) {
            this.activeKey = key;
            return true;
        }
        try {
            await this.connection();
            const local = rawPayload(readLocal(key));
            const remote = await this.api.read(this.engine.state.slotId);
            const decision = await decideStartup(this.engine.state, local, remote);
            await this.engine.acknowledgePending(remote);
            if (decision === 'remote') {
                if (compareVersions(remote.envelope.gameVersion, version) > 0) {
                    throw new Error('云存档来自更新版本，请先更新游戏。');
                }
                await this.stage(key, remote.envelope.payload, remote);
                return false;
            }
            if (decision === 'conflict' || this.engine.state.hasConflict) {
                if (local) {
                    await this.engine.capture(local);
                }
                await this.engine.conflict(remote);
                this.render();
                (document.getElementById('cloud-save-panel') as HTMLDetailsElement).open = true;
                this.message('本地与云端均有不同进度。请先选择使用哪一份，再开始游戏。');
                return false;
            }
        } catch (error) {
            if (error instanceof CloudApiError && error.code === 'LOGIN_REQUIRED') {
                this.loginRequired = true;
                this.render();
            }
            this.message(this.errorMessage(error));
            const proceed = await Notifier.confirm({
                title: '暂时无法确认云存档',
                message: '云同步未完成。继续只使用本地进度吗？之后同步仍会检查是否冲突。',
                confirm: '继续本地游戏', cancel: '返回选档',
            });
            if (!proceed) {
                return false;
            }
        }
        this.activeKey = key;
        return true;
    }

    static started(): void {
        this.running = true;
        if (!this.blocked) {
            this.message('游戏已启动，本地保存继续生效。换设备前请同步并等待成功。');
        }
        this.refreshLocalChoices();
        this.render();
    }

    static reportError(message: string): void {
        this.message(message);
        const panel = document.getElementById('cloud-save-panel') as HTMLDetailsElement;
        if (panel) {
            panel.open = true;
        }
    }

    static blockUploads(message: string): void {
        this.blocked = message;
        this.message(message + ' 云同步已停止，请先导出本地备份。');
        const panel = document.getElementById('cloud-save-panel') as HTMLDetailsElement;
        if (panel) {
            panel.open = true;
        }
        this.render();
    }

    static afterLocalSave(key: string, raw: RawSave): void {
        if (!this.running || this.blocked || !this.engine || this.engine.state.localKey !== key) {
            return;
        }
        const snapshot = raw.slice() as RawSave;
        this.captureQueue = this.captureQueue.then(async () => {
            const payload = rawPayload(snapshot);
            validatePayload(payload);
            await this.engine.capture(payload);
            this.render();
        }).catch((error) => this.blockUploads(this.errorMessage(error)));
    }

    static canSave(): boolean {
        return !this.stopped;
    }

    private static async connection(): Promise<string> {
        const slot = await this.api.status();
        if (this.engine.state.slotId && this.engine.state.slotId !== slot) {
            throw new Error('服务器云槽位与本机已关联槽位不同，请检查配置，不要覆盖存档。');
        }
        this.serverSlot = slot;
        this.loginRequired = false;
        return slot;
    }

    private static async current(key: string): Promise<SavePayload> {
        if (this.running && key === this.activeKey && !this.stopped) {
            player._lastSeen = Date.now();
            Save.store(player);
        }
        await this.captureQueue;
        const payload = rawPayload(readLocal(key));
        validatePayload(payload);
        return payload;
    }

    private static async stage(key: string, payload: SavePayload, remote: RemoteSave | null): Promise<void> {
        validatePayload(payload);
        if (this.gameVersion && compareVersions(payloadVersion(payload), this.gameVersion) > 0) {
            throw new Error('此存档来自更新版本，请更新游戏后再导入。');
        }
        await this.engine.wait();
        localStorage.setItem('pcCloud:install', key);
        try {
            await this.storage.stageInstall({ key, before: readLocal(key), after: payloadRaw(payload), remote });
        } catch (error) {
            localStorage.removeItem('pcCloud:install');
            throw error;
        }
        this.stopped = true;
        window.onbeforeunload = () => {};
        location.reload();
    }

    private static async upload(key: string, switchDevice: boolean): Promise<void> {
        if (this.blocked) {
            throw new Error(this.blocked);
        }
        if (Date.now() < this.retryAt) {
            throw new Error('服务要求稍后重试，请等待 ' + Math.ceil((this.retryAt - Date.now()) / 1000) + ' 秒。');
        }
        await this.connection();
        const payload = await this.current(key);
        if (this.engine.state.localKey !== key) {
            const accepted = await Notifier.confirm({
                title: '关联云存档', message: '将选中的本地存档关联到你的云槽位。已有云档时会先显示冲突，不会直接覆盖。',
                confirm: '关联此存档', cancel: '取消',
            });
            if (!accepted) {
                return;
            }
            const remote = await this.api.read(this.serverSlot);
            await this.engine.bind(key, this.serverSlot, null);
            await this.engine.capture(payload);
            if (remote) {
                await this.engine.conflict(remote);
                return;
            }
        } else {
            await this.engine.capture(payload);
        }
        if (switchDevice && this.running && !this.stopped) {
            player._lastSeen = Date.now();
            Save.store(player);
            this.stopped = true;
            App.game.stop();
            await this.captureQueue;
        }
        this.lastAttempt = Date.now();
        this.message('正在同步，请等待云端确认。');
        await this.engine.sync(this.gameVersion + '-cloud-save-1');
        // A previous uncertain request may have been acknowledged; flush the newest snapshot separately.
        const remaining = await this.engine.dirty();
        this.failures = 0;
        this.retryAt = 0;
        this.message(remaining
            ? '上一份快照已确认，但仍有更新的本地进度。请 15 秒后再点一次同步，暂不要换设备。'
            : switchDevice ? '同步成功，可以关闭此页面并换设备。当前游戏已暂停；继续游玩请刷新页面。' : '云端已确认保存。');
    }

    private static async logout(): Promise<void> {
        if (this.serverSlot === null) {
            throw new Error('请先检查连接，确认当前地址已启用云存档。');
        }
        if (!await Notifier.confirm({
            title: '退出游戏登录',
            message: '退出只保存当前设备的本地进度，不会上传云端，并会关闭自动同步。若要换设备，请取消后先点“同步后换设备”。确定退出吗？',
            confirm: '保存本地并退出', cancel: '取消',
        })) {
            return;
        }
        await this.engine.setAutomatic(false);
        if (this.running && this.activeKey !== null) {
            await this.current(this.activeKey);
        }
        if (this.blocked) {
            throw new Error('本地备份尚未完成，已保留当前页面。请先导出本地存档，再处理退出登录。');
        }
        this.message('本地进度已保存，正在退出登录；这次操作不会上传云端。');
        await this.api.logout();
        // Keep playing on network failure; only pause after the server confirms logout.
        if (this.running && !this.stopped) {
            player._lastSeen = Date.now();
            Save.store(player);
            this.stopped = true;
            App.game.stop();
            await this.captureQueue;
        }
        if (this.blocked) {
            throw new Error('登录已退出，但本地备份未完成。请保留本页并导出本地存档。');
        }
        window.onbeforeunload = () => {};
        location.assign('/login');
    }

    private static async restore(useConflict: boolean): Promise<void> {
        const remote = useConflict ? this.engine.state.remoteConflict : await this.api.read(await this.connection());
        if (!remote) {
            throw new Error('云端还没有存档，请先在有进度的设备上传。');
        }
        const key = useConflict ? this.conflictKey() : this.selectedKey(true);
        if (!await Notifier.confirm({
            title: '恢复云存档', message: '将保存本地恢复副本，再加载这份云档并刷新页面。游戏内的离线收益会在启动时计算。',
            confirm: '备份并恢复', cancel: '取消',
        })) {
            return;
        }
        await this.currentIfRunning(key);
        await this.storage.backup(readLocal(key), remote, 'before-restore');
        await this.stage(key, remote.envelope.payload, remote);
    }

    private static async currentIfRunning(key: string): Promise<void> {
        if (this.running && key === this.activeKey) {
            await this.current(key);
        }
    }

    private static conflictKey(): string {
        const key = this.engine.state.localKey;
        if (key === null || (this.activeKey !== null && this.activeKey !== key)) {
            throw new Error('请刷新页面，选择发生冲突的本地存档后再处理。');
        }
        return key;
    }

    private static async overwrite(): Promise<void> {
        const key = this.conflictKey();
        const remote = this.engine.state.remoteConflict;
        if (!await Notifier.confirm({
            title: '用本地进度覆盖云端', message: '将先备份两份数据，再提交本地进度。若其他设备再次更新，仍会阻止覆盖。',
            confirm: '备份并覆盖', cancel: '取消',
        })) {
            return;
        }
        const payload = await this.current(key);
        await this.storage.backup(readLocal(key), remote, 'resolve-conflict');
        await this.engine.bind(key, await this.connection(), remote);
        await this.engine.capture(payload);
        await this.upload(key, false);
    }

    private static downloadJson(value: unknown, name: string): void {
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    private static async action(action: string): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            await this.initialize();
            if (action === 'export') {
                const payload = await this.current(this.selectedKey());
                await SaveSelector.downloadSaveData(payload, payloadVersion(payload));
                return;
            }
            if (!this.engine) {
                throw new Error('本地备份空间不可用，请先导出原版存档。');
            }
            if (action === 'check') {
                await this.connection();
                this.message('连接成功，可以上传本地进度或下载云档。');
            } else if (action === 'backups') {
                this.downloadJson(await this.storage.allBackups(), 'pokeclicker-recovery-backups.json');
            } else {
                await this.requireWriter();
                if (action === 'logout') {
                    await this.logout();
                } else if (action === 'automatic') {
                    if (this.selectedKey() !== this.engine.state.localKey) {
                        throw new Error('请先选择已关联的本地存档。');
                    }
                    await this.engine.setAutomatic((document.getElementById('cloud-save-auto') as HTMLInputElement).checked);
                } else if (action === 'restore' || action === 'remote') {
                    await this.restore(action === 'remote');
                } else if (action === 'local') {
                    await this.overwrite();
                } else {
                    await this.upload(this.selectedKey(), action === 'switch');
                }
            }
        } catch (error) {
            if (error instanceof CloudApiError && error.code === 'LOGIN_REQUIRED') {
                this.loginRequired = true;
            }
            if (error instanceof CloudApiError && (error.status === 429 || error.status === 0 || error.status >= 500)) {
                this.failures++;
                this.retryAt = Date.now() + Math.max(error.retryAfter * 1000, Math.min(600000, 30000 * 2 ** Math.min(this.failures, 5)));
            }
            this.message(this.errorMessage(error) + (this.stopped
                ? action === 'logout' ? ' 当前游戏已暂停，保留本页并导出本地备份后再处理退出。' : ' 当前游戏已暂停，重试同步成功后再换设备。'
                : ' 本地进度不会被云端覆盖。'));
        } finally {
            this.busy = false;
            this.render();
        }
    }

    static async importFile(file: File): Promise<void> {
        if (this.busy) {
            throw new Error('请先完成当前云存档操作，再导入文件。');
        }
        this.busy = true;
        try {
            await this.importData(file, Save.key);
        } finally {
            this.busy = false;
        }
    }

    private static async importData(file: File, key: string): Promise<void> {
        await this.initialize();
        await this.requireWriter();
        if (file.size > 10 * 1024 * 1024) {
            throw new Error('文件过大，请选择游戏导出的存档。');
        }
        const text = await file.text();
        let decoded: unknown;
        try {
            decoded = JSON.parse(text);
        } catch {
            decoded = JSON.parse(SaveSelector.atob(text.trim()));
        }
        const remote: RemoteSave | null = null;
        if (isRecord(decoded) && decoded.schemaVersion === 1) {
            // Historical JSON is imported as local data; it must not inherit an obsolete remote SHA.
            decoded = (await validateRemote({ blobSha: '0'.repeat(40), envelope: decoded }, String(decoded.slotId))).envelope.payload;
        }
        if (isRecord(decoded) && isRecord(decoded.player) && isRecord(decoded.save)) {
            if (!isRecord(decoded.settings)) {
                decoded.settings = {};
            }
            if (!isRecord(decoded.save.update)) {
                decoded.save.update = { version: '0.0.0' };
            }
        }
        validatePayload(decoded);
        await this.currentIfRunning(key);
        await this.stage(key, decoded, remote);
    }

    static async beforeDelete(key: string): Promise<void> {
        if (this.busy) {
            throw new Error('请先完成当前云存档操作，再删除本地存档。');
        }
        this.busy = true;
        try {
            await this.initialize();
            await this.requireWriter();
            await this.currentIfRunning(key);
            await this.storage.backup(readLocal(key), null, 'before-delete');
            await this.engine.forget(key);
            if (this.running) {
                this.stopped = true;
                App.game.stop();
            }
        } finally {
            this.busy = false;
        }
    }
}
