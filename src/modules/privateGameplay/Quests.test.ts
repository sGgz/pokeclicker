import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as GameConstants from '../GameConstants';
import SeededRand from '../utilities/SeededRand';
import '../koExtenders';

const read = (name: string) => readFileSync(`src/scripts/quests/${name}.ts`, 'utf8');
const helperSource = read('QuestHelper');
const types = helperSource.slice(helperSource.indexOf('public static quests = {'), helperSource.indexOf('public static createQuest'))
    .match(/\b\w+Quest\b/g)!;
// Exercise the real registry, row lifecycle and persistence with controlled gameplay counters.
const fixtures = types.map(type => `class ${type} extends Quest {
    constructor(amount, reward, target) { super(amount, reward); this.target = target; this.focus = stats['${type}']; }
    static canComplete() { return available.has('${type}'); }
    static generateData() { return [100, 1000, SeededRand.intBetween(1, 100000)]; }
    toJSON() { return { ...super.toJSON(), name: '${type}', data: [this.amount, this.pointsReward, this.target] }; }
}`).join('\n');
const compiled = transpileModule([read('Quest'), fixtures, helperSource, read('Quests')].join('\n'), {
    compilerOptions: { target: ScriptTarget.ES2020 },
}).outputText;

afterEach(() => { vi.useRealTimers(); ko.options.deferUpdates = false; ko.tasks.runEarly(); });

function setup(unlocked = true) {
    const stats = Object.fromEntries(types.map(type => [type, ko.observable(50).extend({ numeric: 0 })]));
    const available = new Set(types);
    const dailyUnlocked = ko.observable(unlocked);
    const wallet = { hasAmount: vi.fn((cost: { amount: number }) => cost.amount >= 0), loseAmount: vi.fn((cost: { amount: number }) => cost.amount > 0), gainQuestPoints: vi.fn() };
    const confirm = vi.fn(async () => true);
    const notify = vi.fn();
    const achievement = vi.fn();
    const player = { highestRegion: () => 6, hasMegaStone: () => false, gainMegaStone: vi.fn() };
    const chance = vi.fn(() => true);
    const game: any = { wallet, statistics: { questsCompleted: ko.observable(0) }, logbook: { newLog: vi.fn() }, party: { alreadyCaughtPokemonByName: () => true } };
    const classes = runInNewContext(`${compiled}\n({ Quests, Quest, QuestHelper });`, {
        ko, GameConstants, SeededRand, stats, available, player, Date,
        Rand: { chance },
        Amount: class { constructor(public amount: number, public currency: number) {} },
        QuestLineHelper: { isQuestLineCompleted: () => dailyUnlocked(), loadQuestLines: vi.fn() },
        QuestLineState: { inactive: 0, started: 1, suspended: 2, ended: 3 },
        App: { game }, Notifier: { notify, confirm },
        NotificationConstants: { NotificationOption: {}, NotificationSetting: { General: {} }, NotificationSound: { Quests: {} } },
        AchievementHandler: { unlockAchievement: achievement },
        LogBookTypes: { QUEST: 1 },
        createLogContent: { questLevelUp: v => v, completedQuestWithPoints: v => v, completedQuest: v => v },
        GameHelper: { incrementObservable: (value: KnockoutObservable<number>, amount = 1) => value(value() + amount) },
    });
    const quests = new classes.Quests();
    game.quests = quests;
    const row = (type = types[0]) => quests.questList().find(q => quests.typeOf(q) === type);
    const saved = () => JSON.parse(JSON.stringify(quests.toJSON()));
    return { quests, stats, available, dailyUnlocked, wallet, confirm, notify, achievement, player, chance, game, classes, row, saved };
}

describe('independent ordinary quest cycles', () => {
    it('gates the list behind the tutorial and starts exactly one row per available type', () => {
        const h = setup(false);
        h.quests.tick(100);
        expect(h.quests.questList()).toHaveLength(0);
        h.dailyUnlocked(true);
        h.quests.tick(100);
        expect(types).toHaveLength(18);
        expect(h.quests.currentQuests()).toHaveLength(18);
        expect(new Set(h.quests.questList().map(q => q.constructor.name)).size).toBe(18);
        expect(h.quests.questList().every(q => q.initial() === 50 && q.progress() === 0)).toBe(true);
    });

    it.each([false, true])('claims once with frozen points bonus and base-only XP, then starts at current statistics (deferred=%s)', (deferred) => {
        ko.options.deferUpdates = deferred;
        const h = setup();
        h.quests.xp(h.quests.levelToXP(30));
        h.quests.tick(100);
        const old = h.row();
        const xp = h.quests.xp();
        expect(old.totalPointsReward).toBe(1370);
        h.stats[types[0]](100050);
        h.quests.tick(100);
        ko.tasks.runEarly();
        expect(h.row()).not.toBe(old);
        expect(h.row().initial()).toBe(100050);
        expect(h.row().progress()).toBe(0);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledExactlyOnceWith(1370);
        expect(h.quests.xp() - xp).toBe(200);
        expect(h.game.statistics.questsCompleted()).toBe(1);
        expect(h.player.gainMegaStone).toHaveBeenCalledTimes(1);
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledTimes(1);
    });

    it('handles two simultaneous types independently, preserving the other rows and order', () => {
        const h = setup();
        h.quests.tick(100);
        const other = h.row(types[2]);
        h.stats[types[0]](150);
        h.stats[types[1]](150);
        h.quests.tick(10000);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledTimes(2);
        expect(h.row(types[2])).toBe(other);
        expect(h.quests.sortedQuestList().map(q => q.constructor.name)).toEqual(types);
        expect(h.notify.mock.calls.filter(([message]) => message.message.includes('自动完成 2'))).toHaveLength(1);
    });

    it('gives each type one daily free refresh, charges a fixed amount thereafter, and preserves other progress', async () => {
        const h = setup();
        h.quests.tick(100);
        const other = h.row(types[1]);
        h.stats[types[1]](70);
        await h.quests.refreshQuest(h.row(), false);
        expect(h.quests.getRefreshCost(h.row()).amount).toBe(100000);
        expect(h.quests.getRefreshCost(other).amount).toBe(0);
        await h.quests.refreshQuest(h.row(), false);
        await h.quests.refreshQuest(h.row(), false);
        expect(h.wallet.loseAmount).toHaveBeenCalledTimes(2);
        expect(h.wallet.loseAmount.mock.calls.every(([cost]) => cost.amount === 100000)).toBe(true);
        expect(other.progress()).toBe(0.2);
        expect(h.achievement).toHaveBeenCalledWith('Picky Quester');
        h.quests.tick(100, new Date(Date.now() + 86400000));
        expect(h.quests.getRefreshCost(h.row()).amount).toBe(0);
        expect(h.quests.freeRefresh()).toBe(false);
    });

    it('keeps a non-stacking level credit and consumes daily credits first', async () => {
        const h = setup();
        h.quests.tick(100);
        h.quests.addXP(1100);
        h.quests.addXP(1500);
        expect(h.quests.freeRefresh()).toBe(true);
        await h.quests.refreshQuest(h.row(), false);
        expect(h.quests.freeRefresh()).toBe(true);
        await h.quests.refreshQuest(h.row(), false);
        expect(h.quests.freeRefresh()).toBe(false);
        expect(h.wallet.loseAmount).not.toHaveBeenCalled();
        expect(h.quests.getRefreshCost(h.row()).amount).toBe(100000);
    });

    it('does not spend manual credit on automatic replacements or reset at midnight/level up', () => {
        const h = setup();
        h.quests.tick(100);
        const other = h.row(types[1]);
        h.stats[types[1]](80);
        h.stats[types[0]](150);
        h.quests.tick(100);
        expect(h.quests.getRefreshCost(h.row()).amount).toBe(0);
        h.quests.addXP(1000);
        h.quests.tick(100, new Date(Date.now() + 86400000));
        expect(h.row(types[1])).toBe(other);
        expect(other.initial()).toBe(50);
        expect(other.progress()).toBe(0.3);
    });

    it('keeps progress and credits on cancellation or insufficient funds', async () => {
        const h = setup();
        h.quests.tick(100);
        await h.quests.refreshQuest(h.row(), false);
        const current = h.row();
        h.confirm.mockResolvedValue(false);
        await h.quests.refreshQuest(current);
        h.wallet.hasAmount.mockReturnValue(false);
        await h.quests.refreshQuest(current, false);
        expect(h.row()).toBe(current);
        expect(h.wallet.loseAmount).not.toHaveBeenCalled();
    });

    it.each([false, true])('prioritizes completion while a manual confirmation is open (tick=%s)', async (tickFirst) => {
        const h = setup();
        h.quests.tick(100);
        await h.quests.refreshQuest(h.row(), false);
        let confirm!: (value: boolean) => void;
        h.confirm.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
        const old = h.row();
        const action = h.quests.refreshQuest(old);
        await h.quests.refreshQuest(old);
        expect(h.confirm).toHaveBeenCalledTimes(1);
        h.stats[types[0]](150);
        if (tickFirst) { h.quests.tick(100); }
        confirm(true);
        await action;
        expect(h.wallet.loseAmount).not.toHaveBeenCalled();
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledTimes(1);
        expect(h.row()).not.toBe(old);
    });

    it('does not silently turn a quoted free refresh into a paid refresh', async () => {
        const h = setup();
        h.quests.tick(100);
        for (const type of types.slice(0, 2)) { await h.quests.refreshQuest(h.row(type), false); }
        h.quests.freeRefresh(true);
        let confirm!: (value: boolean) => void;
        h.confirm.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
        const old = h.row();
        const action = h.quests.refreshQuest(old);
        await h.quests.refreshQuest(h.row(types[1]), false);
        confirm(true);
        await action;
        expect(h.row()).toBe(old);
        expect(h.wallet.loseAmount).not.toHaveBeenCalled();
    });

    it('adds newly unlocked types without restarting existing tasks', () => {
        const h = setup();
        h.available.delete(types[1]);
        h.quests.tick(100);
        const old = h.row();
        h.stats[types[0]](75);
        h.available.add(types[1]);
        h.quests.tick(100);
        expect(h.quests.questList()).toHaveLength(18);
        expect(h.row()).toBe(old);
        expect(old.progress()).toBe(0.25);
    });

    it('releases old stat subscriptions during repeated refreshes', async () => {
        const h = setup();
        h.quests.tick(100);
        const count = h.stats[types[0]].getSubscriptionsCount();
        for (let i = 0; i < 20; i++) { await h.quests.refreshQuest(h.row(), false); }
        expect(h.stats[types[0]].getSubscriptionsCount()).toBe(count);
        h.stats[types[0]](150);
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledTimes(1);
    });
});

describe('quest save migration and reward continuity', () => {
    it('preserves targets and progress and compensates the claimed portion exactly once across reloads', () => {
        const h = setup();
        h.quests.fromJSON({ xp: h.quests.levelToXP(30), questList: [
            { name: types[0], data: [100, 1000, 123], initial: 25, claimed: false },
            { name: types[1], data: [100, 2000, 456], initial: 25, claimed: true },
        ] });
        expect(h.row().progress()).toBe(0.25);
        expect(h.row().target).toBe(123);
        expect(h.saved().pendingLegacyBonus).toBe(740);
        expect(h.wallet.gainQuestPoints).not.toHaveBeenCalled();
        h.quests.fromJSON(h.saved()); // Saving before the first game tick must retain pending compensation.
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledExactlyOnceWith(740);
        expect(h.game.statistics.questsCompleted()).toBe(0);
        h.quests.fromJSON(h.saved());
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledTimes(1);
        h.stats[types[0]](125);
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).toHaveBeenLastCalledWith(1370);
    });

    it('claims completed unclaimed legacy tasks once and resumes abandoned tasks at current stats', () => {
        const h = setup();
        h.quests.fromJSON({ xp: 0, questList: [
            { name: types[0], data: [20, 1000, 1], initial: 0, claimed: false },
            { name: types[1], data: [100, 1000, 2], initial: null, claimed: false },
        ] });
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledExactlyOnceWith(1100);
        expect(h.row(types[1]).initial()).toBe(50);
        h.quests.fromJSON(h.saved());
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledTimes(1);
    });

    it('never re-awards a legacy batch that was already fully claimed', () => {
        const h = setup();
        h.quests.fromJSON({ questList: [{ name: types[0], data: [20, 1000, 1], initial: 0, claimed: true }] });
        h.quests.tick(100);
        expect(h.wallet.gainQuestPoints).not.toHaveBeenCalled();
    });

    it('round-trips row targets, frozen rewards, manual costs, and independent random sequences', async () => {
        const h = setup();
        h.quests.tick(100);
        await h.quests.refreshQuest(h.row(), false);
        h.stats[types[0]](70);
        const saved = h.saved();
        const other = setup();
        other.stats[types[0]](70);
        other.quests.fromJSON(saved);
        expect(other.saved()).toEqual(saved);
        expect(other.row().progress()).toBe(0.2);
        expect(other.quests.getRefreshCost(other.row()).amount).toBe(100000);
        await h.quests.refreshQuest(h.row(types[1]), false);
        const rngState = SeededRand.state;
        await h.quests.refreshQuest(h.row(), false);
        await other.quests.refreshQuest(other.row(), false);
        expect(h.row().toJSON()).toEqual(other.row().toJSON());
        expect(SeededRand.state).toBe(rngState);
    });

    it('leaves ordinary Quest.claim defaults available to quest lines without a bonus', () => {
        const h = setup();
        const quest = new h.classes.Quest(10, 1000);
        quest.focus = ko.observable(0);
        quest.autoComplete = true;
        quest.begin();
        quest.focus(10);
        expect(quest.claim()).toBe(true);
        expect(quest.claim()).toBe(false);
        expect(h.wallet.gainQuestPoints).toHaveBeenCalledExactlyOnceWith(1000);
        expect(h.quests.xp()).toBe(200);
    });
});

describe('background game clock for automatic quests', () => {
    const gameCode = transpileModule(readFileSync('src/scripts/Game.ts', 'utf8'), {
        compilerOptions: { target: ScriptTarget.ES2020 },
    }).outputText;

    function clockFixture() {
        let now = 0;
        let frame: () => void;
        let workerTick: () => void;
        let visibilityChange: () => void;
        const enabled = { value: true };
        const document = { hidden: false, getElementById: () => ({ classList: { add: vi.fn(), remove: vi.fn() } }),
            addEventListener: (_event: string, callback: () => void) => { visibilityChange = callback; } };
        const Game = runInNewContext(`${gameCode}\nGame`, {
            GameConstants, document, console: { log: vi.fn(), error: vi.fn() },
            performance: { now: () => now },
            player: { regionStarters: [() => GameConstants.Starter.Grass] },
            requestAnimationFrame: (callback: () => void) => { frame = callback; return 1; },
            cancelAnimationFrame: vi.fn(), Settings: { getSetting: () => enabled },
            Blob: class { constructor(public parts: string[]) {} },
            window: { URL: { createObjectURL: blob => blob } },
            Worker: class {
                callback: () => void;
                constructor(blob: { parts: string[] }) {
                    runInNewContext(blob.parts.join(''), {
                        setInterval: (callback: () => void) => { workerTick = callback; },
                        postMessage: () => this.callback(),
                    });
                }
                addEventListener(_event: string, callback: () => void) { this.callback = callback; }
                terminate() { workerTick = () => {}; }
            },
        });
        const game = Object.create(Game.prototype);
        game.gameTick = vi.fn();
        game.start();
        return { game, enabled, hidden: (value: boolean) => { document.hidden = value; visibilityChange(); },
            frame: (time: number) => { now = time; frame(); }, worker: (time: number) => { now = time; workerTick(); } };
    }

    it('continues on worker messages when a minimized renderer still reports visible, without double ticking', () => {
        const h = clockFixture();
        h.frame(100);
        h.worker(100);
        h.worker(200);
        h.frame(200);
        h.worker(300);
        expect(h.game.gameTick).toHaveBeenCalledTimes(3);
    });

    it('retains the worker preference and skips delayed catch-up bursts', () => {
        const h = clockFixture();
        h.hidden(true);
        h.frame(100);
        expect(h.game.gameTick).not.toHaveBeenCalled();
        h.worker(100);
        h.worker(10000);
        expect(h.game.gameTick).toHaveBeenCalledTimes(2);
        h.enabled.value = false;
        h.worker(10100);
        expect(h.game.gameTick).toHaveBeenCalledTimes(2);
        h.hidden(false);
        h.frame(10100);
        expect(h.game.gameTick).toHaveBeenCalledTimes(3);
    });
});
