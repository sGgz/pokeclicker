/// <reference path="../../declarations/GameHelper.d.ts" />
/// <reference path="../../declarations/DataStore/common/Saveable.d.ts" />

class Quests implements Saveable {
    saveKey = 'quests';
    defaults = { xp: 0, freeRefresh: false };
    public xp = ko.observable(0).extend({ numeric: 0 });
    // A non-stacking level-up credit, separate from each type's daily free refresh.
    public freeRefresh = ko.observable(false);
    public questList: KnockoutObservableArray<Quest> = ko.observableArray();
    public questLines: KnockoutObservableArray<QuestLine> = ko.observableArray();
    private questLineMap: Map<QuestLineNameType, QuestLine> = new Map();
    private cycleSeed = Date.now() >>> 0;
    private cycleCounters: Record<string, number> = {};
    private manualRefreshDays = ko.observable<Record<string, string>>({});
    private today = ko.observable(new Date().toDateString());
    private refreshing = ko.observableArray<Quest>();
    private pendingLegacyBonus = 0;
    private notificationTime = 0;
    private notificationCount = 0;
    private notificationPoints = 0;

    public level = ko.pureComputed(() => this.xpToLevel(this.xp()));
    public currentQuests = ko.pureComputed(() => this.questList().filter(quest => quest.inProgress()));

    /** Registry order is stable even when one row completes or a new type unlocks. */
    public sortedQuestList = ko.pureComputed(() => {
        const order = Object.keys(QuestHelper.quests);
        return [...this.questList()].sort((a, b) => order.indexOf(this.typeOf(a)) - order.indexOf(this.typeOf(b)));
    });

    public typeOf(quest: Quest): string {
        return quest.constructor.name;
    }

    getQuestLine(name: QuestLineNameType) {
        // Map did not work as a pureComputed due to deferUpdates = true, so build it here.
        if (this.questLineMap.size !== this.questLines().length) {
            this.questLineMap.clear();
            this.questLines().forEach(ql => this.questLineMap.set(ql.name, ql));
        }
        return this.questLineMap.get(name);
    }

    replaceQuestLine(questLine: QuestLine) {
        const oldQuestLine = this.getQuestLine(questLine.name);
        if (!oldQuestLine) {
            return;
        }
        oldQuestLine.dispose();
        this.questLines.replace(oldQuestLine, questLine);
        this.questLineMap.set(questLine.name, questLine);
    }

    public calcListBonusPercent(level: number): number {
        return Math.max(0.1, Math.min(5000 + level * 100, (2 * level) ** 2 + 100) / 10000);
    }

    public addXP(amount: number) {
        if (isNaN(amount)) {
            return;
        }
        const currentLevel = this.level();
        GameHelper.incrementObservable(this.xp, amount);
        if (this.level() > currentLevel) {
            Notifier.notify({
                message: `Your quest level has increased to ${this.level()}!\n<i>You have one extra free refresh for any quest type (does not stack).</i>`,
                type: NotificationConstants.NotificationOption.success,
                timeout: 1e4,
                sound: NotificationConstants.NotificationSound.Quests.quest_level_increased,
            });
            this.freeRefresh(true);
            App.game.logbook.newLog(LogBookTypes.QUEST, createLogContent.questLevelUp({ level: this.level().toLocaleString() }));
        }
    }

    private generateQuest(type: string): Quest {
        const counter = this.cycleCounters[type] || 0;
        let seed = this.cycleSeed;
        for (const char of `${type}:${counter}`) {
            seed = (Math.imul(seed, 31) + char.charCodeAt(0)) >>> 0;
        }
        const quest = QuestHelper.generateQuest(type, seed);
        quest.autoComplete = true; // Suppress ready popups; tick owns claiming and replacement.
        quest.bonusPointsReward = Math.round(quest.pointsReward * this.calcListBonusPercent(this.level()));
        this.cycleCounters[type] = counter + 1;
        return quest;
    }

    private replaceQuest(quest: Quest, replacement: Quest) {
        replacement.index = quest.index;
        replacement.begin();
        this.questList.replace(quest, replacement);
        quest.dispose();
    }

    /** Called after game statistics update, never from a progress subscription. */
    public tick(elapsed: number, now = new Date()) {
        this.today(now.toDateString());
        if (!this.isDailyQuestsUnlocked()) {
            return;
        }
        if (this.pendingLegacyBonus > 0) {
            const bonus = this.pendingLegacyBonus;
            App.game.wallet.gainQuestPoints(bonus);
            this.pendingLegacyBonus = 0;
            Notifier.notify({
                message: `旧任务奖励已迁移：已领取任务补发 ${bonus.toLocaleString('en-US')} 任务点加成。未完成任务的进度已保留。`,
                type: NotificationConstants.NotificationOption.info,
            });
        }

        // Snapshot once: a successor cannot consume the same action or offline statistic jump.
        for (const quest of [...this.questList()]) {
            if (quest.initial() === null && !quest.claimed()) {
                quest.begin();
            }
            if (quest.isCompleted()) {
                this.completeQuest(quest);
            }
        }
        for (const type of QuestHelper.availableTypes()) {
            if (!this.questList().some(quest => this.typeOf(quest) === type)) {
                const quest = this.generateQuest(type);
                quest.index = this.questList().length;
                quest.begin();
                this.questList.push(quest);
            }
        }

        this.notificationTime += elapsed;
        if (this.notificationTime >= 10000) {
            this.notificationTime = 0;
            if (this.notificationCount) {
                Notifier.notify({
                    message: `自动完成 ${this.notificationCount} 个任务，领取 ${this.notificationPoints.toLocaleString('en-US')} 任务点（含等级加成），已续接同类型任务。`,
                    type: NotificationConstants.NotificationOption.success,
                    setting: NotificationConstants.NotificationSetting.General.quest_completed,
                });
                this.notificationCount = 0;
                this.notificationPoints = 0;
            }
        }
    }

    private completeQuest(quest: Quest) {
        if (!this.questList().includes(quest) || !quest.isCompleted()) {
            return;
        }
        if (quest.claim(true)) {
            this.notificationCount++;
            this.notificationPoints += quest.totalPointsReward;
            if (player.highestRegion() >= GameConstants.Region.kalos && App.game.party.alreadyCaughtPokemonByName('Medicham') && !player.hasMegaStone(GameConstants.MegaStoneType.Medichamite)) {
                if (Rand.chance(Math.max(0, (this.level() - 15) / 4096))) {
                    player.gainMegaStone(GameConstants.MegaStoneType.Medichamite);
                }
            }
        }
        const type = this.typeOf(quest);
        // Keep a claimed row if its feature has become unavailable; never pay it twice.
        if (QuestHelper.quests[type].canComplete()) {
            this.replaceQuest(quest, this.generateQuest(type));
        }
    }

    public getRefreshCost(quest: Quest): Amount {
        const dailyFree = this.manualRefreshDays()[this.typeOf(quest)] !== this.today();
        return new Amount(dailyFree || this.freeRefresh() ? 0 : 100000, GameConstants.Currency.money);
    }

    public canRefresh(quest: Quest): boolean {
        return this.isDailyQuestsUnlocked() && this.questList().includes(quest) && !quest.isCompleted()
            && !this.refreshing().includes(quest) && QuestHelper.quests[this.typeOf(quest)].canComplete()
            && App.game.wallet.hasAmount(this.getRefreshCost(quest));
    }

    public async refreshQuest(quest: Quest, shouldConfirm = true) {
        this.today(new Date().toDateString());
        if (!this.canRefresh(quest)) {
            return;
        }
        this.refreshing.push(quest);
        const quotedCost = this.getRefreshCost(quest).amount;
        try {
            if (shouldConfirm && !await Notifier.confirm({
                title: '刷新此类任务',
                message: `仅刷新「${quest.description}」\n当前进度将清零，替换为同类型任务。\n费用：${quotedCost ? `${quotedCost.toLocaleString('en-US')} 金币` : '免费'}。`,
                type: NotificationConstants.NotificationOption.warning,
                confirm: '刷新',
            })) {
                return;
            }
            this.today(new Date().toDateString());
            // A confirmation can remain open while a task finishes or another row uses a credit.
            if (!this.isDailyQuestsUnlocked() || !this.questList().includes(quest)) {
                return;
            }
            if (quest.isCompleted()) {
                this.completeQuest(quest);
                return;
            }
            const type = this.typeOf(quest);
            const cost = this.getRefreshCost(quest);
            if (cost.amount > quotedCost || !App.game.wallet.hasAmount(cost) || !QuestHelper.quests[type].canComplete()) {
                return;
            }
            const replacement = this.generateQuest(type);
            if (cost.amount && !App.game.wallet.loseAmount(cost)) {
                replacement.dispose();
                return;
            }
            if (this.manualRefreshDays()[type] === this.today() && !cost.amount) {
                this.freeRefresh(false);
            }
            this.manualRefreshDays({ ...this.manualRefreshDays(), [type]: this.today() });
            this.replaceQuest(quest, replacement);
            AchievementHandler.unlockAchievement('Picky Quester');
        } finally {
            this.refreshing.remove(quest);
        }
    }

    public levelToXP(level: number): number {
        if (level >= 2) {
            const a = 1000, r = 1.2, n = level - 1;
            return Math.ceil(a * (Math.pow(r, n) - 1) / (r - 1));
        }
        return 0;
    }

    public xpToLevel(xp: number): number {
        const a = 1000, r = 1.2;
        const n = Math.log(1 + ((r - 1) * xp) / a) / Math.log(r);
        return Math.floor(n + 1);
    }

    public percentToNextQuestLevel(): number {
        const current = this.level();
        return 100 * (this.xp() - this.levelToXP(current)) / (this.levelToXP(current + 1) - this.levelToXP(current));
    }

    public questProgressTooltip() {
        const level = this.level();
        return { title: `${(this.xp() - this.levelToXP(level)).toLocaleString('en-US')} / ${(this.levelToXP(level + 1) - this.levelToXP(level)).toLocaleString('en-US')}`, trigger: 'hover' };
    }

    public isDailyQuestsUnlocked() {
        return QuestLineHelper.isQuestLineCompleted('Tutorial Quests');
    }

    loadQuestList(questList: any[], legacy = false) {
        this.questList().forEach(quest => quest.dispose());
        this.questList.removeAll();
        for (const data of questList) {
            // Do not silently replace unreadable saved progress with a random quest.
            if (!Object.prototype.hasOwnProperty.call(QuestHelper.quests, data.name) || this.questList().some(quest => this.typeOf(quest) === data.name)) {
                throw new Error(`Invalid or duplicate saved quest type: ${data.name}`);
            }
            const quest = QuestHelper.createQuest(data.name, data.data);
            quest.autoComplete = true;
            quest.fromJSON(data);
            quest.index = this.questList().length;
            if (legacy) {
                quest.bonusPointsReward = Math.round(quest.pointsReward * this.calcListBonusPercent(this.level()));
            }
            this.questList.push(quest);
        }
    }

    loadQuestLines(questLines) {
        questLines.forEach(questLine => {
            try {
                if (questLine.state == QuestLineState.inactive) {
                    return;
                }
                const ql = this.getQuestLine(questLine.name as QuestLineNameType);
                if (ql) {
                    ql.state(questLine.state);
                    if (questLine.state == QuestLineState.started || questLine.state == QuestLineState.suspended) {
                        if (ql.quests()[questLine.quest] instanceof MultipleQuestsQuest) {
                            ql.resumeAt(questLine.quest, 0);
                            ql.curQuestObject().quests.forEach((q, i) => {
                                if (questLine?.initial[i] === true) {
                                    return q.complete(true);
                                }
                                q.initial(questLine?.initial[i] ?? 0);
                            });
                        } else {
                            ql.resumeAt(questLine.quest, questLine.initial);
                        }
                        if (questLine.state == QuestLineState.suspended) {
                            ql.suspendQuest(true);
                        }
                    }
                }
            } catch (e) {
                console.error(`Quest line "${questLine.name}" failed to load`, questLine);
            }
        });
    }

    toJSON() {
        return {
            cycleVersion: 1,
            cycleSeed: this.cycleSeed,
            cycleCounters: { ...this.cycleCounters },
            manualRefreshDays: { ...this.manualRefreshDays() },
            pendingLegacyBonus: this.pendingLegacyBonus,
            xp: this.xp(),
            freeRefresh: this.freeRefresh(),
            questList: this.questList().map(quest => quest.toJSON()),
            questLines: this.questLines().filter(q => q.state()),
        };
    }

    fromJSON(json: any) {
        if (json?.cycleVersion > 1) {
            throw new Error('Unsupported quest cycle save version');
        }
        QuestLineHelper.loadQuestLines(json?.questLines);
        this.xp(json?.xp || 0);
        this.freeRefresh(!!json?.freeRefresh);
        this.today(new Date().toDateString());
        this.cycleSeed = Number.isFinite(json?.cycleSeed) ? json.cycleSeed >>> 0 : Date.now() >>> 0;
        this.cycleCounters = { ...json?.cycleCounters };
        this.manualRefreshDays({ ...json?.manualRefreshDays });
        this.pendingLegacyBonus = Number.isFinite(json?.pendingLegacyBonus) ? Math.max(0, json.pendingLegacyBonus) : 0;
        this.refreshing.removeAll();
        this.notificationTime = 0;
        this.notificationCount = 0;
        this.notificationPoints = 0;

        const legacy = !json?.cycleVersion;
        this.loadQuestList(json?.questList || [], legacy);
        if (legacy && this.questList().some(quest => !quest.claimed())) {
            // Only the already-claimed part of an unfinished old batch is missing its bonus.
            this.pendingLegacyBonus = this.questList().filter(quest => quest.claimed())
                .reduce((sum, quest) => sum + quest.bonusPointsReward, 0);
        }
        if (json?.questLines) {
            this.loadQuestLines(json.questLines);
        }
        // Wallet and other modules may still be loading. Pay and fill rows on the first tick.
    }
}
