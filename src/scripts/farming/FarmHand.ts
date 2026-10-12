const FarmHandSkills = [
    'energy',
    'efficiency',
    'accuracy',
    'cost',
];

enum FarmHandSpeeds {
    Fastest,
    Faster,
    Fast,
    AboveAverage,
    Average,
    BelowAverage,
    Slow,
    Slower,
    Slowest,
    SnailPaced,
    Lazy,
}

enum FarmHandBerryType {
    'Random' = -3,
    'Replant' = -2,
}

const FarmHandBerryTypes = {
    ...FarmHandBerryType,
    ...BerryType,
};
type FarmHandBerryTypes = (typeof FarmHandBerryTypes)[keyof typeof FarmHandBerryTypes];

class FarmHand {
    static readonly MAX_LEVEL = 50;
    static readonly WORK_ENERGY_COST = 2;
    public experience: KnockoutObservable<number>;

    get level(): number {
        return Math.min(FarmHand.MAX_LEVEL, Math.floor((1 + Math.sqrt(1 + this.experience() / 12.5)) / 2));
    }

    get maxEnergy(): number {
        return this.baseEnergy + 5 * (this.level - 1);
    }

    get efficiency(): number {
        if (this.baseEfficiency >= 25) {
            return this.isMaxLevel ? this.maxEfficiency : Math.min(this.maxEfficiency, this.baseEfficiency);
        }
        return Math.min(this.maxEfficiency, this.baseEfficiency + Math.floor((25 - this.baseEfficiency) * (this.level - 1) / (FarmHand.MAX_LEVEL - 1)));
    }

    get recovery(): number {
        return 1 + (this.level - 1) / (FarmHand.MAX_LEVEL - 1);
    }

    get isMaxLevel(): boolean {
        return this.level === FarmHand.MAX_LEVEL;
    }

    get nextLevelExperience(): number {
        return this.isMaxLevel ? 0 : 50 * this.level * (this.level + 1) - this.experience();
    }

    gainExperience(amount: number): void {
        this.experience(Math.min(50 * FarmHand.MAX_LEVEL * (FarmHand.MAX_LEVEL - 1), this.experience() + amount));
    }
    public defaults = {
        focus: BerryType.None,
        shouldHarvest: false,
        workTicks: 0,
        costTicks: 0,
        energy: 0,
        hired: false,
        plots: [],
        name: undefined,
        shouldCatch : false,
    };
    // Maximum Efficiency value
    public maxEfficiency = 50;
    // Idle work timer; hiring schedules an immediate first work cycle.
    public workTicks = ko.observable(-GameConstants.TICK_TIME).extend({ numeric: 0 });
    public costTicks = ko.observable(-GameConstants.TICK_TIME).extend({ numeric: 0 });
    // When to charge the player whatever the cost is, when to work
    get workTick(): number {
        return Math.max(GameConstants.TICK_TIME, this.calcWorkTick(this.speed) / (1 + 0.04 * (this.level - 1)));
    }
    public costTick = GameConstants.HOUR;

    public cost = new Amount(+0, GameConstants.Currency.farmPoint);
    public trainerSprite = 0;
    public focus: KnockoutObservable<FarmHandBerryTypes> = ko.observable(BerryType.None);
    public shouldHarvest: KnockoutObservable<boolean> = ko.observable(false).extend({ boolean: null });
    public energy: KnockoutObservable<number> = ko.observable(0).extend({ numeric: 6 });
    public hired: KnockoutObservable<boolean> = ko.observable(false).extend({ boolean: null });
    public plots: KnockoutObservableArray<number> = ko.observableArray(new Array(GameConstants.FARM_PLOT_WIDTH * GameConstants.FARM_PLOT_HEIGHT).fill(0).map((v, i) => i));
    public tooltip: KnockoutComputed<string>;
    public shouldCatch: KnockoutObservable<boolean> = ko.observable(false);

    constructor(
        public name: string,
        public baseEnergy: number, // Level 1 capacity
        public baseEfficiency: number, // Level 1 action limit
        public speed: FarmHandSpeeds,
        public accuracy: number, // 0 - 10 (80% - 100%)
        cost: number, // 0 - 10? (can go higher if needed)
        public unlockRequirement?: Requirement | MultiRequirement | OneFromManyRequirement,
        public farmId = 0,
        experience?: KnockoutObservable<number>
    ) {
        this.experience = experience ?? ko.observable(0);
        SeededRand.seed(parseInt(this.name, 36));
        this.trainerSprite = SeededRand.intBetween(0, 118);
        // New, unassigned assistants start with an idle timer.
        this.workTicks(-GameConstants.TICK_TIME);
        this.costTicks(-GameConstants.TICK_TIME);
        // Set initial energy to maximum energy
        this.energy(this.maxEnergy);
        // Calculate how much to charge the player in farm points
        this.cost = new Amount(+Math.pow(100, 1 + cost * 0.08).toPrecision(2), GameConstants.Currency.farmPoint);
        this.tooltip = ko.pureComputed(() => `<strong>${this.name} · 农田 ${this.farmId + 1} · Lv.${this.level}</strong><br/>
            每轮恢复 ${this.recovery.toFixed(2)} 点体力<br/>
            Energy: ${this.energy().toLocaleString('en-US', { maximumFractionDigits: 2 })}/${this.maxEnergy}<br/>
            Work Cycle: ${GameConstants.formatTimeFullLetters((this.workTick - this.workTicks()) / GameConstants.SECOND)}<br/>
            Next Payment: ${GameConstants.formatTimeFullLetters((this.costTick - this.costTicks()) / GameConstants.SECOND)}`
        );
    }

    private calcWorkTick(speed: FarmHandSpeeds): number {
        speed = ((speed + 1) * 0.03) + 1;
        let time = Math.pow(GameConstants.MINUTE, speed);
        time -= time > 5 * GameConstants.MINUTE ? time % GameConstants.MINUTE : time % (30 * GameConstants.SECOND);
        return time;
    }

    isUnlocked(): boolean {
        return this.unlockRequirement?.isCompleted() ?? true;
    }

    togglePlot(plotIndex: number): void {
        const index = this.plots().findIndex(p => p == plotIndex);
        if (index >= 0) {
            this.plots.splice(index, 1);
        } else {
            this.plots.push(plotIndex);
        }
        this.plots.sort((a, b) => a - b);
    }

    hire(): void {
        const hands = App.game.farming.farms()[this.farmId]?.hands;
        if (this.hired() || !this.isUnlocked() || !hands?.canHire()) {
            return;
        }
        // Hiring pays immediately and schedules work for the next tick.
        this.workTicks(this.workTick);
        this.costTicks(0);

        // Check the player has enough Farm Points to hire this Farm Hand
        if (!App.game.wallet.loseAmount(this.cost)) {
            Notifier.notify({
                title: `[FARM HAND] <img src="assets/images/profile/trainer-${this.trainerSprite}.png" height="24px" class="pixelated"/> ${this.name}`,
                message: `You don't have enough Farm Points to hire me...\nCost: <img src="./assets/images/currency/farmPoint.svg" height="24px"/> ${this.cost.amount.toLocaleString('en-US')}`,
                type: NotificationConstants.NotificationOption.warning,
                timeout: 30 * GameConstants.SECOND,
            });
            return;
        }
        // Farm hand is hired
        this.hired(true);
        Notifier.notify({
            title: `[FARM HAND] <img src="assets/images/profile/trainer-${this.trainerSprite}.png" height="24px" class="pixelated"/> ${this.name}`,
            message: 'Thanks for hiring me,\nI won\'t let you down!',
            type: NotificationConstants.NotificationOption.success,
            timeout: 30 * GameConstants.SECOND,
            setting: NotificationConstants.NotificationSetting.Farming.farm_hand,
        });
    }

    fire(): void {
        Notifier.notify({
            title: `[FARM HAND] <img src="assets/images/profile/trainer-${this.trainerSprite}.png" height="24px" class="pixelated"/> ${this.name}`,
            message: 'Thanks for the work.\nLet me know when you\'re hiring again!',
            type: NotificationConstants.NotificationOption.info,
            timeout: 30 * GameConstants.SECOND,
            setting: NotificationConstants.NotificationSetting.Farming.farm_hand,
        });
        this.hired(false);
        return;
    }

    tick(): void {

        if (!this.hired() && this.energy() >= this.maxEnergy) {
            return;
        }
        // Charge player when cost tick reached
        if (this.hired()) {
            GameHelper.incrementObservable(this.costTicks, GameConstants.TICK_TIME);
            if (this.costTicks() >= this.costTick) {
                this.costTicks(0);
                this.charge();
            }
        }

        // Work/Restore energy when work ticks reached
        GameHelper.incrementObservable(this.workTicks, GameConstants.TICK_TIME);
        if (this.workTicks() >= this.workTick) {
            this.workTicks(0);
            if (this.hired()) {
                this.work();
            } else if (this.energy() < this.maxEnergy) {
                this.addEnergy();
            }

        }
    }

    work(): void {
        // Out of energy cannot work right now..
        if (!this.energy()) {
            this.addEnergy();
            return;
        }

        // flip this if they worked, otherwise restore energy points
        let worked = false;
        let workTimes = this.efficiency;
        const farming = App.game.farming;
        const plots = farming.getFarmPlots(this.farmId);

        // Harvesting berries
        if (this.shouldHarvest()) {
            let readyPlotIndex;
            do {
                readyPlotIndex = plots.findIndex((p, i) => p.isUnlocked && p.berry !== BerryType.None && p.stage() === PlotStage.Berry && this.plots().includes(i) && !p.isSafeLocked);
                if (readyPlotIndex >= 0 && workTimes > 0) {
                    const berry = plots[readyPlotIndex].berry;
                    farming.harvest(readyPlotIndex, this.farmId);
                    workTimes--;
                    this.gainExperience(2);
                    worked = true;
                    if (this.focus() == FarmHandBerryTypes.Replant && workTimes > 0 && farming.plant(readyPlotIndex, berry, this.farmId)) {
                        workTimes--;
                        this.gainExperience(1);
                    }
                }
            } while (readyPlotIndex >= 0 && workTimes > 0);
        }

        // Planting berries
        if (this.focus() != FarmHandBerryTypes.None) {
            let emptyPlotIndex;
            let berry;
            do {
                // Find empty plots
                emptyPlotIndex = plots.findIndex((p, i) => p.isUnlocked && p.berry == BerryType.None && this.plots().includes(i) && !p.isSafeLocked);
                // Plant the berry
                if (emptyPlotIndex >= 0 && workTimes > 0) {
                    // Plant the expected berry
                    switch (this.focus()) {
                        case FarmHandBerryTypes.Replant: // Re-plant last berry used
                            berry = plots[emptyPlotIndex].lastPlanted;
                            break;
                        case FarmHandBerryTypes.Random: // Plant a random berry
                            berry = Rand.fromArray(App.game.farming.farmHands.availableBerries().filter(b => b >= 0));
                            break;
                        default:
                            berry = this.focus();
                    }
                    // If we somehow didn't find a berry to use, just plant a Cheri..
                    berry = berry < 0 ? BerryType.Cheri : berry;
                    // Only plant and work if the player has a berry to plant
                    if (farming.plant(emptyPlotIndex, berry as BerryType, this.farmId)) {
                        workTimes--;
                        this.gainExperience(1);
                        worked = true;
                    } else {
                        // An unavailable or invalid seed must not leave the same empty plot in an endless loop.
                        break;
                    }
                }
            } while (emptyPlotIndex >= 0 && workTimes > 0 && App.game.farming.hasBerry(berry));
        }

        if (this.shouldCatch()) {
            // First handle plots whose wanderer might flee soon
            const prioPlots = plots.filter(p => p.wanderer && p.wanderer.distractTime() > 0 && p.canCatchWanderer() && !p.isSafeLocked);
            while (prioPlots.length > 0 && workTimes > 0) {
                const plot = prioPlots.shift();
                if (this.plots().includes(plot.index)) {
                    farming.handleWanderer(plot);
                    workTimes--;
                    if (plot.wanderer?.catching()) {
                        this.gainExperience(1);
                    }
                    worked = true;
                }
            }
            // Then handle any plot
            const wandererPlots = plots.filter(p => p.canCatchWanderer() && !p.isSafeLocked);
            while (wandererPlots.length > 0 && workTimes > 0) {
                const plot = wandererPlots.shift();
                if (this.plots().includes(plot.index)) {
                    farming.handleWanderer(plot);
                    workTimes--;
                    if (plot.wanderer?.catching()) {
                        this.gainExperience(1);
                    }
                    worked = true;
                }
            }
        }

        // All levels recover every cycle; actual work has a fixed cost.
        // Apply the net change before clamping so low energy cannot produce extra recovery.
        this.addEnergy(this.recovery - (worked ? FarmHand.WORK_ENERGY_COST : 0));
    }

    addEnergy(amt = this.recovery): void {
        this.energy(Math.max(0, Math.min(this.maxEnergy, this.energy() + amt)));
    }

    charge(): void {
        // Charge the player if they can afford it, otherwise notify that they cannot
        if (!App.game.wallet.loseAmount(this.cost)) {
            Notifier.notify({
                title: `[FARM HAND] <img src="assets/images/profile/trainer-${this.trainerSprite}.png" height="24px" class="pixelated"/> ${this.name}`,
                message: `It looks like you are a little short on Farm Points right now...\nLet me know when you're hiring again!\nCost: <img src="./assets/images/currency/farmPoint.svg" height="24px"/> ${this.cost.amount.toLocaleString('en-US')}`,
                type: NotificationConstants.NotificationOption.danger,
                timeout: 30 * GameConstants.MINUTE,
            });
            this.hired(false);
            App.game.logbook.newLog(
                LogBookTypes.OTHER,
                createLogContent.unableToPayFarmHand({ name: this.name})
            );
            return;
        }
        // Charge the player for the hour
        Notifier.notify({
            title: `[FARM HAND] <img src="assets/images/profile/trainer-${this.trainerSprite}.png" height="24px" class="pixelated"/> ${this.name}`,
            message: `Here's your bill for the hour!\nCost: <img src="./assets/images/currency/farmPoint.svg" height="24px"/> ${this.cost.amount.toLocaleString('en-US')}`,
            type: NotificationConstants.NotificationOption.info,
            timeout: 30 * GameConstants.SECOND,
        });
    }

    toJSON(): Record<string, any> {
        const output = {
            focus: this.focus(),
            shouldHarvest: this.shouldHarvest(),
            workTicks: this.workTicks(),
            costTicks: this.costTicks(),
            energy: this.energy(),
            hired: this.hired(),
            plots: this.plots(),
            // It uses the name to look up the farmhand on load
            name: this.name,
            shouldCatch: this.shouldCatch(),
        };

        // Don't save anything that is the default option
        Object.entries(output).forEach(([key, value]) => {
            if (value === this.defaults[key]) {
                delete output[key];
            }
        });

        return output;
    }

    fromJSON(json: Record<string, any>): void {
        if (!json) {
            return;
        }
        this.focus(json.focus ?? this.defaults.focus);
        this.shouldHarvest(json.shouldHarvest ?? this.defaults.shouldHarvest);
        this.workTicks(json.workTicks ?? this.defaults.workTicks);
        this.costTicks(json.costTicks ?? this.defaults.costTicks);
        this.energy(Math.max(0, Math.min(this.maxEnergy, Number(json.energy) || 0)));
        this.hired(json.hired ?? this.defaults.hired);
        this.plots(Array.isArray(json.plots) ? [...new Set<number>(json.plots.filter(i => Number.isInteger(i) && i >= 0 && i < 25))] : Array.from({ length: 25 }, (_, i) => i));
        this.shouldCatch(json.shouldCatch ?? this.defaults.shouldCatch);
    }
}

class FarmHands {
    public static list: FarmHand[] = [];

    public static add(farmHand: FarmHand) {
        this.list.push(farmHand);
    }

    public MAX_HIRES = 3;
    public available: KnockoutComputed<FarmHand[]>;
    public hired: KnockoutComputed<FarmHand[]>;
    public availableBerries: KnockoutComputed<FarmHandBerryTypes[]>;
    public canHire: KnockoutComputed<boolean>;
    public requirement = new TotalBerriesUnlockedRequirement(8);

    public list: FarmHand[];

    constructor(public farmId = 0) {
        this.list = FarmHands.list.map(template => {
            const hand = new FarmHand(template.name, template.baseEnergy, template.baseEfficiency, template.speed, template.accuracy, 0, template.unlockRequirement, farmId, template.experience);
            hand.cost.amount = template.cost.amount;
            return hand;
        });
        this.available = ko.pureComputed(() => this.list.filter(f => f.isUnlocked()));
        this.hired = ko.pureComputed(() => this.list.filter(f => f.hired()));
        this.availableBerries = ko.pureComputed(() => GameHelper.enumNumbers(FarmHandBerryTypes).filter(b => App.game.farming.unlockedBerries[b]?.() || b < 0).sort((a, b) => a - b));
        this.canHire =  ko.pureComputed(() => this.hired().length < this.MAX_HIRES);
    }

    public isUnlocked() {
        return this.requirement.isCompleted();
    }

    public tick() {
        // run game tick for all farmhands
        this.list.forEach(f => f.tick());
    }

    public toJSON(): Record<string, any>[] {
        return this.list.map(f => f.toJSON());
    }

    public fromJSON(json: Array<any>): void {
        if (!json || !json.length) {
            return;
        }

        this.list.forEach(f => {
            const data = json?.find(_f => _f.name == f.name);
            if (data) {
                f.fromJSON(data);
            }
        });
        this.hired().slice(this.MAX_HIRES).forEach(f => f.hired(false));
    }
}

// Note: Gender-neutral names used as the trainer sprite is (seeded) randomly generated
FarmHands.add(new FarmHand('Alex', 10, 1, FarmHandSpeeds.Lazy, 1, 1, new TotalBerriesUnlockedRequirement(8)));
FarmHands.add(new FarmHand('Logan', 15, 3, FarmHandSpeeds.Slowest, 2, 4, new TotalBerriesUnlockedRequirement(16)));
FarmHands.add(new FarmHand('Joey', 10, 5, FarmHandSpeeds.Slow, 2, 5, new TotalBerriesUnlockedRequirement(24)));
FarmHands.add(new FarmHand('Charlie', 30, 10, FarmHandSpeeds.BelowAverage, 7, 6, new TotalBerriesUnlockedRequirement(32)));
FarmHands.add(new FarmHand('Bailey', 10, 12, FarmHandSpeeds.Average, 7, 7, new UniqueItemOwnedRequirement('FarmHandBailey', 'purchase', 'Purchased in the Johto region.')));
FarmHands.add(new FarmHand('Kerry', 50, 16, FarmHandSpeeds.AboveAverage, 8, 8, new UniqueItemOwnedRequirement('FarmHandKerry', 'purchase', 'Purchased in the Hoenn region.')));
FarmHands.add(new FarmHand('Riley', 70, 25, FarmHandSpeeds.Fast, 8, 10, new UniqueItemOwnedRequirement('FarmHandRiley', 'purchase', 'Purchased in the Sinnoh region.')));
FarmHands.add(new FarmHand('Jamie', 65, 5, FarmHandSpeeds.Faster, 9, 10, new UniqueItemOwnedRequirement('FarmHandJamie', 'purchase', 'Purchased in the Hoenn region.')));
FarmHands.add(new FarmHand('Jessie', 100, 50, FarmHandSpeeds.Fastest, 10, 12, new TotalBerriesUnlockedRequirement(56)));
