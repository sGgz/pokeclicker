/// <reference path="../../declarations/GameHelper.d.ts" />

class BattleFrontierRunner {
    public static timeLeft: KnockoutObservable<number> = ko.observable(GameConstants.GYM_TIME);
    public static timeLeftPercentage: KnockoutObservable<number> = ko.observable(100);
    static stage: KnockoutObservable<number> = ko.observable(1); // Start at stage 1
    public static checkpoint: KnockoutObservable<number> = ko.observable(1); // Start at stage 1
    public static runStartStage: KnockoutObservable<number> = ko.observable(1);
    public static highest: KnockoutObservable<number> = ko.observable(1);
    public static battleBackground: KnockoutObservable<GameConstants.BattleBackground> = ko.observable('Default');

    public static counter = 0;

    public static started = ko.observable(false);
    public static confirmationPending = ko.observable(false);
    private static readonly retainedStages = 100;

    public static quickStartStage = ko.pureComputed(() => {
        const startStage = Math.max(1, App.game.statistics.battleFrontierHighestStageCompleted() - BattleFrontierRunner.retainedStages + 1);
        // Replay any unlocked, unclaimed milestone instead of skipping its reward.
        return BattleFrontierMilestones.milestoneRewards
            .filter(m => m.isUnlocked() && !m.obtained() && m.stage < startStage)
            .reduce((stage, m) => Math.min(stage, m.stage), startStage);
    });

    public static pendingRewards = ko.pureComputed(() => {
        const stageBeaten = Math.max(0, BattleFrontierRunner.checkpoint() - 1);
        const skippedStages = BattleFrontierRunner.runStartStage() - 1;
        const totalReward = stageBeaten * Math.max(stageBeaten / 100, 1);
        const skippedReward = skippedStages * Math.max(skippedStages / 100, 1);
        return {
            stages: Math.max(0, stageBeaten - skippedStages),
            battlePoints: Math.max(0, Math.round(totalReward) - Math.round(skippedReward)),
            money: Math.max(0, stageBeaten * Math.max(stageBeaten, 100) - skippedStages * Math.max(skippedStages, 100)),
        };
    });

    constructor() {}

    public static tick() {
        if (!this.started()) {
            return;
        }
        if (this.timeLeft() < 0) {
            this.battleLost();
            return;
        }
        this.timeLeft(this.timeLeft() - GameConstants.GYM_TICK);
        this.timeLeftPercentage(Math.floor(this.timeLeft() / GameConstants.GYM_TIME * 100));
    }

    public static async start(useCheckpoint: boolean, quickStart = false) {
        if (this.started() || this.confirmationPending()) {
            return;
        }
        if (!useCheckpoint && this.hasCheckpoint()) {
            this.confirmationPending(true);
            try {
                if (!await Notifier.confirm({
                    title: 'Restart Battle Frontier?',
                    message: 'Your saved run and its unclaimed Battle Points and money will be lost. Start a new challenge?',
                    type: NotificationConstants.NotificationOption.warning,
                    confirm: 'Restart',
                })) {
                    return;
                }
            } finally {
                this.confirmationPending(false);
            }
        }

        if (!useCheckpoint) {
            BattleFrontierRunner.battleBackground('Default');
            this.runStartStage(quickStart ? this.quickStartStage() : 1);
            this.checkpoint(this.runStartStage());
        }

        this.started(true);
        this.stage(this.checkpoint());
        this.highest(App.game.statistics.battleFrontierHighestStageCompleted());
        BattleFrontierBattle.pokemonIndex(0);
        BattleFrontierBattle.generateNewEnemy();
        BattleFrontierRunner.timeLeft(GameConstants.GYM_TIME);
        BattleFrontierRunner.timeLeftPercentage(100);
        App.game.gameState = GameConstants.GameState.battleFrontier;
    }

    public static nextStage() {
        // Gain any rewards we should have earned for defeating this stage
        BattleFrontierMilestones.gainReward(this.stage());
        if (App.game.statistics.battleFrontierHighestStageCompleted() < this.stage()) {
            // Update our highest stage
            App.game.statistics.battleFrontierHighestStageCompleted(this.stage());
        }
        // Move on to the next stage
        GameHelper.incrementObservable(this.stage);
        GameHelper.incrementObservable(App.game.statistics.battleFrontierTotalStagesCompleted);
        BattleFrontierRunner.timeLeft(GameConstants.GYM_TIME);
        BattleFrontierRunner.timeLeftPercentage(100);

        this.checkpoint(this.stage());

        if (this.stage() % 25 == 0) {
            const currentBackground = BattleFrontierRunner.battleBackground();
            const backgrounds = Object.keys(GameConstants.BattleBackgrounds).filter((key) => key !== currentBackground);
            BattleFrontierRunner.battleBackground(Rand.fromArray(backgrounds) as GameConstants.BattleBackground);
        }
    }

    public static end() {
        BattleFrontierBattle.enemyPokemon(null);
        this.stage(1);
        this.started(false);
    }

    public static battleLost() {
        if (this.started()) {
            this.settle();
        }
    }

    private static settle() {
        if (!this.started() && !this.hasCheckpoint()) {
            return;
        }
        const stageBeaten = this.checkpoint() - 1;
        const rewards = this.pendingRewards();

        // Clear the run before awarding anything so it cannot be claimed twice.
        this.checkpoint(1);
        this.runStartStage(1);
        this.end();

        // Wallet.addAmount converts zero into one, so don't send empty rewards.
        const battlePointsEarned = rewards.battlePoints > 0 ? App.game.wallet.gainBattlePoints(rewards.battlePoints).amount : 0;
        const moneyEarned = rewards.money > 0 ? App.game.wallet.gainMoney(rewards.money, true).amount : 0;
        const progressMessage = rewards.stages > 0
            ? `You completed ${rewards.stages.toLocaleString('en-US')} stages this run, reaching stage ${stageBeaten.toLocaleString('en-US')}.`
            : 'You ended this run without completing a stage.';

        Notifier.notify({
            title: 'Battle Frontier',
            message: `${progressMessage}\nYou received <img src="./assets/images/currency/battlePoint.svg" height="24px"/> ${battlePointsEarned.toLocaleString('en-US')}.\nYou received <img src="./assets/images/currency/money.svg" height="24px"/> ${moneyEarned.toLocaleString('en-US')}.`,
            strippedMessage: `${progressMessage}\nYou received ${battlePointsEarned.toLocaleString('en-US')} Battle Points.\nYou received ${moneyEarned.toLocaleString('en-US')} Pokédollars.`,
            type: NotificationConstants.NotificationOption.success,
            setting: NotificationConstants.NotificationSetting.General.battle_frontier,
            sound: NotificationConstants.NotificationSound.General.battle_frontier,
            timeout: 30 * GameConstants.MINUTE,
        });
        if (rewards.stages > 0) {
            App.game.logbook.newLog(
                LogBookTypes.FRONTIER,
                createLogContent.gainBattleFrontierPoints({
                    stage: stageBeaten.toLocaleString('en-US'),
                    points: battlePointsEarned.toLocaleString('en-US'),
                })
            );
        }
    }

    public static async battleFinish() {
        if ((!this.started() && !this.hasCheckpoint()) || this.confirmationPending()) {
            return;
        }
        this.confirmationPending(true);
        try {
            if (await Notifier.confirm({
                title: 'Finish Battle Frontier?',
                message: 'End this run and claim Battle Points and money for the stages you completed? Your checkpoint will be cleared.',
                type: NotificationConstants.NotificationOption.warning,
                confirm: 'Finish & Claim',
            })) {
                this.settle();
            }
        } finally {
            this.confirmationPending(false);
        }
    }

    public static async battleQuit() {
        if (!this.started() || this.confirmationPending()) {
            return;
        }
        this.confirmationPending(true);
        try {
            const confirmed = await Notifier.confirm({
                title: 'Pause Battle Frontier?',
                message: 'Save this run and return later? Battle Points and money will remain unclaimed until you finish the run.',
                type: NotificationConstants.NotificationOption.warning,
                confirm: 'Pause',
            });
            if (confirmed && this.started()) {
                Notifier.notify({
                    title: 'Battle Frontier',
                    message: `Checkpoint set for stage ${this.stage()}.`,
                    type: NotificationConstants.NotificationOption.info,
                    timeout: 1 * GameConstants.MINUTE,
                });

                this.end();
            }
        } finally {
            this.confirmationPending(false);
        }
    }

    public static timeLeftSeconds = ko.pureComputed(() => {
        return (Math.ceil(BattleFrontierRunner.timeLeft() / 100) / 10).toFixed(1);
    })

    public static pokemonLeftImages = ko.pureComputed(() => {
        let str = '';
        for (let i = 0; i < 3; i++) {
            str += `<img class="pokeball-smallest" src="assets/images/pokeball/Pokeball.svg"${BattleFrontierBattle.pokemonIndex() > i ? ' style="filter: saturate(0);"' : ''}>`;
        }
        return str;
    })

    public static hasCheckpoint = ko.computed(() => {
        return BattleFrontierRunner.checkpoint() > 1;
    })
}
