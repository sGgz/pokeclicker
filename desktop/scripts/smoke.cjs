// Real Electron + real Worker handler; only GitHub persistence and network destination are test doubles.
// The debugger replaces fetch in the test process. Production builds contain no test endpoint or auth bypass.
const { _electron: electron, chromium } = require('playwright');
const { buildSync } = require('../../cloud-save-worker/node_modules/esbuild');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { createServer } = require('node:http');
const { createServer: createHttpsServer } = require('node:https');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');

async function run() {
    const startedAt = Date.now();
    const root = path.resolve(__dirname, '../..');
    const gameVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
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
    let uploadGate = null;
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
            if (uploadGate) await uploadGate;
            assert.equal(base, remote?.blobSha ?? null);
            const blobSha = createHash('sha1').update(JSON.stringify(envelope)).digest('hex');
            const commitSha = createHash('sha1').update(blobSha).digest('hex');
            remote = { envelope: structuredClone(envelope), blobSha, commitSha }; writes++;
            return { blobSha, commitSha };
        },
    }) });
    let serverOrigin;
    let webOrigin;
    const handleRequest = async (incoming, outgoing) => {
        if (!online) { incoming.socket.destroy(); return; }
        try {
            const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
            const headers = new Headers();
            for (const [key, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            if (headers.get('origin') === serverOrigin || headers.get('origin') === webOrigin) headers.set('origin', origin);
            const body = Buffer.concat(chunks);
            const response = await handler(new Request(origin + incoming.url, { method: incoming.method, headers, ...(body.length ? { body } : {}) }), fixture);
            requests.push({ method: incoming.method, path: incoming.url, status: response.status });
            outgoing.writeHead(response.status, Object.fromEntries(response.headers));
            outgoing.end(Buffer.from(await response.arrayBuffer()));
        } catch { outgoing.writeHead(500); outgoing.end('Test fixture error'); }
    };
    const server = createServer(handleRequest);
    // 浏览器使用 HTTPS 保留真实的 Secure Cookie 约束；证书仅用于隔离测试，不加入系统信任库。
    const webServer = createHttpsServer({
        key: await fs.readFile(path.join(root, 'desktop/test/fixtures/localhost-test-key.pem')),
        cert: await fs.readFile(path.join(root, 'desktop/test/fixtures/localhost-test-cert.pem')),
    }, handleRequest);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    serverOrigin = 'http://localhost:' + server.address().port;
    await new Promise(resolve => webServer.listen(0, '127.0.0.1', resolve));
    webOrigin = 'https://localhost:' + webServer.address().port;
    const dev = process.argv.includes('--dev');
    const backgroundTest = !process.argv.includes('--show-windows');
    const executableArgument = process.argv.find(value => value.startsWith('--exe='));
    const executable = executableArgument ? executableArgument.slice(6) : path.join(root, dev ? 'desktop/node_modules/electron/dist/electron.exe' : 'output/desktop/win-unpacked/PokeclickerCloud.exe');
    const profiles = [path.join(work, 'device-a'), path.join(work, 'device-b')];
    const running = new Set();
    const checks = [];
    const progressTimer = setInterval(() => console.log(`验收进度：已完成 ${checks.length} 项，已用时 ${Math.floor((Date.now() - startedAt) / 1000)} 秒。`), 15000);
    const desktopVersion = JSON.parse(await fs.readFile(path.join(root, 'desktop/package.json'), 'utf8')).version;
    const errors = [];
    let browser;
    let lastPage;
    async function launch(profile) {
        const env = { ...process.env, TEMP: work, TMP: work }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
        const app = await electron.launch({ executablePath: executable, args: [...(dev ? [path.join(root, 'desktop')] : []), '--data-dir=' + profile, ...(backgroundTest ? ['--background-test'] : [])], env, timeout: 60000 });
        running.add(app);
        // Redirect before waiting for the renderer: startup session checks also belong to the fixture.
        await app.evaluate((_electron, destination) => {
            const original = globalThis.fetch;
            globalThis.fetch = (input, init) => {
                const url = new URL(String(input));
                if (url.origin !== 'https://play.ggzz.fun') throw new Error('Unexpected outbound network');
                return original(destination + url.pathname + url.search, init);
            };
        }, serverOrigin);
        if (backgroundTest) {
            await app.evaluate(({ app, BrowserWindow }) => {
                globalThis.visibleTestWindows = [];
                const watch = window => {
                    if (window.isVisible()) globalThis.visibleTestWindows.push(window.id);
                    window.on('show', () => globalThis.visibleTestWindows.push(window.id));
                };
                BrowserWindow.getAllWindows().forEach(watch);
                app.on('browser-window-created', (_event, window) => watch(window));
            });
        }
        app.on('window', page => page.on('pageerror', error => errors.push(error.message)));
        const page = await app.firstWindow(); lastPage = page;
        page.on('pageerror', error => errors.push(error.message));
        await page.locator('#cloud-save-panel').waitFor({ timeout: 60000 });
        assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
        assert.equal(await app.evaluate(({ app }) => app.getVersion()), desktopVersion);
        return { app, page };
    }
    async function status(page, text) {
        await page.waitForFunction(value => document.getElementById('cloud-save-status')?.textContent?.includes(value), text, { timeout: 30000 });
    }
    async function panel(page) {
        await page.locator('#cloud-save-panel').evaluate(el => { el.open = true; });
    }
    async function captureWindow(app, page, name) {
        if (!backgroundTest) {
            await page.screenshot({ path: path.join(output, name) });
            return;
        }
        const png = await app.evaluate(async ({ BrowserWindow }, url) => {
            const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL() === url);
            const snapshot = await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true });
            if (snapshot.isEmpty()) throw new Error('Empty hidden window capture');
            return snapshot.toPNG().toString('base64');
        }, page.url());
        await fs.writeFile(path.join(output, name), Buffer.from(png, 'base64'));
    }
    async function login(app, page, useMenu = false) {
        const pending = app.waitForEvent('window');
        if (useMenu) await app.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
        else { await panel(page); await page.getByRole('button', { name: '登录云存档', exact: true }).click(); }
        const loginPage = await pending;
        await loginPage.getByLabel('游戏专用密码').fill(password);
        await loginPage.getByRole('button', { name: '登录云存档', exact: true }).click();
        await loginPage.getByRole('button', { name: '返回游戏', exact: true }).waitFor();
        await captureWindow(app, loginPage, 'login-success.png');
        await loginPage.getByRole('button', { name: '返回游戏', exact: true }).click();
        await status(page, '登录成功');
    }
    async function quit(app) {
        if (backgroundTest) assert.deepEqual(await app.evaluate(() => globalThis.visibleTestWindows), []);
        const exited = once(app.process(), 'exit');
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === 'pokeclicker://game/').close());
        await Promise.race([exited, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Graceful close timed out')), 25000); timer.unref(); })]);
        running.delete(app);
    }
    async function backgroundWindow(app, active) {
        await app.evaluate(({ BrowserWindow }, options) => {
            const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL() === 'pokeclicker://game/');
            if (options.hidden) window.hide();
            else if (options.active) window.minimize();
            else window.restore();
        }, { hidden: backgroundTest, active });
    }
    try {
        online = false;
        let { app: a, page: pageA } = await launch(profiles[0]);
        assert.deepEqual(await pageA.evaluate(() => ({ secure: isSecureContext, locks: !!navigator.locks, idb: !!indexedDB, bridge: window.pokeclickerDesktop?.version, node: typeof require })),
            { secure: true, locks: true, idb: true, bridge: 1, node: 'undefined' });
        assert.ok(await pageA.locator('#theme-link').evaluate(el => el.href.startsWith('pokeclicker://game/vendor/themes/')));
        assert.equal(await pageA.evaluate(() => new Update().version), gameVersion);
        checks.push('The actual renderer game version agrees with package.json rather than trusting only desktop-build.json.');
        await pageA.getByText('New Save', { exact: true }).click();
        await pageA.waitForFunction(() => typeof App !== 'undefined' && App.game?.statistics?.secondsPlayed && CloudSave.running);
        assert.equal(await pageA.evaluate(() => CloudSave.gameVersion), gameVersion);
        if (process.argv.includes('--version-only')) {
            const key = await pageA.evaluate(version => {
                App.game.profile.name('Version fixture ' + version);
                Save.store(player);
                return Save.key;
            }, gameVersion);
            assert.equal(await pageA.evaluate(saveKey => JSON.parse(localStorage.getItem('save' + saveKey)).update.version, key), gameVersion);
            await quit(a);
            ({ app: a, page: pageA } = await launch(profiles[0]));
            await pageA.getByText('Version fixture ' + gameVersion, { exact: true }).click();
            await pageA.waitForFunction(() => typeof App !== 'undefined' && CloudSave.running && !!App.game);
            assert.deepEqual(await pageA.evaluate(() => ({ version: App.game.update.version, blocked: CloudSave.blocked })), { version: gameVersion, blocked: '' });
            if (backgroundTest) assert.deepEqual(await a.evaluate(() => globalThis.visibleTestWindows), []);
            checks.push('An existing save with the current game version loads after an isolated desktop restart without blocking cloud sync.');
            const report = { passed: true, executable, packaged: !dev, desktopVersion, gameVersion, backgroundTest, checks, elapsedSeconds: (Date.now() - startedAt) / 1000 };
            await fs.writeFile(path.join(output, 'version-smoke-report.json'), JSON.stringify(report, null, 2));
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        assert.deepEqual(await pageA.evaluate(() => ({ enabled: PrivateGameplay.autoClickEnabled(), rate: PrivateGameplay.autoClickRate() })), { enabled: true, rate: 20 });
        // Keep the tutorial and unrelated fixtures deterministic; verify automation separately below.
        await pageA.evaluate(() => {
            Settings.setSettingByName('ggzz.private.autoClickAttack', false);
            Settings.setSettingByName('ggzz.private.autoMine', false);
        });
        await pageA.locator('#startSequenceModal').getByRole('button', { name: 'Next', exact: true }).click();
        await pageA.locator('#pickStarterTutorialModal input.image-starter').first().click();
        // Hide the tutorial tooltip only in this disposable test profile.
        await pageA.evaluate(() => { Information.hide(); App.game.profile.name('Desktop fixture A'); Save.store(player); });
        await pageA.locator('#routeBattleContainer > .clickable').click({ clickCount: 10, delay: 100 });
        await pageA.locator('#starterCaughtModal').getByRole('button', { name: 'Next', exact: true }).click();
        await pageA.locator('#starterCaughtModal').waitFor({ state: 'hidden' });
        await pageA.evaluate(() => {
            Information.hide();
            // The level-100 fixture below clears Route 1 quickly. Unlock its map
            // silently now so its tutorial cannot interrupt unrelated UI checks.
            App.game.keyItems.gainKeyItem(KeyItemType.Town_map, true);
        });
        // Exercise the actual Knockout controls and game objects in this isolated save.
        await pageA.waitForFunction(() => !Battle.catching() && Battle.enemyPokemon()?.isAlive());
        await pageA.evaluate(() => {
            const enemy = Battle.enemyPokemon();
            // Exercise real attacks without capturing extra Pokemon in unrelated party fixtures.
            window.autoClickEnemyFixture = { enemy, health: enemy.health(), maxHealth: enemy.maxHealth(), percentage: enemy.healthPercentage() };
            enemy.maxHealth(1_000_000);
            enemy.health(1_000_000);
            enemy.healthPercentage(100);
        });
        await pageA.evaluate(() => new Promise(resolve => $('#settingsModal').one('shown.bs.modal', () => resolve()).modal('show')));
        await pageA.locator('#settingsModal a[href="#settings-game"]').click();
        await pageA.getByLabel('自动点击攻击', { exact: true }).selectOption({ label: '开启' });
        await pageA.getByLabel('自动点击频率', { exact: true }).selectOption({ label: '5 次/秒' });
        assert.deepEqual(await pageA.evaluate(() => ({ enabled: PrivateGameplay.autoClickEnabled(), rate: PrivateGameplay.autoClickRate() })), { enabled: true, rate: 5 });
        await pageA.getByLabel('自动点击频率', { exact: true }).selectOption({ label: '20 次/秒（最大）' });
        await pageA.getByLabel('自动点击攻击', { exact: true }).selectOption({ label: '关闭' });
        await pageA.locator('select[name="ggzz.private.guidePathfinding"]').selectOption('optimized');
        const chestPriority = pageA.locator('select[name="ggzz.private.drakeChestPriority"]');
        assert.equal(await chestPriority.inputValue(), 'off');
        await chestPriority.selectOption('mythic');
        assert.equal(await pageA.evaluate(() => PrivateGameplay.drakeChestPriority()), 'mythic');
        await chestPriority.selectOption('off');
        assert.equal(await pageA.evaluate(() => PrivateGameplay.drakeChestPriority()), undefined);
        await chestPriority.selectOption('epic');
        assert.equal(await pageA.evaluate(() => PrivateGameplay.drakeChestPriority()), 'epic');
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
        const autoClickBefore = await pageA.evaluate(() => ({ clicks: App.game.statistics.clickAttacks(), time: performance.now() }));
        await pageA.locator('#auto-click-toggle').click();
        await pageA.waitForFunction(before => App.game.statistics.clickAttacks() >= before + 4, autoClickBefore.clicks, { timeout: 3000 });
        const autoClickAfter = await pageA.evaluate(() => ({ clicks: App.game.statistics.clickAttacks(), time: performance.now() }));
        assert.ok(autoClickAfter.clicks - autoClickBefore.clicks <= Math.ceil((autoClickAfter.time - autoClickBefore.time) / 50) + 1);
        const backgroundClicks = await pageA.evaluate(() => App.game.statistics.clickAttacks());
        await backgroundWindow(a, true);
        try {
            await pageA.waitForFunction(before => App.game.statistics.clickAttacks() >= before + 4, backgroundClicks, { polling: 50, timeout: 5000 });
        } finally {
            await backgroundWindow(a, false);
        }
        await pageA.locator('#auto-click-toggle').click();
        assert.equal(await pageA.locator('#auto-click-toggle').getAttribute('aria-pressed'), 'false');
        assert.equal(await pageA.evaluate(() => PrivateGameplay.autoClickRate()), 20);
        const stoppedClickCount = await pageA.evaluate(() => {
            window.autoClickStoppedAt = performance.now();
            return App.game.statistics.clickAttacks();
        });
        await pageA.waitForFunction(() => performance.now() - window.autoClickStoppedAt >= 200);
        assert.equal(await pageA.evaluate(() => App.game.statistics.clickAttacks()), stoppedClickCount);
        await pageA.evaluate(() => {
            const saved = window.autoClickEnemyFixture;
            if (Battle.enemyPokemon() !== saved.enemy) throw new Error('Auto click fixture unexpectedly defeated its enemy');
            saved.enemy.maxHealth(saved.maxHealth);
            saved.enemy.health(saved.health);
            saved.enemy.healthPercentage(saved.percentage);
            delete window.autoClickEnemyFixture;
        });
        await pageA.screenshot({ path: path.join(output, 'auto-click-controls.png') });
        checks.push('Auto click defaults to 20/s, typed settings and the battle toggle stay in sync, attacks respect the cooldown, background desktop attacks continue, and disabling stops attacks.');
        if (process.argv.includes('--auto-click-only')) {
            await pageA.evaluate(() => new Promise(resolve => $('#settingsModal').one('shown.bs.modal', () => resolve()).modal('show')));
            await pageA.locator('#settingsModal a[href="#settings-game"]').click();
            await pageA.getByLabel('自动点击频率', { exact: true }).selectOption({ label: '5 次/秒' });
            await pageA.evaluate(() => new Promise(resolve => $('#settingsModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
            await quit(a);
            ({ app: a, page: pageA } = await launch(profiles[0]));
            await pageA.getByText('Desktop fixture A', { exact: true }).click();
            await pageA.waitForFunction(() => typeof App !== 'undefined' && !!App.game);
            assert.deepEqual(await pageA.evaluate(() => ({ enabled: PrivateGameplay.autoClickEnabled(), rate: PrivateGameplay.autoClickRate() })), { enabled: false, rate: 5 });
            checks.push('Opening the saved game after a desktop restart restores the disabled state and non-default 5/s frequency.');
            assert.deepEqual(errors, []);
            if (backgroundTest) assert.deepEqual(await a.evaluate(() => globalThis.visibleTestWindows), []);
            const report = { passed: true, executable, checks, desktopVersion, packaged: !dev, backgroundTest, elapsedSeconds: (Date.now() - startedAt) / 1000 };
            await fs.writeFile(path.join(output, 'auto-click-smoke-report.json'), JSON.stringify(report, null, 2));
            console.log(JSON.stringify(report, null, 2));
            return;
        }
        // Multi-farm UI operates only on this disposable desktop profile.
        await pageA.evaluate(() => {
            const farming = App.game.farming;
            window.farmSmoke = { saved: JSON.parse(JSON.stringify(farming.toJSON())), update: farming.update };
            farming.update = () => {};
            App.game.keyItems.gainKeyItem(KeyItemType.Wailmer_pail, true);
            farming.getFarmPlots(0).forEach(plot => { plot.isUnlocked = true; });
            farming.unlockedBerries.slice(0, 8).forEach(berry => berry(true));
            farming.berryInventory[BerryType.Cheri](1000);
            App.game.wallet.currencies[GameConstants.Currency.farmPoint](20_000_000);
            FarmController.openFarmModal();
        });
        const farmModal = pageA.locator('#farmModal');
        // 在隔离存档中核对实际预览绑定，结束后恢复田地与道具倍率。
        await pageA.evaluate(() => {
            const farming = App.game.farming;
            window.previewSmoke = {
                saved: JSON.parse(JSON.stringify(farming.toJSON())),
                calculateBonus: App.game.oakItems.calculateBonus,
                selectedBerry: App.game.statistics.selectedBerryID(),
                berryDexMode: Settings.getSetting('berryDexMode').value,
            };
            App.game.oakItems.calculateBonus = function (type) {
                return type === OakItemType.Sprayduck ? 2 : window.previewSmoke.calculateBonus.call(this, type);
            };
            farming.plotList.forEach(plot => { plot.isSafeLocked = true; plot.mulch = MulchType.None; });
            const plot = farming.plotList[0];
            plot.isSafeLocked = false;
            plot.plant(BerryType.Cheri);
            App.game.statistics.selectedBerryID(BerryType.Cheri);
            Settings.setSettingByName('berryDexMode', 'preview');
        });
        await farmModal.getByRole('link', { name: 'Berrydex', exact: true }).click();
        const growthRow = farmModal.locator('#berryDexPreviewTable tr').filter({ hasText: '预计收获时间' });
        await pageA.waitForFunction(() => document.querySelector('#berryDexPreviewTable code[data-bind*="getBerryGrowthTimePreview"]')?.textContent === '15 secs');
        assert.equal(await growthRow.locator('code').textContent(), '15 secs');
        assert.equal(await pageA.evaluate(() => App.game.farming.plotList[0].calcTimeLeft(true)), 15);
        await pageA.evaluate(() => {
            App.game.farming.plotList[0].mulch = MulchType.Boost_Mulch;
            App.game.farming.plotList[1].isSafeLocked = false;
        });
        await pageA.waitForFunction(() => document.querySelector('#berryDexPreviewTable code[data-bind*="getBerryGrowthTimePreview"]')?.textContent === '10 secs ～ 15 secs');
        await farmModal.screenshot({ path: path.join(output, 'farm-growth-preview.png') });
        await pageA.evaluate(() => { App.game.farming.plotList[0].mulch = MulchType.Freeze_Mulch; });
        await pageA.waitForFunction(() => document.querySelector('#berryDexPreviewTable code[data-bind*="getBerryGrowthTimePreview"]')?.textContent === '15 secs 起（部分格子暂停生长）');
        await pageA.evaluate(() => { App.game.farming.plotList[1].isSafeLocked = true; });
        await pageA.waitForFunction(() => document.querySelector('#berryDexPreviewTable code[data-bind*="getBerryGrowthTimePreview"]')?.textContent === '暂停生长');
        await pageA.evaluate(() => {
            App.game.farming.fromJSON(window.previewSmoke.saved);
            App.game.oakItems.calculateBonus = window.previewSmoke.calculateBonus;
            App.game.statistics.selectedBerryID(window.previewSmoke.selectedBerry);
            Settings.setSettingByName('berryDexMode', window.previewSmoke.berryDexMode);
            delete window.previewSmoke;
        });
        await farmModal.getByRole('link', { name: 'Farm', exact: true }).click();
        checks.push('实际客户端的树果预览计入全局和肥料加成，与新种倒计时一致，显示格子时间范围和冻结暂停。');
        await farmModal.getByRole('button', { name: /购买下一块田/ }).click();
        await farmModal.getByRole('button', { name: /购买下一块田/ }).click();
        assert.equal(await pageA.evaluate(() => App.game.farming.farms().length), 3);
        await farmModal.locator('#farmBatchScope').selectOption('all');
        const batchActions = farmModal.locator('.farm-batch-actions');
        const searchSeeds = farmModal.locator('#seeds input[placeholder="Search"]');
        await farmModal.locator('#activeFarm').selectOption('0');
        await searchSeeds.fill('cheri');
        await farmModal.locator('#seedList li').filter({ hasText: 'Cheri' }).click();
        await farmModal.locator('#activeFarm').selectOption('1');
        assert.equal(await searchSeeds.inputValue(), '');
        await searchSeeds.fill('chesto');
        await farmModal.locator('#seedList li').filter({ hasText: 'Chesto' }).click();
        await farmModal.locator('#activeFarm').selectOption('2');
        await searchSeeds.fill('pecha');
        await farmModal.locator('#seedList li').filter({ hasText: 'Pecha' }).click();
        await farmModal.locator('#activeFarm').selectOption('0');
        assert.equal(await searchSeeds.inputValue(), 'cheri');
        assert.equal(await pageA.evaluate(() => FarmController.selectedBerry()), 0);
        await farmModal.locator('#activeFarm').selectOption('1');
        assert.equal(await searchSeeds.inputValue(), 'chesto');
        assert.equal(await pageA.evaluate(() => FarmController.selectedBerry() === BerryType.Chesto), true);
        await pageA.evaluate(() => { App.game.farming.berryInventory[BerryType.Chesto](1000); });
        await farmModal.locator('#seeds').getByRole('button', { name: '种植', exact: true }).click();
        assert.deepEqual(await pageA.evaluate(() => App.game.farming.farms().map(farm => farm.plots.filter(plot => !plot.isEmpty()).length)), [0, 25, 0]);
        await pageA.evaluate(() => App.game.farming.getFarmPlots(1).forEach(plot => { plot.age = BerryList[plot.berry].growthTime[PlotStage.Bloom]; }));
        await farmModal.locator('#seeds').getByRole('button', { name: '收获', exact: true }).click();
        assert.deepEqual(await pageA.evaluate(() => App.game.farming.farms().map(farm => farm.plots.filter(plot => !plot.isEmpty()).length)), [0, 0, 0]);
        await farmModal.locator('#activeFarm').selectOption('2');
        assert.equal(await searchSeeds.inputValue(), 'pecha');
        await pageA.evaluate(() => { FarmController.selectedBerry(BerryType.Cheri); });
        await batchActions.getByRole('button', { name: '种植', exact: true }).click();
        assert.deepEqual(await pageA.evaluate(() => App.game.farming.farms().map(farm => farm.plots.filter(plot => !plot.isEmpty()).length)), [25, 25, 25]);
        await pageA.evaluate(() => App.game.farming.farms().forEach(farm => farm.plots.forEach(plot => { plot.age = BerryList[plot.berry].growthTime[PlotStage.Bloom]; })));
        await pageA.keyboard.press('h');
        assert.deepEqual(await pageA.evaluate(() => App.game.farming.farms().map(farm => farm.plots.filter(plot => !plot.isEmpty()).length)), [0, 0, 0]);
        await pageA.keyboard.press('b');
        assert.deepEqual(await pageA.evaluate(() => App.game.farming.farms().map(farm => farm.plots.filter(plot => !plot.isEmpty()).length)), [25, 25, 25]);
        await pageA.evaluate(() => {
            window.farmSmoke.confirmMulch = Settings.getSetting('confirmBeformeMulchingAllPlots').value;
            Settings.setSettingByName('confirmBeformeMulchingAllPlots', false);
            App.game.farming.mulchList[MulchType.Boost_Mulch](1000);
            FarmController.selectedMulch(MulchType.Boost_Mulch);
            FarmController.multIndex(0);
        });
        await farmModal.getByRole('link', { name: 'Mulch', exact: true }).click();
        assert.equal(await farmModal.locator('.farm-batch-actions').getByRole('button', { name: '重种', exact: true }).isVisible(), false);
        assert.equal(await farmModal.locator('.farm-batch-actions').getByRole('button', { name: '清作物', exact: true }).isVisible(), false);
        assert.equal(await farmModal.locator('.farm-batch-actions').getByRole('button', { name: '施肥', exact: true }).isVisible(), true);
        assert.equal(await farmModal.locator('.farm-batch-actions').getByRole('button', { name: '清肥料', exact: true }).isVisible(), true);
        const mulchBefore = await pageA.evaluate(() => App.game.farming.mulchList[MulchType.Boost_Mulch]());
        await farmModal.locator('#mulches').getByRole('button', { name: '施肥', exact: true }).click();
        assert.deepEqual(await pageA.evaluate(() => App.game.farming.farms().map(farm => farm.plots.filter(plot => plot.mulch !== MulchType.None).length)), [0, 0, 25]);
        assert.equal(await pageA.evaluate(() => App.game.farming.mulchList[MulchType.Boost_Mulch]()), mulchBefore - 25);
        const batchMulchBefore = await pageA.evaluate(() => App.game.farming.mulchList[MulchType.Boost_Mulch]());
        await pageA.keyboard.press('m');
        assert.equal(await pageA.evaluate(() => App.game.farming.mulchList[MulchType.Boost_Mulch]()), batchMulchBefore - 75);
        await pageA.evaluate(() => { App.game.farming.mulchShovelAmt(100); });
        await pageA.keyboard.press('c');
        const mulchConfirm = pageA.locator('.modal.show').filter({ hasText: '批量铲除肥料' });
        await mulchConfirm.getByRole('button', { name: '清理', exact: true }).click();
        await pageA.waitForFunction(() => !document.querySelector('.modal[id^="modal"]'));
        assert.equal(await pageA.evaluate(() => App.game.farming.farms().flatMap(farm => farm.plots).filter(plot => plot.mulch !== MulchType.None).length), 0);
        assert.equal(await pageA.evaluate(() => App.game.farming.mulchShovelAmt()), 25);
        const berriesBefore = await pageA.evaluate(() => App.game.farming.berryInventory[BerryType.Cheri]());
        await pageA.keyboard.press('h');
        assert.equal(await pageA.evaluate(() => App.game.farming.berryInventory[BerryType.Cheri]()), berriesBefore);
        await pageA.evaluate(() => $('#toaster').hide());
        await farmModal.locator('.modal-content').screenshot({ path: path.join(output, 'farm-mulch-controls.png') });
        await farmModal.getByRole('link', { name: 'Berries', exact: true }).click();
        assert.equal(await farmModal.locator('.farm-batch-actions').getByRole('button', { name: '清肥料', exact: true }).isVisible(), false);
        const afterMulch = await pageA.evaluate(() => App.game.farming.mulchList[MulchType.Boost_Mulch]());
        await pageA.keyboard.press('m');
        assert.equal(await pageA.evaluate(() => App.game.farming.mulchList[MulchType.Boost_Mulch]()), afterMulch);
        await farmModal.locator('.modal-content').screenshot({ path: path.join(output, 'farm-batch-controls.png') });
        await farmModal.getByLabel('农田名称', { exact: true }).fill('测试生产田');
        await farmModal.getByLabel('农田名称', { exact: true }).press('Tab');
        await pageA.keyboard.press('[');
        assert.equal(await pageA.evaluate(() => App.game.farming.selectedFarm()), 1);
        await farmModal.getByRole('link', { name: 'Farm Hands', exact: true }).click();
        await pageA.evaluate(() => {
            const hand = App.game.farming.farmHands.list[0];
            hand.gainExperience(122_500);
            hand.focus(BerryType.Cheri);
            hand.shouldHarvest(true);
            hand.hire();
        });
        assert.ok((await farmModal.locator('#farmHandsView').textContent()).includes('Alex · Lv.50'));
        assert.equal(await farmModal.locator('#farmHandsView .card').filter({ hasText: 'Alex · Lv.50' }).getByRole('row').filter({ hasText: 'Efficiency:' }).locator('td').last().innerText(), '25 actions/cycle');
        assert.equal(await farmModal.locator('#farmHandsView .card').filter({ hasText: 'Alex · Lv.50' }).getByRole('row').filter({ hasText: '体力恢复' }).locator('td').last().innerText(), '2 点/轮');
        // 临时切换共享等级并调用真实工作逻辑，结束后恢复助手、作物与库存。
        await pageA.evaluate(() => { window.farmRecoverySmoke = JSON.parse(JSON.stringify(App.game.farming.toJSON())); });
        try {
            for (const [level, recovery] of [[1, 1], [2, 2], [49, 2], [50, 2]]) {
                const result = await pageA.evaluate(level => {
                    const farming = App.game.farming;
                    const hand = farming.farmHands.list.find(candidate => candidate.name === 'Alex');
                    const plots = farming.getFarmPlots(hand.farmId);
                    hand.experience(50 * level * (level - 1));
                    hand.focus(BerryType.Cheri);
                    hand.shouldHarvest(false);
                    hand.shouldCatch(false);
                    hand.plots([0]);
                    plots.forEach(plot => { plot.berry = BerryType.None; plot.isSafeLocked = true; });
                    plots[0].isUnlocked = true;
                    plots[0].isSafeLocked = false;
                    farming.berryInventory[BerryType.Cheri](1000);
                    hand.energy(5);
                    hand.work();
                    const workEnergy = hand.energy();
                    const planted = plots[0].berry === BerryType.Cheri;
                    plots[0].berry = BerryType.None;
                    hand.energy(0);
                    const beforeRestExperience = hand.experience();
                    hand.work();
                    const restEnergy = hand.energy();
                    const zeroEnergySkippedWork = plots[0].isEmpty() && hand.experience() === beforeRestExperience;
                    hand.focus(BerryType.None);
                    hand.energy(5);
                    hand.work();
                    const idleEnergy = hand.energy();
                    hand.energy(hand.maxEnergy - 1);
                    hand.work();
                    return { level: hand.level, recovery: hand.recovery, workEnergy, planted, restEnergy,
                        zeroEnergySkippedWork, idleEnergy, capacityReached: hand.energy() === hand.maxEnergy, tooltip: hand.tooltip() };
                }, level);
                assert.deepEqual({ ...result, tooltip: undefined }, { level, recovery, workEnergy: 5 + recovery - 2, planted: true,
                    restEnergy: recovery, zeroEnergySkippedWork: true, idleEnergy: 5 + recovery, capacityReached: true, tooltip: undefined });
                assert.ok([result.recovery, result.workEnergy, result.restEnergy, result.idleEnergy].every(Number.isInteger));
                assert.ok(result.tooltip.includes(`每轮恢复 ${recovery} 点体力`));
                assert.equal(/每轮恢复\s+\d+\./.test(result.tooltip), false);
                const recoveryCell = farmModal.locator('#farmHandsView .card').filter({ hasText: `Alex · Lv.${level}` }).getByRole('row').filter({ hasText: '体力恢复' }).locator('td').last();
                assert.equal(await recoveryCell.innerText(), `${recovery} 点/轮`);
            }
        } finally {
            await pageA.evaluate(() => {
                App.game.farming.fromJSON(window.farmRecoverySmoke);
                delete window.farmRecoverySmoke;
            });
        }
        checks.push('农场助手 Lv.1 每轮恢复 1 点，Lv.2、Lv.49、Lv.50 每轮恢复 2 点；实际工作、零体力休息与空闲恢复均使用整数，界面与悬浮提示没有小数，并保持体力上限。');
        const actionCaps = await pageA.evaluate(() => {
            const riley = App.game.farming.farmHands.list.find(hand => hand.name === 'Riley');
            const initial = riley.efficiency;
            riley.gainExperience(122_499);
            const beforeMax = riley.efficiency;
            riley.gainExperience(1);
            return { initial, beforeMax, riley: App.game.farming.farms().map(farm => farm.hands.list.find(hand => hand.name === 'Riley').efficiency),
                jessie: App.game.farming.farmHands.list.find(hand => hand.name === 'Jessie').efficiency };
        });
        assert.deepEqual(actionCaps, { initial: 25, beforeMax: 25, riley: [50, 50, 50], jessie: 50 });
        assert.ok(!(await farmModal.textContent()).includes('永动'));
        assert.equal(await pageA.evaluate(() => App.game.farming.farmHands.list[0].tooltip().includes('永动')), false);
        assert.equal(await pageA.evaluate(() => App.game.farming.farms()[0].hands.list[0].level), 50);
        await pageA.waitForFunction(() => getComputedStyle(document.getElementById('farmHandsView')).opacity === '1');
        await pageA.evaluate(() => $('#toaster').hide());
        await farmModal.screenshot({ path: path.join(output, 'multi-farm-levels.png') });
        await pageA.evaluate(() => {
            const farming = App.game.farming;
            const saved = JSON.parse(JSON.stringify(farming.toJSON()));
            farming.fromJSON(saved);
            if (farming.farms().length !== 3 || farming.farms()[2].name() !== '测试生产田' || farming.farms()[1].hands.list[0].level !== 50) throw new Error('Farm save round trip failed');
            if (farming.farmHands.list[0].efficiency !== 25 || farming.farmHands.list.find(hand => hand.name === 'Riley').efficiency !== 50) throw new Error('Farm hand action caps changed after save round trip');
            if (farming.farms()[0].berrySearch() !== 'cheri' || farming.farms()[1].selectedBerry() !== BerryType.Chesto || farming.farms()[2].berrySearch() !== 'pecha') throw new Error('Independent farm controls did not survive the save');
            while (farming.farms().length < 16) {
                if (!farming.buyFarm()) throw new Error('Unable to unlock all sixteen farms');
            }
        });
        assert.equal(await farmModal.locator('#activeFarm option').count(), 16);
        await farmModal.getByRole('link', { name: 'Farm', exact: true }).click();
        await pageA.waitForFunction(() => getComputedStyle(document.getElementById('berryFarmView')).opacity === '1');
        await farmModal.locator('summary').click();
        await farmModal.getByRole('button', { name: '查看', exact: true }).first().click();
        assert.equal(await pageA.evaluate(() => App.game.farming.selectedFarm()), 0);
        await farmModal.screenshot({ path: path.join(output, 'multi-farm-overview.png') });
        await pageA.evaluate(() => new Promise(resolve => $('#farmModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        await pageA.evaluate(() => {
            App.game.farming.fromJSON(window.farmSmoke.saved);
            App.game.farming.update = window.farmSmoke.update;
            Settings.setSettingByName('confirmBeformeMulchingAllPlots', window.farmSmoke.confirmMulch);
            delete window.farmSmoke;
            FarmController.batchScope('current');
            FarmController.farmingModalTabSelected('berryFarmView');
            $('#farmModal a[href="#berryFarmView"]').tab('show');
            $('#toaster').show();
        });
        checks.push('Multi-farm purchase, all-farm planting, scoped harvest and plant hotkeys, farm switching, shared helper levels without a perpetual UI label, and save round-trip work in real Electron.');
        checks.push('Mulch hotkey applies to the selected farm scope; berry and mulch buttons and hotkeys follow the visible tab.');
        checks.push('Each farm retains its own search and seed through switching and save round-trip; lower plant, harvest and mulch controls affect only the current farm even with all farms selected.');
        checks.push('Level 50 Alex displays 25 actions/cycle; Riley stays at 25 until reaching level 50, then jumps to 50 in every farm; Jessie stays at 50 and action caps survive save round-trip.');
        await pageA.evaluate(() => {
            window.mineSmoke = JSON.parse(JSON.stringify(App.game.underground.toJSON()));
            App.game.keyItems.gainKeyItem(KeyItemType.Explorer_kit, true);
            App.game.underground.tools.selectedToolType = UndergroundToolType.Chisel;
            App.game.underground.mine.tick(100_000);
            UndergroundController.openUndergroundModal();
        });
        const mineModal = pageA.locator('#mineModal');
        const mineBefore = await pageA.evaluate(() => App.game.statistics.undergroundToolsUsed[UndergroundToolType.Chisel]());
        await mineModal.locator('#auto-mine-toggle').click();
        await pageA.waitForFunction(before => App.game.statistics.undergroundToolsUsed[UndergroundToolType.Chisel]() >= before + 3, mineBefore, { timeout: 3000 });
        assert.equal(await pageA.locator('#auto-mine-quick-toggle').getAttribute('aria-pressed'), 'true');
        const mineBackgroundBefore = await pageA.evaluate(() => App.game.statistics.undergroundToolsUsed[UndergroundToolType.Chisel]());
        await backgroundWindow(a, true);
        try {
            await pageA.waitForFunction(before => App.game.statistics.undergroundToolsUsed[UndergroundToolType.Chisel]() >= before + 3, mineBackgroundBefore, { timeout: 3000 });
        } finally {
            await backgroundWindow(a, false);
        }
        await mineModal.locator('#auto-mine-toggle').click();
        const mineStopped = await pageA.evaluate(() => {
            window.mineStoppedAt = performance.now();
            return App.game.statistics.undergroundToolsUsed[UndergroundToolType.Chisel]();
        });
        await pageA.waitForFunction(() => performance.now() - window.mineStoppedAt >= 200);
        assert.equal(await pageA.evaluate(() => App.game.statistics.undergroundToolsUsed[UndergroundToolType.Chisel]()), mineStopped);
        assert.equal(await pageA.locator('#auto-mine-quick-toggle').getAttribute('aria-pressed'), 'false');
        const batteryBefore = await pageA.evaluate(() => {
            const underground = App.game.underground;
            if (underground.mine.completed) underground.generateMine(MineType.Random);
            underground.mine.tick(100_000);
            underground.tools.selectedToolType = UndergroundToolType.Survey;
            underground.battery.fromJSON({ charges: underground.battery.maxCharges, batteryCooldown: 0 });
            window.batteryTestAt = performance.now();
            return Object.values(App.game.statistics.undergroundBatteryDischarges).reduce((sum, counter) => sum + counter(), 0);
        });
        await pageA.waitForFunction(() => performance.now() - window.batteryTestAt >= 200);
        assert.equal(await pageA.evaluate(() => App.game.underground.battery.charges === App.game.underground.battery.maxCharges), true);
        await mineModal.locator('#auto-mine-toggle').click();
        await pageA.waitForFunction(before => Object.values(App.game.statistics.undergroundBatteryDischarges).reduce((sum, counter) => sum + counter(), 0) === before + 1, batteryBefore, { timeout: 5000 });
        await pageA.waitForFunction(() => !App.game.underground.battery.toJSON().activeDischargeID, undefined, { timeout: 10000 });
        assert.equal(await pageA.evaluate(() => App.game.underground.battery.charges < App.game.underground.battery.maxCharges), true);
        await mineModal.locator('#auto-mine-toggle').click();
        await pageA.evaluate(() => $('#toaster').hide());
        await mineModal.locator('.modal-content').screenshot({ path: path.join(output, 'auto-mine-controls.png') });
        await pageA.evaluate(() => new Promise(resolve => $('#mineModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        await pageA.evaluate(() => { App.game.underground.fromJSON(window.mineSmoke); delete window.mineSmoke; $('#toaster').show(); });
        checks.push('Mining toggle operates the real Chisel and durability, stays synchronized with the sidebar, continues in the background and stops when disabled.');
        checks.push('Full battery charges remain while automation is off; enabling automation triggers one real discharge even with Survey selected and finishes the original mining pattern.');
        if (process.argv.includes('--farm-only')) {
            assert.deepEqual(errors, []);
            if (backgroundTest) assert.deepEqual(await a.evaluate(() => globalThis.visibleTestWindows), []);
            const farmReport = { passed: true, executable, checks, desktopVersion, packaged: !dev, farmsVerified: 16, backgroundTest, elapsedSeconds: (Date.now() - startedAt) / 1000 };
            await fs.writeFile(path.join(output, 'farm-smoke-report.json'), JSON.stringify(farmReport, null, 2));
            console.log(JSON.stringify(farmReport, null, 2));
            return;
        }
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
        checks.push('Drake chest priority defaults to off, accepts a minimum chest tier through the real settings control, and can be disabled again.');
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
        await pageA.waitForFunction(() => {
            const rows = document.querySelectorAll('#pokemonListContainer .pokemon-row');
            return rows.length === 1 && rows[0].textContent.includes('Blastoise');
        }, undefined, { timeout: 5000 });
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
            controller.fromJSON({ onlineTime: 300, orbs: [{ color: 'Pink', amount: 7 }] });
            const migratedProgress = controller.onlineTimeMs();
            controller.tick(15 * GameConstants.MINUTE);
            const beforeOffline = JSON.stringify(controller.toJSON());
            const lastSeen = player._lastSeen;
            player._lastSeen = Date.now() - 48 * GameConstants.HOUR;
            try { App.game.computeOfflineEarnings(); } finally { player._lastSeen = lastSeen; }
            const offlineUnchanged = beforeOffline === JSON.stringify(controller.toJSON());
            controller.onlineTimeMs(GameConstants.HOUR - 3000);
            return { oldProgress, migratedProgress, offlineUnchanged, pink: controller.orbs[0].amount() };
        });
        assert.deepEqual(dreamOrbs, { oldProgress: 0, migratedProgress: 300000, offlineUnchanged: true, pink: 7 });
        await pageA.evaluate(() => new Promise(resolve => $('#dreamOrbsModal').one('shown.bs.modal', () => resolve()).modal('show')));
        assert.match(await pageA.locator('#dream-orb-countdown').innerText(), /^\d{2}:\d{2}:\d{2}$/);
        await pageA.waitForFunction(() => App.game.dreamOrbController.orbs[0].amount() === 8, undefined, { timeout: 15000 });
        await pageA.screenshot({ path: path.join(output, 'dream-orbs-online.png') });
        await pageA.evaluate(() => new Promise(resolve => $('#dreamOrbsModal').one('hidden.bs.modal', () => resolve()).modal('hide')));
        checks.push('Dream Orbs retain legacy balances, require the original unlocks, ignore offline settlement and award once per online hour with a live countdown.');

        const keyA = await pageA.evaluate(() => Save.key);
        await pageA.evaluate(() => { App.game.dreamOrbController.onlineTimeMs(GameConstants.HOUR - 5000); });
        const seconds = await pageA.evaluate(() => App.game.statistics.secondsPlayed());
        await backgroundWindow(a, true);
        try {
            await pageA.waitForFunction(start => App.game.statistics.secondsPlayed() >= start + 2, seconds, { timeout: 15000, polling: 200 });
        } catch (error) {
            console.error('Background tick state:', await pageA.evaluate(start => ({ start, seconds: App.game.statistics.secondsPlayed(), hidden: document.hidden,
                state: App.game.gameState, worker: !!App.game.worker, workerEnabled: Settings.getSetting('useWebWorkerForGameTicks').value,
                cloudRunning: CloudSave.running, counter: Game.achievementCounter }), seconds));
            throw error;
        }
        await pageA.waitForFunction(() => App.game.dreamOrbController.orbs[0].amount() === 9, undefined, { timeout: 20000 });
        await backgroundWindow(a, false);
        assert.ok(await pageA.evaluate(() => !!App.game.worker));
        await pageA.evaluate(() => { App.game.dreamOrbController.onlineTimeMs(20 * GameConstants.MINUTE); Save.store(player); });
        checks.push('A background client earns exactly one Dream Orb at the online threshold through the background game clock.');
        checks.push('Local game cold-starts without a network, has isolated storage/Web Locks, no renderer Node, and continues ticking in the background.');

        // Freeze only the frontier combat clock in this disposable fixture so real
        // buttons and settlement can be checked against a precise completed range.
        const frontierBefore = await pageA.evaluate(() => {
            window.frontierSmoke = { attack: BattleFrontierBattle.pokemonAttack, tick: BattleFrontierRunner.tick };
            BattleFrontierBattle.pokemonAttack = () => {};
            BattleFrontierRunner.tick = () => {};
            BattleFrontierMilestones.milestoneRewards.forEach(m => m.obtained(true));
            App.game.statistics.battleFrontierHighestStageCompleted(2000);
            App.game.statistics.battleFrontierTotalStagesCompleted(0);
            App.game.battleFrontier.enter();
            return { bp: App.game.wallet.currencies[GameConstants.Currency.battlePoint](), money: App.game.wallet.currencies[GameConstants.Currency.money]() };
        });
        const frontierPanel = pageA.locator('#battleFrontierInformation');
        await frontierPanel.getByRole('button', { name: 'Quick Challenge (Stage 1,901)', exact: true }).click();
        assert.equal(await pageA.locator('#auto-click-toggle').isVisible(), false);
        const frontierClickCount = await pageA.evaluate(() => {
            Settings.setSettingByName('ggzz.private.autoClickAttack', true);
            window.frontierClickStartedAt = performance.now();
            return App.game.statistics.clickAttacks();
        });
        await pageA.waitForFunction(() => performance.now() - window.frontierClickStartedAt >= 250);
        assert.equal(await pageA.evaluate(() => App.game.statistics.clickAttacks()), frontierClickCount);
        await pageA.evaluate(() => Settings.setSettingByName('ggzz.private.autoClickAttack', false));
        checks.push('Battle Frontier never receives auto click attacks, and its battle view hides the auto click toggle.');
        assert.deepEqual(await pageA.evaluate(() => ({ stage: BattleFrontierRunner.stage(), total: App.game.statistics.battleFrontierTotalStagesCompleted(), rewards: BattleFrontierRunner.pendingRewards() })),
            { stage: 1901, total: 0, rewards: { stages: 0, battlePoints: 0, money: 0 } });
        await pageA.evaluate(() => { for (let i = 0; i < 6; i++) BattleFrontierBattle.defeatPokemon(); });
        assert.ok((await frontierPanel.innerText()).includes('This run: 2 stages completed'));
        assert.ok((await frontierPanel.innerText()).includes('7,604'));
        await pageA.screenshot({ path: path.join(output, 'battle-frontier-rewards.png') });
        checks.push('The packaged Quick Challenge button skips to stage 1,901 with zero skipped rewards or completion count, then shows only the two actually cleared stages.');
        await frontierPanel.getByRole('button', { name: 'Pause & Save Progress', exact: true }).click();
        await pageA.locator('.modal.show').filter({ hasText: 'Pause Battle Frontier?' }).getByRole('button', { name: 'Pause', exact: true }).click();
        await pageA.waitForFunction(() => !BattleFrontierRunner.started() && !BattleFrontierRunner.confirmationPending());
        await pageA.waitForFunction(() => !document.querySelector('.modal[id^="modal"]'));
        assert.deepEqual(await pageA.evaluate(() => App.game.battleFrontier.toJSON().runStartStage), 1901);
        await frontierPanel.getByRole('button', { name: 'Resume (Stage 1,903)', exact: true }).click();
        await frontierPanel.getByRole('button', { name: 'Finish & Claim Rewards', exact: true }).click();
        await pageA.locator('.modal.show').filter({ hasText: 'Finish Battle Frontier?' }).getByRole('button', { name: 'Finish & Claim', exact: true }).click();
        await pageA.waitForFunction(() => !BattleFrontierRunner.started() && !BattleFrontierRunner.confirmationPending());
        await pageA.waitForFunction(() => !document.querySelector('.modal[id^="modal"]'));
        assert.deepEqual(await pageA.evaluate(before => ({
            bp: App.game.wallet.currencies[GameConstants.Currency.battlePoint]() - before.bp,
            money: App.game.wallet.currencies[GameConstants.Currency.money]() - before.money,
            checkpoint: BattleFrontierRunner.checkpoint(), start: BattleFrontierRunner.runStartStage(),
        }), frontierBefore), { bp: 76, money: 7604, checkpoint: 1, start: 1 });
        checks.push('Real Pause, Resume and Finish & Claim dialogs preserve the quick-run baseline and pay exactly 76 BP and 7,604 money once before clearing the checkpoint.');
        // Exercise the actual automation controls in the same disposable profile.
        const autoPanel = pageA.locator('#battleFrontierAutomation');
        await pageA.locator('#frontierAutomationMode').selectOption('fixed');
        await pageA.locator('#frontierAutomationTarget').fill('2');
        await pageA.locator('#frontierAutomationTarget').press('Tab');
        await autoPanel.getByRole('button', { name: 'Start Auto Challenge / Resume Saved Run', exact: true }).click();
        assert.equal(await pageA.evaluate(() => BattleFrontierRunner.runStartStage()), 1);
        await pageA.evaluate(() => { for (let i = 0; i < 6; i++) BattleFrontierBattle.defeatPokemon(); });
        assert.deepEqual(await pageA.evaluate(() => ({ cycles: BattleFrontierRunner.automation.cycles(), points: BattleFrontierRunner.automation.earnedPoints(), started: BattleFrontierRunner.started() })),
            { cycles: 1, points: 2, started: false });
        await pageA.waitForTimeout(1100);
        await pageA.evaluate(() => window.frontierSmoke.tick.call(BattleFrontierRunner));
        assert.equal(await pageA.evaluate(() => BattleFrontierRunner.started()), true);
        await pageA.evaluate(() => { for (let i = 0; i < 6; i++) BattleFrontierBattle.defeatPokemon(); });
        assert.equal(await pageA.evaluate(() => BattleFrontierRunner.automation.earnedPoints()), 4);
        await pageA.screenshot({ path: path.join(output, 'battle-frontier-automation.png') });
        await autoPanel.getByRole('button', { name: 'Stop Automation (Keep Current Run)', exact: true }).click();
        await pageA.waitForTimeout(1100);
        await pageA.evaluate(() => window.frontierSmoke.tick.call(BattleFrontierRunner));
        assert.equal(await pageA.evaluate(() => BattleFrontierRunner.started()), false);
        checks.push('Real fixed-stage automation controls claim two runs exactly once, restart after the delay, and respect Stop during the countdown.');

        // Vary output as breeding and hatching would; never touch real saves or queues.
        await pageA.evaluate(() => {
            window.frontierAutomationSmoke = { attack: App.game.party.calculatePokemonAttack, health: PokemonFactory.routeHealth, damage: 1000000 };
            App.game.party.calculatePokemonAttack = () => window.frontierAutomationSmoke.damage;
            PokemonFactory.routeHealth = stage => Math.floor((stage - 10) ** 2.53);
        });
        await pageA.locator('#frontierAutomationMode').selectOption('efficiency');
        await autoPanel.getByRole('button', { name: 'Start Auto Challenge / Resume Saved Run', exact: true }).click();
        const strongEnd = await pageA.evaluate(() => BattleFrontierRunner.automation.plannedEnd());
        await pageA.evaluate(() => { window.frontierAutomationSmoke.damage = 10000; });
        await pageA.waitForTimeout(5100);
        await pageA.evaluate(() => BattleFrontierRunner.automation.tick());
        const weakEnd = await pageA.evaluate(() => BattleFrontierRunner.automation.plannedEnd());
        assert.ok(weakEnd < strongEnd);
        await pageA.evaluate(() => { window.frontierAutomationSmoke.damage = 1000000; });
        await pageA.waitForTimeout(5100);
        await pageA.evaluate(() => BattleFrontierRunner.automation.tick());
        assert.ok(await pageA.evaluate(end => BattleFrontierRunner.automation.plannedEnd() > end, weakEnd));
        await autoPanel.getByRole('button', { name: 'Stop Automation (Keep Current Run)', exact: true }).click();
        await frontierPanel.getByRole('button', { name: 'Finish & Claim Rewards', exact: true }).click();
        await pageA.locator('.modal.show').filter({ hasText: 'Finish Battle Frontier?' }).getByRole('button', { name: 'Finish & Claim', exact: true }).click();
        await pageA.waitForFunction(() => !BattleFrontierRunner.started() && !BattleFrontierRunner.confirmationPending());
        await pageA.waitForFunction(() => !document.querySelector('.modal[id^="modal"]'));
        await pageA.evaluate(() => {
            App.game.party.calculatePokemonAttack = window.frontierAutomationSmoke.attack;
            PokemonFactory.routeHealth = window.frontierAutomationSmoke.health;
            delete window.frontierAutomationSmoke;
        });
        checks.push('Efficiency mode re-estimates the real enemy type distribution after attack drops and recovers, moving the next farming range down and up.');
        assert.equal(await pageA.evaluate(() => App.game.battleFrontier.toJSON().automation.mode), 'efficiency');
        checks.push('Automation saves its mode and target without persisting a running flag; normal quick-run checkpoints remain compatible.');
        await frontierPanel.getByRole('button', { name: 'Quick Challenge (Stage 1,901)', exact: true }).click();
        await pageA.evaluate(() => { for (let i = 0; i < 6; i++) BattleFrontierBattle.defeatPokemon(); });
        await frontierPanel.getByRole('button', { name: 'Pause & Save Progress', exact: true }).click();
        await pageA.locator('.modal.show').filter({ hasText: 'Pause Battle Frontier?' }).getByRole('button', { name: 'Pause', exact: true }).click();
        await pageA.waitForFunction(() => !BattleFrontierRunner.started() && !BattleFrontierRunner.confirmationPending());
        await pageA.waitForFunction(() => !document.querySelector('.modal[id^="modal"]'));
        await pageA.evaluate(() => {
            BattleFrontierBattle.pokemonAttack = window.frontierSmoke.attack;
            BattleFrontierRunner.tick = window.frontierSmoke.tick;
            delete window.frontierSmoke;
            Battle.generateNewEnemy();
            App.game.gameState = GameConstants.GameState.fighting;
            Save.store(player);
        });
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
        assert.deepEqual(await pageA.evaluate(key => {
            const settings = JSON.parse(localStorage.getItem('settings' + key));
            return { enabled: settings['ggzz.private.autoClickAttack'], rate: settings['ggzz.private.autoClickRate'] };
        }, keyA), { enabled: false, rate: 20 });
        checks.push('Auto click enabled state and chosen frequency remain in the saved profile after a desktop restart.');
        assert.equal(await pageA.evaluate(key => JSON.parse(localStorage.getItem('save' + key)).profile.name, keyA), 'Desktop fixture A');
        const restoredOrbs = await pageA.evaluate(key => JSON.parse(localStorage.getItem('save' + key))['dream-orbs'], keyA);
        assert.equal(restoredOrbs.orbs.find(orb => orb.color === 'Pink').amount, 9);
        assert.ok(restoredOrbs.onlineTimeMs >= 20 * 60000 && restoredOrbs.onlineTimeMs < 21 * 60000);
        const restartedFrontier = await pageA.evaluate(key => JSON.parse(localStorage.getItem('save' + key)).battleFrontier, keyA);
        assert.equal(restartedFrontier.checkpoint, 1903);
        assert.equal(restartedFrontier.runStartStage, 1901);
        checks.push('The quick-run checkpoint and original starting stage persist through closing and restarting the actual packaged EXE.');
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
        const probesBeforeUpload = requests.filter(request => request.path === '/api/cloud-save/status').length;
        let finishUpload;
        uploadGate = new Promise(resolve => { finishUpload = resolve; });
        await pageA.getByRole('button', { name: '上传 / 立即同步', exact: true }).click();
        await pageA.getByRole('button', { name: '关联此存档', exact: true }).click();
        await pageA.waitForFunction(() => {
            const text = document.getElementById('cloud-save-status').textContent;
            const seconds = text.match(/已等待 (\d+) 秒/);
            return text.includes('正在上传存档') && seconds && Number(seconds[1]) >= 2;
        }, undefined, { timeout: 15000 });
        assert.equal(await pageA.getByRole('button', { name: '上传 / 立即同步', exact: true }).isDisabled(), true);
        assert.equal(requests.filter(request => request.path === '/api/cloud-save/status').length, probesBeforeUpload);
        uploadGate = null;
        finishUpload();
        await status(pageA, '云端已确认保存');
        assert.equal(await pageA.getByRole('button', { name: '上传 / 立即同步', exact: true }).isDisabled(), false);
        checks.push('A delayed real Worker upload shows its current phase and elapsed time, blocks duplicate clicks, restores controls on completion and avoids a redundant status probe.');
        assert.equal(remote.envelope.payload.save.profile.name, 'Desktop fixture A');
        assert.equal(remote.envelope.revision, 1);
        assert.equal(remote.envelope.payload.settings['ggzz.private.pricingMode'], 'base-price');
        assert.equal(remote.envelope.payload.settings['ggzz.private.guidePathfinding'], 'optimized');
        assert.equal(remote.envelope.payload.settings['ggzz.private.drakeChestPriority'], 'epic');
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
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        await context.route('**/*', route => new URL(route.request().url()).origin === webOrigin ? route.continue() : route.abort());
        const web = await context.newPage();
        lastPage = web;
        await web.goto(webOrigin + '/');
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
        assert.equal(restoredSettings['ggzz.private.drakeChestPriority'], 'epic');
        assert.equal(restoredSettings['ggzz.private.guideFeeRate'], 0.01);
        assert.equal(restoredSettings['ggzz.private.fixedVitaminPurchased'], true);
        assert.equal(restoredSettings['ggzz.private.hatcherySlotLimit'], 4);
        assert.equal(restoredSettings.partyIDFilter, 9);
        assert.equal(restoredSettings.partyDisplayValue, 2);
        assert.deepEqual(restoredSettings.vitaminCategoryFilter, [1]);
        const restoredGame = await web.evaluate(key => JSON.parse(localStorage.getItem('save' + key)), webKey);
        assert.equal(restoredGame.battleFrontier.checkpoint, 1903);
        assert.equal(restoredGame.battleFrontier.runStartStage, 1901);
        checks.push('The same paused Battle Frontier run retains its starting stage and checkpoint through desktop-to-web cloud restoration.');
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
            globalThis.exportForSmoke = new Promise(resolve => {
                const timeout = setTimeout(() => resolve({ state: 'timeout' }), 30000);
                BrowserWindow.getAllWindows()[0].webContents.session.once('will-download', (_event, item) => {
                    item.setSavePath(target);
                    item.once('done', (_doneEvent, state) => {
                        clearTimeout(timeout);
                        resolve({ state, path: item.getSavePath() });
                    });
                });
            });
        }, exportFile);
        await panel(pageB);
        await pageB.getByRole('button', { name: '导出本地备份', exact: true }).click();
        assert.deepEqual(await b.evaluate(() => globalThis.exportForSmoke), { state: 'completed', path: exportFile });
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
        await captureWindow(b, help, 'offline-manual.png');
        assert.ok((await help.locator('body').innerText()).includes('同步后换设备'));
        assert.ok((await help.locator('#private-gameplay').innerText()).includes('原价的 1%'));
        assert.ok((await help.locator('#private-gameplay').innerText()).includes('Battle Frontier 快速挑战与主动结算'));
        assert.ok((await help.locator('.meta').innerText()).includes('桌面程序 ' + desktopVersion));
        await help.locator('#private-gameplay').evaluate(element => element.scrollIntoView());
        await captureWindow(b, help, 'private-gameplay-manual.png');
        checks.push('The Chinese operation manual, including private gameplay instructions, opens locally while offline.');
        await quit(b); await quit(a);
        assert.deepEqual(errors, []);
        checks.push('No uncaught renderer errors during the desktop acceptance flow.');
        await fs.writeFile(path.join(output, 'smoke-report.json'), JSON.stringify({ passed: true, executable, desktopVersion, packaged: !dev, backgroundTest, checks, elapsedSeconds: (Date.now() - startedAt) / 1000, requests: requests.filter(item => item.path.startsWith('/api/') || item.path.startsWith('/auth/')), note: 'Isolated fixtures only; this does not replace the user’s real two-device acceptance.' }, null, 2));
        console.log(JSON.stringify({ passed: true, checks }, null, 2));
    } catch (error) {
        console.error('SMOKE FAILED:', error.message);
        if (lastPage && !lastPage.isClosed()) {
            let diagnosticTimeout;
            const state = lastPage.evaluate(() => ({
                ready: document.readyState,
                app: typeof App === 'undefined' ? null : { starting: App.starting, loaded: !!App.game },
                cloud: typeof CloudSave === 'undefined' ? null : {
                    running: CloudSave.running, busy: CloudSave.busy, blocked: CloudSave.blocked,
                    writer: CloudSave.writer, profile: CloudSave.profileId, engine: !!CloudSave.engine,
                },
            })).catch(() => null);
            try {
                console.error('Renderer state:', await Promise.race([state, new Promise(resolve => {
                    diagnosticTimeout = setTimeout(() => resolve(null), 3000);
                })]));
            } finally {
                clearTimeout(diagnosticTimeout);
            }
        }
        if (lastPage && !lastPage.isClosed()) { console.error((await lastPage.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 7000)); await lastPage.screenshot({ path: path.join(output, 'failure.png'), timeout: 3000 }).catch(() => {}); }
        console.error('Renderer errors:', errors);
        throw error;
    } finally {
        clearInterval(progressTimer);
        for (const app of running) {
            const process = app.process();
            const timeout = setTimeout(() => {
                if (process.exitCode !== null) return;
                // 仅终止本脚本启动且使用隔离数据目录的进程树，避免退出等待一直占用资源。
                spawnSync('taskkill.exe', ['/PID', String(process.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
            }, 5000);
            try {
                await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
                await app.close().catch(() => {});
            } finally {
                clearTimeout(timeout);
            }
        }
        await browser?.close();
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
        webServer.closeAllConnections(); await new Promise(resolve => webServer.close(resolve));
    }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
