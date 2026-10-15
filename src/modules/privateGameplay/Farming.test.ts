import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import '../koExtenders';
import * as GameConstants from '../GameConstants';
import GameHelper from '../GameHelper';
import Amount from '../wallet/Amount';
import BerryType from '../enums/BerryType';
import MulchType from '../enums/MulchType';
import PlotStage from '../enums/PlotStage';
import AuraType from '../enums/AuraType';
import FarmNotificationType from '../enums/FarmNotificationType';
import FarmingTool from '../enums/FarmingTool';
import SizeUnits from '../enums/SizeUnits';
import { BerryList } from '../farming/BerryList';
import FarmLayoutPlan from '../farming/FarmLayoutPlan';
import SeededRand from '../utilities/SeededRand';

const scripts = [
    'FarmHand.ts', 'Plot.ts', 'FarmLayout.ts', 'mutation/Mutation.ts',
    'mutation/mutationTypes/GrowMutation.ts', 'mutation/mutationTypes/GrowNearMutation.ts',
    'mutation/mutationTypes/GrowNearBerryMutation.ts', 'mutation/mutationTypes/FieldMutation.ts',
    'mutation/mutationTypes/EvolveMutation.ts', 'mutation/mutationTypes/EvolveNearMutation.ts',
    'mutation/mutationTypes/EvolveNearBerryStrictMutation.ts', 'mutation/mutationTypes/EnigmaMutation.ts',
    'Farming.ts', 'FarmController.ts', 'FarmLayoutController.ts',
].map(file => transpileModule(readFileSync(`src/scripts/farming/${file}`, 'utf8'), {
    compilerOptions: { target: ScriptTarget.ES2020 },
}).outputText).join('\n');

function setup() {
    let balance = 1_000_000_000;
    const wallet = {
        hasAmount: vi.fn((cost: Amount) => balance >= cost.amount),
        loseAmount: vi.fn((cost: Amount) => {
            if (balance < cost.amount) return false;
            balance -= cost.amount;
            return true;
        }),
        gainFarmPoints: vi.fn(),
    };
    const requirement = class { isCompleted() { return true; } };
    const statistics = {
        totalManualHarvests: ko.observable(0), totalBerriesHarvested: ko.observable(0), totalBerriesMutated: ko.observable(0),
        berriesHarvested: BerryList.map(() => ko.observable(0)), totalMulchesUsed: ko.observable(0),
        totalBerriesObtained: ko.observable(0), berriesObtained: BerryList.map(() => ko.observable(0)),
        mulchesUsed: Array.from({ length: 10 }, () => ko.observable(0)),
    };
    const app = { game: { farming: null, wallet, statistics, oakItems: { use: vi.fn(), calculateBonus: () => 1 }, logbook: { newLog: vi.fn() } } };
    const notification = { notify: vi.fn(), confirm: vi.fn(async () => true) };
    const constants = {
        NotificationOption: { info: 0, warning: 1, success: 2, danger: 3 },
        NotificationSetting: { Farming: { farm_hand: 0 } },
    };
    const classes = runInNewContext(`${scripts}\n({ Farming, FarmHands, FarmHand, FarmController, FarmLayoutController, GrowNearBerryMutation, FieldMutation, EvolveNearBerryStrictMutation, EnigmaMutation });`, {
        ko, GameConstants, GameHelper, Amount, BerryType, BerryList, MulchType, PlotStage, AuraType, FarmNotificationType, FarmingTool, SizeUnits, FarmLayoutPlan,
        App: app, Notifier: notification, NotificationConstants: constants,
        TotalBerriesUnlockedRequirement: requirement, UniqueItemOwnedRequirement: requirement,
        SeededRand,
        Rand: { chance: () => false },
        WandererPokemon: { fromJSON: () => undefined },
        OakItemType: { Sprayduck: 0, Sprinklotad: 1, Squirtbottle: 2 },
        MultiplierDecreaser: { Berry: 0 }, player: { lowerItemMultipliers: vi.fn(), trainerId: '12345' },
        Settings: { getSetting: () => ({ observableValue: () => false }) },
        LogBookTypes: { OTHER: 0 }, createLogContent: { unableToPayFarmHand: () => '' },
    });
    const farming = new classes.Farming({ addBonus: vi.fn(), getBonus: () => 1 });
    app.game.farming = farming;
    farming.unlockedBerries.forEach(berry => berry(true));
    farming.berryInventory.forEach(berry => berry(1000));
    const unlockFirst = () => farming.getFarmPlots(0).forEach(plot => { plot.isUnlocked = true; });
    const addFarm = () => { unlockFirst(); expect(farming.buyFarm()).toBe(true); };
    const ripe = (farmId: number, index = 0, berry = BerryType.Cheri) => {
        const plot = farming.getFarmPlots(farmId)[index];
        plot.plant(berry);
        plot.age = BerryList[berry].growthTime[PlotStage.Bloom];
        expect(plot.stage()).toBe(PlotStage.Berry);
        return plot;
    };
    return { ...classes, farming, wallet, notification, app, unlockFirst, addFarm, ripe, setBalance: (value: number) => { balance = value; } };
}

function growthPreview(FarmController, app, detail = false) {
    const template = document.createElement('div');
    template.innerHTML = readFileSync(`src/components/${detail ? 'berryDexModal' : 'farmModal'}.html`, 'utf8');
    const row = Array.from(template.querySelectorAll(detail ? 'tr' : '#berryDexPreviewTable tr'))
        .find(element => element.textContent.includes('Growth Duration') || element.textContent.includes('预计收获时间'));
    const preview = row.querySelector('code').cloneNode(true) as HTMLElement;
    ko.applyBindings({ $data: BerryType.Cheri, BerryList, GameConstants, FarmController, App: app }, preview);
    return preview;
}

function layoutPlan(cells: Record<number, Record<string, unknown>>, name = '布局助手集成测试') {
    return {
        version: 1,
        name,
        cells: Array.from({ length: 25 }, (_, index) => ({
            role: 'ignore', berry: BerryType.None, targetBerry: BerryType.None,
            mulch: MulchType.None, freezeStage: PlotStage.Berry,
            ...cells[index],
        })),
    };
}

function enableLayout(farming, cells: Record<number, Record<string, unknown>>, farmId = 0) {
    const layout = farming.farms()[farmId].layout;
    layout.setPlan(layoutPlan(cells));
    expect(layout.enabled()).toBe(false);
    expect(layout.validation()).toEqual([]);
    layout.toggle();
    expect(layout.enabled()).toBe(true);
    return layout;
}

function advanceLayoutFarm(farming, seconds: number, farmId = 0) {
    const tick = GameConstants.TICK_TIME / GameConstants.SECOND;
    const steps = Math.ceil(seconds / tick);
    for (let step = 0; step < steps; step++) {
        farming.getFarmPlots(farmId).forEach(plot => plot.update(tick));
        farming.farms()[farmId].hands.tick();
    }
}

describe('农场布局助手真实作业', () => {
    it('突变时机：目标下拉框保留数字类型，编辑暂停布局且导出保存目标', () => {
        const { farming, unlockFirst, FarmLayoutController } = setup();
        unlockFirst();
        const layout = enableLayout(farming, { 0: { role: 'mutation', targetBerry: BerryType.Lum } });
        const template = document.createElement('div');
        template.innerHTML = readFileSync('src/components/farmModal.html', 'utf8');
        const select = template.querySelector('#farmLayoutTargetBerry').cloneNode(true) as HTMLSelectElement;
        ko.applyBindings({ FarmLayoutController }, select);
        expect(select.value).toBe(String(BerryType.Lum));

        select.value = String(BerryType.Passho);
        select.dispatchEvent(new Event('change'));

        expect(layout.plan().cells[0].targetBerry).toBe(BerryType.Passho);
        expect(typeof layout.plan().cells[0].targetBerry).toBe('number');
        expect(layout.enabled()).toBe(false);
        expect(JSON.parse(FarmLayoutController.exportText()).cells[0].targetBerry).toBe(BerryType.Passho);
        expect(FarmLayoutController.berryText(0)).toContain('Passho');
        ko.cleanNode(select);
    });

    it('突变时机：冻结预算不足时先保住快枯萎的 Cheri，再照顾长寿命 Sitrus', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.gainExperience(122_500);
        hand.maxEfficiency = 1;
        hand.hire();
        const cells: Record<number, Record<string, unknown>> = {
            0: { role: 'keep', berry: BerryType.Cheri, mulch: MulchType.Freeze_Mulch },
            6: { role: 'mutation', targetBerry: BerryType.Lum },
        };
        [1, 2, 3].forEach(index => {
            const plot = farming.getFarmPlots(0)[index];
            plot.plant(BerryType.Sitrus);
            plot.age = BerryList[BerryType.Sitrus].growthTime[PlotStage.Bloom] - 10;
            cells[index] = { role: 'keep', berry: BerryType.Sitrus, mulch: MulchType.Freeze_Mulch };
        });
        enableLayout(farming, cells);
        farming.mulchList[MulchType.Freeze_Mulch](1000);
        const plant = vi.spyOn(farming, 'plant');

        advanceLayoutFarm(farming, 85);

        const cheri = farming.getFarmPlots(0)[0];
        expect(cheri.berry).toBe(BerryType.Cheri);
        expect(cheri.stage()).toBe(PlotStage.Berry);
        expect(cheri.mulch).toBe(MulchType.Freeze_Mulch);
        [1, 2, 3].forEach(index => expect(farming.getFarmPlots(0)[index].mulch).toBe(MulchType.Freeze_Mulch));
        expect(plant).toHaveBeenCalledTimes(1);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(999);
    });

    it('突变时机：母株未成熟时不施 Surprise，真实配方可突变后才施肥', () => {
        const { farming, unlockFirst, GrowNearBerryMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(122_500);
        hand.hire();
        const source = farming.getFarmPlots(0)[0];
        const target = farming.getFarmPlots(0)[1];
        source.plant(BerryType.Cheri);
        const mutation = new GrowNearBerryMutation(1, BerryType.Lum, [BerryType.Cheri]);
        farming.mutations = [mutation];
        farming.mulchList[MulchType.Surprise_Mulch](100);
        enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Cheri },
            1: { role: 'mutation', targetBerry: BerryType.Lum, mulch: MulchType.Surprise_Mulch },
        });

        expect(mutation.forFarm(0).getMutationPlots()).not.toContain(1);
        hand.work();
        expect(target.mulch).toBe(MulchType.None);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBe(100);

        source.update(BerryList[BerryType.Cheri].growthTime[PlotStage.Bloom]);
        expect(source.stage()).toBe(PlotStage.Berry);
        expect(mutation.forFarm(0).getMutationPlots()).toContain(1);
        hand.work();
        expect(target.mulch).toBe(MulchType.Surprise_Mulch);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBeLessThan(100);
    });

    it('突变时机：长周期母株先种，短周期母株等待成熟时间差后再种', () => {
        const { farming, unlockFirst, GrowNearBerryMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.gainExperience(122_500);
        hand.hire();
        const mutation = new GrowNearBerryMutation(1, BerryType.Lum, [BerryType.Sitrus, BerryType.Cheri]);
        farming.mutations = [mutation];
        enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Sitrus },
            1: { role: 'keep', berry: BerryType.Cheri },
            6: { role: 'mutation', targetBerry: BerryType.Lum },
        });

        hand.work();

        expect(farming.getFarmPlots(0)[0].berry).toBe(BerryType.Sitrus);
        expect(farming.getFarmPlots(0)[1].berry).toBe(BerryType.None);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(1000);
        expect(mutation.forFarm(0).getMutationPlots()).not.toContain(6);
    });

    it('突变时机：Lum 实阵从空田错峰播种并自然生长到四格均具备有效突变机会', () => {
        const { farming, unlockFirst, GrowNearBerryMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.gainExperience(122_500);
        hand.hire();
        const plan = FarmLayoutPlan.createPreset('lum-mutation');
        const layout = farming.farms()[0].layout;
        layout.setPlan(plan);
        layout.toggle();
        const rule = new GrowNearBerryMutation(1, BerryType.Lum, [
            BerryType.Cheri, BerryType.Chesto, BerryType.Pecha, BerryType.Rawst,
            BerryType.Aspear, BerryType.Leppa, BerryType.Oran, BerryType.Sitrus,
        ]);
        farming.mutations = [rule];
        farming.mulchList[MulchType.Freeze_Mulch](10_000);
        farming.mulchList[MulchType.Surprise_Mulch](10_000);
        const plant = vi.spyOn(farming, 'plant');
        const mulch = vi.spyOn(farming, 'addMulch');
        const targets = [6, 8, 16, 18];
        const tick = GameConstants.TICK_TIME / GameConstants.SECOND;

        advanceLayoutFarm(farming, tick);
        expect(plant.mock.calls.length).toBe(4);
        expect(plant.mock.calls.every(([, berry]) => berry === BerryType.Sitrus)).toBe(true);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBe(10_000);

        let inspected = 0;
        for (let elapsed = tick; elapsed < 750; elapsed += tick) {
            advanceLayoutFarm(farming, tick);
            const calls = mulch.mock.calls.slice(inspected);
            calls.forEach(([index, type]) => {
                if (type === MulchType.Surprise_Mulch) {
                    expect(rule.forFarm(0).getMutationPlots()).toContain(index);
                }
            });
            inspected = mulch.mock.calls.length;
            if (targets.every(index => farming.getFarmPlots(0)[index].mulch === MulchType.Surprise_Mulch)) {
                break;
            }
        }

        expect(rule.forFarm(0).getMutationPlots()).toEqual(expect.arrayContaining(targets));
        targets.forEach(index => {
            expect(farming.getFarmPlots(0)[index].isEmpty()).toBe(true);
            expect(farming.getFarmPlots(0)[index].mulch).toBe(MulchType.Surprise_Mulch);
        });
        plan.cells.forEach((cell, index) => {
            if (cell.role !== 'keep') return;
            const plot = farming.getFarmPlots(0)[index];
            expect(plot.berry).toBe(cell.berry);
            expect(plot.stage()).toBe(PlotStage.Berry);
            expect(plot.mulch).toBe(MulchType.Freeze_Mulch);
        });
        expect(plant).toHaveBeenCalledTimes(21);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBeLessThan(10_000);
    }, 30_000);

    it('突变时机：低级助手来不及首次冻结 Cheri 时暂停播种并提示处理方法', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.hire();
        const layout = enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Cheri, mulch: MulchType.Freeze_Mulch },
            1: { role: 'mutation', targetBerry: BerryType.Lum },
        });
        const seeds = farming.berryInventory[BerryType.Cheri]();

        hand.work();

        expect(hand.workTick / GameConstants.SECOND).toBeGreaterThanOrEqual(BerryList[BerryType.Cheri].growthTime[PlotStage.Berry]);
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(seeds);
        expect(layout.status(0)).toMatch(/来不及首次冻结.*暂停播种/);
    });

    it('突变时机：成熟 Petaya 保活时低级助手可以播种需要冻结的 Cheri', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        ripe(0, 24, BerryType.Petaya);
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.hire();
        const layout = enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Cheri, mulch: MulchType.Freeze_Mulch },
            1: { role: 'mutation', targetBerry: BerryType.Lum },
        });
        farming.mulchList[MulchType.Freeze_Mulch](100);

        hand.work();

        const source = farming.getFarmPlots(0)[0];
        expect(source.berry).toBe(BerryType.Cheri);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(999);
        source.update(BerryList[BerryType.Cheri].growthTime[PlotStage.Berry] + 1);
        expect(source.stage()).toBe(PlotStage.Berry);
        hand.work();
        expect(source.mulch).toBe(MulchType.Freeze_Mulch);
        expect(layout.status(0)).not.toContain('来不及首次冻结');
    });

    it('突变时机：Yache 真实规则在 Passho 长到 Taller 时即可施肥，无需等待成熟', () => {
        const { farming, unlockFirst, EvolveNearBerryStrictMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.gainExperience(122_500);
        hand.hire();
        const source = farming.getFarmPlots(0)[0];
        source.plant(BerryType.Passho);
        const rule = new EvolveNearBerryStrictMutation(.0001, BerryType.Yache, BerryType.Passho, {}, PlotStage.Seed);
        farming.mutations = [rule];
        farming.mulchList[MulchType.Surprise_Mulch](100);
        enableLayout(farming, {
            0: { role: 'evolve', berry: BerryType.Passho, targetBerry: BerryType.Yache, mulch: MulchType.Surprise_Mulch },
        });

        hand.work();
        expect(source.mulch).toBe(MulchType.None);
        source.update(BerryList[BerryType.Passho].growthTime[PlotStage.Sprout] + 1);
        expect(source.stage()).toBe(PlotStage.Taller);
        expect(rule.forFarm(0).getMutationPlots()).toContain(0);
        hand.work();

        expect(source.stage()).not.toBe(PlotStage.Berry);
        expect(source.mulch).toBe(MulchType.Surprise_Mulch);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBeLessThan(100);
    });

    it('突变时机：Enigma 真实资格查询和实际施肥均恢复共用随机数状态', () => {
        const { farming, unlockFirst, ripe, EnigmaMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.gainExperience(122_500);
        hand.hire();
        const rule = new EnigmaMutation(.0001);
        farming.mutations = [rule];
        EnigmaMutation.getReqs().forEach((berry, direction) => ripe(0, [7, 11, 13, 17][direction], berry));
        farming.mulchList[MulchType.Surprise_Mulch](100);
        const layout = enableLayout(farming, {
            12: { role: 'mutation', targetBerry: BerryType.Enigma, mulch: MulchType.Surprise_Mulch },
        });
        SeededRand.seed(777777);
        const previousState = SeededRand.state;

        expect(layout.status(12)).toContain('Enigma');
        expect(SeededRand.state).toBe(previousState);
        hand.work();

        expect(farming.getFarmPlots(0)[12].mulch).toBe(MulchType.Surprise_Mulch);
        expect(SeededRand.state).toBe(previousState);
    });

    it('突变时机：等待阶段不耗工作预算，真实播种仍扣种子、体力并获得经验', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.maxEfficiency = 1;
        hand.hire();
        enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Sitrus },
            1: { role: 'keep', berry: BerryType.Oran },
            6: { role: 'mutation', targetBerry: BerryType.Lum },
        });
        const energy = hand.energy();
        hand.work();
        expect(farming.getFarmPlots(0)[0].berry).toBe(BerryType.Sitrus);
        expect(farming.getFarmPlots(0)[1].isEmpty()).toBe(true);
        expect(farming.berryInventory[BerryType.Sitrus]()).toBe(999);
        expect(farming.berryInventory[BerryType.Oran]()).toBe(1000);
        expect(hand.experience()).toBe(1);
        expect(hand.energy()).toBe(energy - 1);

        hand.work();
        expect(hand.experience()).toBe(1);
        expect(hand.energy()).toBe(energy);
        expect(farming.berryInventory[BerryType.Oran]()).toBe(1000);
    });

    it('突变时机：生长倍率改变后按真实剩余时间重算播种时机', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.gainExperience(122_500);
        hand.hire();
        enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Sitrus },
            1: { role: 'keep', berry: BerryType.Oran },
            6: { role: 'mutation', targetBerry: BerryType.Lum },
        });
        advanceLayoutFarm(farming, 250);
        expect(farming.getFarmPlots(0)[0].berry).toBe(BerryType.Sitrus);
        expect(farming.getFarmPlots(0)[1].isEmpty()).toBe(true);

        vi.spyOn(farming, 'getGrowthMultiplier').mockReturnValue(2);
        advanceLayoutFarm(farming, 30);
        hand.work();

        expect(farming.getFarmPlots(0)[0].age).toBeGreaterThan(300);
        expect(farming.getFarmPlots(0)[1].berry).toBe(BerryType.Oran);
        expect(farming.berryInventory[BerryType.Oran]()).toBe(999);
    });

    it.each([
        { reason: '长周期母株被提前冻结', berry: BerryType.Sitrus, mulch: MulchType.Freeze_Mulch, status: /冻结|暂停/ },
        { reason: '母株格已有错种的稀有树果', berry: BerryType.Liechi, mulch: MulchType.None, status: /不符|冲突|等待/ },
    ])('突变时机：$reason 时保留现场并阻止短周期种子白种', ({ berry, mulch, status }) => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.gainExperience(122_500);
        hand.hire();
        const source = farming.getFarmPlots(0)[0];
        source.plant(berry);
        source.mulch = mulch;
        source.mulchTimeLeft = mulch === MulchType.None ? 0 : 100_000;
        const layout = enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Sitrus },
            1: { role: 'keep', berry: BerryType.Oran },
            6: { role: 'mutation', targetBerry: BerryType.Lum, mulch: MulchType.Surprise_Mulch },
        });
        farming.mulchList[MulchType.Surprise_Mulch](100);
        const shovels = farming.shovelAmt();

        hand.work();

        expect(source.berry).toBe(berry);
        expect(source.age).toBe(0);
        expect(farming.getFarmPlots(0)[1].isEmpty()).toBe(true);
        expect(farming.berryInventory[BerryType.Oran]()).toBe(1000);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBe(100);
        expect(farming.shovelAmt()).toBe(shovels);
        expect(layout.status(1)).toMatch(status);
    });

    it('突变时机：竞争配方已经就绪不能替代布局指定目标的成熟要求', () => {
        const { farming, unlockFirst, ripe, GrowNearBerryMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.hire();
        ripe(0, 0, BerryType.Cheri);
        const competing = new GrowNearBerryMutation(1, BerryType.Persim, [BerryType.Cheri]);
        const target = new GrowNearBerryMutation(1, BerryType.Lum, [BerryType.Cheri, BerryType.Chesto]);
        farming.mutations = [competing, target];
        farming.mulchList[MulchType.Surprise_Mulch](100);
        enableLayout(farming, { 1: { role: 'mutation', targetBerry: BerryType.Lum, mulch: MulchType.Surprise_Mulch } });

        expect(competing.forFarm(0).getMutationPlots()).toContain(1);
        expect(target.forFarm(0).getMutationPlots()).not.toContain(1);
        hand.work();

        expect(farming.getFarmPlots(0)[1].mulch).toBe(MulchType.None);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBe(100);
    });

    it.each([
        { reason: '目标规则尚未解锁', unlocked: false, chance: 1, occupied: false },
        { reason: '目标概率已降至零', unlocked: true, chance: 0, occupied: false },
        { reason: '突变格已有幼年产物', unlocked: true, chance: 1, occupied: true },
    ])('突变时机：$reason 时不消耗突变肥料', ({ unlocked, chance, occupied }) => {
        const { farming, unlockFirst, ripe, GrowNearBerryMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.hire();
        ripe(0, 0, BerryType.Cheri);
        const target = farming.getFarmPlots(0)[1];
        if (occupied) {
            target.plant(BerryType.Lum);
        }
        farming.mutations = [new GrowNearBerryMutation(1, BerryType.Lum, [BerryType.Cheri], {
            unlockReq: () => unlocked,
            chanceModifier: () => chance,
        })];
        farming.mulchList[MulchType.Surprise_Mulch](100);
        enableLayout(farming, { 1: { role: 'mutation', targetBerry: BerryType.Lum, mulch: MulchType.Surprise_Mulch } });

        hand.work();

        expect(target.mulch).toBe(MulchType.None);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBe(100);
    });

    it('突变时机：检查同目标所有配方，不被未解锁的第一条规则阻塞', () => {
        const { farming, unlockFirst, ripe, GrowNearBerryMutation } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.hire();
        ripe(0, 0, BerryType.Cheri);
        farming.mutations = [
            new GrowNearBerryMutation(1, BerryType.Lum, [BerryType.Chesto], { unlockReq: () => false }),
            new GrowNearBerryMutation(1, BerryType.Lum, [BerryType.Cheri]),
        ];
        farming.mulchList[MulchType.Surprise_Mulch](100);
        enableLayout(farming, { 1: { role: 'mutation', targetBerry: BerryType.Lum, mulch: MulchType.Surprise_Mulch } });

        hand.work();

        expect(farming.getFarmPlots(0)[1].mulch).toBe(MulchType.Surprise_Mulch);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBeLessThan(100);
    });

    it('突变时机：只读取助手所属农田，其他田的成熟母株不能触发提前施肥', () => {
        const { farming, addFarm, ripe, GrowNearBerryMutation } = setup();
        addFarm();
        farming.getFarmPlots(1).forEach(plot => { plot.isUnlocked = true; });
        const hand = farming.farms()[1].hands.list[0];
        hand.hire();
        ripe(0, 0, BerryType.Cheri);
        const source = farming.getFarmPlots(1)[0];
        source.plant(BerryType.Cheri);
        const target = farming.getFarmPlots(1)[1];
        farming.mutations = [new GrowNearBerryMutation(1, BerryType.Lum, [BerryType.Cheri])];
        farming.mulchList[MulchType.Surprise_Mulch](100);
        enableLayout(farming, { 1: { role: 'mutation', targetBerry: BerryType.Lum, mulch: MulchType.Surprise_Mulch } }, 1);
        farming.selectedFarm(0);

        hand.work();
        expect(target.mulch).toBe(MulchType.None);
        expect(farming.mulchList[MulchType.Surprise_Mulch]()).toBe(100);

        source.update(BerryList[BerryType.Cheri].growthTime[PlotStage.Bloom]);
        hand.work();
        expect(target.mulch).toBe(MulchType.Surprise_Mulch);
        expect(farming.getFarmPlots(0)[1].mulch).toBe(MulchType.None);
    });

    it('Lum 母株保留成熟冻结状态，收获突变格后继续留空且不按 Replant 回种', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const berries = [7, 6, 4, 6, 7, 5, -1, 2, -1, 5, 3, 1, 0, 1, 3, 5, -1, 2, -1, 5, 7, 6, 4, 6, 7];
        const cells = Object.fromEntries(berries.map((berry, index) => [index, berry < 0
            ? { role: 'mutation', mulch: MulchType.Surprise_Mulch, targetBerry: BerryType.Lum }
            : { role: 'keep', berry, mulch: MulchType.Freeze_Mulch }]));
        berries.forEach((berry, index) => {
            const plot = berry < 0 ? farming.getFarmPlots(0)[index] : ripe(0, index, berry);
            plot.mulch = berry < 0 ? MulchType.Surprise_Mulch : MulchType.Freeze_Mulch;
            plot.mulchTimeLeft = 100_000;
        });
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
        hand.focus(-2);
        hand.shouldHarvest(true);
        hand.hire();
        enableLayout(farming, cells);
        const before = farming.berryInventory.map(berry => berry());
        const target = ripe(0, 6, BerryType.Lum);
        const amount = target.harvestAmount();
        hand.work();
        expect(farming.getFarmPlots(0).filter(plot => plot.isEmpty()).map(plot => plot.index)).toEqual([6, 8, 16, 18]);
        expect(farming.berryInventory[BerryType.Lum]()).toBe(before[BerryType.Lum] + amount);
        berries.forEach((berry, index) => {
            if (berry < 0) return;
            expect(farming.getFarmPlots(0)[index].berry).toBe(berry);
            expect(farming.getFarmPlots(0)[index].stage()).toBe(PlotStage.Berry);
            expect(farming.berryInventory[berry]()).toBe(before[berry]);
        });
    });

    it('成熟之前不冻结原料，成熟后按真实库存扣除肥料且不改年龄', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.hire();
        const plot = farming.getFarmPlots(0)[0];
        plot.plant(BerryType.Chesto);
        farming.mulchList[MulchType.Freeze_Mulch](1000);
        enableLayout(farming, { 0: { role: 'keep', berry: BerryType.Chesto, mulch: MulchType.Freeze_Mulch } });
        hand.work();
        expect(plot.mulch).toBe(MulchType.None);
        expect(plot.age).toBe(0);
        expect(farming.mulchList[MulchType.Freeze_Mulch]()).toBe(1000);
        ripe(0, 0, BerryType.Chesto);
        const age = plot.age;
        hand.work();
        const consumed = 1000 - farming.mulchList[MulchType.Freeze_Mulch]();
        expect(consumed).toBeGreaterThan(0);
        expect(plot.mulch).toBe(MulchType.Freeze_Mulch);
        expect(plot.mulchTimeLeft).toBe(consumed * GameConstants.MULCH_USE_TIME);
        expect(plot.age).toBe(age);
    });

    it('Yache 原株进化位不收成熟 Passho，只有成熟 Yache 才采收并补回 Passho', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Logan');
        hand.focus(BerryType.Cheri);
        hand.shouldHarvest(true);
        hand.plots([0]);
        hand.hire();
        enableLayout(farming, { 0: { role: 'evolve', berry: BerryType.Passho, targetBerry: BerryType.Yache } });
        const source = ripe(0, 0, BerryType.Passho);
        const passhoBefore = farming.berryInventory[BerryType.Passho]();
        hand.work();
        expect(source.berry).toBe(BerryType.Passho);
        expect(source.stage()).toBe(PlotStage.Berry);
        expect(farming.berryInventory[BerryType.Passho]()).toBe(passhoBefore);
        source.berry = BerryType.Yache;
        source.age = 0;
        hand.work();
        expect(source.berry).toBe(BerryType.Yache);
        expect(source.age).toBe(0);
        const yacheBefore = farming.berryInventory[BerryType.Yache]();
        ripe(0, 0, BerryType.Yache);
        const amount = source.harvestAmount();
        hand.work();
        expect(farming.berryInventory[BerryType.Yache]()).toBe(yacheBefore + amount);
        expect(farming.berryInventory[BerryType.Passho]()).toBe(passhoBefore - 1);
        expect(source.berry).toBe(BerryType.Passho);
        expect(source.age).toBe(0);
    });

    it('空突变位采收任意成熟副产物后仍留空，纯隔离位保留已有植物', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Logan');
        hand.shouldHarvest(true);
        hand.focus(BerryType.Cheri);
        hand.plots([0, 1]);
        hand.hire();
        enableLayout(farming, {
            0: { role: 'mutation', targetBerry: BerryType.Lum },
            1: { role: 'empty' },
        });
        ripe(0, 0, BerryType.Persim);
        const isolated = ripe(0, 1, BerryType.Liechi);
        const before = farming.berryInventory[BerryType.Liechi]();
        hand.work();
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        expect(isolated.berry).toBe(BerryType.Liechi);
        expect(farming.berryInventory[BerryType.Liechi]()).toBe(before);
        hand.work();
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
    });

    it('安全锁和错种冲突逐格阻塞，绝不铲除唯一 Liechi 或消耗铲子', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Logan');
        hand.shouldHarvest(true);
        hand.focus(BerryType.Cheri);
        hand.plots([0, 1, 2]);
        hand.hire();
        farming.shovelAmt(9);
        farming.mulchShovelAmt(8);
        const unique = ripe(0, 0, BerryType.Liechi);
        const locked = ripe(0, 1, BerryType.Chesto);
        locked.isSafeLocked = true;
        const layout = enableLayout(farming, {
            0: { role: 'cycle', berry: BerryType.Cheri },
            1: { role: 'cycle', berry: BerryType.Chesto },
            2: { role: 'keep', berry: BerryType.Pecha },
        });
        const age = unique.age;
        hand.work();
        expect(unique.berry).toBe(BerryType.Liechi);
        expect(unique.age).toBe(age);
        expect(locked.stage()).toBe(PlotStage.Berry);
        expect(farming.getFarmPlots(0)[2].berry).toBe(BerryType.Pecha);
        expect(farming.shovelAmt()).toBe(9);
        expect(farming.mulchShovelAmt()).toBe(8);
        expect(layout.status(0)).toBeTruthy();
        expect(layout.status(1)).toBeTruthy();
    });

    it('布局与常规作业共享助手效率，未托管格正常种植且托管母株不被普通收获', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Logan');
        hand.plots([0, 1, 2, 3, 4]);
        hand.focus(BerryType.Cheri);
        hand.shouldHarvest(true);
        hand.hire();
        ripe(0, 0, BerryType.Chesto);
        enableLayout(farming, {
            0: { role: 'keep', berry: BerryType.Chesto },
            1: { role: 'mutation', targetBerry: BerryType.Lum },
            2: { role: 'cycle', berry: BerryType.Cheri },
        });
        const seeds = farming.berryInventory[BerryType.Cheri]();
        hand.work();
        expect(farming.getFarmPlots(0).filter(plot => plot.berry === BerryType.Cheri).map(plot => plot.index)).toEqual([2, 3, 4]);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(seeds - 3);
        expect(farming.getFarmPlots(0)[0].berry).toBe(BerryType.Chesto);
        expect(farming.getFarmPlots(0)[1].isEmpty()).toBe(true);
        expect(hand.experience()).toBe(3);
        expect(hand.energy()).toBe(14);
    });

    it('效率一的助手本轮只采收，下轮才重新播种，并按真实收获量增加库存', () => {
        const { farming, unlockFirst, ripe, wallet } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.plots([0]);
        hand.hire();
        enableLayout(farming, { 0: { role: 'cycle', berry: BerryType.Cheri } });
        const plot = ripe(0, 0);
        const seeds = farming.berryInventory[BerryType.Cheri]();
        const amount = plot.harvestAmount();
        hand.work();
        expect(plot.isEmpty()).toBe(true);
        expect(hand.experience()).toBe(2);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(seeds + amount);
        hand.work();
        expect(plot.berry).toBe(BerryType.Cheri);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(seeds + amount - 1);
        expect(hand.experience()).toBe(3);
        expect(wallet.loseAmount).toHaveBeenCalledTimes(1);
    });

    it('Rich 在成熟采收时才施用，施肥和采收分别占用助手动作', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.plots([0]);
        hand.hire();
        farming.mulchList[MulchType.Rich_Mulch](20);
        enableLayout(farming, { 0: { role: 'cycle', berry: BerryType.Cheri, mulch: MulchType.Rich_Mulch } });
        const plot = farming.getFarmPlots(0)[0];
        plot.plant(BerryType.Cheri);
        hand.work();
        expect(farming.mulchList[MulchType.Rich_Mulch]()).toBe(20);
        expect(plot.mulch).toBe(MulchType.None);
        ripe(0, 0);
        const seeds = farming.berryInventory[BerryType.Cheri]();
        hand.work();
        expect(plot.stage()).toBe(PlotStage.Berry);
        expect(plot.mulch).toBe(MulchType.Rich_Mulch);
        expect(farming.mulchList[MulchType.Rich_Mulch]()).toBeLessThan(20);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(seeds);
        const amount = plot.harvestAmount();
        hand.work();
        expect(plot.isEmpty()).toBe(true);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(seeds + amount);
    });

    it('不替换已有其他肥料，待耗尽后再按布局施肥且不消耗肥料铲', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.plots([0]);
        hand.hire();
        farming.mulchList[MulchType.Rich_Mulch](20);
        farming.mulchShovelAmt(3);
        const plot = ripe(0, 0);
        plot.mulch = MulchType.Boost_Mulch;
        plot.mulchTimeLeft = 30;
        enableLayout(farming, { 0: { role: 'cycle', berry: BerryType.Cheri, mulch: MulchType.Rich_Mulch } });
        hand.work();
        expect(plot.berry).toBe(BerryType.Cheri);
        expect(plot.mulch).toBe(MulchType.Boost_Mulch);
        expect(farming.mulchList[MulchType.Rich_Mulch]()).toBe(20);
        expect(farming.mulchShovelAmt()).toBe(3);
        plot.clearMulch();
        hand.work();
        expect(plot.mulch).toBe(MulchType.Rich_Mulch);
        expect(farming.mulchShovelAmt()).toBe(3);
    });

    it('现有 Rich 直接用于收获，不因工作窗口长而反复补肥耗尽预算', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.plots([0]);
        hand.hire();
        farming.mulchList[MulchType.Rich_Mulch](100);
        const layout = enableLayout(farming, { 0: { role: 'cycle', berry: BerryType.Cheri, mulch: MulchType.Rich_Mulch } });
        const plot = ripe(0, 0);
        plot.mulch = MulchType.Rich_Mulch;
        plot.mulchTimeLeft = 0.001;
        const amount = plot.harvestAmount();
        const before = farming.berryInventory[BerryType.Cheri]();
        expect(layout.work(hand, 1)).toEqual({ actions: 1, experience: 2 });
        expect(plot.isEmpty()).toBe(true);
        expect(farming.mulchList[MulchType.Rich_Mulch]()).toBe(100);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(before + amount);
        ripe(0, 0);
        plot.clearMulch();
        expect(layout.work(hand, 50)).toEqual({ actions: 3, experience: 3 });
        expect(farming.mulchList[MulchType.Rich_Mulch]()).toBe(99);
        expect(plot.berry).toBe(BerryType.Cheri);
        expect(plot.age).toBe(0);
    });

    it('循环生产等待本田辅助株成熟，期间保留成熟 Liechi 并暂停施 Rich', () => {
        vi.useFakeTimers();
        try {
            const { farming, unlockFirst, ripe } = setup();
            unlockFirst();
            const hand = farming.farmHands.list.find(candidate => candidate.name === 'Logan');
            hand.plots([0, 1]);
            hand.shouldHarvest(true);
            hand.focus(BerryType.Cheri);
            hand.hire();
            farming.mulchList[MulchType.Rich_Mulch](10);
            const target = ripe(0, 0, BerryType.Liechi);
            const support = farming.getFarmPlots(0)[1];
            support.plant(BerryType.Passho);
            enableLayout(farming, {
                0: { role: 'cycle', berry: BerryType.Liechi, mulch: MulchType.Rich_Mulch },
                1: { role: 'keep', berry: BerryType.Passho },
            });
            const before = farming.berryInventory[BerryType.Liechi]();
            hand.work();
            expect(target.berry).toBe(BerryType.Liechi);
            expect(target.stage()).toBe(PlotStage.Berry);
            expect(target.mulch).toBe(MulchType.None);
            expect(farming.berryInventory[BerryType.Liechi]()).toBe(before);
            expect(farming.mulchList[MulchType.Rich_Mulch]()).toBe(10);
            ripe(0, 1, BerryType.Passho);
            vi.advanceTimersByTime(60);
            hand.work();
            expect(target.berry).toBe(BerryType.Liechi);
            expect(target.age).toBe(0);
            expect(support.berry).toBe(BerryType.Passho);
            expect(support.stage()).toBe(PlotStage.Berry);
            expect(farming.mulchList[MulchType.Rich_Mulch]()).toBe(9);
            expect(hand.experience()).toBe(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it('冻结续肥能覆盖低效率助手巡田，并受 Sprinklotad 持续时间加成影响', () => {
        const run = (duration: number) => {
            const { farming, unlockFirst, ripe, app } = setup();
            unlockFirst();
            app.game.oakItems.calculateBonus = item => item === 1 ? duration : 1;
            const hand = farming.farmHands.list[0];
            hand.plots([0, 1, 2]);
            hand.hire();
            farming.mulchList[MulchType.Freeze_Mulch](1000);
            const layout = enableLayout(farming, Object.fromEntries([0, 1, 2].map(index => [index, {
                role: 'keep', berry: BerryType.Chesto, mulch: MulchType.Freeze_Mulch,
            }])));
            [0, 1, 2].forEach(index => ripe(0, index, BerryType.Chesto));
            const plot = farming.getFarmPlots(0)[0];
            const age = plot.age;
            expect(layout.work(hand, 1)).toEqual({ actions: 1, experience: 0 });
            const consumed = 1000 - farming.mulchList[MulchType.Freeze_Mulch]();
            expect(plot.mulchTimeLeft * duration).toBeGreaterThan(4 * hand.workTick / GameConstants.SECOND);
            plot.update(4 * hand.workTick / GameConstants.SECOND);
            expect(plot.mulch).toBe(MulchType.Freeze_Mulch);
            expect(plot.age).toBe(age);
            return consumed;
        };
        const plain = run(1);
        const doubled = run(2);
        expect(doubled).toBeLessThan(plain);
        expect(Math.abs(plain - 2 * doubled)).toBeLessThanOrEqual(1);
    });

    it('全田托管但 Alex 仅负责一格时，冻结肥料开销与单格方案相同', () => {
        const run = (managedCount: number) => {
            const { farming, unlockFirst, ripe, app } = setup();
            unlockFirst();
            const hand = farming.farmHands.list[0];
            hand.plots([0]);
            hand.hire();
            farming.mulchList[MulchType.Freeze_Mulch](1000);
            const layout = enableLayout(farming, Object.fromEntries(Array.from({ length: managedCount }, (_, index) => [index, {
                role: 'keep', berry: BerryType.Chesto, mulch: MulchType.Freeze_Mulch,
            }])));
            Array.from({ length: managedCount }, (_, index) => ripe(0, index, BerryType.Chesto));
            expect(layout.work(hand, 50)).toEqual({ actions: 1, experience: 0 });
            const consumed = 1000 - farming.mulchList[MulchType.Freeze_Mulch]();
            expect(consumed).toBeGreaterThan(0);
            expect(app.game.statistics.totalMulchesUsed()).toBe(consumed);
            expect(farming.getFarmPlots(0)[0].mulchTimeLeft).toBe(consumed * GameConstants.MULCH_USE_TIME);
            expect(farming.getFarmPlots(0).slice(1).every(plot => plot.mulch === MulchType.None)).toBe(true);
            return consumed;
        };
        expect(run(25)).toBe(run(1));
    });

    it('保留株成熟后不再新施或续 Boost 与 Amaze，未成熟时仍正常施肥', () => {
        for (const mulch of [MulchType.Boost_Mulch, MulchType.Amaze_Mulch]) {
            const { farming, unlockFirst, ripe } = setup();
            unlockFirst();
            const hand = farming.farmHands.list[0];
            hand.plots([0]);
            hand.hire();
            farming.mulchList[mulch](1000);
            const plot = ripe(0, 0, BerryType.Passho);
            const age = plot.age;
            const layout = enableLayout(farming, { 0: { role: 'keep', berry: BerryType.Passho, mulch } });
            expect(layout.work(hand, 1)).toEqual({ actions: 0, experience: 0 });
            expect(plot.mulch).toBe(MulchType.None);
            expect(farming.mulchList[mulch]()).toBe(1000);
            plot.mulch = mulch;
            plot.mulchTimeLeft = 0.001;
            expect(layout.work(hand, 1)).toEqual({ actions: 0, experience: 0 });
            expect(plot.mulchTimeLeft).toBe(0.001);
            expect(plot.age).toBe(age);
            expect(farming.mulchList[mulch]()).toBe(1000);
            plot.plant(BerryType.Passho);
            plot.clearMulch();
            expect(layout.work(hand, 1)).toEqual({ actions: 1, experience: 0 });
            expect(plot.mulch).toBe(mulch);
            expect(plot.age).toBe(0);
            expect(farming.mulchList[mulch]()).toBeLessThan(1000);
        }
    });

    it('仅第一个已雇用且允许该格的助手负责布局，其他助手不能普通补种托管空位', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const [first, second] = farming.farmHands.list;
        first.plots([0]);
        second.plots([0]);
        [first, second].forEach(hand => {
            hand.hire();
            hand.focus(BerryType.Cheri);
            hand.shouldHarvest(true);
        });
        enableLayout(farming, { 0: { role: 'keep', berry: BerryType.Chesto } });
        second.work();
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        first.work();
        expect(farming.getFarmPlots(0)[0].berry).toBe(BerryType.Chesto);
        farming.getFarmPlots(0)[0].berry = BerryType.None;
        first.plots([]);
        second.work();
        expect(farming.getFarmPlots(0)[0].berry).toBe(BerryType.Chesto);
    });

    it('未雇用或未分配格子的助手不能执行布局，缺种时不耗动作或凭空增加种子', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.plots([0]);
        const layout = enableLayout(farming, { 0: { role: 'keep', berry: BerryType.Chesto } });
        expect(layout.work(hand, 1).actions).toBe(0);
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        hand.hire();
        hand.plots([]);
        expect(layout.work(hand, 1).actions).toBe(0);
        hand.plots([0]);
        farming.berryInventory[BerryType.Chesto](0);
        const before = hand.experience();
        hand.work();
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        expect(farming.berryInventory[BerryType.Chesto]()).toBe(0);
        expect(hand.experience()).toBe(before);
    });

    it('布局按田保存并仅操作助手所属田，读档不收费且旧档默认停用', () => {
        const first = setup();
        first.addFarm();
        const hand = first.farming.farms()[1].hands.list[0];
        hand.hire();
        hand.plots([0]);
        enableLayout(first.farming, { 0: { role: 'keep', berry: BerryType.Chesto } }, 1);
        first.farming.selectedFarm(0);
        hand.work();
        expect(first.farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        expect(first.farming.getFarmPlots(1)[0].berry).toBe(BerryType.Chesto);
        const saved = JSON.parse(JSON.stringify(first.farming.toJSON()));
        const second = setup();
        second.farming.fromJSON(saved);
        expect(second.wallet.loseAmount).not.toHaveBeenCalled();
        expect(second.farming.farms()[0].layout.enabled()).toBe(false);
        expect(second.farming.farms()[1].layout.enabled()).toBe(true);
        expect(second.farming.farms()[1].layout.plan()).toEqual(first.farming.farms()[1].layout.plan());
        expect(JSON.parse(JSON.stringify(second.farming.toJSON()))).toEqual(saved);
        const legacy = setup();
        legacy.farming.fromJSON({ plotList: [], farmHands: [] });
        expect(legacy.farming.farms()[0].layout.enabled()).toBe(false);
    });

    it('非法或未补全布局不能启用，也不会改变真实作物和库存', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const layout = farming.farms()[0].layout;
        const plot = ripe(0, 0, BerryType.Liechi);
        const before = farming.berryInventory.map(berry => berry());
        layout.setPlan(layoutPlan({ 0: { role: 'evolve', berry: BerryType.Passho, targetBerry: BerryType.None } }));
        expect(layout.validation().length).toBeGreaterThan(0);
        layout.toggle();
        expect(layout.enabled()).toBe(false);
        expect(plot.berry).toBe(BerryType.Liechi);
        expect(farming.berryInventory.map(berry => berry())).toEqual(before);
    });

    it('单田损坏布局安全停用，不阻止其他田的计划与真实作物读档', () => {
        const first = setup();
        first.addFarm();
        first.ripe(0, 0, BerryType.Liechi);
        enableLayout(first.farming, { 0: { role: 'keep', berry: BerryType.Chesto } }, 1);
        const saved = JSON.parse(JSON.stringify(first.farming.toJSON()));
        saved.farms[0].layout = { enabled: true, plan: { version: 1, cells: '损坏数据' } };
        const second = setup();
        expect(() => second.farming.fromJSON(saved)).not.toThrow();
        expect(second.farming.getFarmPlots(0)[0].berry).toBe(BerryType.Liechi);
        expect(second.farming.farms()[0].layout.enabled()).toBe(false);
        expect(second.farming.farms()[1].layout.enabled()).toBe(true);
        expect(second.farming.farms()[1].layout.plan()).toEqual(first.farming.farms()[1].layout.plan());
        expect(second.wallet.loseAmount).not.toHaveBeenCalled();
    });
});

describe('树果收获时间预览', () => {
    it('将全局生长加成应用到实际预览绑定', () => {
        const { farming, FarmController, app } = setup();
        farming.getFarmPlots(0)[0].isUnlocked = true;
        app.game.oakItems.calculateBonus = () => 2;
        const preview = growthPreview(FarmController, app);
        expect(preview.innerHTML).toBe(GameConstants.formatSecondsToTime(Math.ceil(BerryList[BerryType.Cheri].growthTime[PlotStage.Bloom] / 2)));
        const template = document.createElement('div');
        template.innerHTML = readFileSync('src/components/farmModal.html', 'utf8');
        const seedBindings = runInNewContext(`({${template.querySelector('#seedList li').getAttribute('data-bind')}})`, {
            $data: BerryType.Cheri, App: app, FarmController, BerryList, BerryType, GameConstants, FarmingTool,
        });
        expect(seedBindings.tooltip.title).toContain(`<u>预计收获时间</u>: ${preview.innerHTML}<br/>`);
        ko.cleanNode(preview);
    });

    it('预览和详情随全局加成变化更新，并与新种格子的倒计时保持一致', () => {
        const { farming, FarmController, app } = setup();
        const plot = farming.getFarmPlots(0)[0];
        plot.isUnlocked = true;
        plot.plant(BerryType.Cheri);
        const bonus = ko.observable(1);
        app.game.oakItems.calculateBonus = () => bonus();
        const previews = [growthPreview(FarmController, app), growthPreview(FarmController, app, true)];
        for (const multiplier of [1, 1.3, 2]) {
            bonus(multiplier);
            previews.forEach(preview => expect(preview.innerHTML).toBe(GameConstants.formatSecondsToTime(plot.calcTimeLeft(true))));
        }
        previews.forEach(preview => ko.cleanNode(preview));
    });

    it('叠加肥料和邻近生长光环，预览成熟格子重种时使用生长倍率', () => {
        vi.useFakeTimers();
        try {
            const { farming, FarmController, app, ripe } = setup();
            farming.getFarmPlots(0).forEach(plot => { plot.isUnlocked = false; });
            const plot = ripe(0, 0);
            plot.isUnlocked = true;
            plot.mulch = MulchType.Boost_Mulch;
            const neighbour = ripe(0, 1, BerryType.Wacan);
            neighbour.isUnlocked = true;
            neighbour.isSafeLocked = true;
            app.game.oakItems.calculateBonus = () => 2;
            vi.advanceTimersByTime(60);
            const preview = growthPreview(FarmController, app);
            expect(preview.innerHTML).toBe(GameConstants.formatSecondsToTime(Math.ceil(30 / (2 * 1.5 * 1.3))));
            plot.plant(BerryType.Cheri);
            expect(preview.innerHTML).toBe(GameConstants.formatSecondsToTime(plot.calcTimeLeft(true)));
            plot.update(plot.calcTimeLeft(true));
            expect(plot.stage()).toBe(PlotStage.Berry);
            ko.cleanNode(preview);
        } finally {
            vi.useRealTimers();
        }
    });

    it('按当前田展示时间范围，忽略未解锁和锁定格子，并在切田后更新', () => {
        const { farming, FarmController, app, addFarm } = setup();
        addFarm();
        farming.selectedFarm(0);
        const plots = farming.getFarmPlots(0);
        plots[0].mulch = MulchType.Boost_Mulch;
        plots[1].mulch = MulchType.Freeze_Mulch;
        plots[1].isSafeLocked = true;
        plots[2].mulch = MulchType.Freeze_Mulch;
        plots[2].isUnlocked = false;
        const preview = growthPreview(FarmController, app);
        expect(preview.innerHTML).toBe('20 secs ～ 30 secs');
        farming.selectedFarm(1);
        expect(preview.innerHTML).toBe('30 secs');
        farming.getFarmPlots(1).forEach(plot => { plot.mulch = MulchType.Amaze_Mulch; });
        expect(preview.innerHTML).toBe('24 secs');
        ko.cleanNode(preview);
    });

    it('明确显示冻结暂停，不输出无效时间', () => {
        const { farming, FarmController, app } = setup();
        const plots = farming.getFarmPlots(0);
        plots.forEach(plot => { plot.isUnlocked = false; });
        plots[0].isUnlocked = true;
        plots[0].mulch = MulchType.Freeze_Mulch;
        const preview = growthPreview(FarmController, app);
        expect(preview.innerHTML).toBe('暂停生长');
        plots[1].isUnlocked = true;
        expect(preview.innerHTML).toBe('30 secs 起（部分格子暂停生长）');
        ko.cleanNode(preview);
    });

    it('没有可操作格子时按全局加成估算', () => {
        const { farming, FarmController, app } = setup();
        farming.getFarmPlots(0).forEach(plot => { plot.isUnlocked = false; });
        app.game.oakItems.calculateBonus = () => 2;
        const preview = growthPreview(FarmController, app);
        expect(preview.innerHTML).toBe('15 secs');
        farming.getFarmPlots(0)[0].isUnlocked = true;
        farming.getFarmPlots(0)[0].isSafeLocked = true;
        farming.getFarmPlots(0)[0].mulch = MulchType.Freeze_Mulch;
        expect(preview.innerHTML).toBe('15 secs');
        ko.cleanNode(preview);
    });
});

describe('multiple farms', () => {
    it('remembers each farm search, seed and page without resetting the page on a farm switch', () => {
        const { farming, FarmController, addFarm } = setup();
        addFarm();
        addFarm();
        FarmController.initialize();
        // Keep the computed controls subscribed, as they are while the modal is open.
        const subscriptions = [FarmController.berryListSearch, FarmController.navigateIndex, FarmController.selectedBerry].map(control => control.subscribe(() => undefined));
        farming.selectedFarm(0);
        FarmController.berryListSearch('ch');
        FarmController.selectedBerry(BerryType.Chesto);
        farming.selectedFarm(1);
        expect(FarmController.berryListSearch()).toBe('');
        expect(FarmController.selectedBerry()).toBe(BerryType.Cheri);
        FarmController.navigateIndex(2);
        FarmController.selectedBerry(BerryType.Pecha);
        farming.selectedFarm(2);
        FarmController.berryListSearch('cheri');
        farming.selectedFarm(0);
        expect(FarmController.berryListSearch()).toBe('ch');
        expect(FarmController.selectedBerry()).toBe(BerryType.Chesto);
        farming.selectedFarm(1);
        expect(FarmController.navigateIndex()).toBe(2);
        expect(FarmController.selectedBerry()).toBe(BerryType.Pecha);
        FarmController.berryListSearch('pecha');
        expect(FarmController.navigateIndex()).toBe(0);
        farming.selectedFarm(2);
        expect(FarmController.berryListSearch()).toBe('cheri');
        subscriptions.forEach(subscription => subscription.dispose());
    });

    it('restores independent farm controls with the save and defaults safely for old or invalid data', () => {
        const first = setup();
        first.addFarm();
        first.farming.selectedFarm(0);
        first.FarmController.berryListSearch('ch');
        first.FarmController.selectedBerry(BerryType.Chesto);
        first.farming.selectedFarm(1);
        first.FarmController.selectedBerry(BerryType.Pecha);
        first.FarmController.navigateIndex(2);
        const saved = JSON.parse(JSON.stringify(first.farming.toJSON()));
        const second = setup();
        second.farming.fromJSON(saved);
        second.FarmController.initialize();
        expect(second.FarmController.selectedBerry()).toBe(BerryType.Pecha);
        expect(second.FarmController.navigateIndex()).toBe(2);
        second.farming.selectedFarm(0);
        expect(second.FarmController.berryListSearch()).toBe('ch');
        expect(second.FarmController.selectedBerry()).toBe(BerryType.Chesto);
        expect(JSON.parse(JSON.stringify(second.farming.toJSON())).farms).toEqual(saved.farms);
        second.farming.fromJSON({ farms: [{}, { berrySearch: 7, selectedBerry: -1, berryPage: Infinity }] });
        expect(second.farming.farms().map(farm => [farm.berrySearch(), farm.selectedBerry(), farm.berryPage()])).toEqual([
            ['', BerryType.Cheri, 0], ['', BerryType.Cheri, 0],
        ]);
    });

    it('keeps lower plant and harvest controls on the current farm even when the batch scope is all', () => {
        const { farming, FarmController, addFarm, ripe } = setup();
        addFarm();
        addFarm();
        FarmController.batchScope('all');
        farming.selectedFarm(1);
        FarmController.selectedBerry(BerryType.Chesto);
        FarmController.plantAll();
        expect(farming.farms().map(farm => farm.plots.filter(plot => plot.berry === BerryType.Chesto).length)).toEqual([0, 25, 0]);
        [0, 1, 2].forEach(id => ripe(id));
        FarmController.harvestAll();
        expect(farming.getFarmPlots(1)[0].isEmpty()).toBe(true);
        expect(farming.getFarmPlots(0)[0].stage()).toBe(PlotStage.Berry);
        expect(farming.getFarmPlots(2)[0].stage()).toBe(PlotStage.Berry);
        FarmController.harvestBatch();
        expect([0, 1, 2].every(id => farming.getFarmPlots(id)[0].isEmpty())).toBe(true);
        FarmController.plantBatch();
        expect(farming.farms().every(farm => farm.plots.every(plot => plot.berry === BerryType.Chesto))).toBe(true);
    });

    it('separates current-farm mulching from selected-farm batch mulching and shares the inventory', async () => {
        const { farming, FarmController, addFarm } = setup();
        addFarm();
        addFarm();
        FarmController.batchScope('all');
        farming.selectedFarm(1);
        farming.mulchList[MulchType.Boost_Mulch](100);
        await FarmController.mulchAll();
        expect(farming.farms().map(farm => farm.plots.filter(plot => plot.mulch !== MulchType.None).length)).toEqual([0, 25, 0]);
        expect(farming.mulchList[MulchType.Boost_Mulch]()).toBe(75);
        FarmController.batchScope('selected');
        FarmController.checkedFarms([0, 2]);
        await FarmController.mulchBatch();
        expect(farming.farms().every(farm => farm.plots.every(plot => plot.mulch === MulchType.Boost_Mulch))).toBe(true);
        expect(farming.mulchList[MulchType.Boost_Mulch]()).toBe(25);
    });

    it('requires the original 25 plots and purchases complete farms at the agreed prices up to 16', () => {
        const { farming, wallet, unlockFirst } = setup();
        expect(farming.buyFarm()).toBe(false);
        expect(wallet.loseAmount).not.toHaveBeenCalled();
        unlockFirst();
        for (let count = 1; count < 16; count++) {
            expect(farming.nextFarmCost()).toBe(10_000 * count ** 2);
            expect(farming.buyFarm()).toBe(true);
            expect(farming.plotList).toHaveLength(25);
            expect(farming.plotList.every(plot => plot.isUnlocked && plot.isEmpty())).toBe(true);
        }
        expect(farming.buyFarm()).toBe(false);
        expect(wallet.loseAmount).toHaveBeenCalledTimes(15);
        expect(wallet.loseAmount.mock.calls.reduce((sum, [cost]) => sum + cost.amount, 0)).toBe(12_400_000);
    });

    it('does not create a farm when payment fails', () => {
        const { farming, unlockFirst, setBalance } = setup();
        unlockFirst();
        setBalance(9999);
        expect(farming.buyFarm()).toBe(false);
        expect(farming.farms()).toHaveLength(1);
    });

    it('distributes scarce seeds across farms and respects locks and existing plants', () => {
        const { farming, addFarm } = setup();
        addFarm();
        addFarm();
        farming.getFarmPlots(0)[0].isSafeLocked = true;
        farming.berryInventory[BerryType.Cheri](5);
        expect(farming.batchPlant([0, 1, 2, 1, 99], BerryType.Cheri)).toBe(5);
        expect([0, 1, 2].map(id => farming.getFarmPlots(id).filter(plot => !plot.isEmpty()).length)).toEqual([1, 2, 2]);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(0);
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
    });

    it('harvests and replants across the requested farms without touching safe locks', () => {
        const { farming, addFarm, ripe } = setup();
        addFarm();
        ripe(0);
        ripe(1);
        const protectedPlot = ripe(1, 1);
        protectedPlot.isSafeLocked = true;
        expect(farming.batchHarvest([0, 1], true)).toBe(2);
        expect(farming.getFarmPlots(0)[0].age).toBe(0);
        expect(farming.getFarmPlots(1)[0].berry).toBe(BerryType.Cheri);
        expect(protectedPlot.stage()).toBe(PlotStage.Berry);
    });

    it('shares mulch across eligible plots without wasting inventory on a locked plot', () => {
        const { farming, addFarm } = setup();
        addFarm();
        farming.getFarmPlots(0)[0].isSafeLocked = true;
        farming.mulchList[MulchType.Boost_Mulch](100);
        expect(farming.batchMulch([0, 1], MulchType.Boost_Mulch, 10)).toBe(49);
        expect(farming.mulchList[MulchType.Boost_Mulch]()).toBe(2);
        expect(farming.getFarmPlots(0)[0].mulch).toBe(MulchType.None);
        farming.mulchList[MulchType.Boost_Mulch](49);
        expect(farming.batchMulch([0, 1], MulchType.Boost_Mulch, Infinity)).toBe(49);
        expect(farming.mulchList[MulchType.Boost_Mulch]()).toBe(0);
    });

    it('confirms destructive scope once and retains the original targets if selection changes', async () => {
        const { farming, FarmController, notification, addFarm } = setup();
        addFarm();
        farming.batchPlant([0, 1], BerryType.Cheri);
        farming.shovelAmt(100);
        farming.selectedFarm(0);
        farming.getFarmPlots(0)[0].isSafeLocked = true;
        let approve: (value: boolean) => void;
        notification.confirm.mockImplementationOnce(() => new Promise(resolve => { approve = resolve; }));
        const pending = FarmController.shovelBatch();
        farming.selectedFarm(1);
        approve(true);
        await pending;
        expect(farming.getFarmPlots(0).filter(plot => !plot.isEmpty())).toHaveLength(1);
        expect(farming.getFarmPlots(1).filter(plot => !plot.isEmpty())).toHaveLength(25);
        expect(farming.shovelAmt()).toBe(76);
    });

    it('copies employment configurations without copying energy and charges each new job', async () => {
        const { farming, FarmController, addFarm, wallet } = setup();
        addFarm();
        addFarm();
        farming.selectedFarm(0);
        const source = farming.farmHands.list[0];
        source.focus(BerryType.Cheri);
        source.plots([12]);
        source.hire();
        source.energy(2);
        FarmController.batchScope('all');
        wallet.loseAmount.mockClear();
        await FarmController.copyHands();
        expect(wallet.loseAmount).toHaveBeenCalledTimes(2);
        for (const id of [1, 2]) {
            const target = farming.farms()[id].hands.list[0];
            expect(target.focus()).toBe(BerryType.Cheri);
            expect(target.plots()).toEqual([12]);
            expect(target.hired()).toBe(true);
            expect(target.energy()).toBe(10);
        }
    });

    it('does not partly change employment when the combined immediate fee cannot be paid', async () => {
        const { farming, FarmController, addFarm, setBalance } = setup();
        addFarm();
        addFarm();
        farming.selectedFarm(0);
        const source = farming.farmHands.list[0];
        source.hire();
        source.focus(BerryType.Cheri);
        FarmController.batchScope('all');
        setBalance(source.cost.amount);
        await FarmController.copyHands();
        expect(farming.farms()[1].hands.hired()).toHaveLength(0);
        expect(farming.farms()[2].hands.list[0].focus()).toBe(BerryType.None);
    });

    it('keeps neighbours and Petaya protection inside their own farm despite selection changes', () => {
        const { farming, addFarm, ripe } = setup();
        addFarm();
        ripe(0, 12, BerryType.Petaya);
        farming.selectedFarm(0);
        expect(farming.getFarmPlots(1)[12].neighbours().every(plot => plot.farmId === 1)).toBe(true);
        const crop = ripe(1, 0);
        crop.update(10);
        expect(crop.age).toBeGreaterThan(BerryList[BerryType.Cheri].growthTime[PlotStage.Bloom]);
    });

    it('evaluates field mutations independently and mutates the bound farm, preserving shared hints', () => {
        const { farming, FieldMutation, addFarm, ripe } = setup();
        addFarm();
        ripe(0, 0);
        ripe(1, 0);
        const mutation = new FieldMutation(1, BerryType.Chesto, [{ berry: BerryType.Cheri, amountRequired: 2 }]);
        expect(mutation.forFarm(0).getMutationPlots()).toEqual([]);
        expect(mutation.forFarm(1).getMutationPlots()).toEqual([]);
        ripe(1, 1);
        farming.selectedFarm(0);
        expect(mutation.forFarm(1).getMutationPlots()).toContain(2);
        mutation.forFarm(1).handleMutation(2);
        expect(farming.getFarmPlots(1)[2].berry).toBe(BerryType.Chesto);
        expect(farming.getFarmPlots(0)[2].isEmpty()).toBe(true);
        mutation.forFarm(1).hintSeen = true;
        expect(mutation.hintSeen).toBe(true);
    });

    it('takes the strongest complete farm for each external aura rather than multiplying farms', () => {
        const { farming, addFarm } = setup();
        addFarm();
        const emit = (farmId: number, index: number, type: AuraType, value: number) => {
            farming.getFarmPlots(farmId)[index].emittingAura = { type: () => type, value: () => value };
        };
        emit(0, 0, AuraType.Shiny, 2);
        emit(0, 1, AuraType.Shiny, 3);
        emit(1, 0, AuraType.Shiny, 4);
        emit(1, 1, AuraType.Xp, 5);
        expect(farming.multiplyPlotAuras(AuraType.Shiny)).toBe(6);
        expect(farming.multiplyPlotAuras(AuraType.Xp)).toBe(5);
    });

    it('updates crops in all sixteen farms while displaying just one', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        for (let i = 1; i < 16; i++) farming.buyFarm();
        farming.batchPlant(farming.farms().map(farm => farm.id), BerryType.Cheri);
        farming.selectedFarm(0);
        farming.update(1);
        expect(farming.farms().every(farm => farm.plots.every(plot => plot.age === 1))).toBe(true);
    });

    it('migrates an old save into farm one and preserves crop, mulch, lock and helper progress', () => {
        const { farming } = setup();
        farming.fromJSON({
            plotList: Array.from({ length: 25 }, (_, index) => ({
                isUnlocked: index === 12, berry: index === 12 ? BerryType.Cheri : BerryType.None,
                age: 12, mulch: MulchType.Boost_Mulch, mulchTimeLeft: 300, isSafeLocked: index === 12,
            })),
            farmHands: [{ name: 'Alex', hired: true, energy: 7, workTicks: 5000, costTicks: 60_000, plots: [12], focus: BerryType.Cheri }],
        });
        expect(farming.farms()).toHaveLength(1);
        expect(farming.plotList[12].toJSON()).toMatchObject({ berry: BerryType.Cheri, age: 12, mulchTimeLeft: 300, isSafeLocked: true });
        expect(farming.farmHands.list[0].toJSON()).toMatchObject({ hired: true, energy: 7, workTicks: 5000, costTicks: 60_000, plots: [12] });
        expect(farming.farmHands.list[0].level).toBe(1);
    });

    it('round-trips multiple farm states and shared experience without charging on load', () => {
        const first = setup();
        first.addFarm();
        first.farming.farms()[1].name('变异田');
        first.ripe(1, 5);
        const hand = first.farming.farms()[1].hands.list[0];
        hand.gainExperience(20_000);
        hand.hire();
        hand.energy(93.408163);
        const saved = JSON.parse(JSON.stringify(first.farming.toJSON()));
        const second = setup();
        second.farming.fromJSON(saved);
        expect(second.wallet.loseAmount).not.toHaveBeenCalled();
        expect(JSON.parse(JSON.stringify(second.farming.toJSON()))).toEqual(saved);
        expect(second.farming.farms()[0].hands.list[0].experience()).toBe(20_000);
        expect(second.farming.farms()[1].hands.list[0].energy()).toBe(93.408163);
    });
});

describe('farm hand levels and independent employment', () => {
    it.each([
        ['Alex', 1, 25], ['Logan', 3, 25], ['Joey', 5, 25], ['Charlie', 10, 25],
        ['Bailey', 12, 25], ['Kerry', 16, 25], ['Riley', 25, 50], ['Jamie', 5, 25], ['Jessie', 50, 50],
    ])('grows %s from %i actions to %i without decreasing or exceeding the cap', (name, initial, maximum) => {
        const { farming } = setup();
        const hand = farming.farmHands.list.find(candidate => candidate.name === name);
        expect(hand.efficiency).toBe(initial);
        let previous = initial;
        for (let level = 2; level <= 50; level++) {
            hand.experience(50 * level * (level - 1));
            expect(hand.efficiency).toBeGreaterThanOrEqual(previous);
            expect(hand.efficiency).toBeLessThanOrEqual(maximum);
            expect(Number.isInteger(hand.efficiency)).toBe(true);
            if (initial >= 25 && level < 50) {
                expect(hand.efficiency).toBe(initial);
            }
            previous = hand.efficiency;
        }
        expect(hand.efficiency).toBe(maximum);
    });

    it.each([
        ['Alex', 25, 12], ['Alex', 49, 24],
    ])('gradually increases %s at level %i to %i actions', (name, level, expected) => {
        const { farming } = setup();
        const hand = farming.farmHands.list.find(candidate => candidate.name === name);
        hand.experience(50 * level * (level - 1));
        expect(hand.efficiency).toBe(expected);
    });

    it('keeps Riley at 25 actions until the exact level 50 experience threshold', () => {
        const { farming } = setup();
        const hand = farming.farmHands.list.find(candidate => candidate.name === 'Riley');
        hand.experience(122_499);
        expect(hand.level).toBe(49);
        expect(hand.efficiency).toBe(25);
        hand.gainExperience(1);
        expect(hand.level).toBe(50);
        expect(hand.efficiency).toBe(50);
    });

    it('lets a level 50 Riley harvest and plant all 25 plots independently in three farms', () => {
        const { farming, addFarm, ripe } = setup();
        addFarm();
        addFarm();
        farming.farms()[0].hands.list.find(hand => hand.name === 'Riley').gainExperience(122_500);
        farming.farms().forEach((farm, id) => {
            farm.plots.forEach((plot, index) => ripe(id, index));
            const hand = farm.hands.list.find(candidate => candidate.name === 'Riley');
            hand.focus(BerryType.Cheri);
            hand.shouldHarvest(true);
            hand.hire();
        });
        const before = farming.berryInventory[BerryType.Cheri]();
        farming.farms().forEach(farm => farm.hands.list.find(hand => hand.name === 'Riley').tick());
        expect(farming.farms().every(farm => farm.plots.every(plot => plot.berry === BerryType.Cheri && plot.age === 0))).toBe(true);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(before + 75 * (BerryList[BerryType.Cheri].harvestAmount - 1));
        expect(farming.farms().every(farm => farm.hands.list.find(hand => hand.name === 'Riley').energy() === 70)).toBe(true);
    });

    it.each(Array.from({ length: 50 }, (_, index) => [
        index + 1, index === 0 ? 1 : 2, index === 0 ? 4 : 5,
    ]))('Lv.%i 工作、休息和零体力时按整数恢复，且不超过容量上限', (level, recovery, remaining) => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(50 * level * (level - 1));
        expect(hand.recovery).toBe(recovery);
        hand.energy(5);
        hand.focus(BerryType.Cheri);
        hand.work();
        expect(hand.energy()).toBe(remaining);
        expect(farming.plotList.some(plot => !plot.isEmpty())).toBe(true);
        const experienceAfterWork = hand.experience();
        hand.focus(BerryType.None);
        hand.work();
        expect(hand.energy()).toBe(remaining + recovery);
        expect(hand.experience()).toBe(experienceAfterWork);
        farming.plotList.forEach(plot => { plot.berry = BerryType.None; });
        hand.focus(BerryType.Cheri);
        hand.energy(0);
        hand.work();
        expect(hand.energy()).toBe(recovery);
        expect(farming.plotList.every(plot => plot.isEmpty())).toBe(true);
        expect(hand.experience()).toBe(experienceAfterWork);
        hand.focus(BerryType.None);
        hand.energy(hand.maxEnergy - 1);
        hand.work();
        expect(hand.energy()).toBe(hand.maxEnergy);
        expect(hand.experience()).toBe(experienceAfterWork);
    });

    it('实际恢复单元格和提示随等级更新，Lv.1 显示 1 点，Lv.2–50 显示 2 点且不带小数', () => {
        const { farming } = setup();
        const hand = farming.farmHands.list[0];
        const template = document.createElement('div');
        template.innerHTML = readFileSync('src/components/farmModal.html', 'utf8');
        const row = Array.from(template.querySelectorAll('#farmHandsView tr'))
            .find(element => element.querySelector('td')?.textContent === '体力恢复');
        const recoveryCell = row.querySelector('td.text-right').cloneNode(true) as HTMLElement;
        ko.applyBindings(hand, recoveryCell);
        try {
            for (let level = 1; level <= 50; level++) {
                hand.experience(50 * level * (level - 1));
                const recovery = level === 1 ? 1 : 2;
                expect(recoveryCell.textContent).toBe(`${recovery} 点/轮`);
                expect(hand.tooltip()).toContain(`每轮恢复 ${recovery} 点体力`);
            }
        } finally {
            ko.cleanNode(recoveryCell);
        }
    });

    it('shares experience while keeping energy, assignments and wages independent', () => {
        const { farming, addFarm, wallet } = setup();
        addFarm();
        wallet.loseAmount.mockClear();
        const first = farming.farms()[0].hands.list[0];
        const second = farming.farms()[1].hands.list[0];
        first.gainExperience(100);
        expect([first.level, second.level]).toEqual([2, 2]);
        expect(first.maxEnergy).toBe(15);
        expect(first.energy()).toBe(10);
        first.hire();
        second.hire();
        expect(wallet.loseAmount).toHaveBeenCalledTimes(2);
        expect(farming.totalHourlyWages()).toBe(first.cost.amount * 2);
        first.energy(3);
        first.focus(BerryType.Cheri);
        first.fire();
        expect(second.energy()).toBe(10);
        expect(second.focus()).toBe(BerryType.None);
        expect(second.hired()).toBe(true);
    });

    it('enforces three hires per farm and pays nothing for duplicate or fourth hires', () => {
        const { farming, wallet } = setup();
        const hands = farming.farmHands.list;
        hands.slice(0, 4).forEach(hand => hand.hire());
        hands[0].hire();
        expect(farming.farmHands.hired()).toHaveLength(3);
        expect(wallet.loseAmount).toHaveBeenCalledTimes(3);
    });

    it('does not perform a free replant beyond the cycle action limit and only rewards actual work', () => {
        const { farming, unlockFirst, ripe } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.shouldHarvest(true);
        hand.focus(-2);
        const plot = ripe(0);
        hand.work();
        expect(plot.isEmpty()).toBe(true);
        expect(hand.experience()).toBe(2);
        expect(hand.energy()).toBe(9);
        hand.work();
        expect(plot.berry).toBe(BerryType.Cheri);
        expect(hand.experience()).toBe(3);
    });

    it('未雇佣助手按等级恢复整数体力，上限截断且不增加休息经验', () => {
        const { farming } = setup();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(50 * 21 * 20);
        expect(hand.level).toBe(21);
        hand.energy(0);
        hand.workTicks(Math.ceil(hand.workTick) - GameConstants.TICK_TIME);
        hand.tick();
        expect(hand.energy()).toBe(2);
        expect(hand.experience()).toBe(21_000);
        hand.energy(hand.maxEnergy - 1);
        hand.workTicks(Math.ceil(hand.workTick) - GameConstants.TICK_TIME);
        hand.tick();
        expect(hand.energy()).toBe(hand.maxEnergy);
        expect(hand.experience()).toBe(21_000);
    });

    it('does not loop or award experience when saved planting focus refers to a locked berry', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.focus(BerryType.Cheri);
        farming.unlockedBerries[BerryType.Cheri](false);
        hand.energy(5);
        hand.work();
        expect(hand.experience()).toBe(0);
        expect(hand.energy()).toBe(6);
        expect(farming.plotList.every(plot => plot.isEmpty())).toBe(true);
    });

    it('balances level 50 recovery and work cost for repeated cycles and rests first at zero energy', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(122_500);
        expect(hand.level).toBe(50);
        expect(hand.maxEnergy).toBe(255);
        expect(hand.efficiency).toBe(25);
        expect(hand.workTick).toBeLessThan(1_000_000);
        hand.focus(BerryType.Cheri);
        farming.berryInventory[BerryType.Cheri](6000);
        hand.energy(0);
        hand.work();
        expect(hand.energy()).toBe(2);
        expect(farming.plotList.every(plot => plot.isEmpty())).toBe(true);
        for (let cycle = 0; cycle < 200; cycle++) {
            farming.plotList.forEach(plot => { plot.berry = BerryType.None; });
            hand.work();
            expect(hand.energy()).toBe(2);
            expect(farming.plotList.filter(plot => !plot.isEmpty())).toHaveLength(25);
        }
        expect(hand.experience()).toBe(122_500);
        expect(hand.tooltip()).not.toContain('永动');
    });

    it('Lv.49 每轮恢复与工作消耗抵消，零体力先休息，并保留旧存档的小数体力', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(117_600);
        expect(hand.level).toBe(49);
        expect(hand.maxEnergy).toBe(250);
        hand.focus(BerryType.Cheri);
        farming.berryInventory[BerryType.Cheri](2000);
        hand.energy(1);
        hand.work();
        expect(hand.energy()).toBe(1);
        for (let cycle = 0; cycle < 49; cycle++) {
            farming.plotList.forEach(plot => { plot.berry = BerryType.None; });
            hand.work();
            expect(farming.plotList.filter(plot => !plot.isEmpty())).toHaveLength(24);
            expect(hand.energy()).toBe(1);
        }
        expect(hand.level).toBe(49);
        hand.energy(0);
        farming.plotList.forEach(plot => { plot.berry = BerryType.None; });
        hand.work();
        expect(farming.plotList.every(plot => plot.isEmpty())).toBe(true);
        expect(hand.energy()).toBe(2);
        hand.energy(0.01);
        farming.plotList.forEach(plot => { plot.berry = BerryType.None; });
        hand.work();
        expect(farming.plotList.filter(plot => !plot.isEmpty())).toHaveLength(24);
        expect(hand.energy()).toBe(0.01);
        hand.focus(BerryType.None);
        hand.work();
        expect(hand.energy()).toBe(2.01);
    });

    it('continues working only its own farm while another farm is selected', () => {
        const { farming, addFarm } = setup();
        addFarm();
        const hand = farming.farms()[1].hands.list[0];
        hand.focus(BerryType.Cheri);
        farming.selectedFarm(0);
        hand.hire();
        hand.tick();
        expect(farming.getFarmPlots(1)[0].berry).toBe(BerryType.Cheri);
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
    });

    it('charges hourly during idle rest and stops working when renewal cannot be paid', () => {
        const { farming, wallet, setBalance } = setup();
        const hand = farming.farmHands.list[0];
        hand.hire();
        hand.costTicks(GameConstants.HOUR - GameConstants.TICK_TIME);
        hand.tick();
        expect(wallet.loseAmount).toHaveBeenCalledTimes(2);
        setBalance(0);
        hand.costTicks(GameConstants.HOUR - GameConstants.TICK_TIME);
        hand.tick();
        expect(hand.hired()).toBe(false);
    });
});
