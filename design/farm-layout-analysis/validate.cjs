/* 对照离线仿真的光环缓存，并检查可复制布局的结构与变异保护。 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const analysis = require('./generate.cjs');

const { BerryList, BerryType, MulchType, FarmLayoutPlan, T, neighbour, planFor, simulate } = analysis;
const protectedNames = new Set([
    'Enigma', 'Occa', 'Kebia', 'Colbur', 'Chople', 'Tamato', 'Cornn',
    'Magost', 'Rabuta', 'Nomel', 'Spelon', 'Pamtre', 'Watmel',
]);
const protectedPositions = [6, 8, 16, 18];
const numericFields = [
    'hours', 'grossPerHour', 'netPerHour', 'harvestsPerHour', 'coinsPerHour',
    'wagesPerHour', 'mulchUnitsPerHour', 'netCoinsBeforeMulch', 'netCoinsBaseMulch',
    'steps', 'finalProductionEmpty',
];

function closeEnough(actual, expected, label) {
    assert.ok(Number.isFinite(actual) && Number.isFinite(expected), `${label} 必须为有限数`);
    const tolerance = 1e-9 * Math.max(1, Math.abs(actual), Math.abs(expected));
    assert.ok(Math.abs(actual - expected) <= tolerance,
        `${label} 不一致：缓存 ${actual}，源码派生 ${expected}，容差 ${tolerance}`);
}

function referenceCandidate(name) {
    const berry = BerryType[name];
    const board = Array(25).fill(T);
    board[0] = BerryType.Petaya;
    for (const index of [6, 7, 8, 11, 13, 16, 17, 18]) board[index] = BerryType.Wacan;
    for (const index of [2, 10, 14, 22]) board[index] = BerryType.Lum;
    if (protectedNames.has(name)) {
        for (const index of protectedPositions) board[index] = BerryType.Babiri;
    }
    const mulch = name === 'Cheri' || name === 'Wacan' ? MulchType.Rich_Mulch : MulchType.Amaze_Mulch;
    return { berry, board, mulch, hand: 'Jessie', plan: planFor(board, berry, mulch, `${name} 缓存对照`) };
}

function validateCandidate(candidate, label = BerryType[candidate.berry]) {
    assert.ok(Number.isInteger(candidate.berry) && BerryList[candidate.berry], `${label} 的目标树果无效`);
    assert.ok(Array.isArray(candidate.board) && candidate.board.length === 25, `${label} 必须有 25 个棋盘格`);
    assert.ok(Array.isArray(candidate.plan?.cells) && candidate.plan.cells.length === 25, `${label} 必须有 25 个布局格`);
    const parsed = FarmLayoutPlan.parse(JSON.stringify(candidate.plan));
    assert.equal(parsed.cells.length, 25, `${label} 导入后必须有 25 格`);
    candidate.board.forEach((berry, index) => {
        const cell = candidate.plan.cells[index];
        assert.equal(cell.role, berry === T ? 'cycle' : 'keep', `${label} 第 ${index + 1} 格用途错误`);
        assert.equal(cell.berry, berry === T ? candidate.berry : berry, `${label} 第 ${index + 1} 格树果错位`);
        // -2 仅表示报告层按格混合肥料；导入计划内仍须使用真实肥料编号。
        if (berry !== T || candidate.mulch !== -2) {
            assert.equal(cell.mulch, berry === T ? candidate.mulch : MulchType.None, `${label} 第 ${index + 1} 格肥料错位`);
        } else {
            assert.ok([MulchType.None, MulchType.Boost_Mulch, MulchType.Rich_Mulch, MulchType.Amaze_Mulch].includes(cell.mulch),
                `${label} 第 ${index + 1} 格的混合肥料编号无效`);
        }
    });
    assert.ok(candidate.board.includes(T), `${label} 必须至少有一个生产格`);
    const protectedBerry = protectedNames.has(BerryType[candidate.berry]);
    if (protectedBerry) {
        const babiri = candidate.plan.cells.flatMap((cell, index) =>
            cell.role === 'keep' && cell.berry === BerryType.Babiri && cell.mulch !== MulchType.Freeze_Mulch ? [index] : []);
        assert.equal(babiri.length, 4, `${label} 必须保留 4 株有效 Babiri`);
        assert.deepEqual(babiri, protectedPositions, `${label} 的 Babiri 应在四个内角`);
        candidate.plan.cells.forEach((cell, index) => {
            if (cell.berry === BerryType.Babiri) return;
            assert.ok(neighbour[index].some(near => babiri.includes(near)),
                `${label} 第 ${index + 1} 格未被成熟 Babiri 光环保护`);
        });
    }
    if (candidate.measured) {
        for (const field of numericFields) assert.ok(Number.isFinite(candidate.measured[field]), `${label}.${field} 缺失或不是有限数`);
        assert.ok(candidate.measured.hours > 0, `${label} 仿真时长必须大于零`);
        const assigned = candidate.measured.assignments.flatMap(hand => hand.plots);
        assert.equal(new Set(assigned).size, 25, `${label} 的助手必须覆盖全部 25 格`);
        assert.equal(assigned.length, 25, `${label} 的助手职责不能重叠`);
    }
    return { protectedBerry };
}

function validateSimulation(hours = 0.1) {
    assert.ok(Number.isFinite(hours) && hours > 0 && hours <= 1, '对照窗口须大于 0 且不超过 1 小时');
    const previous = process.env.FARM_NO_AURA_CACHE;
    const results = [];
    try {
        for (const name of ['Cheri', 'Wacan', 'Passho', 'Lum', 'Enigma', 'Petaya']) {
            const candidate = referenceCandidate(name);
            validateCandidate(candidate, `${name} 对照阵`);
            process.env.FARM_NO_AURA_CACHE = '0';
            const cachedStart = performance.now();
            const cached = simulate(candidate, hours);
            const cachedMs = performance.now() - cachedStart;
            process.env.FARM_NO_AURA_CACHE = '1';
            const originalStart = performance.now();
            const original = simulate(candidate, hours);
            const originalMs = performance.now() - originalStart;
            for (const field of numericFields) closeEnough(cached[field], original[field], `${name}.${field}`);
            assert.deepEqual(cached.assignments, original.assignments, `${name} 的助手分工不一致`);

            // 净库存已经扣除播种种子；终点在田作物不预支未来收获，短窗口因此可能为负。
            const gross = cached.grossPerHour * hours;
            const net = cached.netPerHour * hours;
            const planted = gross - net;
            const harvests = cached.harvestsPerHour * hours;
            const productionCount = candidate.board.filter(berry => berry === T).length;
            const livingProduction = productionCount - cached.finalProductionEmpty;
            closeEnough(planted, Math.round(planted), `${name} 播种数应为整数`);
            closeEnough(planted - harvests, livingProduction, `${name} 终点在田种子账目`);
            results.push({ name, hours, cachedMs: Math.round(cachedMs), originalMs: Math.round(originalMs),
                steps: cached.steps, gross: Math.round(gross), planted: Math.round(planted), net: Math.round(net),
                livingProduction, mulchUnits: cached.mulchUnitsPerHour * hours });
            console.log(`通过 ${name}：${cached.steps} 事件，缓存 ${Math.round(cachedMs)} ms，源码派生 ${Math.round(originalMs)} ms，净 ${Math.round(net)} 颗`);
        }
    } finally {
        if (previous === undefined) delete process.env.FARM_NO_AURA_CACHE;
        else process.env.FARM_NO_AURA_CACHE = previous;
    }
    console.log('短窗口记账：净颗数 = 已收获颗数 − 已播种颗数；终点仍在田里的种子已经扣除，不计尚未兑现的收获。');
    console.log('因此长周期树果在 0.1 小时内可能只有播种支出而呈负净值，这属于库存口径，并不代表成熟后的稳定收益。');
    return results;
}

function validateTickEquivalence() {
    const filename = require.resolve('./generate.cjs');
    const source = fs.readFileSync(filename, 'utf8');
    const eventStatement = 'let next = Math.min(end, ...nextWorks);';
    assert.equal(source.split(eventStatement).length, 2, '事件调度代码已变化，需更新逐 tick 对照入口');
    // 只在内存中将事件推进限制为一个 100ms tick，不修改计算器文件或业务公式。
    const stepModule = new Module(filename, module);
    stepModule.filename = filename;
    stepModule.paths = Module._nodeModulePaths(path.dirname(filename));
    stepModule._compile(source.replace(eventStatement, 'let next = Math.min(end, now + 1, ...nextWorks);'), filename);
    const previous = process.env.FARM_NO_AURA_CACHE;
    const cases = [
        ['Cheri', 0.01], ['Wacan', 0.01],
        // Jessie 首轮为 0.1 秒，随后每 20.3 秒工作；在 40.7 秒工作边界两侧复核。
        ['Cheri', 40.6 / 3600], ['Cheri', 40.7 / 3600],
    ];
    const results = [];
    try {
        process.env.FARM_NO_AURA_CACHE = '0';
        for (const [name, hours] of cases) {
            const candidate = referenceCandidate(name);
            const event = simulate(candidate, hours);
            const tick = stepModule.exports.simulate(candidate, hours);
            for (const field of numericFields.filter(field => field !== 'steps')) {
                closeEnough(event[field], tick[field], `${name} ${hours * 3600}秒 事件/逐tick ${field}`);
            }
            assert.deepEqual(event.assignments, tick.assignments, `${name} 事件/逐tick 助手分工不一致`);
            assert.equal(tick.steps, Math.round(hours * 36000), `${name} 逐tick计数错误`);
            assert.ok(event.steps <= tick.steps, `${name} 事件步数不应大于逐tick步数`);
            results.push({ name, seconds: hours * 3600, eventSteps: event.steps, tickSteps: tick.steps,
                net: event.netPerHour * hours });
            console.log(`通过事件/逐tick ${name} ${Number((hours * 3600).toFixed(3))}秒：${event.steps}/${tick.steps} 步，产出与肥料一致`);
        }
    } finally {
        if (previous === undefined) delete process.env.FARM_NO_AURA_CACHE;
        else process.env.FARM_NO_AURA_CACHE = previous;
    }
    console.log('精度范围：两种离线调度均保留浮点年龄，未重现游戏 numeric: 5 的逐次舍入；上述一致性适用于本次窗口与离线模型，不证明所有真实游戏边界逐 tick 恒等。');
    return results;
}

function validateData(files, requireComplete = false) {
    const berryIds = new Set();
    let candidates = 0, protectedCandidates = 0;
    for (const file of files) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const entry of data.berries ?? []) {
            assert.ok(Number.isInteger(entry.berry) && BerryList[entry.berry], `${file} 的树果编号无效`);
            assert.equal(entry.name, BerryType[entry.berry], `${file} 的树果名称与编号不符`);
            berryIds.add(entry.berry);
        }
        const visit = (value, location) => {
            if (!value || typeof value !== 'object') return;
            if (Array.isArray(value.board) && value.plan) {
                const checked = validateCandidate(value, `${path.basename(file)}:${location}`);
                candidates++;
                if (checked.protectedBerry) protectedCandidates++;
                return;
            }
            for (const [key, child] of Object.entries(value)) visit(child, `${location}.${key}`);
        };
        visit(data, '数据');
    }
    const missing = BerryList.flatMap((_, id) => berryIds.has(id) ? [] : [BerryType[id]]);
    if (requireComplete) assert.equal(missing.length, 0, `生产结果未齐全，缺少：${missing.join('、')}`);
    console.log(`布局数据通过：${files.length} 个文件，${berryIds.size}/${BerryList.length} 种树果，${candidates} 个方案，其中 ${protectedCandidates} 个高风险方案满足四株 Babiri 全覆盖。`);
    if (missing.length) console.log(`当前结果尚在生成，待补齐 ${missing.length} 种树果；最终复核请加 --require-complete。`);
    return { files: files.length, berries: berryIds.size, candidates, protectedCandidates, missing };
}

function main() {
    const args = process.argv.slice(2);
    const dataIndex = args.indexOf('--data');
    const files = dataIndex >= 0
        ? [path.resolve(args[dataIndex + 1] ?? '')]
        : fs.readdirSync(__dirname).filter(file => /^(production|part-).*\.json$/.test(file)).map(file => path.join(__dirname, file));
    if (!args.includes('--data-only')) {
        validateSimulation(+(process.env.FARM_VALIDATE_HOURS || 0.1));
        validateTickEquivalence();
    }
    validateData(files, args.includes('--require-complete'));
}

module.exports = { validateCandidate, validateSimulation, validateTickEquivalence, validateData, referenceCandidate };
if (require.main === module) {
    try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
}
