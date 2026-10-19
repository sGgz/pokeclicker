/* 隔离农场界面性能复现：使用人工数据、真实绑定与真实自动点击计时器，不读取游戏存档。 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const deps = process.env.FARM_PERF_DEPS || root;
const { chromium } = require(path.join(deps, 'desktop/node_modules/playwright'));
const { buildSync } = require(path.join(deps, 'cloud-save-worker/node_modules/esbuild'));
const ts = require(path.join(deps, 'node_modules/typescript'));
const { JSDOM } = require(path.join(deps, 'node_modules/jsdom'));
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const javascript = source => ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
}).outputText;

function sourceScripts() {
    const added = new Set();
    const ordered = [];
    function add(file) {
        if (added.has(file)) return;
        added.add(file);
        const source = fs.readFileSync(file, 'utf8');
        for (const match of source.matchAll(/<reference path="([^"]+)"/g)) {
            const referenced = path.resolve(path.dirname(file), match[1]);
            if (referenced.startsWith(path.join(root, 'src/scripts/farming')) && fs.existsSync(referenced)) add(referenced);
        }
        ordered.push(javascript(source));
    }
    for (const file of ['FarmHand.ts', 'Plot.ts', 'FarmLayout.ts', 'mutation/Mutation.ts']) {
        add(path.join(root, 'src/scripts/farming', file));
    }
    for (const file of fs.readdirSync(path.join(root, 'src/scripts/farming/mutation/mutationTypes'))) {
        if (file.endsWith('.ts')) add(path.join(root, 'src/scripts/farming/mutation/mutationTypes', file));
    }
    for (const file of ['Farming.ts', 'FarmController.ts', 'FarmLayoutController.ts']) add(path.join(root, 'src/scripts/farming', file));
    ordered.push(javascript(read('src/scripts/AutoClicker.ts')));
    return ordered.join('\n');
}

function bootstrap() {
    const settings = new Map();
    const initialSettings = { showFarmModule: 'limited', farmDisplay: 'remaining', farmBoostDisplay: false };
    const counts = {};
    const statistic = new Proxy({}, { get: (obj, key) => obj[key] ?? (obj[key] = /^(berries|mulches|pokemonCaptured)/.test(key)
        ? Array.from({ length: 1200 }, () => ko.observable(0)) : ko.observable(0)) });
    const requirement = class { isCompleted() { return true; } hint() { return ''; } };
    const battle = { CLICK_ATTACK_INTERVAL: 50, lastClickAttack: 0, catching: () => false,
        enemyPokemon: () => ({ isAlive: () => true }), clickAttack() { this.lastClickAttack = Date.now(); fixture.attacks++; } };
    Object.assign(window, {
        App: { game: { gameState: GameConstants.GameState.fighting, farming: null,
            wallet: { hasAmount: () => true, loseAmount: () => true, gainFarmPoints: () => {}, currencies: Array.from({ length: 20 }, () => ko.observable(1e9)) },
            statistics: statistic, oakItems: { use: () => {}, isActive: () => false, calculateBonus: () => 1 },
            keyItems: { hasKeyItem: () => true }, quests: { getQuestLine: () => ({ state: () => 2 }) }, logbook: { newLog: () => {} } } },
        GameHelper: { enumLength: obj => Object.values(obj).filter(v => typeof v === 'number').length,
            enumNumbers: obj => Object.values(obj).filter(v => typeof v === 'number'),
            incrementObservable: (o, n = 1) => o(o() + n), shallowEqual: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
        Settings: { getSetting(name) { if (!settings.has(name)) settings.set(name, { observableValue: ko.observable(initialSettings[name] ?? false) }); return settings.get(name); } },
        GameController: { keyHeld: { Shift: ko.observable(false) } },
        KeyItemType: { Wailmer_pail: 0 }, QuestLineState: { inactive: 0, ended: 2 },
        Amount: class { constructor(amount, currency) { this.amount = amount; this.currency = currency; } },
        TotalBerriesUnlockedRequirement: requirement, UniqueItemOwnedRequirement: requirement,
        SeededRand: { state: 1, seed(value) { this.state = value; }, intBetween: () => 1, fromArray: values => values[0] },
        Rand: { chance: () => false, fromArray: values => values[0] },
        player: { trainerId: '12345', lowerItemMultipliers: () => {}, highestRegion: () => 0 },
        PokemonHelper: { getPokemonByName: () => ({ id: 1 }), displayName: name => name },
        Notifier: { notify: () => {} }, NotificationConstants: { NotificationOption: {}, NotificationSetting: { Farming: {} } },
        MultiplierDecreaser: { Berry: 0 }, WandererPokemon: { fromJSON: () => undefined },
        PrivateGameplay: { autoClickEnabled: () => true, autoClickRate: () => 20, autoMineEnabled: () => false },
        Battle: battle,
        ItemList: new Proxy({}, { get: (_, key) => ({ description: key, displayName: key, image: '' }) }),
        fixture: { counts, attacks: 0 },
    });
    const collapsed = ko.observable('show');
    const modalShown = ko.observable('hidden');
    window.DisplayObservables = {
        collapseState: new Proxy({}, { get: (_, key) => key.endsWith('Observable') ? collapsed : collapsed() }),
        modalState: new Proxy({}, { get: () => modalShown() }),
    };
    fixture.collapsed = collapsed;
    fixture.modalShown = modalShown;
    fixture.initialize = () => {
        const farming = new Farming({ addBonus: () => {}, getBonus: () => 1 });
        App.game.farming = farming;
        farming.unlockedBerries.forEach(value => value(true));
        farming.berryInventory.forEach(value => value(1000));
        farming.getFarmPlots(0).forEach(plot => { plot.isUnlocked = true; });
        for (let index = 1; index < fixture.farms; index++) farming.buyFarm();
        farming.selectedFarm(0);
        farming.initialize();
        FarmController.initialize();
        const plants = [BerryType.Wacan, BerryType.Passho, BerryType.Lum, BerryType.Rindo, BerryType.Custap,
            BerryType.Chople, BerryType.Payapa, BerryType.Haban, BerryType.Roseli, BerryType.Enigma];
        farming.farms().forEach(farm => farm.plots.forEach((plot, index) => {
            plot.plant(plants[index % plants.length]);
            plot.age = BerryList[plot.berry].growthTime[2] + 1;
        }));
        if (fixture.layout) {
            const plan = FarmLayoutPlan.createPreset('passho-rows', BerryType.Liechi);
            farming.farms().forEach(farm => {
                farm.layout.setPlan(plan);
                const hand = farm.hands.list.find(candidate => candidate.name === 'Jessie');
                hand.gainExperience(122500);
                hand.plots(Array.from({ length: 25 }, (_, index) => index));
                hand.hired(true);
                farm.layout.enabled(true);
                farm.plots.forEach((plot, index) => {
                    plot.plant(plan.cells[index].berry);
                    if (fixture.empty && index % 5 === 2) plot.berry = BerryType.None;
                    else plot.age = BerryList[plot.berry].growthTime[2] + 1;
                });
            });
        }
        for (const name of ['getFarmPlots', 'berryInFarm']) {
            const original = farming[name];
            farming[name] = function (...args) { counts[name] = (counts[name] || 0) + 1; return original.apply(this, args); };
        }
        for (const mutation of farming.mutations) {
            const original = mutation.getMutationPlots;
            mutation.getMutationPlots = function (...args) { counts.mutationScans = (counts.mutationScans || 0) + 1; return original.apply(this, args); };
        }
        const tooltipSource = ko.bindingHandlers.tooltip.update;
        ko.bindingHandlers.tooltip.update = function (...args) { counts.tooltipUpdates = (counts.tooltipUpdates || 0) + 1; return tooltipSource.apply(this, args); };
        fixture.farming = farming;
        farming.farms().forEach(farm => farm.plots.forEach(plot => {
            const tooltip = plot.tooltip;
            plot.tooltip = () => { counts.tooltipEvaluations = (counts.tooltipEvaluations || 0) + 1; return tooltip(); };
        }));
    };
    fixture.bind = (kind, markup) => {
        const target = document.getElementById('fixture');
        ko.cleanNode(target);
        fixture.collapsed(kind === 'collapsed' ? 'hidden' : 'show');
        fixture.modalShown(kind === 'modal' || kind === 'layout' ? 'show' : 'hidden');
        FarmController.farmingModalTabSelected(kind === 'layout' ? 'farmLayoutView' : 'berryFarmView');
        target.innerHTML = markup;
        ko.applyBindings(window, target);
        if (kind === 'collapsed') document.getElementById('plotListCard').style.display = 'none';
        const modal = document.getElementById('farmModal');
        if (modal) modal.style.display = kind === 'modal' || kind === 'layout' ? 'block' : 'none';
    };
    fixture.measure = async (milliseconds) => {
        Object.keys(counts).forEach(key => { counts[key] = 0; });
        fixture.attacks = 0;
        const tickDurations = [];
        const started = performance.now();
        let ticks = 0;
        const timer = setInterval(() => {
            const began = performance.now();
            fixture.farming.update(0.1);
            tickDurations.push(performance.now() - began);
            ticks++;
        }, 100);
        AutoClicker.start();
        await new Promise(resolve => setTimeout(resolve, milliseconds));
        clearInterval(timer);
        AutoClicker.stop();
        const elapsed = performance.now() - started;
        const sorted = [...tickDurations].sort((a, b) => a - b);
        return { elapsed: Math.round(elapsed), ticks, attacks: fixture.attacks,
            attacksPerSecond: fixture.attacks / elapsed * 1000,
            tickMean: tickDurations.reduce((a, b) => a + b, 0) / Math.max(1, ticks),
            tickP95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0,
            counts: { ...counts }, domNodes: document.querySelectorAll('*').length };
    };
}

function browserBundle() {
    const modules = path.join(root, 'src/modules').replaceAll('\\', '/');
    const imports = [`import * as GameConstants from ${JSON.stringify(`${modules}/GameConstants.ts`)};`,
        `import { BerryList } from ${JSON.stringify(`${modules}/farming/BerryList.ts`)};`,
        `import FarmLayoutPlan from ${JSON.stringify(`${modules}/farming/FarmLayoutPlan.ts`)};`];
    const names = ['BerryType', 'MulchType', 'PlotStage', 'AuraType', 'FarmNotificationType', 'FarmingTool', 'SizeUnits', 'OakItemType'];
    for (const name of names) imports.push(`import ${name} from ${JSON.stringify(`${modules}/enums/${name}.ts`)};`);
    const bindings = read('src/modules/koBindingHandlers.ts');
    const tooltip = bindings.slice(bindings.indexOf('const tooltipHandler ='), bindings.indexOf('\nObject.assign(ko.bindingHandlers,', bindings.indexOf('const tooltipHandler =')));
    const content = `${imports.join('\n')}\nObject.assign(window,{ GameConstants, BerryList, FarmLayoutPlan, ${names.join(',')} });\n`
        + javascript(read('src/modules/koExtenders.ts')) + '\n' + `(${bootstrap.toString()})();\n` + sourceScripts()
        + `\n${javascript(tooltip)}\nko.bindingHandlers.tooltip = tooltipHandler;\n`
        + (tooltip.includes('lazyTooltipHandler') ? 'ko.bindingHandlers.lazyTooltip = lazyTooltipHandler;\n' : '')
        + `Object.assign(window,{ Farming, Plot, FarmLayout, FarmController, FarmLayoutController, AutoClicker, FarmHands, FarmHandBerryTypes });`;
    return buildSync({ stdin: { contents: content, resolveDir: root, loader: 'js' }, bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' }).outputFiles[0].text;
}

async function main() {
    const browser = await chromium.launch({ channel: process.env.PC_BROWSER_CHANNEL || 'msedge', headless: true });
    const context = await browser.newContext();
    await context.route('**/*', route => route.fulfill({ status: 200, body: '' }));
    const page = await context.newPage();
    if (+process.env.FARM_PERF_CPU > 1) {
        const session = await context.newCDPSession(page);
        await session.send('Emulation.setCPUThrottlingRate', { rate: +process.env.FARM_PERF_CPU });
    }
    const errors = [];
    page.on('pageerror', error => errors.push(error.stack || error.message));
    const display = read('src/components/farmDisplay.html');
    const modalSource = read('src/components/farmModal.html');
    const modal = new JSDOM(modalSource).window.document.querySelector('#plotList').outerHTML;
    const results = {};
    try {
        await page.setContent('<!doctype html><html><head><style>.plot{display:inline-block;width:70px}.plotImage{position:relative;width:70px;height:70px}.row{max-width:350px}.w-100{display:block}</style></head><body><script type="text/html" id="currencyTemplate"><span data-bind="text: amount"></span></script><main id="fixture"></main></body></html>');
        for (const file of ['knockout/build/output/knockout-latest.js', 'jquery/dist/jquery.min.js', 'popper.js/dist/umd/popper.min.js', 'bootstrap/dist/js/bootstrap.min.js']) {
            await page.addScriptTag({ content: fs.readFileSync(path.join(deps, 'node_modules', file), 'utf8') });
        }
        await page.addScriptTag({ content: browserBundle() });
        await page.evaluate(options => { Object.assign(fixture, options); fixture.initialize(); },
            { farms: +(process.env.FARM_PERF_FARMS || 1), layout: process.env.FARM_PERF_LAYOUT === '1', empty: process.env.FARM_PERF_EMPTY === '1' });
        for (const kind of ['collapsed', 'expanded', 'modal', 'layout', 'collapsedAgain']) {
            const markup = process.env.FARM_PERF_FULL === '1' ? display + modalSource : kind === 'modal' ? modal : display;
            await page.evaluate(({ kind, markup }) => fixture.bind(kind === 'collapsedAgain' ? 'collapsed' : kind, markup), { kind, markup });
            await page.waitForTimeout(100);
            results[kind] = await page.evaluate(duration => fixture.measure(duration), +(process.env.FARM_PERF_MS || 1800));
            console.log(kind, JSON.stringify(results[kind]));
        }
        const expandedRatio = results.expanded.tickMean / results.collapsed.tickMean;
        const recovery = results.collapsedAgain.attacksPerSecond;
        console.log(`展开/折叠 tick 耗时比 ${expandedRatio.toFixed(2)}，折叠恢复 ${recovery.toFixed(2)} 次攻击/秒。`);
        const output = path.join(root, 'output/playwright/farm-performance');
        fs.mkdirSync(output, { recursive: true });
        fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify({ farms: +(process.env.FARM_PERF_FARMS || 1), results, expandedRatio, errors }, null, 2), 'utf8');
        assert.deepEqual(errors, [], '性能测量期间不应发生页面异常');
        if (!process.argv.includes('--measure-only')) {
            assert.ok(results.collapsed.attacksPerSecond >= 16, '隔离基线应接近 20 次攻击/秒');
            assert.ok(results.expanded.attacksPerSecond >= 16, '展开农场后不应拖慢自动攻击至 16 次/秒以下');
            assert.ok(results.modal.attacksPerSecond >= 16, '农场详情不应拖慢自动攻击至 16 次/秒以下');
            assert.ok(results.layout.attacksPerSecond >= 16, '布局页不应拖慢自动攻击至 16 次/秒以下');
            assert.ok(recovery >= 16, '关闭详情并折叠后应恢复正常自动攻击');
            assert.ok(expandedRatio < 4, '展开农场后每 tick 耗时不应达到折叠时的四倍');
            for (const result of Object.values(results)) {
                assert.equal(result.counts.tooltipEvaluations || 0, 0, '未悬停时不应计算农田格子提示');
            }
        }
    } finally {
        await browser.close();
    }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
