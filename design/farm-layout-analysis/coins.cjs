/* 农场币候选搜索：复用真实助手与布局执行链，不修改游戏或真实存档。 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const engine = require('./generate.cjs');
const { BerryList, BerryType, MulchType, hands, options, T, neighbour, candidates, analytic, planFor, simulate } = engine;
options.growth = 2.75;
options.duration = 4.5;
options.restarts = 2;
options.iterations = 300;
const output = path.join(__dirname, 'coins-data.json');
const engineSourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'generate.cjs'))).digest('hex');
const protectedNames = new Set(['Enigma', 'Occa', 'Kebia', 'Colbur', 'Chople', 'Tamato', 'Cornn', 'Magost', 'Rabuta', 'Nomel', 'Spelon', 'Pamtre', 'Watmel']);
const parasites = new Set([BerryType.Occa, BerryType.Kebia, BerryType.Colbur]);
const enigmaVictims = new Set([BerryType.Passho, BerryType.Shuca, BerryType.Coba, BerryType.Payapa, BerryType.Chilan, BerryType.Roseli, BerryType.Haban]);
const mulchTypes = [-1, MulchType.Boost_Mulch, MulchType.Rich_Mulch, MulchType.Amaze_Mulch];
const physical = item => item.board.map(b => b === T ? item.berry : b);
const structureKey = item => JSON.stringify([item.berry, item.board, item.mulch]);
const candidateKey = item => `${structureKey(item)}:${item.hand}:${item.auxHand}`;

function safe(candidate) {
    const plants = physical(candidate);
    const isProtected = i => neighbour[i].some(j => plants[j] === BerryType.Babiri && candidate.plan.cells[j].mulch !== MulchType.Freeze_Mulch);
    // 对十三种特殊目标使用完整 Babiri 覆盖，排除已知原株进化和寄生风险。
    if (protectedNames.has(BerryType[candidate.berry])) {
        for (let i = 0; i < 25; i++) {
            if (plants[i] !== BerryType.Babiri && !isProtected(i)) return false;
        }
    }
    for (let i = 0; i < 25; i++) {
        if (plants[i] === BerryType.Babiri) continue;
        const threatened = neighbour[i].some(j => parasites.has(plants[j]) && plants[j] !== plants[i])
            || (enigmaVictims.has(plants[i]) && neighbour[i].some(j => plants[j] === BerryType.Enigma));
        if (threatened && !isProtected(i)) return false;
    }
    return candidate.board.includes(T);
}

function make(board, berry, mulch, hand, family, auxHand = 'self') {
    const item = { board: [...board], berry, mulch, hand: hand.name, auxHand, family,
        plan: planFor(board, berry, mulch, `${BerryType[berry]} 农场币生产`) };
    item.score = analytic(board, berry, mulch, hand, 'coins');
    item.estimatedGross = item.score + hand.wages;
    item.estimatedWages = hand.wages + (auxHand !== 'self' && board.some(b => b !== T) ? hand.name === 'Jessie' ? 4000 : 8300 : 0);
    const count = board.filter(b => b === T).length;
    // 肥料支出只是筛选估算，最终以真实执行链记录的实际袋数为准。
    item.estimatedMulchCost = mulch < 0 ? 0 : count * ({ 0: 50, 1: 100, 3: 200 })[mulch] * 3600 / (300 * options.duration);
    item.estimatedNet = item.estimatedGross - item.estimatedWages - item.estimatedMulchCost;
    return item;
}

function supported(berry, mode) {
    const board = new Array(25).fill(T);
    board[0] = BerryType.Petaya;
    const fixed = new Set([0]);
    if (protectedNames.has(BerryType[berry])) for (const i of [6, 8, 16, 18]) { board[i] = BerryType.Babiri; fixed.add(i); }
    // 固定结构保证无 Passho 增产占位，直接比较 Wacan 生长阵和 Lum 强化阵。
    const growthCells = mode === 'ring' ? [2, 7, 10, 11, 13, 14, 17, 22] : [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23];
    for (const i of growthCells) if (!fixed.has(i) && berry !== BerryType.Wacan) board[i] = BerryType.Wacan;
    if (berry !== BerryType.Lum && !fixed.has(12)) board[12] = BerryType.Lum;
    return board;
}

function uniqueStructures(items) {
    const seen = new Set();
    return items.filter(item => { const key = structureKey(item); if (seen.has(key)) return false; seen.add(key); return true; });
}

function main() {
    const previous = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, 'utf8')) : undefined;
    const cacheAllowed = previous?.scope?.engineSourceHash === engineSourceHash || process.env.FARM_COINS_RESUME === '1';
    const cache = new Map(cacheAllowed ? (previous.measuredCandidates || []).map(c => [candidateKey(c), c.measured]) : []);
    const ratioRanking = BerryList.map((b, berry) => ({ berry, name: BerryType[berry], farmValue: b.farmValue,
        maturitySeconds: b.growthTime[3], baseCoinsPerHourPerPlot: b.farmValue / b.growthTime[3] * 3600 }))
        .sort((a, b) => b.baseCoinsPerHourPerPlot - a.baseCoinsPerHourPerPlot);
    const chosen = [...new Set([...ratioRanking.slice(0, 12).map(b => b.berry), BerryType.Wacan, BerryType.Lum, BerryType.Cheri])];
    console.log(`基础币率前十二：${ratioRanking.slice(0, 12).map(b => b.name).join('、')}`);
    const all = [];
    const searched = [];
    for (const berry of chosen) {
        const initial = candidates(berry, 'coins');
        const boards = new Map(initial.map(c => [JSON.stringify(c.board), { board: c.board, family: '随机搜索' }]));
        if (!protectedNames.has(BerryType[berry])) boards.set(JSON.stringify(new Array(25).fill(T)), { board: new Array(25).fill(T), family: '纯种25格' });
        for (const mode of ['ring', 'checker']) {
            const board = supported(berry, mode);
            boards.set(JSON.stringify(board), { board, family: `Wacan+Lum+Petaya-${mode}` });
        }
        let safeCount = 0;
        for (const { board, family } of boards.values()) for (const mulch of mulchTypes) for (const hand of hands) {
            const item = make(board, berry, mulch, hand, family);
            if (safe(item)) { all.push(item); safeCount++; }
        }
        searched.push({ berry, name: BerryType[berry], generatedByEngine: initial.length, evaluated: safeCount });
        console.log(`静态筛选 ${BerryType[berry]}：${safeCount} 个安全组合`);
    }
    const grossRanking = [...all].sort((a, b) => b.estimatedGross - a.estimatedGross);
    const netRanking = [...all].sort((a, b) => b.estimatedNet - a.estimatedNet);
    const flat = all.filter(c => c.family === '纯种25格');
    const supportedItems = all.filter(c => c.family.startsWith('Wacan+Lum+Petaya'));
    const reservations = [
        [...flat].sort((a, b) => b.estimatedGross - a.estimatedGross)[0],
        [...flat].sort((a, b) => b.estimatedNet - a.estimatedNet)[0],
        [...supportedItems].sort((a, b) => b.estimatedGross - a.estimatedGross)[0],
        [...supportedItems].sort((a, b) => b.estimatedNet - a.estimatedNet)[0],
        [...flat].filter(c => c.mulch === -1).sort((a, b) => b.estimatedNet - a.estimatedNet)[0],
        [...supportedItems].filter(c => c.mulch === -1).sort((a, b) => b.estimatedNet - a.estimatedNet)[0],
    ].filter(Boolean);
    const finalists = uniqueStructures([...reservations,
        ...uniqueStructures(grossRanking).slice(0, 3), ...uniqueStructures(netRanking).slice(0, 3),
        ...grossRanking, ...netRanking]).slice(0, 10);
    const scope = {
        label: '限定候选与真实助手执行链中的最佳方案，不宣称数学全局最优', engineSourceHash,
        growthMultiplier: options.growth, mulchDurationMultiplier: options.duration, simulationHours: 12,
        restarts: options.restarts, iterations: options.iterations, randomSeed: options.seed,
        allBerryCount: BerryList.length, rankedBy: 'farmValue / growthTime[3]',
        selectedBerryCount: chosen.length, selectedBerries: chosen.map(berry => ({ berry, name: BerryType[berry] })),
        evaluatedStaticCandidates: all.length, finalistStructures: finalists.length,
        handsCompared: hands.map(h => h.name), mulchesCompared: mulchTypes,
        farmPointWalletMultiplier: 1, wagesDiscount: 1, mulchBasePrices: { Boost: 50, Rich: 100, Amaze: 200 },
        platform: '辅助株预先成熟，生产株从真实扣种播种开始；包含辅助株维护与工资，不包含初次建阵与农田购买费',
        assumptions: [
            '全部树果与助手已解锁，助手50级，种子与肥料充足，Sprayduck2.75与Sprinklotad4.5同时生效。',
            '普通采收每格给一次farmValue，颗数不直接放大农场币。',
            '无肥与三种生产肥同时比较；九位主手均比较独自负责全田auxHand=self，另外验证Jessie主手配Jamie副手。',
            '单助手负责成熟辅助株维护只收一份工资；独立副手的工资由simulate真实计入。',
            '十三种高风险目标采用四棵成熟Babiri覆盖，筛除寄生或Enigma受害株未受保护的布局。',
            '仿真不执行随机突变、漫游者和随机自播；候选预先筛除已知原株突变风险。',
            '净币按固定基础肥价计；官方动态采购价格和额外漫游者收益没有并入。',
            '工资按持续雇用的每小时时薪计算，不叠加首次雇用的一小时预付款。',
            '不包含自然枯萎免种子、寄生复制、Enigma主动进化等特殊生产路径。',
        ],
    };
    const result = { scope, ratioRanking, searched, finalistStructures: finalists.map(c => ({ ...c, plan: undefined })), coins: [], measuredCandidates: [] };
    const write = () => fs.writeFileSync(output, JSON.stringify(result, null, 2), 'utf8');
    write();
    let completed = 0;
    for (const [index, structural] of finalists.entries()) for (const hand of [...hands, hands.find(h => h.name === 'Jessie')]) {
        const withSecondary = completed % 10 === 9;
        const item = make(structural.board, structural.berry, structural.mulch, hand, structural.family, withSecondary ? 'Jamie' : 'self');
        item.measured = cache.get(candidateKey(item)) || simulate(item, 12);
        result.measuredCandidates.push(item);
        completed++;
        console.log(`仿真 ${completed}/${finalists.length * 10}：结构${index + 1} ${BerryType[item.berry]} ${hand.name}/${item.auxHand} 肥${item.mulch} 毛${item.measured.coinsPerHour.toFixed(2)} 净${item.measured.netCoinsBaseMulch.toFixed(2)}`);
        write();
    }
    for (const [name, metric] of [['最大毛收入', 'coinsPerHour'], ['扣工资与基础肥价后的最大净收入', 'netCoinsBaseMulch']]) {
        const ranked = [...result.measuredCandidates].sort((a, b) => b.measured[metric] - a.measured[metric]);
        const seen = new Set();
        const distinct = ranked.filter(item => { const key = candidateKey(item); if (seen.has(key)) return false; seen.add(key); return true; });
        const champion = distinct[0];
        // 最终两名冠军无条件重算，确认缓存没有改变推荐结果。
        const verified = simulate(champion, 12);
        for (const field of ['coinsPerHour', 'wagesPerHour', 'mulchCostPerHour', 'netCoinsBaseMulch']) {
            if (Math.abs(verified[field] - champion.measured[field]) > 1e-6) throw new Error(`冠军复核不一致：${name} ${field}`);
        }
        champion.measured = verified;
        const berryName = BerryType[champion.berry];
        const best = { ...champion, plan: { ...champion.plan,
            name: `${berryName}｜${name}`,
            notes: [
                `生产树果为 ${berryName}；本方案按${name}筛选，是已验证候选中的最佳。`,
                `使用满级 ${champion.hand}，${champion.auxHand === 'self' ? '单人负责全部25格' : `辅助株交给 ${champion.auxHand}`}；主副手分区以报告中的 assignments 为准。`,
                `成熟辅助平台测量12小时；毛农场币 ${champion.measured.coinsPerHour.toFixed(2)}/小时，工资 ${champion.measured.wagesPerHour}/小时，基础肥价支出 ${champion.measured.mulchCostPerHour.toFixed(2)}/小时，净币 ${champion.measured.netCoinsBaseMulch.toFixed(2)}/小时。`,
                '假设 Sprayduck 2.75、Sprinklotad 4.5；不含初次建阵、首次雇用预付款与农田购买费，不含漫游者随机收益。',
            ] } };
        result.coins.push({ name: `${name}（${berryName}）`, berry: champion.berry, best, alternatives: distinct.slice(1, 6), metric });
        engine.FarmLayoutPlan.normalize(best.plan);
    }
    const longSources = [
        { source: '12小时毛收入冠军', candidate: result.coins[0].best },
        { source: '12小时净收入冠军', candidate: result.coins[1].best },
        { source: '纯25格Wacan加Boost，由Jamie单人维护', candidate: make(new Array(25).fill(T), BerryType.Wacan,
            MulchType.Boost_Mulch, hands.find(h => h.name === 'Jamie'), '纯种25格') },
    ];
    const longMeasured = longSources.map(({ source, candidate }, index) => {
        console.log(`96小时连续运行 ${index + 1}/3：${source} ${candidate.hand}`);
        const item = { ...candidate, source, measured: simulate(candidate, 96) };
        console.log(`96小时结果：毛${item.measured.coinsPerHour.toFixed(2)} 净${item.measured.netCoinsBaseMulch.toFixed(2)}`);
        return item;
    });
    longMeasured.sort((a, b) => b.measured.netCoinsBaseMulch - a.measured.netCoinsBaseMulch);
    const longChampion = longMeasured[0];
    const longBerryName = BerryType[longChampion.berry];
    const longName = `96小时连续运行最佳候选（${longBerryName}）`;
    const longBest = { ...longChampion, plan: { ...longChampion.plan, name: longName, notes: [
        `生产树果为 ${longBerryName}；只在12小时毛收入冠军、12小时净收入冠军、纯25格Wacan加Boost/Jamie这三份布局中，按96小时净收入比较。`,
        `使用满级 ${longChampion.hand}，${longChampion.auxHand === 'self' ? '单人负责全部25格' : `辅助株交给 ${longChampion.auxHand}`}；按真实工作周期连续运行96小时。`,
        `毛农场币 ${longChampion.measured.coinsPerHour.toFixed(2)}/小时，工资 ${longChampion.measured.wagesPerHour}/小时，基础肥价支出 ${longChampion.measured.mulchCostPerHour.toFixed(2)}/小时，净币 ${longChampion.measured.netCoinsBaseMulch.toFixed(2)}/小时。`,
        '辅助株仅开始时预先成熟，随后不再人工重置；96小时覆盖Petaya寿命和后续重建空档。假设Sprayduck2.75、Sprinklotad4.5与固定基础肥价。',
    ] } };
    engine.FarmLayoutPlan.normalize(longBest.plan);
    result.longRunComparison = { hours: 96, metric: 'netCoinsBaseMulch',
        label: '仅上述三份限定候选的96小时连续运行比较，不宣称全部布局的长期全局最优',
        candidates: longMeasured, best: longBest,
        coverage: '初始辅助阵成熟；随后完整模拟96小时，不手动刷新辅助株，包含Petaya老化、抢救、重种与辅助阵等待。',
    };
    result.coins.push({ name: longName, berry: longChampion.berry, best: longBest,
        alternatives: longMeasured.slice(1), metric: 'netCoinsBaseMulch' });
    scope.completedSimulations = completed;
    scope.finalChampionsRechecked = true;
    scope.longRunHours = 96;
    scope.longRunComparedCandidates = longMeasured.length;
    scope.completed = true;
    write();
    console.log(`结果已写入 ${output}`);
}

if (require.main === module) main();
