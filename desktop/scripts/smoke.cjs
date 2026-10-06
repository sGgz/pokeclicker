// Real Electron + real Worker handler; only GitHub persistence and network destination are test doubles.
// The debugger replaces fetch in the test process. Production builds contain no test endpoint or auth bypass.
const { _electron: electron, chromium } = require('playwright');
const { buildSync } = require('../../cloud-save-worker/node_modules/esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { once } = require('node:events');

async function run() {
    const root = path.resolve(__dirname, '../..');
    const output = path.join(root, 'output/playwright/desktop');
    await fs.mkdir(output, { recursive: true });
    await fs.mkdir(path.join(root, 'output/desktop-tests'), { recursive: true });
    const work = await fs.mkdtemp(path.join(root, 'output/desktop-tests/run-'));
    const bundle = path.join(work, 'worker.cjs');
    buildSync({ entryPoints: [path.join(root, 'cloud-save-worker/src/index.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const { createHandler } = require(bundle);
    const origin = 'https://play.ggzz.fun';
    const password = randomBytes(24).toString('base64url');
    const slot = randomUUID();
    let clock = Date.now();
    let remote = null;
    let online = true;
    let writes = 0;
    const requests = [];
    const fixture = {
        ALLOWED_ORIGIN: origin,
        GAME_AUTH: JSON.stringify({ version: 1, passwordHash: createHash('sha256').update(password).digest('hex'), sessionKey: randomBytes(32).toString('base64url') }),
        GITHUB_OWNER: 'test-owner', GITHUB_SAVE_REPO: 'test-saves', GITHUB_SAVE_BRANCH: 'main', GITHUB_SAVE_TOKEN: 'test-only', CLOUD_SLOT_ID: slot,
        LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) }, LOGIN_GLOBAL_LIMITER: { limit: async () => ({ success: true }) },
        ASSETS: { fetch: async request => {
            const url = new URL(request.url);
            const file = path.resolve(root, 'docs', '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
            if (!file.startsWith(path.join(root, 'docs') + path.sep)) return new Response(null, { status: 404 });
            try {
                const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
                return new Response(await fs.readFile(file), { headers: { 'Content-Type': type } });
            } catch { return new Response(null, { status: 404 }); }
        } },
    };
    const handler = createHandler({ now: () => clock, store: () => ({
        assertAvailable: async () => {}, read: async () => structuredClone(remote),
        write: async (envelope, base) => {
            assert.equal(base, remote?.blobSha ?? null);
            const blobSha = createHash('sha1').update(JSON.stringify(envelope)).digest('hex');
            const commitSha = createHash('sha1').update(blobSha).digest('hex');
            remote = { envelope: structuredClone(envelope), blobSha, commitSha }; writes++;
            return { blobSha, commitSha };
        },
    }) });
    let serverOrigin;
    const server = createServer(async (incoming, outgoing) => {
        if (!online) { incoming.socket.destroy(); return; }
        try {
            const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
            const headers = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            if (headers.get('origin') === serverOrigin) headers.set('origin', origin);
            const body = Buffer.concat(chunks);
            const response = await handler(new Request(origin + incoming.url, { method: incoming.method, headers, ...(body.length ? { body } : {}) }), fixture);
            requests.push({ method: incoming.method, path: incoming.url, status: response.status });
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch { outgoing.writeHead(500); outgoing.end('Test fixture error'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    serverOrigin = 'http://localhost:' + server.address().port;
    const dev = process.argv.includes('--dev');
    const executableArgument = process.argv.find(value => value.startsWith('--exe='));
    const executable = executableArgument ? executableArgument.slice(6) : path.join(root, dev ? 'desktop/node_modules/electron/dist/electron.exe' : 'output/desktop/win-unpacked/PokeclickerCloud.exe');
    const profiles = [path.join(work, 'device-a'), path.join(work, 'device-b')];
    const running = new Set();
    const checks = [];
    const errors = [];
    let browser;
    let lastPage;
    async function launch(profile) {
        const env = { ...process.env, TEMP: work, TMP: work }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
        const app = await electron.launch({ executablePath: executable, args: [...(dev ? [path.join(root, 'desktop')] : []), '--data-dir=' + profile], env, timeout: 60000 });
        running.add(app);
        app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
        const page = await app.firstWindow(); lastPage = page;
        page.on('pageerror', error => errors.push(error.message));
        await page.locator('#cloud-save-panel').waitFor({ timeout: 60000 });
        await app.evaluate((_electron, destination) => {
            const original = globalThis.fetch;
            globalThis.fetch = (input, init) => {
                const url = new URL(String(input));
                if (url.origin !== 'https://play.ggzz.fun') throw new Error('Unexpected outbound network');
                return original(destination + url.pathname + url.search, init);
            };
        }, serverOrigin);
        assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
        return { app, page };
    }
    async function status(page, text) {
        await page.waitForFunction(value => document.getElementById('cloud-save-status')?.textContent?.includes(value), text, { timeout: 30000 });
    }
    async function panel(page) {
        await page.locator('#cloud-save-panel').evaluate(el => { el.open = true; });
    }
    async function login(app, page, useMenu = false) {
        const pending = app.waitForEvent('window');
        if (useMenu) await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
        else { await panel(page); await page.getByRole('button', { name: '登录云存档', exact: true }).click(); }
        const loginPage = await pending;
        await loginPage.getByLabel('游戏专用密码').fill(password);
        await loginPage.getByRole('button', { name: '登录云存档', exact: true }).click();
        await loginPage.getByRole('button', { name: '返回游戏', exact: true }).waitFor();
        await loginPage.screenshot({ path: path.join(output, 'login-success.png') });
        await loginPage.getByRole('button', { name: '返回游戏', exact: true }).click();
        await status(page, '登录成功');
    }
    async function quit(app) {
        const exited = once(app.process(), 'exit');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'pokeclicker://game/').close());
        await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Graceful close timed out')), 25000); timer.unref(); })]);
        running.delete(app);
    }
    try {
        online = false;
        let { app: a, page: pageA } = await launch(profiles[0]);
        assert.deepEqual(await pageA.evaluate(() => ({ secure: isSecureContext, locks: !!navigator.locks, idb: !!indexedDB, bridge: window.pokeclickerDesktop?.version, node: typeof require })),
            { secure: true, locks: true, idb: true, bridge: 1, node: 'undefined' });
        assert.ok(await pageA.locator('#theme-link').evaluate(el => el.href.startsWith('pokeclicker://game/vendor/themes/')));
        await pageA.getByText('New Save', { exact: true }).click();
        await pageA.waitForFunction(() => typeof App !== 'undefined' && App.game?.statistics?.secondsPlayed && CloudSave.running);
        await pageA.locator('#startSequenceModal').getByRole('button', { name: 'Next', exact: true }).click();
        await pageA.locator('#pickStarterTutorialModal input.image-starter').first().click();
        // Hide the tutorial tooltip only in this disposable test profile.
        await pageA.evaluate(() => { Information.hide(); App.game.profile.name('Desktop fixture A'); Save.store(player); });
        await pageA.locator('#routeBattleContainer > .clickable').click({ clickCount: 10, delay: 100 });
        await pageA.locator('#starterCaughtModal').getByRole('button', { name: 'Next', exact: true }).click();
        await pageA.locator('#starterCaughtModal').waitFor({ state: 'hidden' });
        await pageA.evaluate(() => Information.hide());
        // Exercise the actual Knockout controls and game objects in this isolated save.
        await pageA.evaluate(() => new Promise(resolve => $('#settingsModal').one('shown.bs.modal', () => resolve()).modal('show')));
        await pageA.locator('#settingsModal a[href="#settings-game"]').click();
        await pageA.locator('select[name="ggzz.private.guidePathfinding"]').selectOption('optimized');
        await pageA.locator('select[name="ggzz.private.pricingMode"]').selectOption('base-price');
        assert.equal(await pageA.evaluate(() => PrivateGameplay.optimizedPathfinding()), true);
        assert.equal(await pageA.evaluate(() => PrivateGameplay.fixedItemPrices()), true);
        assert.equal(await pageA.evaluate(() => PrivateGameplay.guideFeeRate()), 0.01);
        await pageA.locator('#private-guide-fee').selectOption({ label: '官方原价' });
        assert.equal(await pageA.evaluate(() => PrivateGameplay.guideFeeRate()), 1);
        await pageA.locator('#private-guide-fee').selectOption({ label: '原价的 1%（门票原价）' });
        assert.equal(await pageA.evaluate(() => PrivateGameplay.guideFeeRate()), 0.01);
        await pageA.screenshot({ path: path.join(output, 'private-gameplay-settings.png') });
        await pageA.evaluate(() => new Promise(resolve => $('#settingsModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        const purchase = await pageA.evaluate(() => {
            const vitamin = ItemList.Protein;
            player.itemMultipliers[vitamin.saveName] = 8;
            vitamin.price(vitamin.basePrice * 8);
            App.game.wallet.currencies[vitamin.currency](vitamin.basePrice * 100);
            const beforeMoney = App.game.wallet.currencies[vitamin.currency]();
            const beforeItems = player.amountOfItem(vitamin.name);
            vitamin.buy(2);
            const result = {
                spent: beforeMoney - App.game.wallet.currencies[vitamin.currency](),
                expected: Math.round(vitamin.basePrice * 2),
                gained: player.amountOfItem(vitamin.name) - beforeItems,
                multiplier: player.itemMultipliers[vitamin.saveName],
                refundProtected: PrivateGameplay.fixedVitaminsPurchased(),
            };
            Save.store(player);
            return result;
        });
        assert.equal(purchase.spent, purchase.expected);
        assert.equal(purchase.gained, 2);
        assert.equal(purchase.multiplier, 8);
        assert.equal(purchase.refundProtected, true);
        checks.push('Private gameplay controls work in the real renderer: optimized paths, fixed-price purchase, frozen old multiplier, vitamin history and 1% guide fee.');
        // Exercise the extended progression and slot migration using this disposable save only.
        const progression = await pageA.evaluate(() => {
            const magic = App.game.oakItems.itemList[0];
            magic.fromJSON({ level: 6, exp: 110000, isActive: true });
            App.game.wallet.currencies[GameConstants.Currency.money](10000000);
            magic.use();
            const before = magic.toJSON();
            while (magic.canBuy()) magic.buy();
            magic.use();
            const helmet = App.game.oakItems.itemList[2];
            helmet.fromJSON({ level: 15, exp: 2270000, isActive: true });
            const oldHelmet = helmet.calculateBonus();
            helmet.use(750000);
            helmet.buy();
            return { before, magic: magic.toJSON(), oldHelmet, helmetLevel: helmet.level, helmetBonus: helmet.calculateBonus(), helmetCap: helmet.maxLevel };
        });
        assert.deepEqual(progression.before, { level: 6, exp: 110000, isActive: true });
        assert.deepEqual(progression.magic, { level: 10, exp: 110000, isActive: true });
        assert.equal(progression.oldHelmet, 2.75);
        assert.equal(progression.helmetLevel, 16);
        assert.equal(progression.helmetBonus, 2.95);
        assert.equal(progression.helmetCap, 30);
        checks.push('Magic Ball retains old excess XP through manual upgrades; an old level-15 Rocky Helmet continues to level 16 under the new level-30 cap.');

        await pageA.evaluate(() => new Promise(resolve => $('#settingsModal').one('shown.bs.modal', () => resolve()).modal('show')));
        await pageA.locator('#settingsModal a[href="#settings-game"]').click();
        await pageA.locator('select[name="ggzz.private.hatcherySlotLimit"]').selectOption('16');
        assert.equal(await pageA.evaluate(() => PrivateGameplay.hatcherySlotLimit()), 16);
        await pageA.evaluate(() => new Promise(resolve => $('#settingsModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        const hatchery = await pageA.evaluate(() => {
            const breeding = App.game.breeding;
            App.game.keyItems.gainKeyItem(KeyItemType.Mystery_egg, true);
            breeding.eggSlots = 4;
            App.game.wallet.currencies[GameConstants.Currency.questPoint](13000);
            for (let slot = 5; slot <= 8; slot++) breeding.buyEggSlot();
            for (let id = 1; id <= 9; id++) {
                App.game.party.gainPokemonById(id, false, true);
                const pokemon = App.game.party.getPokemon(id);
                pokemon.exp = 2000000; pokemon.level = 100;
                if (id <= 8) breeding.gainPokemonEgg(pokemon);
            }
            Settings.setSettingByName('ggzz.private.hatcherySlotLimit', 4);
            const saved = breeding.toJSON();
            breeding.fromJSON(JSON.parse(JSON.stringify(saved)));
            return { purchased: breeding.eggSlots, usable: breeding.usableEggSlots, occupied: breeding.eggList.filter(egg => !egg().isNone()).length,
                hasSpace: breeding.hasFreeEggSlot(), balance: App.game.wallet.currencies[GameConstants.Currency.questPoint](),
                ids: breeding.eggList.filter(egg => !egg().isNone()).map(egg => egg().pokemon) };
        });
        assert.equal(hatchery.purchased, 8);
        assert.equal(hatchery.usable, 4);
        assert.equal(hatchery.occupied, 8);
        assert.equal(hatchery.hasSpace, false);
        assert.equal(hatchery.balance, 0);
        checks.push('The real settings control changes the incubation cap; purchased slots, all eight eggs and their save data survive lowering it to four.');

        await pageA.evaluate(() => {
            Settings.setSettingByName('breedingShinyFilter', 1);
            Settings.setSettingByName('hatcherySort', SortOptions.breedingEfficiency);
            Settings.setSettingByName('partySort', SortOptions.evs);
            $('#pokemonListBody').collapse('show');
            $('#toaster .toast').toast('hide');
        });
        await pageA.locator('#party-list-filters summary').click();
        await pageA.locator('#party-list-search').fill('9');
        await pageA.waitForFunction(() => PartyController.getSortedList().length === 1 && PartyController.getSortedList()[0].id === 9);
        assert.ok((await pageA.locator('#pokemonListContainer .pokemon-row').innerText()).includes('EVs:'));
        await pageA.locator('#party-display-value').selectOption(String(2));
        await pageA.waitForFunction(() => document.querySelector('#pokemonListContainer .pokemon-row')?.textContent.includes('Attack:'));
        await pageA.locator('#party-select-partyShinyFilter').selectOption('1');
        await pageA.waitForFunction(() => PartyController.getSortedList().length === 0);
        await pageA.locator('#pokemonListContainer').getByRole('button', { name: 'Reset Filters', exact: true }).click();
        await pageA.waitForFunction(() => PartyController.getSortedList().length > 0);
        assert.equal(await pageA.evaluate(() => Settings.getSetting('breedingShinyFilter').value), 1);
        assert.equal(await pageA.evaluate(() => Settings.getSetting('hatcherySort').value), 8);
        await pageA.locator('#party-filter-partyCategoryFilter button').first().click();
        await pageA.locator('#party-filter-partyCategoryFilter input[type="checkbox"]').first().check();
        assert.equal(await pageA.evaluate(() => Settings.getSetting('partyCategoryFilter').value.length), 1);
        assert.equal(await pageA.evaluate(() => Settings.getSetting('breedingCategoryFilter').value.length), 0);
        await pageA.locator('#party-filter-partyCategoryFilter .dropdown-menu').getByRole('button', { name: 'All', exact: true }).click();
        assert.equal(await pageA.evaluate(() => Settings.getSetting('partyCategoryFilter').value.length), 0);
        await pageA.locator('#party-filter-partyCategoryFilter button').first().click();
        await pageA.screenshot({ path: path.join(output, 'expanded-party-list.png') });
        await pageA.locator('#party-filter-partyCategoryFilter button').first().click();
        await pageA.locator('#party-list-search').fill('9');
        await pageA.evaluate(() => Save.store(player));
        checks.push('External Pokemon list search, follow-sort display, independent display selection and filter reset work without changing hatchery filters or sorting.');

        // The vitamin filter uses the existing categories and does not modify membership.
        await pageA.evaluate(() => {
            App.game.party.getPokemon(9).addCategory(1);
            $('#toaster .toast').toast('hide');
        });
        await pageA.evaluate(() => new Promise(resolve => $('#pokemonVitaminExpandedModal').one('shown.bs.modal', () => resolve()).modal('show')));
        await pageA.locator('#multivitamin-category-filter button').first().click();
        await pageA.locator('#multivitamin-category-filter input[type="checkbox"]').nth(1).check();
        await pageA.waitForFunction(() => PartyController.getVitaminFilteredList().length === 1 && PartyController.getVitaminFilteredList()[0].id === 9);
        await pageA.waitForFunction(() => document.querySelectorAll('#pokemonVitaminExpandedModal tbody > tr').length === 1);
        assert.equal(await pageA.evaluate(() => Settings.getSetting('breedingCategoryFilter').value.length), 0);
        assert.equal(await pageA.evaluate(() => Settings.getSetting('partyCategoryFilter').value.length), 0);
        await pageA.screenshot({ path: path.join(output, 'vitamin-category-filter.png') });
        await pageA.locator('#multivitamin-category-filter button').first().click();
        await pageA.evaluate(() => new Promise(resolve => $('#pokemonVitaminExpandedModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        checks.push('Vitamin UI filters by existing categories independently of hatchery and party filters, without changing categories or vitamin usage.');

        const migratedQuests = await pageA.evaluate(() => {
            App.game.gameState = GameConstants.GameState.paused;
            const quests = App.game.quests;
            const tutorial = quests.getQuestLine('Tutorial Quests');
            tutorial.state(QuestLineState.ended);
            const legacy = JSON.parse(JSON.stringify(quests.toJSON()));
            delete legacy.cycleVersion;
            legacy.xp = quests.levelToXP(30);
            legacy.freeRefresh = false;
            legacy.questList = [
                { name: 'CatchShiniesQuest', data: [1, 1000], initial: App.game.statistics.totalShinyPokemonCaptured(), claimed: false },
                { name: 'CapturePokemonsQuest', data: [100, 2000], initial: App.game.statistics.totalPokemonCaptured() - 100, claimed: true },
            ];
            const before = App.game.wallet.currencies[GameConstants.Currency.questPoint]();
            // fromJSON initializes quest-line definitions once at startup. Clear this fixture's
            // definitions before simulating another load in the same renderer.
            quests.questLines().forEach(line => line.dispose());
            quests.questLines.removeAll();
            quests.fromJSON(legacy);
            const pending = quests.toJSON().pendingLegacyBonus;
            quests.tick(100);
            const afterMigration = App.game.wallet.currencies[GameConstants.Currency.questPoint]() - before;
            const migrated = JSON.parse(JSON.stringify(quests.toJSON()));
            quests.questLines().forEach(line => line.dispose());
            quests.questLines.removeAll();
            quests.fromJSON(migrated);
            quests.tick(100);
            return { pending, afterMigration, afterReload: App.game.wallet.currencies[GameConstants.Currency.questPoint]() - before,
                names: quests.questList().map(q => q.constructor.name), available: QuestHelper.availableTypes(),
                shinyBonus: quests.questList().find(q => q.constructor.name === 'CatchShiniesQuest').bonusPointsReward };
        });
        assert.equal(migratedQuests.pending, 740);
        assert.equal(migratedQuests.afterMigration, 740);
        assert.equal(migratedQuests.afterReload, 740);
        assert.equal(migratedQuests.shinyBonus, 370);
        assert.equal(new Set(migratedQuests.names).size, migratedQuests.names.length);
        assert.deepEqual([...migratedQuests.names].sort(), [...migratedQuests.available].sort());
        await pageA.evaluate(() => new Promise(resolve => $('#QuestModal').one('shown.bs.modal', () => resolve()).modal('show')));
        const shinyRow = pageA.locator('#QuestModal [data-quest-type="CatchShiniesQuest"]');
        await shinyRow.locator('.quest-refresh').click();
        await pageA.locator('.modal.show').filter({ hasText: '刷新此类任务' }).getByRole('button', { name: '刷新', exact: true }).click();
        await pageA.waitForFunction(() => {
            const quest = App.game.quests.questList().find(q => q.constructor.name === 'CatchShiniesQuest');
            return App.game.quests.getRefreshCost(quest).amount === 100000;
        });
        await pageA.waitForFunction(() => !document.querySelector('.modal[id^="modal"]'));
        const autoClaim = await pageA.evaluate(() => {
            const quests = App.game.quests;
            const old = quests.questList().find(q => q.constructor.name === 'CatchShiniesQuest');
            const other = quests.questList().find(q => q.constructor.name === 'CapturePokemonsQuest');
            const before = App.game.wallet.currencies[GameConstants.Currency.questPoint]();
            const xp = quests.xp();
            const completed = App.game.statistics.questsCompleted();
            const reward = old.totalPointsReward;
            const expectedXP = old.xpReward;
            App.game.statistics.totalShinyPokemonCaptured(old.initial() + old.amount);
            quests.tick(100);
            const next = quests.questList().find(q => q.constructor.name === 'CatchShiniesQuest');
            quests.tick(100);
            return { reward, gained: App.game.wallet.currencies[GameConstants.Currency.questPoint]() - before,
                expectedXP, xp: quests.xp() - xp, completed: App.game.statistics.questsCompleted() - completed,
                replaced: next !== old, progress: next.progress(), unchanged: quests.questList().includes(other), cost: quests.getRefreshCost(next).amount };
        });
        assert.equal(autoClaim.gained, autoClaim.reward);
        assert.equal(autoClaim.xp, Math.round(autoClaim.expectedXP));
        assert.equal(autoClaim.completed, 1);
        assert.equal(autoClaim.replaced, true);
        assert.equal(autoClaim.progress, 0);
        assert.equal(autoClaim.unchanged, true);
        assert.equal(autoClaim.cost, 100000);
        await pageA.screenshot({ path: path.join(output, 'independent-quest-cycles.png') });
        await pageA.evaluate(() => new Promise(resolve => $('#QuestModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        await pageA.evaluate(() => { App.game.gameState = GameConstants.GameState.fighting; Save.store(player); });
        checks.push('Ordinary quest rows migrate old bonuses exactly once, refresh individually through the real confirmation UI, and auto-claim once before starting the same type at zero progress.');

        const dreamOrbs = await pageA.evaluate(() => {
            const controller = App.game.dreamOrbController;
            const lockedBefore = controller.onlineTimeMs();
            controller.tick(GameConstants.HOUR);
            if (controller.onlineTimeMs() !== lockedBefore || controller.orbs.some(orb => orb.amount())) throw new Error('Locked Dream Orbs accumulated time');
            ['Tornadus', 'Thundurus', 'Landorus'].forEach(name => App.game.party.gainPokemonById(pokemonMap[name].id, false, true));
            controller.fromJSON({ orbs: [{ color: 'Pink', amount: 7 }] });
            const oldProgress = controller.onlineTimeMs();
            controller.tick(15 * GameConstants.MINUTE);
            const beforeOffline = JSON.stringify(controller.toJSON());
            const lastSeen = player._lastSeen;
            player._lastSeen = Date.now() - 48 * GameConstants.HOUR;
            try { App.game.computeOfflineEarnings(); } finally { player._lastSeen = lastSeen; }
            const offlineUnchanged = beforeOffline === JSON.stringify(controller.toJSON());
            controller.onlineTimeMs(GameConstants.HOUR - 3000);
            return { oldProgress, offlineUnchanged, pink: controller.orbs[0].amount() };
        });
        assert.deepEqual(dreamOrbs, { oldProgress: 0, offlineUnchanged: true, pink: 7 });
        await pageA.evaluate(() => new Promise(resolve => $('#dreamOrbsModal').one('shown.bs.modal', () => resolve()).modal('show')));
        assert.match(await pageA.locator('#dream-orb-countdown').innerText(), /^\d{2}:\d{2}:\d{2}$/);
        await pageA.waitForFunction(() => App.game.dreamOrbController.orbs[0].amount() === 8, undefined, { timeout: 15000 });
        await pageA.screenshot({ path: path.join(output, 'dream-orbs-online.png') });
        await pageA.evaluate(() => new Promise(resolve => $('#dreamOrbsModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        checks.push('Dream Orbs retain legacy balances, require the original unlocks, ignore offline settlement and award once per online hour with a live countdown.');

        const keyA = await pageA.evaluate(() => Save.key);
        await pageA.evaluate(() => { App.game.dreamOrbController.onlineTimeMs(GameConstants.HOUR - 5000); });
        const seconds = await pageA.evaluate(() => App.game.statistics.secondsPlayed());
        await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
        try {
            await pageA.waitForFunction(start => App.game.statistics.secondsPlayed() >= start + 2, seconds, { timeout: 15000, polling: 200 });
        } catch (error) {
            console.error('Background tick state:', await pageA.evaluate(start => ({ start, seconds: App.game.statistics.secondsPlayed(), hidden: document.hidden,
                state: App.game.gameState, worker: !!App.game.worker, workerEnabled: Settings.getSetting('useWebWorkerForGameTicks').value,
                cloudRunning: CloudSave.running, counter: Game.achievementCounter }), seconds));
            throw error;
        }
        await pageA.waitForFunction(() => App.game.dreamOrbController.orbs[0].amount() === 9, undefined, { timeout: 20000 });
        await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
        assert.ok(await pageA.evaluate(() => !!App.game.worker));
        await pageA.evaluate(() => { App.game.dreamOrbController.onlineTimeMs(20 * GameConstants.MINUTE); Save.store(player); });
        checks.push('A minimized packaged client earns exactly one Dream Orb at the online threshold through the background game clock.');
        checks.push('Local game cold-starts without a network, has isolated storage/Web Locks, no renderer Node, and continues ticking while minimized.');
        await panel(pageA);
        await pageA.screenshot({ path: path.join(output, 'offline-game.png') });
        await a.evaluate(({ dialog }) => { globalThis.testDialogs = []; dialog.showMessageBox = async (_window, options) => { globalThis.testDialogs.push(options.message); return { response: 0 }; }; });
        await pageA.evaluate(() => { window.originalSaveForTest = Save.store; Save.store = () => { throw new Error('Test local write failure'); }; });
        await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
        await status(pageA, 'Test local write failure');
        assert.equal(pageA.isClosed(), false);
        await pageA.evaluate(() => { Save.store = window.originalSaveForTest; delete window.originalSaveForTest; });
        checks.push('An injected local disk-write failure refuses window close and keeps the running game available.');
        const beforeQuitWrites = writes;
        await quit(a);
        assert.equal(writes, beforeQuitWrites);
        ({ app: a, page: pageA } = await launch(profiles[0]));
        assert.equal(await pageA.evaluate(key => JSON.parse(localStorage.getItem('save' + key)).profile.name, keyA), 'Desktop fixture A');
        const restoredOrbs = await pageA.evaluate(key => JSON.parse(localStorage.getItem('save' + key))['dream-orbs'], keyA);
        assert.equal(restoredOrbs.orbs.find(orb => orb.color === 'Pink').amount, 9);
        assert.ok(restoredOrbs.onlineTimeMs >= 20 * 60000 && restoredOrbs.onlineTimeMs < 21 * 60000);
        checks.push('Graceful close saves local progress; restarting the same profile restores it without uploading.');

        online = true;
        await login(a, pageA);
        const encrypted = await fs.readFile(path.join(profiles[0], 'encrypted-session.bin'));
        assert.ok(!encrypted.includes(Buffer.from(password)) && !encrypted.includes(Buffer.from('eyJ')));
        assert.equal(await pageA.evaluate(() => document.cookie), '');
        const denied = await pageA.evaluate(() => window.pokeclickerDesktop.cloudRequest({ path: '/auth/login', method: 'POST', body: '{}' }));
        assert.equal(denied.status, 403);
        checks.push('Password login uses the real Worker verifier; credentials are encrypted and unavailable to renderer JavaScript, and arbitrary IPC routes are rejected.');
        await panel(pageA);
        await pageA.locator('#cloud-save-local').selectOption(keyA);
        await pageA.getByRole('button', { name: '上传 / 立即同步', exact: true }).click();
        await pageA.getByRole('button', { name: '关联此存档', exact: true }).click();
        await status(pageA, '云端已确认保存');
        assert.equal(remote.envelope.payload.save.profile.name, 'Desktop fixture A');
        assert.equal(remote.envelope.revision, 1);
        assert.equal(remote.envelope.payload.settings['ggzz.private.pricingMode'], 'base-price');
        assert.equal(remote.envelope.payload.settings['ggzz.private.guidePathfinding'], 'optimized');
        assert.equal(remote.envelope.payload.settings['ggzz.private.guideFeeRate'], 0.01);
        assert.equal(remote.envelope.payload.settings['ggzz.private.fixedVitaminPurchased'], true);
        checks.push('Desktop uploads a real game snapshot through the unchanged Worker protocol and receives a revision/SHA receipt.');
        await quit(a);
        ({ app: a, page: pageA } = await launch(profiles[0]));
        await panel(pageA);
        await pageA.getByRole('button', { name: '检查连接', exact: true }).click();
        await status(pageA, '连接成功');
        checks.push('Restarting restores the OS-encrypted session and local cloud binding without asking for a password or changing the cloud save.');

        const { app: b, page: pageB } = await launch(profiles[1]);
        await login(b, pageB);
        await pageB.getByRole('button', { name: '下载云档到本机', exact: true }).click();
        await pageB.getByRole('button', { name: '备份并恢复', exact: true }).click();
        await status(pageB, '存档已恢复到本机');
        const keyB = await pageB.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('save')).slice(4));
        assert.equal(await pageB.evaluate(key => JSON.parse(localStorage.getItem('save' + key)).profile.name, keyB), 'Desktop fixture A');
        assert.notEqual(keyB, keyA);
        checks.push('A second independent desktop profile downloads and transactionally restores the same cloud save.');

        // Browser fixture uses the same real Worker handler and the production website build.
        browser = await chromium.launch({ channel: process.env.PC_BROWSER_CHANNEL || 'msedge', headless: true });
        const context = await browser.newContext();
        await context.route('**/*', route => new URL(route.request().url()).origin === serverOrigin ? route.continue() : route.abort());
        const web = await context.newPage();
        await web.goto(serverOrigin + '/');
        await web.getByLabel('游戏专用密码', { exact: true }).fill(password);
        await web.getByRole('button', { name: '登录游戏', exact: true }).click();
        await web.getByRole('link', { name: '进入游戏', exact: true }).click();
        await panel(web);
        await web.getByRole('button', { name: '下载云档到本机', exact: true }).click();
        await web.getByRole('button', { name: '备份并恢复', exact: true }).click();
        await status(web, '存档已恢复到本机');
        const webKey = await web.evaluate(() => Object.keys(localStorage).find(key => key.startsWith('save')).slice(4));
        const restoredSettings = await web.evaluate(key => JSON.parse(localStorage.getItem('settings' + key)), webKey);
        assert.equal(restoredSettings['ggzz.private.pricingMode'], 'base-price');
        assert.equal(restoredSettings['ggzz.private.guidePathfinding'], 'optimized');
        assert.equal(restoredSettings['ggzz.private.guideFeeRate'], 0.01);
        assert.equal(restoredSettings['ggzz.private.fixedVitaminPurchased'], true);
        assert.equal(restoredSettings['ggzz.private.hatcherySlotLimit'], 4);
        assert.equal(restoredSettings.partyIDFilter, 9);
        assert.equal(restoredSettings.partyDisplayValue, 2);
        assert.deepEqual(restoredSettings.vitaminCategoryFilter, [1]);
        const restoredGame = await web.evaluate(key => JSON.parse(localStorage.getItem('save' + key)), webKey);
        assert.deepEqual(restoredGame['dream-orbs'], remote.envelope.payload.save['dream-orbs']);
        assert.equal(restoredGame['dream-orbs'].orbs.find(orb => orb.color === 'Pink').amount, 9);
        assert.ok(restoredGame['dream-orbs'].onlineTimeMs >= 20 * 60000);
        checks.push('Dream Orb balances and unfinished online time persist through desktop restart and desktop-to-web cloud restoration.');
        assert.equal(restoredGame.breeding.eggSlots, 8);
        assert.equal(restoredGame.breeding.eggList.filter(egg => egg.type !== -1).length, 8);
        assert.equal(restoredGame.oakItems.Magic_Ball.level, 10);
        assert.equal(restoredGame.oakItems.Magic_Ball.exp, 110000);
        assert.equal(restoredGame.oakItems.Rocky_Helmet.level, 16);
        assert.equal(restoredGame.quests.cycleVersion, 1);
        assert.equal(restoredGame.quests.pendingLegacyBonus, 0);
        assert.ok(restoredGame.quests.manualRefreshDays.CatchShiniesQuest);
        assert.equal(new Set(restoredGame.quests.questList.map(q => q.name)).size, restoredGame.quests.questList.length);
        assert.ok(restoredGame.quests.questList.every(q => q.bonusPointsReward > 0));
        checks.push('Quest targets, frozen bonuses, per-type manual refresh history and vitamin category filters survive desktop-to-web cloud restoration.');
        checks.push('Expanded egg data, purchased slot rights, slot cap, list preferences and Oak Item progression survive desktop-to-web cloud restoration.');
        checks.push('All private preferences and vitamin purchase history survive desktop-to-web cloud restore without a protocol change.');
        await web.evaluate(key => { const save = JSON.parse(localStorage.getItem('save' + key)); save.profile.name = 'Web fixture progress'; localStorage.setItem('save' + key, JSON.stringify(save)); }, webKey);
        clock += 20000;
        await panel(web);
        await web.getByRole('button', { name: '上传 / 立即同步', exact: true }).click();
        await status(web, '云端已确认保存');
        assert.equal(remote.envelope.payload.save.profile.name, 'Web fixture progress');
        checks.push('Production webpage restores the desktop upload and publishes a newer compatible snapshot.');

        await pageB.evaluate(key => { const save = JSON.parse(localStorage.getItem('save' + key)); save.profile.name = 'Offline fixture B'; localStorage.setItem('save' + key, JSON.stringify(save)); }, keyB);
        clock += 20000;
        await panel(pageB);
        await pageB.getByRole('button', { name: '上传 / 立即同步', exact: true }).click();
        await pageB.locator('#cloud-save-conflict').waitFor();
        assert.equal(remote.envelope.payload.save.profile.name, 'Web fixture progress');
        await pageB.screenshot({ path: path.join(output, 'conflict.png') });
        await pageB.getByRole('button', { name: '使用这份云端进度', exact: true }).click();
        await pageB.getByRole('button', { name: '备份并恢复', exact: true }).click();
        await status(pageB, '存档已恢复到本机');
        assert.equal(await pageB.evaluate(key => JSON.parse(localStorage.getItem('save' + key)).profile.name, keyB), 'Web fixture progress');
        assert.ok(await pageB.evaluate(async () => (await CloudSave.storage.allBackups()).length > 0));
        checks.push('Diverging offline desktop progress raises a conflict instead of overwriting newer web progress; restoring cloud keeps recovery backups.');

        // Test the actual download event while choosing a path through the privileged harness only.
        const exportFile = path.join(work, 'exported-save.txt');
        await b.evaluate(({ BrowserWindow }, target) => {
            BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => item.setSavePath(target));
        }, exportFile);
        await panel(pageB);
        await pageB.getByRole('button', { name: '导出本地备份', exact: true }).click();
        await pageB.waitForTimeout(500);
        assert.ok((await fs.stat(exportFile)).size > 100);
        const exportText = await fs.readFile(exportFile, 'utf8');
        assert.equal(JSON.parse(decodeURI(Buffer.from(exportText, 'base64').toString('latin1'))).save.profile.name, 'Web fixture progress');
        checks.push('Native save export produces an original-compatible .txt backup.');
        const [chooser] = await Promise.all([
            pageB.waitForEvent('filechooser'),
            pageB.locator('#saveSelector').getByText('Import Save', { exact: true }).click(),
        ]);
        await Promise.all([pageB.waitForEvent('domcontentloaded'), chooser.setFiles(exportFile)]);
        await status(pageB, '存档已恢复到本机');
        assert.equal(await pageB.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('save')).length), 2);
        checks.push('Original-format .txt import creates a separate local slot and preserves the existing restored save.');

        fixture.GAME_AUTH = JSON.stringify({ ...JSON.parse(fixture.GAME_AUTH), sessionKey: randomBytes(32).toString('base64url') });
        await panel(pageB);
        await pageB.getByRole('button', { name: '检查连接', exact: true }).click();
        await status(pageB, '登录已过期');
        assert.equal(pageB.url(), 'pokeclicker://game/');
        await login(b, pageB, true);
        assert.equal(await pageB.evaluate(() => CloudSave.loginRequired), false);
        checks.push('Expired sessions keep the game in place; re-login from the native menu restores frontend connection state.');
        online = false;
        const writesBeforeLogout = writes;
        await pageB.getByRole('button', { name: '退出登录', exact: true }).click();
        await pageB.getByRole('button', { name: '保存本地并退出', exact: true }).click();
        await status(pageB, '云存档已退出登录');
        await assert.rejects(fs.access(path.join(profiles[1], 'encrypted-session.bin')));
        assert.equal(writes, writesBeforeLogout);
        assert.equal(await pageB.locator('#cloud-save-auto').isChecked(), false);
        checks.push('Offline logout removes persisted credentials, disables automatic sync, and preserves the local save.');

        const helpPending = b.waitForEvent('window');
        await b.evaluate(({ Menu }) => Menu.getApplicationMenu().items.find(item => item.label === '帮助').submenu.items[0].click());
        const help = await helpPending;
        await help.locator('h1').waitFor();
        await help.screenshot({ path: path.join(output, 'offline-manual.png') });
        assert.ok((await help.locator('body').innerText()).includes('同步后换设备'));
        assert.ok((await help.locator('#private-gameplay').innerText()).includes('原价的 1%'));
        await help.locator('#private-gameplay').scrollIntoViewIfNeeded();
        await help.locator('#private-gameplay').screenshot({ path: path.join(output, 'private-gameplay-manual.png') });
        checks.push('The Chinese operation manual, including private gameplay instructions, opens locally while offline.');
        await quit(b); await quit(a);
        assert.deepEqual(errors, []);
        checks.push('No uncaught renderer errors during the desktop acceptance flow.');
        await fs.writeFile(path.join(output, 'smoke-report.json'), JSON.stringify({ passed: true, executable, packaged: !dev, checks, requests: requests.filter(item => item.path.startsWith('/api/') || item.path.startsWith('/auth/')), note: 'Isolated fixtures only; this does not replace the user’s real two-device acceptance.' }, null, 2));
        console.log(JSON.stringify({ passed: true, checks }, null, 2));
    } catch (error) {
        console.error('SMOKE FAILED:', error.message);
        if (lastPage && !lastPage.isClosed()) { console.error((await lastPage.locator('body').innerText()).slice(0, 7000)); await lastPage.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {}); }
        console.error('Renderer errors:', errors);
        throw error;
    } finally {
        for (const app of running) { await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); await app.close().catch(() => {}); }
        await browser?.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
