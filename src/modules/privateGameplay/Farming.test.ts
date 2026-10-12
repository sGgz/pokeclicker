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

function growthPreview(FarmController, app, detail = false) {
    const template = document.createElement('div');
    template.innerHTML = readFileSync(`src/components/${detail ? 'berryDexModal' : 'farmModal'}.html`, 'utf8');
    const row = Array.from(template.querySelectorAll(detail ? 'tr' : '#berryDexPreviewTable tr'))
        .find(element => element.textContent.includes('Growth Duration') || element.textContent.includes('预计收获时间'));
    const preview = row.querySelector('code').cloneNode(true) as HTMLElement;
    ko.applyBindings({ $data: BerryType.Cheri, BerryList, GameConstants, FarmController, App: app }, preview);
    return preview;
}

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
