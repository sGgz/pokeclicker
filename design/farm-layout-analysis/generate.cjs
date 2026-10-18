/* 农场攻略的离线计算工具，只读游戏源码，不修改游戏或真实存档。 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const deps = process.env.FARM_ANALYSIS_DEPS || 'E:/myCode/pokeclicker/node_modules';
const ts = require(path.join(deps, 'typescript'));
const ko = require(path.join(deps, 'knockout'));
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);
const load = file => require(path.join(root, 'src/modules', file));
const { BerryList } = load('farming/BerryList.ts');
const BerryType = load('enums/BerryType.ts').default;
const MulchType = load('enums/MulchType.ts').default;
const PlotStage = load('enums/PlotStage.ts').default;
const AuraType = load('enums/AuraType.ts').default;
const GameConstants = load('GameConstants.ts');
const FarmLayoutPlan = load('farming/FarmLayoutPlan.ts').default;
const enums = name => load(`enums/${name}.ts`).default;
const neighbour = Array.from({ length: 25 }, (_, i) => Array.from({ length: 25 }, (_, j) => j)
    .filter(j => j !== i && Math.abs(i % 5 - j % 5) <= 1 && Math.abs(Math.floor(i / 5) - Math.floor(j / 5)) <= 1));
const hands = [
    ['Alex', 750, 25, 140], ['Logan', 385.2, 25, 440], ['Joey', 202.8, 25, 630],
    ['Charlie', 141.9, 25, 910], ['Bailey', 101.4, 25, 1300], ['Kerry', 71, 25, 1900],
    ['Riley', 50.7, 50, 4000], ['Jamie', 30.5, 25, 4000], ['Jessie', 20.3, 50, 8300],
].map(([name, seconds, actions, wages]) => ({ name, seconds, actions, wages }));
const options = { growth: +(process.env.FARM_GROWTH || 2.75), duration: 4.5, seed: 20261018,
    restarts: +(process.env.FARM_RESTARTS || 8), iterations: +(process.env.FARM_ITERATIONS || 700) };
let seed = options.seed;
function random() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; }
const T = -2;
const support = [BerryType.Passho, BerryType.Wacan, BerryType.Lum];
const mulchOptions = [MulchType.Rich_Mulch, MulchType.Amaze_Mulch, MulchType.Boost_Mulch];
function actual(board, berry) { return board.map(b => b === T ? berry : b); }
function planFor(board, berry, mulch, name) {
    return { version: 1, name, cells: board.map(b => ({ role: b === T ? 'cycle' : 'keep', berry: b === T ? berry : b,
        targetBerry: -1, mulch: b === T ? mulch : -1, freezeStage: 4 })) };
}
function multipliers(board, berry) {
    const plants = actual(board, berry);
    const boost = plants.map((b, i) => b !== BerryType.Lum && neighbour[i].some(j => plants[j] === BerryType.Lum) ? 1.03 : 1);
    // 生产株不断收割，搜索阶段只近似其生长期平均光环；实际工作链复核使用真实阶段。
    return board.map((b, i) => {
        let growth = 1, harvest = 1;
        neighbour[i].forEach(j => {
            const data = BerryList[plants[j]];
            if (!data?.aura) return;
            const stage = board[j] === T ? 1 : 2;
            let value = data.aura.auraMultipliers[stage];
            if (board[j] === T) value = Math.sqrt(data.aura.auraMultipliers[0] * data.aura.auraMultipliers[1]);
            value = value > 1 ? value * boost[j] : value / boost[j];
            if (data.aura.auraType === AuraType.Growth) growth *= value;
            if (data.aura.auraType === AuraType.Harvest) harvest *= value;
        });
        return { growth, harvest };
    });
}
function analytic(board, berry, mulch, hand, objective = 'berries') {
    const data = BerryList[berry];
    const speed = mulch === 0 ? 1.5 : mulch === 3 ? 1.25 : 1;
    const amount = mulch === 1 ? 2 : mulch === 3 ? 1.5 : 1;
    const m = multipliers(board, berry);
    let total = 0, count = 0;
    board.forEach((b, i) => {
        if (b !== T) return;
        count++;
        const harvested = Math.floor(Math.max(1, data.harvestAmount * amount * m[i].harvest));
        const maturity = data.growthTime[3] / (options.growth * speed * m[i].growth);
        const cycle = Math.max(1, Math.ceil((maturity - 1e-8) / hand.seconds)) * hand.seconds;
        total += (objective === 'berries' ? harvested - 1 : data.farmValue) / cycle * 3600;
    });
    const capacity = hand.actions / 2;
    // 高密度生产时25动作助手会分轮种收，不能套用单轮周期。
    if (count > capacity) total *= capacity / count;
    return objective === 'coins' ? total - hand.wages : total;
}
function candidates(berry, objective = 'berries') {
    seed = (options.seed ^ Math.imul(berry + 1, 0x9e3779b9) ^ (objective === 'coins' ? 0x5f3759df : 0)) >>> 0;
    const unique = new Map();
    const add = (board, mulch, hand) => {
        const plan = planFor(board, berry, mulch, `${BerryType[berry]} 量产`);
        const key = JSON.stringify([board, mulch, hand.name]);
        if (!unique.has(key)) unique.set(key, { board: [...board], berry, mulch, hand: hand.name,
            score: analytic(board, berry, mulch, hand, objective), plan });
    };
    const allowed = [T, ...support.filter(b => b !== berry)];
    const protectedBerry = ['Enigma', 'Occa', 'Kebia', 'Colbur', 'Chople', 'Tamato', 'Cornn', 'Magost', 'Rabuta', 'Nomel', 'Spelon', 'Pamtre', 'Watmel'].includes(BerryType[berry]);
    const fixed = new Map([[0, BerryType.Petaya], ...(protectedBerry ? [6, 8, 16, 18].map(i => [i, BerryType.Babiri]) : [])]);
    const workingHands = objective === 'coins' ? hands : hands.filter(h => ['Jessie', 'Jamie', 'Riley'].includes(h.name));
    for (const mulch of mulchOptions) {
        if (!protectedBerry) for (const hand of workingHands) add(new Array(25).fill(T), mulch, hand);
        for (let restart = 0; restart < options.restarts; restart++) {
            let board = Array.from({ length: 25 }, (_, i) => fixed.get(i) ?? (restart === 0 || random() < 0.58 ? T : allowed[1 + Math.floor(random() * (allowed.length - 1))]));
            const hand = workingHands[restart % workingHands.length];
            let score = analytic(board, berry, mulch, hand, objective);
            let best = score, bestBoard = [...board];
            for (let iteration = 0; iteration < options.iterations; iteration++) {
                const i = Math.floor(random() * 25), before = board[i];
                const j = Math.floor(random() * 25), other = board[j];
                const swap = random() < 0.22;
                if (fixed.has(i) || (swap && fixed.has(j))) continue;
                if (swap) { board[i] = other; board[j] = before; } else board[i] = allowed[Math.floor(random() * allowed.length)];
                const next = analytic(board, berry, mulch, hand, objective);
                const temperature = Math.max(0.00001, Math.abs(score) * 0.045 * (1 - iteration / options.iterations));
                if (next >= score || random() < Math.exp((next - score) / temperature)) score = next;
                else { board[i] = before; if (swap) board[j] = other; }
                if (score > best) { best = score; bestBoard = [...board]; }
            }
            for (const compareHand of workingHands) add(bestBoard, mulch, compareHand);
        }
    }
    // 同时保留带Petaya的布局，真实工作链再淘汰成熟期不够的纯静态高分阵。
    return [...unique.values()].sort((a, b) => b.score - a.score);
}

ko.extenders.numeric = observable => observable;
ko.extenders.boolean = observable => observable;
// 光环的50ms节流服务界面；离线事件仿真立即传播，消除真实墙钟时间的影响。
ko.extenders.rateLimit = observable => observable;
const scripts = ['FarmHand.ts', 'Plot.ts', 'FarmLayout.ts', 'Farming.ts'].map(file => ts.transpileModule(
    fs.readFileSync(path.join(root, 'src/scripts/farming', file), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText).join('\n');
function setup(candidate) {
    const metric = { coins: 0, harvests: 0, planted: 0, gross: 0, mulches: 0, mulchCost: 0, deaths: 0 };
    const statistics = new Proxy({}, { get: (target, prop) => target[prop] ?? (target[prop] = /^(berries|mulches)/.test(String(prop))
        ? Array.from({ length: 100 }, () => ko.observable(0)) : ko.observable(0)) });
    const app = { game: { farming: null, wallet: { hasAmount: () => true, loseAmount: () => true,
        gainFarmPoints: amount => { metric.coins += amount; } }, statistics,
    oakItems: { use: () => {}, calculateBonus: type => type === 0 ? options.growth : type === 1 ? options.duration : 1 }, logbook: { newLog: () => {} } } };
    const requirement = class { isCompleted() { return true; } };
    const classes = vm.runInNewContext(`${scripts}\n({ Farming, FarmHand, Plot });`, {
        ko, GameConstants, GameHelper: { enumLength: obj => Object.values(obj).filter(v => typeof v === 'number').length,
            enumNumbers: obj => Object.values(obj).filter(v => typeof v === 'number'), incrementObservable: (o, n) => o(o() + n) },
        Amount: class { constructor(amount, currency) { this.amount = amount; this.currency = currency; } },
        BerryType, BerryList, MulchType, PlotStage, AuraType, FarmLayoutPlan,
        FarmNotificationType: enums('FarmNotificationType'), FarmingTool: enums('FarmingTool'), SizeUnits: enums('SizeUnits'),
        SeededRand: { seed: () => {}, intBetween: () => 1 }, App: app,
        Notifier: { notify: () => {} }, NotificationConstants: { NotificationOption: {}, NotificationSetting: { Farming: {} } },
        TotalBerriesUnlockedRequirement: requirement, UniqueItemOwnedRequirement: requirement, Rand: { chance: () => false },
        WandererPokemon: { fromJSON: () => undefined }, OakItemType: { Sprayduck: 0, Sprinklotad: 1, Squirtbottle: 2 },
        MultiplierDecreaser: { Berry: 0 }, player: { lowerItemMultipliers: () => {}, trainerId: '12345' },
        Settings: { getSetting: () => ({ observableValue: () => false }) },
    });
    const farm = new classes.Farming({ addBonus: () => {}, getBonus: () => 1 });
    app.game.farming = farm;
    farm.unlockedBerries.forEach(o => o(true));
    farm.berryInventory.forEach(o => o(1e10));
    farm.mulchList.forEach(o => o(1e10));
    const plots = farm.getFarmPlots(0);
    plots.forEach(p => { p.isUnlocked = true; });
    let refresh = () => {};
    if (process.env.FARM_NO_AURA_CACHE !== '1') {
        // 以源码同公式缓存派生光环，植物/阶段/肥料变化后失效，避免KO反复遍历邻格。
        const auras = plots.map(() => ({}));
        refresh = () => {
            const types = plots.map(p => p.stage() >= 2 && p.mulch !== 4 ? BerryList[p.berry]?.aura?.auraType ?? null : null);
            const bases = plots.map((p, i) => types[i] === null ? 1 : BerryList[p.berry].aura.getAuraValue(p.stage()));
            const boosts = plots.map((p, i) => p.berry === BerryType.Lum ? 1 : Math.max(1, ...neighbour[i]
                .filter(j => types[j] === AuraType.Boost).map(j => bases[j])));
            const values = bases.map((b, i) => b > 1 ? b * boosts[i] : b / boosts[i]);
            plots.forEach((p, i) => {
                const a = auras[i];
                a.type = types[i]; a.value = types[i] === null ? null : values[i]; a.boost = boosts[i];
                for (const [label, type] of [['growth', 0], ['harvest', 3], ['mutation', 2], ['replant', 1], ['decay', 11]]) {
                    a[label] = neighbour[i].filter(j => types[j] === type).reduce((v, j) => v * values[j], 1);
                }
                a.death = p.berry === BerryType.Kasib ? 1 : Math.max(1, ...neighbour[i].filter(j => types[j] === AuraType.Death).map(j => values[j]));
            });
        };
        plots.forEach((p, i) => {
            p.stage = () => p.berry === -1 ? 0 : BerryList[p.berry].growthTime.findIndex(t => p.age < t);
            for (const label of ['growth', 'harvest', 'mutation', 'replant', 'decay', 'death', 'boost']) {
                p[`aura${label[0].toUpperCase()}${label.slice(1)}`] = () => auras[i][label] ?? 1;
            }
            p.emittingAura = { type: () => auras[i].type, value: () => auras[i].value };
        });
        refresh();
    }
    farm.farms()[0].layout.setPlan(candidate.plan);
    farm.farms()[0].layout.enabled(true);
    const primary = farm.farmHands.list.find(h => h.name === candidate.hand);
    primary.gainExperience(122500);
    primary.hired(true);
    // 辅助格由不重叠的另一名助手负责，缩短维护延迟且避免抢走生产格。
    const secondary = farm.farmHands.list.find(h => h.name === (candidate.auxHand && candidate.auxHand !== 'self' ? candidate.auxHand : candidate.hand === 'Jessie' ? 'Jamie' : 'Jessie'));
    secondary.gainExperience(122500);
    const production = candidate.board.flatMap((b, i) => b === T ? [i] : []);
    const auxiliary = candidate.board.flatMap((b, i) => b !== T ? [i] : []);
    const selfMaintained = candidate.auxHand === 'self';
    primary.plots(selfMaintained ? Array.from({ length: 25 }, (_, i) => i) : production);
    primary.workTicks(0);
    if (auxiliary.length && !selfMaintained) { secondary.plots(auxiliary); secondary.hired(true); secondary.workTicks(0); }
    const employed = [primary, ...(auxiliary.length && !selfMaintained ? [secondary] : [])];
    const periods = employed.map(h => Math.ceil(h.workTick / 100 - 1e-10));
    const nextWorks = periods.map(() => 1);
    // 测量成熟平台：先建好辅助阵，生产株从真实扣种播种开始。建阵耗时另列。
    auxiliary.forEach(i => { plots[i].plant(candidate.board[i]); plots[i].age = BerryList[candidate.board[i]].growthTime[3]; });
    refresh();
    const originalHarvest = farm.harvest.bind(farm);
    farm.harvest = (i, fid) => {
        const p = plots[i], berry = p.berry, amount = berry >= 0 ? p.harvestAmount() : 0;
        const success = originalHarvest(i, fid);
        if (success) refresh();
        if (success && berry === candidate.berry) { metric.harvests++; metric.gross += amount; }
        return success;
    };
    const originalPlant = farm.plant.bind(farm);
    farm.plant = (i, berry, fid) => { const ok = originalPlant(i, berry, fid); if (ok) refresh(); if (ok && berry === candidate.berry) metric.planted++; return ok; };
    const originalMulch = farm.addMulch.bind(farm);
    farm.addMulch = (i, mulch, amount, fid) => { const before = farm.mulchList[mulch](); originalMulch(i, mulch, amount, fid);
        const used = before - farm.mulchList[mulch](); metric.mulches += used;
        metric.mulchCost += used * (({ 0: 50, 1: 100, 3: 200 })[mulch] ?? 0); refresh(); };
    return { farm, plots, employed, nextWorks, periods, metric, primary, secondary, production, auxiliary, refresh };
}
function simulate(candidate, hours = 12) {
    const state = setup(candidate);
    const { farm, plots, employed, nextWorks, periods, metric } = state;
    let now = 0, steps = 0;
    const end = Math.round(hours * 36000);
    while (now < end) {
        let next = Math.min(end, ...nextWorks);
        // 只跳过期间不发生阶段/肥料变化/助手工作的tick，保留游戏100ms边界。
        plots.forEach(p => {
            if (p.berry >= 0) {
                const data = BerryList[p.berry];
                const immortal = p.berry !== BerryType.Petaya && farm.berryInFarm(BerryType.Petaya, 4, true, 0);
                const boundary = data.growthTime.find(t => t > p.age + 1e-7);
                const rate = options.growth * p.getGrowthMultiplier();
                if (boundary && rate > 0 && !(immortal && p.age >= data.growthTime[3])) {
                    next = Math.min(next, now + Math.max(1, Math.ceil((boundary - p.age) / rate * 10 - 1e-8)));
                }
            }
            if (p.mulch !== -1) next = Math.min(next, now + Math.max(1, Math.ceil(p.mulchTimeLeft * options.duration * 10 - 1e-8)));
        });
        const quietDelta = (next - now - 1) / 10;
        if (quietDelta > 0) plots.forEach(p => { p.update(quietDelta); p.notifications = []; });
        plots.forEach(p => { const stage = p.stage(), mulch = p.mulch; p.update(0.1); p.notifications = [];
            if (p.stage() !== stage || p.mulch !== mulch) state.refresh(); });
        now = next;
        employed.forEach((h, i) => {
            if (nextWorks[i] !== now) return;
            const canAct = h.plots().some(index => {
                const p = plots[index], cell = candidate.plan.cells[index];
                if (p.berry < 0) return true;
                if (cell.role === 'cycle' && p.stage() === 4) return true;
                if (cell.role === 'keep' && p.stage() === 4
                    && (p.berry === BerryType.Petaya || !farm.berryInFarm(BerryType.Petaya, 4, true, 0))) {
                    const remaining = (BerryList[p.berry].growthTime[4] - p.age) / (options.growth * p.getGrowthMultiplier());
                    if (remaining <= h.workTick / 1000 + 0.1) return true;
                }
                if (cell.mulch !== -1 && cell.mulch !== 1 && (p.mulch === -1 || p.mulchTimeLeft <= 4 * h.workTick / 1000 + 30)) return true;
                return false;
            });
            if (canAct) h.work();
            nextWorks[i] += periods[i];
        });
        if (++steps > 1e6) throw new Error('事件数异常');
    }
    const wages = employed.reduce((sum, h) => sum + h.cost.amount, 0);
    const cost = metric.mulchCost / hours;
    return { hours, grossPerHour: metric.gross / hours, netPerHour: (metric.gross - metric.planted) / hours,
        harvestsPerHour: metric.harvests / hours, coinsPerHour: metric.coins / hours, wagesPerHour: wages,
        mulchUnitsPerHour: metric.mulches / hours, mulchCostPerHour: cost, netCoinsBeforeMulch: metric.coins / hours - wages,
        netCoinsBaseMulch: metric.coins / hours - wages - cost, steps,
        assignments: employed.map(h => ({ name: h.name, plots: [...h.plots()], wages: h.cost.amount })),
        finalProductionEmpty: state.production.filter(i => plots[i].berry === -1).length };
}
function selectShortlist(list, n = 6) {
    const result = [], signatures = new Set();
    for (const item of list) {
        const key = JSON.stringify([item.board, item.mulch]);
        if (!signatures.has(key)) { result.push(item); signatures.add(key); }
        if (result.length >= n) break;
    }
    const petaya = list.find(c => c.board.includes(BerryType.Petaya));
    if (petaya && !result.includes(petaya)) result.push(petaya);
    for (const mulch of mulchOptions) result.push(list.find(c => c.mulch === mulch && c.board.every(b => b === T) && c.hand === 'Jessie'));
    return result.filter(Boolean);
}
function mixedCandidate(candidate) {
    const result = { ...candidate, plan: JSON.parse(JSON.stringify(candidate.plan)), mulch: -2 };
    const auras = multipliers(candidate.board, candidate.berry), data = BerryList[candidate.berry];
    const hand = hands.find(h => h.name === candidate.hand);
    result.plan.cells.forEach((cell, i) => {
        if (cell.role !== 'cycle') return;
        let best = -Infinity;
        for (const mulch of mulchOptions) {
            const growth = mulch === 0 ? 1.5 : mulch === 3 ? 1.25 : 1;
            const harvest = mulch === 1 ? 2 : mulch === 3 ? 1.5 : 1;
            const output = Math.floor(Math.max(1, data.harvestAmount * harvest * auras[i].harvest)) - 1;
            const time = data.growthTime[3] / options.growth / growth / auras[i].growth;
            const score = output / (Math.max(1, Math.ceil(time / hand.seconds)) * hand.seconds);
            if (score > best) { best = score; cell.mulch = mulch; }
        }
    });
    return result;
}
async function main() {
    const cacheFile = path.join(__dirname, process.env.FARM_OUTPUT || `production-${options.growth}.json`);
    const results = fs.existsSync(cacheFile) && process.env.FARM_RESET !== '1' ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : { options, berries: [], coins: [] };
    const subset = process.env.FARM_BERRIES ? process.env.FARM_BERRIES.split(',').map(Number) : BerryList.map((_, i) => i);
    for (const berry of subset) {
        if (results.berries.some(r => r.berry === berry)) continue;
        console.log(`搜索 ${BerryType[berry]}`);
        const list = candidates(berry);
        const shortlist = selectShortlist(list, 3);
        shortlist.push(mixedCandidate(shortlist[0]));
        console.log(`验证 ${BerryType[berry]} ${shortlist.length} 组`);
        const hours = +(process.env.FARM_HOURS || Math.max(0.5, Math.min(32, BerryList[berry].growthTime[3] / options.growth / 3600 * 4)));
        const measured = shortlist.map(c => ({ ...c, measured: simulate(c, hours) }));
        measured.sort((a, b) => b.measured.netPerHour - a.measured.netPerHour);
        results.berries.push({ berry, name: BerryType[berry], best: measured[0], alternatives: measured.slice(1, 4), searched: list.length });
        fs.writeFileSync(cacheFile, JSON.stringify(results, null, 2), 'utf8');
        console.log(`${berry} ${BerryType[berry]}: ${measured[0].measured.netPerHour.toFixed(2)}/h, ${measured[0].hand}, ${measured[0].mulch}`);
    }
    fs.writeFileSync(path.join(__dirname, 'berry-data.json'), JSON.stringify(BerryList.map((b, id) => ({ id, name: BerryType[id],
        growthTime: b.growthTime, harvestAmount: b.harvestAmount, farmValue: b.farmValue,
        aura: b.aura ? { type: AuraType[b.aura.auraType], values: b.aura.auraMultipliers } : null })), null, 2), 'utf8');
}
module.exports = { BerryList, BerryType, MulchType, AuraType, FarmLayoutPlan, hands, options, T, neighbour,
    candidates, selectShortlist, simulate, planFor, analytic, mixedCandidate };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
