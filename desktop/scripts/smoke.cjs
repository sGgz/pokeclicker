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
        const keyA = await pageA.evaluate(() => Save.key);
        const seconds = await pageA.evaluate(() => App.game.statistics.secondsPlayed());
        await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
        await pageA.waitForFunction(start => App.game.statistics.secondsPlayed() >= start + 2, seconds, { timeout: 15000, polling: 200 });
        await a.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
        assert.ok(await pageA.evaluate(() => !!App.game.worker));
        checks.push('Packaged local game cold-starts without a network, has isolated storage/Web Locks, no renderer Node, and continues ticking while minimized.');
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
        checks.push('The packaged Chinese operation manual opens locally while offline.');
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
