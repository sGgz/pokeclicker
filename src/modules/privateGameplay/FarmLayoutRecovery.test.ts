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

const scripts = ['FarmHand.ts', 'Plot.ts', 'FarmLayout.ts', 'Farming.ts']
    .map(file => transpileModule(readFileSync(`src/scripts/farming/${file}`, 'utf8'), {
        compilerOptions: { target: ScriptTarget.ES2020 },
    }).outputText).join('\n');

function setup() {
    const statistics = {
        totalManualHarvests: ko.observable(0), totalBerriesHarvested: ko.observable(0), totalBerriesMutated: ko.observable(0),
        berriesHarvested: BerryList.map(() => ko.observable(0)), totalMulchesUsed: ko.observable(0),
        totalBerriesObtained: ko.observable(0), berriesObtained: BerryList.map(() => ko.observable(0)),
        mulchesUsed: Array.from({ length: 10 }, () => ko.observable(0)),
    };
    const app = {
        game: {
            farming: null,
            wallet: { hasAmount: () => true, loseAmount: () => true, gainFarmPoints: vi.fn() },
            statistics,
            oakItems: { use: vi.fn(), calculateBonus: () => 1 },
            logbook: { newLog: vi.fn() },
        },
    };
    const requirement = class { isCompleted() { return true; } };
    const classes = runInNewContext(`${scripts}\n({ Farming });`, {
        ko, GameConstants, GameHelper, Amount, BerryType, BerryList, MulchType, PlotStage, AuraType,
        FarmNotificationType, FarmingTool, SizeUnits, FarmLayoutPlan, SeededRand,
        App: app,
        Notifier: { notify: vi.fn() },
        NotificationConstants: {
            NotificationOption: { info: 0, warning: 1, success: 2, danger: 3 },
            NotificationSetting: { Farming: { farm_hand: 0 } },
        },
        TotalBerriesUnlockedRequirement: requirement,
        UniqueItemOwnedRequirement: requirement,
        Rand: { chance: () => false },
        WandererPokemon: { fromJSON: () => undefined },
        OakItemType: { Sprayduck: 0, Sprinklotad: 1, Squirtbottle: 2 },
        MultiplierDecreaser: { Berry: 0 },
        player: { lowerItemMultipliers: vi.fn(), trainerId: '12345' },
        Settings: { getSetting: () => ({ observableValue: () => false }) },
    });
    const farming = new classes.Farming({ addBonus: vi.fn(), getBonus: () => 1 });
    app.game.farming = farming;
    farming.unlockedBerries.forEach(berry => berry(true));
    farming.berryInventory.forEach(berry => berry(100));
    farming.getFarmPlots(0).forEach(plot => { plot.isUnlocked = true; });
    const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
    hand.gainExperience(122_500);
    hand.hire();
    const layout = farming.farms()[0].layout;
    const setPlan = (cells: Record<number, Record<string, unknown>>) => {
        layout.setPlan({
            version: 1,
            name: '已有作物恢复测试',
            cells: Array.from({ length: 25 }, (_, index) => ({
                role: 'ignore', berry: BerryType.None, targetBerry: BerryType.None,
                mulch: MulchType.None, freezeStage: PlotStage.Berry,
                ...cells[index],
            })),
        });
        expect(layout.validation()).toEqual([]);
        layout.toggle();
        expect(layout.enabled()).toBe(true);
    };
    return { farming, hand, layout, setPlan, statistics };
}

const productionCells = {
    0: { role: 'empty' },
    2: { role: 'keep', berry: BerryType.Lum },
    6: { role: 'keep', berry: BerryType.Passho },
    12: { role: 'cycle', berry: BerryType.Liechi, mulch: MulchType.Rich_Mulch },
};

describe('农场布局已有作物恢复', () => {
    it('唯一 Liechi 在隔离格生长时保留真实年龄，并等待回收后再播辅助株', () => {
        const { farming, hand, layout, setPlan } = setup();
        farming.berryInventory[BerryType.Liechi](1);
        expect(farming.plant(0, BerryType.Liechi, 0)).toBe(true);
        const misplaced = farming.getFarmPlots(0)[0];
        misplaced.update(600);
        setPlan(productionCells);
        const plant = vi.spyOn(farming, 'plant');
        const harvest = vi.spyOn(farming, 'harvest');
        const shovels = farming.shovelAmt();

        hand.work();

        expect(misplaced.berry).toBe(BerryType.Liechi);
        expect(misplaced.age).toBe(600);
        expect(harvest).not.toHaveBeenCalled();
        expect(farming.getFarmPlots(0)[12].isEmpty()).toBe(true);
        expect(plant).not.toHaveBeenCalled();
        expect(farming.berryInventory[BerryType.Passho]()).toBe(100);
        expect(farming.berryInventory[BerryType.Lum]()).toBe(100);
        expect(farming.shovelAmt()).toBe(shovels);
        expect(layout.status(12)).toContain('1 行 1 列');
        expect(layout.status(12)).toContain('等待成熟采收回收');
    });

    it('隔离格的唯一 Liechi 自然成熟后真实采收，再消耗所得种子播回中心', () => {
        const { farming, hand, setPlan, statistics } = setup();
        farming.berryInventory[BerryType.Liechi](1);
        expect(farming.plant(0, BerryType.Liechi, 0)).toBe(true);
        const misplaced = farming.getFarmPlots(0)[0];
        misplaced.update(BerryList[BerryType.Liechi].growthTime[PlotStage.Bloom]);
        expect(misplaced.stage()).toBe(PlotStage.Berry);
        setPlan(productionCells);
        const originalHarvest = farming.harvest.bind(farming);
        let harvestedAmount = 0;
        const harvest = vi.spyOn(farming, 'harvest').mockImplementation((index: number, farmId = 0) => {
            if (index === 0 && farmId === 0) harvestedAmount = misplaced.harvestAmount();
            return originalHarvest(index, farmId);
        });
        const plant = vi.spyOn(farming, 'plant');

        hand.work();

        expect(harvest).toHaveBeenCalledWith(0, 0);
        expect(harvestedAmount).toBeGreaterThan(0);
        expect(misplaced.isEmpty()).toBe(true);
        expect(plant).toHaveBeenCalledWith(12, BerryType.Liechi, 0);
        expect(farming.getFarmPlots(0)[12].berry).toBe(BerryType.Liechi);
        expect(farming.getFarmPlots(0)[12].age).toBe(0);
        expect(farming.berryInventory[BerryType.Liechi]()).toBe(harvestedAmount - 1);
        expect(statistics.totalManualHarvests()).toBe(1);
    });

    it('中心缺少 Liechi 且没有可回收原株时暂停新播光环，避免先耗尽其寿命', () => {
        const { farming, hand, setPlan } = setup();
        farming.berryInventory[BerryType.Liechi](0);
        setPlan(productionCells);
        const plant = vi.spyOn(farming, 'plant');

        hand.work();

        expect(plant).not.toHaveBeenCalled();
        expect(farming.getFarmPlots(0)[6].isEmpty()).toBe(true);
        expect(farming.getFarmPlots(0)[2].isEmpty()).toBe(true);
    });

    it('量产光环按已有 Liechi 的实际剩余成熟时间补种，避免提前种下后枯萎', () => {
        const { farming, hand, setPlan } = setup();
        farming.berryInventory[BerryType.Liechi](1);
        expect(farming.plant(12, BerryType.Liechi, 0)).toBe(true);
        const source = farming.getFarmPlots(0)[12];
        const matureAt = BerryList[BerryType.Liechi].growthTime[PlotStage.Bloom];
        source.update(matureAt / 2);
        setPlan(productionCells);

        hand.work();

        expect(source.age).toBe(matureAt / 2);
        expect(farming.getFarmPlots(0)[6].isEmpty()).toBe(true);
        expect(farming.getFarmPlots(0)[2].isEmpty()).toBe(true);
        source.update(matureAt / 2 - BerryList[BerryType.Passho].growthTime[PlotStage.Bloom]);
        hand.work();

        expect(farming.getFarmPlots(0)[6].berry).toBe(BerryType.Passho);
        expect(farming.getFarmPlots(0)[2].isEmpty()).toBe(true);
        expect(farming.berryInventory[BerryType.Passho]()).toBe(99);
    });

    it.each(['ignore', 'locked'])('唯一关键株位于 %s 边界时不自动采收或移动', boundary => {
        const { farming, hand, setPlan } = setup();
        farming.berryInventory[BerryType.Liechi](1);
        expect(farming.plant(0, BerryType.Liechi, 0)).toBe(true);
        const misplaced = farming.getFarmPlots(0)[0];
        misplaced.update(BerryList[BerryType.Liechi].growthTime[PlotStage.Bloom]);
        if (boundary === 'locked') misplaced.isSafeLocked = true;
        setPlan({ ...productionCells, 0: { role: boundary === 'ignore' ? 'ignore' : 'empty' } });
        const harvest = vi.spyOn(farming, 'harvest');
        const shovels = farming.shovelAmt();
        const age = misplaced.age;

        hand.work();

        expect(harvest).not.toHaveBeenCalled();
        expect(misplaced.berry).toBe(BerryType.Liechi);
        expect(misplaced.age).toBe(age);
        expect(farming.getFarmPlots(0)[12].isEmpty()).toBe(true);
        expect(farming.shovelAmt()).toBe(shovels);
    });

    it('生产果比光环株短命时先种光环，等待其成熟窗口再播生产果', () => {
        const { farming, hand, setPlan } = setup();
        setPlan({
            0: { role: 'cycle', berry: BerryType.Cheri },
            1: { role: 'keep', berry: BerryType.Passho },
        });

        hand.work();

        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        expect(farming.getFarmPlots(0)[1].berry).toBe(BerryType.Passho);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(100);
        farming.getFarmPlots(0)[1].update(BerryList[BerryType.Passho].growthTime[PlotStage.Bloom]);
        hand.work();

        expect(farming.getFarmPlots(0)[0].berry).toBe(BerryType.Cheri);
        expect(farming.berryInventory[BerryType.Cheri]()).toBe(99);
    });

    it('冻结肥即将耗尽且无库存时仍抢救成熟原料，不能将短冻结视为永久保活', () => {
        const { farming, hand, setPlan, statistics } = setup();
        expect(farming.plant(0, BerryType.Cheri, 0)).toBe(true);
        const source = farming.getFarmPlots(0)[0];
        source.update(BerryList[BerryType.Cheri].growthTime[PlotStage.Berry] - 1);
        expect(source.stage()).toBe(PlotStage.Berry);
        source.mulch = MulchType.Freeze_Mulch;
        source.mulchTimeLeft = 0.1;
        farming.mulchList[MulchType.Freeze_Mulch](0);
        setPlan({ 0: { role: 'keep', berry: BerryType.Cheri, mulch: MulchType.Freeze_Mulch } });
        const harvest = vi.spyOn(farming, 'harvest');

        hand.work();

        expect(harvest).toHaveBeenCalledWith(0, 0);
        expect(statistics.totalManualHarvests()).toBe(1);
    });

    it('现场生产果已临近枯萎但光环尚未成熟时先采收救种，不无限等待光环', () => {
        const { farming, hand, setPlan, statistics } = setup();
        expect(farming.plant(0, BerryType.Cheri, 0)).toBe(true);
        farming.getFarmPlots(0)[0].update(BerryList[BerryType.Cheri].growthTime[PlotStage.Berry] - 1);
        expect(farming.plant(1, BerryType.Passho, 0)).toBe(true);
        setPlan({
            0: { role: 'cycle', berry: BerryType.Cheri, mulch: MulchType.Rich_Mulch },
            1: { role: 'keep', berry: BerryType.Passho },
        });
        const harvest = vi.spyOn(farming, 'harvest');

        hand.work();

        expect(harvest).toHaveBeenCalledWith(0, 0);
        expect(statistics.totalManualHarvests()).toBe(1);
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        expect(farming.getFarmPlots(0)[1].berry).toBe(BerryType.Passho);
    });

    it('低体力助手下一轮只能休息时按两轮间隔优先抢救将枯萎原株', () => {
        const { farming, hand, setPlan } = setup();
        hand.experience(0);
        hand.energy(1);
        hand.maxEfficiency = 1;
        expect(farming.plant(0, BerryType.Liechi, 0)).toBe(true);
        const source = farming.getFarmPlots(0)[0];
        const cycle = Math.ceil(hand.workTick / GameConstants.TICK_TIME) * GameConstants.TICK_TIME / GameConstants.SECOND;
        source.update(BerryList[BerryType.Liechi].growthTime[PlotStage.Berry] - cycle * 1.5);
        expect(source.stage()).toBe(PlotStage.Berry);
        expect(farming.plant(1, BerryType.Lum, 0)).toBe(true);
        farming.getFarmPlots(0)[1].update(BerryList[BerryType.Lum].growthTime[PlotStage.Bloom]);
        setPlan({ 0: { role: 'keep', berry: BerryType.Liechi }, 1: { role: 'empty' } });
        const harvest = vi.spyOn(farming, 'harvest');

        hand.work();

        expect(harvest.mock.calls[0]).toEqual([0, 0]);
        expect(farming.getFarmPlots(0)[0].isEmpty()).toBe(true);
        expect(farming.getFarmPlots(0)[1].berry).toBe(BerryType.Lum);
        expect(hand.energy()).toBe(0);
    });
});
