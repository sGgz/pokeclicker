import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as GameConstants from '../GameConstants';

const compiled = ['Quest', 'Quests'].map(name => transpileModule(
    readFileSync(`src/scripts/quests/${name}.ts`, 'utf8'),
    { compilerOptions: { target: ScriptTarget.ES2020 } },
).outputText).join('\n');

function setup() {
    const stats = ko.observable(50);
    const wallet = { hasAmount: vi.fn(() => true), loseAmount: vi.fn() };
    const confirm = vi.fn(async () => true);
    const helper = { generateQuestList: vi.fn(), createQuest: vi.fn(), loadQuestLines: vi.fn() };
    const classes = runInNewContext(`${compiled}\n({ Quests, Quest });`, {
        ko, GameConstants, player: { highestRegion: () => 0 },
        QuestHelper: helper, QuestLineHelper: helper,
        App: { game: { wallet } },
        Notifier: { notify: vi.fn(), confirm },
        NotificationConstants: { NotificationOption: { warning: 0, danger: 1 } },
        AchievementHandler: { unlockAchievement: vi.fn() },
        GameHelper: { incrementObservable: (value: KnockoutObservable<number>) => value(value() + 1) },
    });
    const createQuest = () => {
        const quest = new classes.Quest(100, 1);
        quest.focus = stats;
        return quest;
    };
    helper.generateQuestList.mockImplementation((_seed, count) => Array.from({ length: count }, createQuest));
    helper.createQuest.mockImplementation(createQuest);
    const quests = new classes.Quests();
    // Refresh price is unchanged; isolate its wallet boundary from Amount construction.
    quests.getRefreshCost = () => ({ amount: 123, currency: GameConstants.Currency.money });
    return { quests, stats, wallet, confirm, helper };
}

describe('automatic quest list acceptance', () => {
    it('starts all ten fresh quests at the current statistics baseline even at level one', () => {
        const { quests, stats } = setup();
        quests.generateQuestList();
        expect(quests.level()).toBe(1);
        expect(quests.questSlots()).toBe(10);
        expect(quests.currentQuests()).toHaveLength(10);
        expect(quests.canStartNewQuest()).toBe(false);
        for (const quest of quests.questList()) {
            expect(quest.initial()).toBe(50);
            expect(quest.progress()).toBe(0);
        }
        stats(60);
        expect(quests.questList().every(quest => quest.progress() === 0.1)).toBe(true);
    });

    it.each([true, false])('accepts the replacement list after a successful refresh (free=%s)', async (free) => {
        const { quests, stats, wallet } = setup();
        quests.generateQuestList();
        const old = quests.questList();
        stats(70);
        await quests.refreshQuests(free);
        expect(quests.currentQuests()).toHaveLength(10);
        expect(quests.questList()).not.toBe(old);
        expect(old.every(quest => !quest.inProgress())).toBe(true);
        expect(quests.questList().every(quest => quest.initial() === 70)).toBe(true);
        expect(wallet.loseAmount).toHaveBeenCalledTimes(free ? 0 : 1);
    });

    it('leaves the list and progress intact on cancellation or insufficient funds', async () => {
        const { quests, confirm, wallet } = setup();
        quests.generateQuestList();
        const old = quests.questList();
        confirm.mockResolvedValue(false);
        await quests.refreshQuests(false, true);
        wallet.hasAmount.mockReturnValue(false);
        await quests.refreshQuests(false);
        expect(quests.questList()).toBe(old);
        expect(quests.currentQuests()).toHaveLength(10);
        expect(wallet.loseAmount).not.toHaveBeenCalled();
    });

    it('preserves saved progress and intentionally abandoned quests instead of restarting them', () => {
        const { quests, stats } = setup();
        quests.generateQuestList();
        stats(65);
        quests.questList()[1].quit();
        const saved = quests.questList().map((quest, index) => ({
            name: 'fixture', index, initial: quest.initial(), claimed: false, notified: false,
        }));
        quests.loadQuestList(saved);
        expect(quests.currentQuests()).toHaveLength(9);
        expect(quests.questList()[0].initial()).toBe(50);
        expect(quests.questList()[0].progress()).toBe(0.15);
        expect(quests.questList()[1].inProgress()).toBe(false);
    });
});
