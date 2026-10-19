/* 使用完整游戏构建与隔离浏览器验证农场界面，不读取用户真实存档。 */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createServer } = require('node:http');
const root = path.resolve(__dirname, '../..');
const deps = process.env.FARM_PERF_DEPS || root;
const { chromium } = require(path.join(deps, 'desktop/node_modules/playwright'));
const build = path.join(root, 'build');
const output = path.join(root, 'output/playwright/farm-performance');

async function main() {
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        if (/^\/(api|auth)\//.test(url.pathname)) { res.writeHead(401); res.end('{}'); return; }
        const filename = path.resolve(build, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
        if (!filename.startsWith(build + path.sep)) { res.writeHead(403); res.end(); return; }
        try {
            const content = await fs.readFile(filename);
            const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(filename)];
            res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }); res.end(content);
        } catch { res.writeHead(404); res.end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let browser;
    const errors = [];
    try {
        browser = await chromium.launch({ channel: process.env.PC_BROWSER_CHANNEL || 'msedge', headless: true });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
        const origin = `http://127.0.0.1:${server.address().port}`;
        await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.stack || error.message));
        await page.goto(origin);
        await page.getByText('New Save', { exact: true }).click();
        await page.waitForFunction(() => typeof App !== 'undefined' && App.game?.statistics?.secondsPlayed && CloudSave.running);
        await page.evaluate(() => {
            // 本夹具只验收农场，跳过新手引导浮层及其全局缩放事件。
            Information.show = () => undefined;
            Information.hide = () => undefined;
        });
        await page.locator('#startSequenceModal').getByRole('button', { name: 'Next', exact: true }).click();
        await page.locator('#pickStarterTutorialModal input.image-starter').first().click();
        await page.evaluate(() => { Information.hide(); Battle.enemyPokemon().health(0); });
        await page.locator('#starterCaughtModal').getByRole('button', { name: 'Next', exact: true }).click();
        await page.evaluate(() => {
            Information.hide();
            App.game.keyItems.gainKeyItem(KeyItemType.Wailmer_pail, true);
            const farm = App.game.farming;
            farm.unlockedBerries.forEach(value => value(true));
            farm.berryInventory.forEach(value => value(1000));
            farm.getFarmPlots(0).forEach(plot => { plot.isUnlocked = true; plot.plant(BerryType.Wacan); });
            App.game.wallet.currencies[GameConstants.Currency.farmPoint](1e9);
            farm.buyFarm();
            farm.selectedFarm(0);
        });
        assert.equal(await page.locator('#farmModal .plotButton').count(), 0);
        await page.evaluate(() => $('#plotListCard').collapse('hide'));
        await page.waitForFunction(() => document.querySelectorAll('#plotListCard .plotButton').length === 0);
        await page.evaluate(() => $('#plotListCard').collapse('show'));
        await page.waitForFunction(() => document.querySelectorAll('#plotListCard .plotButton').length === 25);
        await page.evaluate(() => FarmController.openFarmModal());
        await page.locator('#farmView').waitFor();
        assert.equal(await page.locator('#farmLayoutView .farm-layout-cell').count(), 0);
        await page.locator('#farmModal a[href="#farmLayoutView"]').click();
        await page.waitForFunction(() => document.querySelectorAll('#farmLayoutView .farm-layout-cell').length === 25);
        assert.equal(await page.locator('#plotList .plotButton').count(), 0);
        assert.equal(await page.locator('#farmLayoutSaved option').count(), 1);
        await page.evaluate(() => {
            const plan = FarmLayoutPlan.createPreset('passho-rows', BerryType.Cheri);
            plan.notes = ['隔离浏览器收藏验证'];
            App.game.farming.farms()[0].layout.setPlan(plan);
        });
        await page.locator('#farmLayoutSavedName').fill('浏览器收藏');
        await page.getByRole('button', { name: '保存当前布局', exact: true }).click();
        const saved = await page.evaluate(() => App.game.farming.savedLayouts()[0]);
        assert.equal(saved.plan.name, '浏览器收藏');
        await page.locator('#activeFarm').selectOption('1');
        await page.locator('#farmLayoutSaved').selectOption(String(saved.id));
        assert.equal(await page.evaluate(() => App.game.farming.farms()[1].layout.plan().cells.every(cell => cell.role === 'ignore')), true);
        await page.getByRole('button', { name: '应用为预览', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => App.game.farming.farms()[1].layout.plan().cells), saved.plan.cells);
        assert.equal(await page.evaluate(() => App.game.farming.farms()[1].layout.enabled()), false);
        await page.locator('#farmLayoutSavedName').fill('浏览器重命名');
        await page.getByRole('button', { name: '重命名所选', exact: true }).click();
        await page.evaluate(() => Save.store(player));
        assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem(`save${Save.key}`)).farming.savedLayouts[0].plan.name), '浏览器重命名');
        await page.evaluate(() => $('#farmModal').modal('hide'));
        await page.waitForFunction(() => document.querySelectorAll('#farmModal .farm-layout-cell').length === 0);
        await page.evaluate(() => FarmController.openFarmModal());
        await page.locator('#farmLayoutSaved').waitFor();
        assert.equal(await page.locator('#farmModal a[href="#farmLayoutView"]').getAttribute('class').then(value => value.includes('active')), true);
        await page.locator('#farmModal a[href="#berryFarmView"]').click();
        await page.locator('#farmView').waitFor();
        await page.locator('#farmModal a[href="#mulches"]').click();
        await page.locator('#farmModal a[href="#farmHandsView"]').click();
        await page.locator('#farmModal a[href="#berryFarmView"]').click();
        await page.locator('#mulches.active').waitFor();
        // 反复悬停与卸载，确保提示内容存在且不会留下悬浮层。
        await page.locator('#activeFarm').selectOption('0');
        await page.locator('#plotList .plotButton').first().hover();
        await page.locator('.tooltip.show').waitFor();
        assert.match(await page.locator('.tooltip.show').innerText(), /Wacan/);
        await page.locator('#farmModal a[href="#farmLayoutView"]').click();
        await page.waitForFunction(() => document.querySelectorAll('.tooltip.show').length === 0);
        await page.evaluate(() => $('#toaster .toast').toast('hide'));
        await page.waitForFunction(() => document.querySelectorAll('#toaster .toast.show').length === 0);
        await fs.mkdir(output, { recursive: true });
        await page.screenshot({ path: path.join(output, 'ui-final-desktop.png') });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.screenshot({ path: path.join(output, 'ui-final-mobile.png') });
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert.equal(overflow, false);
        assert.deepEqual(errors, []);
        const result = { passed: true, isolatedSave: true, errors, checks: ['折叠卸载', '隐藏窗口卸载', '按页签挂载', '空收藏', '命名保存', '跨田选择不隐式应用', '应用为暂停预览', '重命名', '真实本地保存', '重开保留页签', '工具子页签保持', '悬停提示与卸载', '390px布局'] };
        await fs.writeFile(path.join(output, 'ui-smoke.json'), JSON.stringify(result, null, 2), 'utf8');
        console.log(JSON.stringify(result));
    } finally {
        await browser?.close();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
