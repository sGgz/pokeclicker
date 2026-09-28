import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import Amount from '../wallet/Amount';
import * as GameConstants from '../GameConstants';

// Execute the original global script so the tests cover the real quote, payment and refund paths.
const source = readFileSync('src/scripts/dungeons/DungeonGuides.ts', 'utf8');
const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;

interface TestGuide {
    name: string;
    index: number;
    interval: number;
    ticks: number;
    walk: () => void;
    calcCost: (clears: number, price: number, region: number, includeDungeonCost?: boolean) => Amount[];
    tick: () => void;
    end: () => void;
    fire: () => void;
}

interface TestGuides {
    list: TestGuide[];
    selected: KnockoutObservable<number>;
    hired: KnockoutObservable<TestGuide>;
    clears: KnockoutObservable<number>;
    totalClears: number;
    calcCost: (includeDungeonCost?: boolean) => Amount[];
    calcDungeonCost: () => Amount;
    canAfford: () => boolean;
    hire: () => void;
}

function setup() {
    const feeRate = ko.observable(0.01);
    const optimized = ko.observable(false);
    const planner = { walk: vi.fn(), reset: vi.fn() };
    const wallet = {
        hasAmount: vi.fn<(amount: Amount) => boolean>().mockReturnValue(true),
        loseAmount: vi.fn<(amount: Amount) => boolean>().mockReturnValue(true),
        addAmount: vi.fn(),
    };
    const dungeon = { tokenCost: 10_000, difficulty: GameConstants.Region.kanto };
    const tileType = ko.observable(GameConstants.DungeonTileType.empty);
    const runner = {
        dungeon,
        map: { currentTile: () => ({ type: tileType }), board: ko.observableArray([]) },
        handleInteraction: vi.fn(),
        canStartDungeon: vi.fn(() => true),
        initializeDungeon: vi.fn(),
    };
    const context = {
        ko,
        GameConstants,
        Amount,
        PrivateGameplay: { guideFeeRate: feeRate, optimizedPathfinding: optimized },
        DungeonGuidePlanner: planner,
        DungeonRunner: runner,
        SeededRand: { seed: vi.fn(), intBetween: () => 1 },
        MaxRegionRequirement: class {
            isCompleted() { return true; }
        },
        App: { game: { wallet } },
        player: { region: GameConstants.Region.galar, town: { dungeon } },
        Notifier: { notify: vi.fn() },
        NotificationConstants: {
            NotificationOption: { danger: 'danger', info: 'info', warning: 'warning' },
            NotificationSound: { General: { dungeon_guide_complete: 'complete' } },
        },
        $: () => ({ modal: vi.fn() }),
        console,
    };
    const guides = runInNewContext(`${compiled}\nDungeonGuides;`, context) as TestGuides;
    return { guides, feeRate, optimized, planner, wallet, runner, tileType };
}

function currencyAmounts(costs: Amount[]): Record<string, number> {
    return Object.fromEntries(costs.map(({ currency, amount }) => [GameConstants.Currency[currency], amount]));
}

describe('private dungeon guide fees', () => {
    it('discounts each service currency while keeping all dungeon tickets at their original price', () => {
        const { guides } = setup();
        const shelly = guides.list.find((guide) => guide.name === 'Shelly');
        expect(currencyAmounts(shelly.calcCost(1, 10_000, GameConstants.Region.kanto))).toEqual({
            money: 400, dungeonToken: 400, questPoint: 1,
        });
        expect(currencyAmounts(shelly.calcCost(1, 10_000, GameConstants.Region.kanto, true))).toEqual({
            money: 400, dungeonToken: 10_400, questPoint: 1,
        });
    });

    it('keeps the original fees exactly when the rate is 100%', () => {
        const { guides, feeRate } = setup();
        feeRate(1);
        expect(currencyAmounts(guides.list[0].calcCost(1, 10_000, GameConstants.Region.kanto, true))).toEqual({
            money: 40_000, dungeonToken: 10_000,
        });
        expect(currencyAmounts(guides.list[2].calcCost(1, 10_000, GameConstants.Region.kanto, true))).toEqual({
            money: 40_000, dungeonToken: 50_000, questPoint: 5,
        });
    });

    it.each([1, 10, 100])('preserves batch pricing and full-price tickets for %i attempts across all six guides', (attempts) => {
        const { guides, feeRate } = setup();
        expect(guides.list.map((guide) => guide.name)).toEqual(['Jimmy', 'Timmy', 'Shelly', 'Angeline', 'Georgia', 'Drake']);
        guides.list.forEach((guide) => {
            feeRate(1);
            const original = guide.calcCost(attempts, 12_345, GameConstants.Region.hoenn);
            feeRate(0.01);
            const discounted = guide.calcCost(attempts, 12_345, GameConstants.Region.hoenn);
            original.forEach((cost, index) => {
                expect(discounted[index].currency).toBe(cost.currency);
                expect(discounted[index].amount).toBe(Math.max(1, Math.round(cost.amount / 100)));
            });
            const total = guide.calcCost(attempts, 12_345, GameConstants.Region.hoenn, true);
            const serviceTokens = discounted.find((cost) => cost.currency === GameConstants.Currency.dungeonToken)?.amount ?? 0;
            expect(total.find((cost) => cost.currency === GameConstants.Currency.dungeonToken).amount - serviceTokens).toBe(12_345 * attempts);
        });
    });

    it('does not turn a zero service fee into a charged currency', () => {
        const { guides } = setup();
        expect(currencyAmounts(guides.list[0].calcCost(1, 0, GameConstants.Region.kanto))).toEqual({ money: 0 });
    });

    it('charges the same quoted service fees and original tickets even when player region differs from dungeon difficulty', () => {
        const { guides, wallet, runner } = setup();
        guides.selected(2);
        expect(currencyAmounts(guides.calcCost(true))).toEqual({ money: 400, dungeonToken: 10_400, questPoint: 1 });
        guides.hire();
        expect(wallet.loseAmount.mock.calls.map(([cost]) => ({ currency: GameConstants.Currency[cost.currency], amount: cost.amount }))).toEqual([
            { currency: 'money', amount: 400 },
            { currency: 'dungeonToken', amount: 400 },
            { currency: 'questPoint', amount: 1 },
            { currency: 'dungeonToken', amount: 10_000 },
        ]);
        expect(runner.initializeDungeon).toHaveBeenCalledOnce();
    });

    it('checks combined service and ticket cost before payment and refuses unaffordable hiring', () => {
        const { guides, wallet, runner } = setup();
        guides.selected(2);
        wallet.hasAmount.mockImplementation((cost: Amount) => cost.currency !== GameConstants.Currency.dungeonToken || cost.amount <= 10_000);
        guides.hire();
        expect(wallet.hasAmount).toHaveBeenCalledWith(expect.objectContaining({ currency: GameConstants.Currency.dungeonToken, amount: 10_400 }));
        expect(wallet.loseAmount).not.toHaveBeenCalled();
        expect(runner.initializeDungeon).not.toHaveBeenCalled();
    });

    it('uses discounted prepaid fees for the original unavailable-dungeon partial refund', () => {
        const { guides, wallet, runner } = setup();
        guides.selected(2);
        guides.clears(10);
        const prepaid = guides.calcCost(true);
        guides.hire();
        guides.clears(4);
        runner.canStartDungeon.mockReturnValue(false);
        guides.hired().end();
        expect(wallet.addAmount.mock.calls.map(([amount]) => amount)).toEqual(prepaid.map((cost) => ({
            currency: cost.currency, amount: Math.round(cost.amount * 0.4),
        })).filter((cost) => cost.amount > 0));
        expect(guides.hired()).toBeNull();
        expect(guides.clears()).toBe(1);
    });

    it('does not submit rounded-zero refunds to a wallet that would credit one', () => {
        const { guides, wallet, runner } = setup();
        const credits: Record<number, number> = {};
        // Match Wallet.addAmount's handling of zero, rather than accepting it in a no-op stub.
        wallet.addAmount.mockImplementation((amount: Amount) => {
            if (Number.isNaN(amount.amount) || amount.amount <= 0) {
                amount.amount = 1;
            }
            credits[amount.currency] = (credits[amount.currency] ?? 0) + amount.amount;
        });
        guides.selected(2);
        guides.clears(10);
        const prepaid = guides.calcCost(true);
        expect(prepaid.find((cost) => cost.currency === GameConstants.Currency.questPoint).amount).toBe(1);
        guides.hire();
        guides.clears(4);
        runner.canStartDungeon.mockReturnValue(false);
        guides.hired().end();
        expect(credits[GameConstants.Currency.questPoint]).toBeUndefined();
        for (const cost of prepaid) {
            expect(credits[cost.currency] ?? 0).toBe(Math.round(cost.amount * 0.4));
        }
    });
});

describe('private dungeon guide planner integration', () => {
    it('preserves the official walk and action interval when optimization is disabled', () => {
        const { guides, planner, runner, tileType } = setup();
        const guide = guides.list[0];
        guide.walk = vi.fn();
        tileType(GameConstants.DungeonTileType.chest);
        guide.ticks = guide.interval - 2 * GameConstants.DUNGEON_TICK;
        guide.tick();
        expect(guide.walk).not.toHaveBeenCalled();
        expect(planner.reset).not.toHaveBeenCalled();
        guide.tick();
        expect(guide.walk).toHaveBeenCalledOnce();
        expect(planner.reset).toHaveBeenCalledOnce();
        expect(planner.walk).not.toHaveBeenCalled();
        expect(runner.handleInteraction).toHaveBeenCalledExactlyOnceWith(GameConstants.DungeonInteractionSource.DungeonGuide);
    });

    it('uses the selected guide planner without duplicating the original tile interaction', () => {
        const { guides, optimized, planner, runner, tileType } = setup();
        const guide = guides.list[3];
        guide.walk = vi.fn();
        optimized(true);
        tileType(GameConstants.DungeonTileType.boss);
        guide.ticks = guide.interval - GameConstants.DUNGEON_TICK;
        guide.tick();
        expect(planner.walk).toHaveBeenCalledExactlyOnceWith('Angeline');
        expect(guide.walk).not.toHaveBeenCalled();
        expect(runner.handleInteraction).toHaveBeenCalledExactlyOnceWith(GameConstants.DungeonInteractionSource.DungeonGuide);
    });

    it('releases planner state on manual fire without refunding or starting another run', () => {
        const { guides, planner, runner, wallet } = setup();
        guides.hired(guides.list[0]);
        guides.hired().fire();
        expect(planner.reset).toHaveBeenCalledOnce();
        expect(guides.hired()).toBeNull();
        expect(wallet.addAmount).not.toHaveBeenCalled();
        expect(runner.initializeDungeon).not.toHaveBeenCalled();
    });
});
