/// <reference path="../../declarations/enums/MulchType.d.ts"/>

class FarmController {
    public static batchScope = ko.observable('current');
    public static checkedFarms = ko.observableArray<number>([]);

    public static targetFarms(): number[] {
        const farming = App.game.farming;
        if (this.batchScope() === 'all') {
            return farming.farms().map(farm => farm.id);
        }
        if (this.batchScope() === 'selected') {
            return this.checkedFarms().filter(id => !!farming.farms()[id]);
        }
        return [farming.selectedFarm()];
    }

    public static navigateFarm(direction: number) {
        const farming = App.game.farming;
        farming.selectedFarm((farming.selectedFarm() + direction + farming.farms().length) % farming.farms().length);
    }

    private static reportBatch(action: string, count: number, targets: number[]) {
        Notifier.notify({
            title: '农田批量操作',
            message: `${action}：${targets.length} 块田，共处理 ${count} 格。锁定或不符合条件的格子已跳过。`,
            type: NotificationConstants.NotificationOption.info,
        });
    }

    public static plantBatch() {
        const targets = this.targetFarms();
        this.reportBatch('种植', App.game.farming.batchPlant(targets, this.selectedBerry()), targets);
    }

    public static plantAll() {
        App.game.farming.plantAll(this.selectedBerry());
    }

    public static harvestAll() {
        App.game.farming.harvestAll();
    }

    public static harvestBatch(replant = false) {
        const targets = this.targetFarms();
        this.reportBatch(replant ? '收获后重种' : '收获', App.game.farming.batchHarvest(targets, replant), targets);
    }

    public static async shovelBatch(mulch = false) {
        const targets = this.targetFarms();
        if (!targets.length || !await Notifier.confirm({
            title: mulch ? '批量铲除肥料' : '批量清理作物',
            message: `将清理 ${targets.length} 块田：${targets.map(id => App.game.farming.farms()[id].name()).join('、')}。锁定格子会跳过。${mulch ? '肥料会丢失并消耗肥料铲。' : '成熟作物正常收获；未成熟作物会被移除并消耗树果铲。'}`,
            type: NotificationConstants.NotificationOption.warning,
            confirm: '清理',
        })) {
            return;
        }
        this.reportBatch(mulch ? '铲除肥料' : '清理作物', App.game.farming.batchShovel(targets, mulch), targets);
    }

    public static async copyHands() {
        const farming = App.game.farming;
        const source = farming.farmHands.list;
        const targets = this.targetFarms().filter(id => id !== farming.selectedFarm());
        const configurations = source.map(hand => ({ name: hand.name, hired: hand.hired(), focus: hand.focus(), shouldHarvest: hand.shouldHarvest(), shouldCatch: hand.shouldCatch(), plots: [...hand.plots()] }));
        const extraWages = targets.reduce((sum, id) => sum + configurations.reduce((cost, config) => {
            const hand = farming.farms()[id].hands.list.find(candidate => candidate.name === config.name);
            return cost + (config.hired && !hand.hired() ? hand.cost.amount : 0);
        }, 0), 0);
        if (!targets.length || !await Notifier.confirm({
            title: '复制助手配置',
            message: `将当前田的助手配置和雇用名单应用到 ${targets.length} 块田。新增雇用立即支付 ${extraWages.toLocaleString('en-US')} 农田币，后续每小时分别计费。体力和工作进度保持独立。`,
            type: NotificationConstants.NotificationOption.info,
            confirm: '应用',
        })) {
            return;
        }
        const currentFee = targets.reduce((sum, id) => sum + configurations.reduce((cost, config) => {
            const hand = farming.farms()[id].hands.list.find(candidate => candidate.name === config.name);
            return cost + (config.hired && !hand.hired() ? hand.cost.amount : 0);
        }, 0), 0);
        if (!App.game.wallet.hasAmount(new Amount(currentFee, GameConstants.Currency.farmPoint))) {
            Notifier.notify({ message: `农田币不足，应用配置需要立即支付 ${currentFee.toLocaleString('en-US')} 农田币。`, type: NotificationConstants.NotificationOption.warning });
            return;
        }
        let hired = 0;
        targets.forEach(id => {
            const hands = farming.farms()[id].hands;
            hands.hired().filter(hand => !configurations.find(config => config.name === hand.name).hired).forEach(hand => hand.fire());
            configurations.forEach(config => {
                const hand = hands.list.find(candidate => candidate.name === config.name);
                hand.focus(config.focus);
                hand.shouldHarvest(config.shouldHarvest);
                hand.shouldCatch(config.shouldCatch);
                hand.plots([...config.plots]);
                if (config.hired && !hand.hired()) {
                    hand.hire();
                    if (hand.hired()) {
                        hired++;
                    }
                }
            });
        });
        this.reportBatch(`助手配置已应用，新增雇用 ${hired} 份`, 0, targets);
    }

    public static navigateIndex = ko.pureComputed({
        read: () => {
            const farm = App.game.farming.farms()[App.game.farming.selectedFarm()];
            const lastPage = Math.max(0, Math.ceil(FarmController.filteredBerryList().length / FarmController.BERRIES_PER_PAGE) - 1);
            return Math.min(farm.berryPage(), lastPage);
        },
        write: (page: number) => App.game.farming.farms()[App.game.farming.selectedFarm()].berryPage(page),
    });
    public static berryListFiltered: KnockoutObservableArray<BerryType> = ko.observableArray([]);
    public static numberOfTabs: KnockoutComputed<number>;
    public static farmingModalTabSelected: KnockoutObservable<string> = ko.observable('berryFarmView');

    public static berryListEnd: KnockoutComputed<number>;
    public static berryListSearch = ko.pureComputed({
        read: () => App.game.farming.farms()[App.game.farming.selectedFarm()].berrySearch(),
        write: (search: string) => {
            const farm = App.game.farming.farms()[App.game.farming.selectedFarm()];
            farm.berrySearch(search);
            farm.berryPage(0);
        },
    });

    public static selectedBerry = ko.pureComputed({
        read: () => App.game.farming.farms()[App.game.farming.selectedFarm()].selectedBerry(),
        write: (berry: BerryType) => App.game.farming.farms()[App.game.farming.selectedFarm()].selectedBerry(berry),
    });
    public static selectedMulch: KnockoutObservable<MulchType> = ko.observable(MulchType.Boost_Mulch);
    public static selectedFarmTool: KnockoutObservable<FarmingTool> = ko.observable(FarmingTool.Berry);
    public static selectedFarmModuleTool: KnockoutObservable<FarmingTool> = ko.observable(FarmingTool.Berry);

    public static berryListVisible: KnockoutObservable<boolean> = ko.observable(true);

    public static multipliers = ['×1', '×10', '×100', '×1000', 'All'];
    public static multIndex: KnockoutObservable<number> = ko.observable(0);

    static readonly BERRIES_PER_PAGE = 8;

    public static initialize() {
        this.berryListFiltered(Array.from(Array(GameHelper.enumLength(BerryType) - 1).keys()));

        this.numberOfTabs = ko.pureComputed(() => {
            return Math.max(1, Math.ceil(FarmController.filteredBerryList().length / this.BERRIES_PER_PAGE));
        });

        this.berryListEnd = ko.pureComputed(() => {
            const highestMutation = App.game.farming.mutations.slice().sort((a, b) => b.mutatedBerry - a.mutatedBerry).find(mut => mut._hintSeen() && !App.game.farming.unlockedBerries[mut.mutatedBerry]());
            const highestMutationHint = highestMutation?.mutatedBerry ?? 0;
            return Math.max(App.game.farming.highestUnlockedBerry(), highestMutationHint);
        });
    }

    public static openFarmModal() {
        if (App.game.farming.canAccess()) {
            $('#farmModal').modal('show');
        } else {
            Notifier.notify({
                message: `You need the ${GameConstants.humanifyString(KeyItemType[KeyItemType.Wailmer_pail])} to access this location.\n<i>Clear Route 6 first.</i>`,
                type: NotificationConstants.NotificationOption.warning,
            });
        }
    }

    public static getImage(index: number) {
        const plot: Plot = App.game.farming.plotList[index];
        if (plot.berry === BerryType.None) {
            return '';
        }
        if (plot.stage() === PlotStage.Seed) {
            return 'assets/images/farm/AllTreeSeed.png';
        } else if (plot.stage() === PlotStage.Sprout) {
            return 'assets/images/farm/AllTreeSprout.png';
        }
        return `assets/images/farm/${BerryType[plot.berry]}Tree${PlotStage[plot.stage()]}.png`;
    }

    public static calculateCssClassFromTool(plot: Plot, tool: FarmingTool) {
        switch (tool) {
            case FarmingTool.Lock:
                return 'PlotSafeLockSelected';
            case FarmingTool.Mulch:
                return 'MulchSelected';
            case FarmingTool.Shovel:
                return 'ShovelSelected';
            case FarmingTool.MulchShovel:
                return 'MulchShovelSelected';
            case FarmingTool.Berry:
            default:
                return plot.wanderer ? 'WandererHandling' : 'BerrySelected';
        }
    }

    public static calculateCssClass(plot: Plot) {
        return this.calculateCssClassFromTool(plot, this.selectedFarmTool());
    }

    public static calcMulchClass(plot: Plot) {
        if (plot.mulch === MulchType.None) {
            return '';
        }
        return MulchType[plot.mulch];
    }

    public static plotClick(index: number, event: MouseEvent) {
        const plot: Plot = App.game.farming.plotList[index];

        // If shift key held, lock/unlock plot
        if (event.shiftKey) {
            this.shiftTogglePlotSafeLock(plot, index);
        } else {
            this.handleClickActions(this.selectedFarmTool(), plot, index);
        }
    }

    public static plotClickMini(index: number, event: MouseEvent) {
        const plot: Plot = App.game.farming.plotList[index];

        // Unlocking Plot (we don't want to do this in the farm module)
        if (!plot.isUnlocked) {
            return;
        }

        // If shift key held, lock/unlock plot
        if (event.shiftKey) {
            this.shiftTogglePlotSafeLock(plot, index);
        } else {
            this.handleClickActions(this.selectedFarmModuleTool(), plot, index);
        }
    }

    private static shiftTogglePlotSafeLock(plot: Plot, index: number) {
        if (!plot.isUnlocked) {
            return;
        }

        App.game.farming.togglePlotSafeLock(index);
    }

    public static toggleAllPlotLocks() {
        App.game.farming.plotList.forEach((plot, index) => {
            if (plot.isUnlocked) {
                App.game.farming.togglePlotSafeLock(index);
            }
        });
    }

    public static toggleAllPlotLocksTo(lock: boolean) {
        App.game.farming.plotList.forEach((plot, index) => {
            if (plot.isUnlocked && ((lock && !plot.isSafeLocked) || (!lock && plot.isSafeLocked))) {
                App.game.farming.togglePlotSafeLock(index);
            }
        });
    }

    private static handleClickActions(tool: FarmingTool, plot: Plot, index: number) {
        // Unlocking Plot
        if (!plot.isUnlocked) {
            return App.game.farming.unlockPlot(index);
        }
        // Check which tool we have selected
        switch (tool) {
            case FarmingTool.Berry:
                if (plot.wanderer) {
                    App.game.farming.handleWanderer(plot);
                } else if (plot.isEmpty()) {
                    App.game.farming.plant(index, this.selectedBerry());
                } else {
                    App.game.farming.harvest(index);
                }
                break;
            case FarmingTool.Mulch:
                App.game.farming.addMulch(index, this.selectedMulch(), this.getAmount());
                break;
            case FarmingTool.Shovel:
                App.game.farming.shovel(index);
                break;
            case FarmingTool.MulchShovel:
                App.game.farming.shovelMulch(index);
                break;
            case FarmingTool.Lock:
                App.game.farming.togglePlotSafeLock(index);
                break;
        }
    }

    public static calculateCssClassMini(plot: Plot) {
        return this.calculateCssClassFromTool(plot, this.selectedFarmModuleTool());
    }

    public static mulchAll() {
        return this.applyMulch([App.game.farming.selectedFarm()], false);
    }

    public static mulchBatch() {
        return this.applyMulch(this.targetFarms(), true);
    }

    private static async applyMulch(targets: number[], batch: boolean) {
        const mulch = this.selectedMulch();
        const amount = this.getAmount();
        const apply = () => {
            const count = App.game.farming.batchMulch(targets, mulch, amount);
            if (batch) {
                this.reportBatch('施肥', count, targets);
            }
        };
        if (!Settings.getSetting('confirmBeformeMulchingAllPlots').observableValue()) {
            apply();
            return;
        }

        const confirmed = await Notifier.confirm({
            title: batch ? '批量施肥' : '当前田施肥',
            message: `将 ${MulchType[mulch].replace('_', ' ')} 应用到 ${targets.length} 块田，每格最多 ${amount} 份，库存不足时均分。`,
            type: NotificationConstants.NotificationOption.info,
            confirm: 'Mulch',
        });
        if (confirmed) {
            apply();
        }
    }

    public static navigateRight() {
        if (FarmController.navigateIndex() < FarmController.numberOfTabs() - 1) {
            FarmController.navigateIndex(FarmController.navigateIndex() + 1);
            this.selectedBerry(this.getUnlockedBerryListWithIndex()[0]);
        }
    }

    public static navigateLeft() {
        if (FarmController.navigateIndex() > 0) {
            FarmController.navigateIndex(FarmController.navigateIndex() - 1);
            this.selectedBerry(this.getUnlockedBerryListWithIndex()[0]);
        }
    }

    public static filteredBerryList = ko.pureComputed((): Array<BerryType> => {
        let berryList = FarmController.getUnlockedBerryList();
        const searchVal = FarmController.berryListSearch().trim();
        if (searchVal.length) {
            const split = searchVal.toLowerCase().split(' ').filter(s => s);
            berryList = berryList.filter((berry) => App.game.farming.unlockedBerries[berry]() && split.some((val) => BerryType[berry].toLowerCase().includes(val)));
        }
        return berryList;
    });

    public static getUnlockedBerryListWithIndex() {
        return FarmController.filteredBerryList().slice(this.navigateIndex() * this.BERRIES_PER_PAGE, (this.navigateIndex() * this.BERRIES_PER_PAGE) + this.BERRIES_PER_PAGE);
    }

    public static getUnlockedBerryList() {
        return this.berryListFiltered().filter((berry) => berry <= this.berryListEnd());
    }

    private static getAmount() {
        return Number(this.multipliers[this.multIndex()].replace(/\D/g, '')) || Infinity;
    }

    public static incrementMultiplier() {
        this.multIndex((this.multIndex() + 1) % this.multipliers.length);
    }

    public static decrementMultiplier() {
        this.multIndex((this.multIndex() + this.multipliers.length - 1) % this.multipliers.length);
    }

    public static getBackgroundColor(index: number) {
        if (App.game.farming.unlockedBerries[index]()) {
            return GameConstants.BerryColor[BerryList[index].color];
        } else if (FarmController.getHint(index, true) !== '') {
            return GameConstants.BerryColor[8];
        } else {
            return GameConstants.BerryColor[9];
        }

    }

    public static getBerryImage(index: number) {
        return `assets/images/items/berry/${BerryType[index]}.png`;
    }

    public static getHint(index: number, checkSeen = false, checkUnlocked = false) {
        if (checkUnlocked && App.game.farming.unlockedBerries[index]()) {
            return '';
        }
        const mutation = App.game.farming.mutations.find(mutation => mutation.mutatedBerry === index && mutation.showHint);
        if (mutation) {
            if (checkSeen && !mutation.hintSeen) {
                return '';
            }
            return mutation.hint;
        }
        return '';
    }

    public static additionalInfoTooltip: KnockoutComputed<string> = ko.pureComputed(() => {
        const tooltip = [];

        // External Auras
        App.game.farming.externalAuras.forEach((aura, idx) => {
            if (typeof aura === 'undefined') {
                return;
            }
            if (aura() !== 1) {
                tooltip.push(`${AuraType[idx]}: ×${aura().toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 })}`);
            }

        });

        // Adding header if necessary
        if (tooltip.length) {
            tooltip.unshift('<u>External Auras</u>');
        }

        return tooltip.join('<br>');
    });

    // For preview in Farm Modal's BerryDex Tab
    public static handleBerryDexClick(berryId: number) {
        if (App.game.statistics.selectedBerryID() === berryId && App.game.farming.unlockedBerries[berryId]()) {
            $('#berryDexModal').modal('show');
        }

        App.game.statistics.selectedBerryID(berryId);
    }

    public static wandererToRoute(pokemon: PokemonNameType): RegionRoute {
        const maxRegion = player.highestRegion();
        const pokemonRegion = pokemonMap[pokemon].nativeRegion;
        const routes = Routes.getRoutesByRegion(maxRegion).filter(r => !r.ignoreRouteInCalculations);
        const minIndex = Math.floor((routes.length - 1) * pokemonRegion / (maxRegion + 2));
        const maxIndex = Math.floor((routes.length - 1) * (pokemonRegion + 2) / (maxRegion + 2));
        // Adds a bit of randomness so it is not always the same route
        const routeIndex = Rand.intBetween(minIndex, maxIndex);
        return routes[routeIndex];
    }

    public static getWandererStyle(plot: Plot): string {
        if (!plot.wanderer) {
            return '';
        }
        const pokemon = pokemonMap[plot.wanderer.name];
        const forgedID = `${pokemon.id}${plot.wanderer.shiny ? 's' : ''}`;
        return `${plot.wanderer.shiny ? 'url(\'assets/images/dynamic-background/pokemon/sparkle.png\'), ' :  ''}url('assets/images/dynamic-background/pokemon/${forgedID}.png')`;
    }

    public static getWandererCss(plot: Plot): string {
        if (!plot.wanderer) {
            return '';
        }
        if (plot.wanderer.fleeing()) {
            return 'walkDownFlee';
        } else if (plot.wanderer.distractTime() > 0) {
            return 'walkDownFlash';
        } else {
            return 'walkDown';
        }
    }

    public static shortcutVisible: KnockoutComputed<boolean> = ko.pureComputed(() => {
        return App.game.farming.canAccess() && Settings.getSetting('showFarmModule').observableValue() === 'never';
    });
}
