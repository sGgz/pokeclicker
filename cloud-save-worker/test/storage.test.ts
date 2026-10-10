import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { CloudStorage, emptyState, payloadRaw, readLocal, recoverInstall, type RawSave } from '../../src/modules/cloudSave/storage';
import type { SavePayload } from '../../src/modules/cloudSave/protocol';

const payload = (money: number): SavePayload => ({
    player: { _lastSeen: 100 }, save: { update: { version: '0.10.26' }, money }, settings: {},
});
function browserStorage() {
    const values = new Map<string, string>();
    let writes = 0;
    return {
        failAt: 0,
        get length() { return values.size; },
        clear() { values.clear(); },
        key(index: number) { return [...values.keys()][index] ?? null; },
        getItem(key: string) { return values.get(key) ?? null; },
        removeItem(key: string) { values.delete(key); },
        setItem(key: string, value: string) {
            writes++;
            if (writes === this.failAt) throw new DOMException('quota', 'QuotaExceededError');
            values.set(key, value);
        },
    };
}
function fixture() {
    globalThis.indexedDB = new IDBFactory();
    return new CloudStorage();
}

test('installation survives reload between local data replacement and sync metadata commit', async () => {
    const storage = fixture();
    const local = browserStorage();
    const before = payloadRaw(payload(1));
    const after = payloadRaw(payload(2));
    await storage.stageInstall({ key: '', before, after, remote: null });
    await assert.rejects(recoverInstall(storage, async () => { throw new Error('interrupted'); }, local), /interrupted/);
    assert.deepEqual(readLocal('', local), after);
    assert.ok(await storage.getJournal());
    const reloaded = new CloudStorage();
    await recoverInstall(reloaded, async () => reloaded.saveState(emptyState()), local);
    assert.deepEqual(readLocal('', local), after);
    assert.equal(await reloaded.getJournal(), undefined);
    const backups = await reloaded.allBackups() as Array<{ local: RawSave }>;
    assert.deepEqual(backups[0].local, before);
    assert.equal(await recoverInstall(reloaded, async () => {}, local), false);
});

test('quota failure on the second key rolls back all keys and keeps the recovery journal', async () => {
    const storage = fixture();
    const local = browserStorage();
    const before = payloadRaw(payload(1));
    ['player', 'save', 'settings'].forEach((key, index) => local.setItem(key, before[index]!));
    local.failAt = 5;
    await storage.stageInstall({ key: '', before, after: payloadRaw(payload(2)), remote: null });
    await assert.rejects(recoverInstall(storage, async () => {}, local), /quota/);
    assert.deepEqual(readLocal('', local), before);
    assert.ok(await storage.getJournal());
    await recoverInstall(storage, async () => {}, local);
    assert.deepEqual(readLocal('', local), payloadRaw(payload(2)));
});

test('IndexedDB abort keeps backup and install journal atomic', async () => {
    const storage = fixture();
    const corrupt = { key: '', before: payloadRaw(payload(1)), after: payloadRaw(payload(2)), remote: null, invalid: () => {} };
    await assert.rejects(storage.stageInstall(corrupt));
    assert.equal(await storage.getJournal(), undefined);
    assert.deepEqual(await storage.allBackups(), []);
});

test('malformed recovery data never replaces local data', async () => {
    const storage = fixture();
    const local = browserStorage();
    local.setItem('save', 'original');
    await storage.stageInstall({ key: '', before: [null, 'original', null], after: ['{}', '{}', '{}'], remote: null });
    await assert.rejects(recoverInstall(storage, async () => {}, local));
    assert.equal(local.getItem('save'), 'original');
    assert.ok(await storage.getJournal());
});

test('switching players preserves every local slot and settings, and a new player starts empty', async () => {
    const profiles = fixture();
    const local = browserStorage();
    local.setItem('save', 'original');
    local.setItem('save2', 'second-slot');
    local.setItem('settings', 'original-settings');
    await profiles.selectProfile('friend', 'player', local);
    assert.equal(local.length, 0);
    assert.equal(await profiles.getProfile(), 'friend');
    local.setItem('save', 'friends-save');
    local.setItem('settings', 'friends-settings');
    await profiles.selectProfile('player', 'player', local);
    assert.equal(local.getItem('save'), 'original');
    assert.equal(local.getItem('save2'), 'second-slot');
    assert.equal(local.getItem('settings'), 'original-settings');
    await profiles.selectProfile('friend', 'player', local);
    assert.equal(local.getItem('save'), 'friends-save');
    assert.equal(local.getItem('save2'), null);
    assert.equal(local.getItem('settings'), 'friends-settings');
});

test('interrupted player switch replays the journal without adopting partial data', async () => {
    const profiles = fixture();
    const local = browserStorage();
    local.setItem('save', 'mine');
    await profiles.selectProfile('friend', 'player', local);
    local.setItem('save', 'theirs');
    local.setItem('settings', 'their-settings');
    await profiles.selectProfile('player', 'player', local);
    local.failAt = 5;
    await assert.rejects(profiles.selectProfile('friend', 'player', local), /quota/);
    assert.equal(await profiles.getProfile(), 'player');
    await new CloudStorage().selectProfile('friend', 'player', local);
    assert.equal(local.getItem('save'), 'theirs');
    assert.equal(local.getItem('settings'), 'their-settings');
    await profiles.selectProfile('player', 'player', local);
    assert.equal(local.getItem('save'), 'mine');
});

test('sync state, pending uploads, backups and installation journals are isolated by player', async () => {
    const mine = fixture();
    const theirs = new CloudStorage('friend');
    const state = emptyState();
    state.autoSync = true;
    state.localKey = 'mine';
    await mine.saveState(state);
    await mine.stageInstall({ key: '', before: payloadRaw(payload(1)), after: payloadRaw(payload(2)), remote: null });
    assert.equal((await theirs.getState()).autoSync, false);
    assert.equal((await theirs.getState()).localKey, null);
    assert.equal(await theirs.getJournal(), undefined);
    assert.deepEqual(await theirs.allBackups(), []);
    assert.equal((await mine.getState()).localKey, 'mine');
    assert.ok(await mine.getJournal());
});
