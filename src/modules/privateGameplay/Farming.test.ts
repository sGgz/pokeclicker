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

const scripts = [
    'FarmHand.ts', 'Plot.ts', 'mutation/Mutation.ts',
    'mutation/mutationTypes/GrowMutation.ts', 'mutation/mutationTypes/FieldMutation.ts',
    'Farming.ts', 'FarmController.ts',
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
    const classes = runInNewContext(`${scripts}\n({ Farming, FarmHands, FarmHand, FarmController, FieldMutation });`, {
        ko, GameConstants, GameHelper, Amount, BerryType, BerryList, MulchType, PlotStage, AuraType, FarmNotificationType, FarmingTool, SizeUnits,
        App: app, Notifier: notification, NotificationConstants: constants,
        TotalBerriesUnlockedRequirement: requirement, UniqueItemOwnedRequirement: requirement,
        SeededRand: { seed: vi.fn(), intBetween: () => 1 },
        Rand: { chance: () => false },
        WandererPokemon: { fromJSON: () => undefined },
        OakItemType: { Sprayduck: 0, Sprinklotad: 1, Squirtbottle: 2 },
        MultiplierDecreaser: { Berry: 0 }, player: { lowerItemMultipliers: vi.fn() },
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

describe('multiple farms', () => {
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
        hand.energy(93);
        const saved = JSON.parse(JSON.stringify(first.farming.toJSON()));
        const second = setup();
        second.farming.fromJSON(saved);
        expect(second.wallet.loseAmount).not.toHaveBeenCalled();
        expect(JSON.parse(JSON.stringify(second.farming.toJSON()))).toEqual(saved);
        expect(second.farming.farms()[0].hands.list[0].experience()).toBe(20_000);
        expect(second.farming.farms()[1].hands.list[0].energy()).toBe(93);
    });
});

describe('farm hand levels and independent employment', () => {
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

    it('recovers by level and caps recovery at capacity without giving idle experience', () => {
        const { farming } = setup();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(50 * 21 * 20);
        expect(hand.level).toBe(21);
        hand.energy(0);
        hand.work();
        expect(hand.energy()).toBe(2);
        expect(hand.experience()).toBe(21_000);
        hand.energy(hand.maxEnergy - 1);
        hand.work();
        expect(hand.energy()).toBe(hand.maxEnergy);
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

    it('makes level 50 perpetual for repeated successful cycles and resumes after a single zero-energy rest', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(122_500);
        expect(hand.level).toBe(50);
        expect(hand.maxEnergy).toBe(255);
        expect(hand.efficiency).toBe(10);
        expect(hand.workTick).toBeLessThan(1_000_000);
        hand.focus(BerryType.Cheri);
        farming.berryInventory[BerryType.Cheri](3000);
        hand.energy(0);
        hand.work();
        expect(hand.energy()).toBe(3);
        expect(farming.plotList.every(plot => plot.isEmpty())).toBe(true);
        for (let cycle = 0; cycle < 200; cycle++) {
            farming.plotList.forEach(plot => { plot.berry = BerryType.None; });
            hand.work();
            expect(hand.energy()).toBe(3);
            expect(farming.plotList.filter(plot => !plot.isEmpty())).toHaveLength(10);
        }
        expect(hand.experience()).toBe(122_500);
    });

    it('keeps level 49 subject to exhaustion and uses the agreed larger energy capacity', () => {
        const { farming, unlockFirst } = setup();
        unlockFirst();
        const hand = farming.farmHands.list[0];
        hand.gainExperience(117_600);
        expect(hand.level).toBe(49);
        expect(hand.maxEnergy).toBe(250);
        hand.focus(BerryType.Cheri);
        hand.energy(1);
        hand.work();
        expect(hand.energy()).toBe(0);
        hand.work();
        expect(hand.energy()).toBe(3);
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
