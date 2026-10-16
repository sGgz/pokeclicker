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
    'mutation/mutationTypes/EvolveNearBerryMutation.ts',
    'mutation/mutationTypes/EvolveNearBerryStrictMutation.ts', 'mutation/mutationTypes/EnigmaMutation.ts',
    'Farming.ts', 'FarmController.ts', 'FarmLayoutController.ts',
].map(file => transpileModule(readFileSync(`src/scripts/farming/${file}`, 'utf8'), {
    compilerOptions: { target: ScriptTarget.ES2020 },
}).outputText).join('\n');

function setup() {
    const requirement = class { isCompleted() { return true; } };
    const wallet = { hasAmount: () => true, loseAmount: () => true, gainFarmPoints: vi.fn() };
    const statistics = {
        totalManualHarvests: ko.observable(0), totalBerriesHarvested: ko.observable(0), totalBerriesMutated: ko.observable(0),
        berriesHarvested: BerryList.map(() => ko.observable(0)), totalMulchesUsed: ko.observable(0),
        totalBerriesObtained: ko.observable(0), berriesObtained: BerryList.map(() => ko.observable(0)),
        mulchesUsed: Array.from({ length: 10 }, () => ko.observable(0)), totalBerriesReplanted: ko.observable(0),
    };
    const app = { game: { farming: null, wallet, statistics, oakItems: { use: vi.fn(), calculateBonus: () => 1 }, logbook: { newLog: vi.fn() } } };
    const random = { chance: vi.fn((chance: number) => chance < 0) };
    const classes = runInNewContext(`${scripts}\n({ Farming, FarmHands, EvolveNearBerryMutation });`, {
        ko, GameConstants, GameHelper, Amount, BerryType, BerryList, MulchType, PlotStage, AuraType, FarmNotificationType, FarmingTool, SizeUnits, FarmLayoutPlan,
        App: app, Notifier: { notify: vi.fn() },
        NotificationConstants: { NotificationOption: { info: 0, warning: 1, success: 2, danger: 3 }, NotificationSetting: { Farming: { farm_hand: 0 } } },
        TotalBerriesUnlockedRequirement: requirement, UniqueItemOwnedRequirement: requirement,
        SeededRand, Rand: random, WandererPokemon: { fromJSON: () => undefined },
        OakItemType: { Sprayduck: 0, Sprinklotad: 1, Squirtbottle: 2 },
        MultiplierDecreaser: { Berry: 0 }, player: { lowerItemMultipliers: vi.fn(), trainerId: '12345', highestRegion: () => 0 },
        Settings: { getSetting: () => ({ observableValue: () => false }) },
        LogBookTypes: { OTHER: 0 }, createLogContent: { unableToPayFarmHand: () => '' },
    });
    const farming = new classes.Farming({ addBonus: vi.fn(), getBonus: () => 1 });
    app.game.farming = farming;
    farming.unlockedBerries.forEach(berry => berry(true));
    farming.berryInventory.forEach(berry => berry(1000));
    farming.getFarmPlots(0).forEach(plot => { plot.isUnlocked = true; });
    const mutation = new classes.EvolveNearBerryMutation(0.0003, BerryType.Rabuta, BerryType.Aspear, [BerryType.Aguav]);
    farming.mutations = [mutation];
    const hand = farming.farmHands.list.find(candidate => candidate.name === 'Jessie');
    hand.gainExperience(122_500);
    hand.hire();
    return { farming, hand, mutation, random };
}

function importedRabuta() {
    const aguav = [6, 9, 21, 24];
    return FarmLayoutPlan.parse(JSON.stringify({
        save: {
            farming: {
                plotList: Array.from({ length: 25 }, (_, index) => ({
                    berry: aguav.includes(index) ? BerryType.Aguav : BerryType.Aspear,
                    age: aguav.includes(index) ? 700 : 240,
                    mulch: aguav.includes(index) ? MulchType.None : MulchType.Surprise_Mulch,
                })),
            },
        },
    }));
}

describe('Rabuta 分享码真实作业回归', () => {
    it('用户分享码可绑定 Rabuta 目标后启用，原始年龄不改写作物', () => {
        const { farming } = setup();
        const plan = importedRabuta();
        expect(plan.cells.filter(cell => cell.role === 'evolve')).toHaveLength(21);
        plan.cells.filter(cell => cell.role === 'evolve').forEach(cell => { cell.targetBerry = BerryType.Rabuta; });
        const layout = farming.farms()[0].layout;
        layout.setPlan(plan);
        expect(layout.validation()).toEqual([]);
        layout.toggle();
        expect(layout.enabled()).toBe(true);
        expect(farming.getFarmPlots(0).every(plot => plot.isEmpty())).toBe(true);
    });

    it('Aguav 原料自然枯萎形成 Kasib 后，布局应收获副产物并恢复 Aguav', () => {
        const { farming, hand, random } = setup();
        const plan = importedRabuta();
        plan.cells.filter(cell => cell.role === 'evolve').forEach(cell => { cell.targetBerry = BerryType.Rabuta; });
        const layout = farming.farms()[0].layout;
        layout.setPlan(plan);
        layout.toggle();
        const donor = farming.getFarmPlots(0)[6];
        donor.plant(BerryType.Aguav);
        // 仅固定枯萎后的 5% Kasib 判定，保留真实死亡与生长流程。
        random.chance.mockImplementation(chance => chance === 0.05);
        donor.update(BerryList[BerryType.Aguav].growthTime[PlotStage.Berry] + 1);
        expect(donor.berry).toBe(BerryType.Kasib);
        random.chance.mockReturnValue(false);
        donor.update(BerryList[BerryType.Kasib].growthTime[PlotStage.Bloom] + 1);
        expect(donor.stage()).toBe(PlotStage.Berry);
        const before = farming.berryInventory[BerryType.Kasib]();
        for (let work = 0; work < 30; work++) hand.work();
        expect(farming.berryInventory[BerryType.Kasib]()).toBeGreaterThan(before);
        expect(donor.berry).toBe(BerryType.Aguav);
    });

    it('用户原码从空田自然运行多轮持续具有 Rabuta 机会，成功进化后收获并重建原料', () => {
        const { farming, mutation } = setup();
        const plan = importedRabuta();
        plan.cells.filter(cell => cell.role === 'evolve').forEach(cell => { cell.targetBerry = BerryType.Rabuta; });
        const layout = farming.farms()[0].layout;
        layout.setPlan(plan);
        layout.toggle();
        farming.mulchList[MulchType.Surprise_Mulch](10_000);
        const plant = vi.spyOn(farming, 'plant');
        const harvest = vi.spyOn(farming, 'harvest');
        const opportunities = new Set<number>();
        let evolvedIndex = -1;
        let recovered = false;
        const before = farming.berryInventory[BerryType.Rabuta]();
        const tick = GameConstants.TICK_TIME / GameConstants.SECOND;
        const steps = Math.ceil(1800 / tick);
        const probeTicks = Math.ceil(1 / tick);
        for (let step = 0; step < steps; step++) {
            farming.getFarmPlots(0).forEach(plot => plot.update(tick));
            farming.farms()[0].hands.tick();
            if (step % probeTicks !== 0) continue;
            const elapsed = step * tick;
            const eligible = mutation.forFarm(0).getMutationPlots();
            if (eligible.length) opportunities.add(Math.floor(elapsed / 600));
            if (evolvedIndex < 0 && elapsed > 650) {
                const mature = eligible.find(index => farming.getFarmPlots(0)[index].stage() === PlotStage.Berry);
                if (mature !== undefined) {
                    // 只固定一次已满足真实资格的成功判定，不提高原始概率或跳改生长年龄。
                    expect(mutation.forFarm(0).getTotalMutationChance(mature)).toBeGreaterThan(0);
                    mutation.forFarm(0).handleMutation(mature);
                    evolvedIndex = mature;
                    expect(farming.getFarmPlots(0)[mature].berry).toBe(BerryType.Rabuta);
                }
            }
            if (evolvedIndex >= 0 && farming.berryInventory[BerryType.Rabuta]() > before
                && farming.getFarmPlots(0)[evolvedIndex].berry === BerryType.Aspear) recovered = true;
        }
        expect([...opportunities]).toEqual([0, 1, 2]);
        expect(evolvedIndex).toBeGreaterThanOrEqual(0);
        expect(farming.berryInventory[BerryType.Rabuta]()).toBeGreaterThan(before);
        expect(recovered).toBe(true);
        expect(plant.mock.calls.filter(call => call[1] === BerryType.Aguav).length).toBeGreaterThan(4);
        expect(plant.mock.calls.filter(call => call[1] === BerryType.Aspear).length).toBeGreaterThan(21);
        expect(harvest.mock.calls.length).toBeGreaterThan(25);
        expect(farming.getFarmPlots(0).some(plot => plot.berry === BerryType.Kasib)).toBe(false);
    }, 90_000);
});
