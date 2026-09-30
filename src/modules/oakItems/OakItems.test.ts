import { afterEach, describe, expect, it, vi } from 'vitest';
import OakItemType from '../enums/OakItemType';
import { Currency } from '../GameConstants';
import Multiplier from '../multiplier/Multiplier';
import MaxLevelOakItemRequirement from '../requirements/MaxLevelOakItemRequirement';
import Amount from '../wallet/Amount';
import BoughtOakItem from './BoughtOakItem';
import OakItems from './OakItems';

vi.mock('../notifications/Notifier', () => ({ default: { notify: vi.fn() } }));

const expected = [
    { type: OakItemType.Magic_Ball, cap: 10, final: 18, old: [5, 6, 7, 8, 9, 10] },
    { type: OakItemType.Amulet_Coin, cap: 15, final: 2.75, old: [1.25, 1.3, 1.35, 1.4, 1.45, 1.5] },
    { type: OakItemType.Rocky_Helmet, cap: 15, final: 2.75, old: [1.25, 1.3, 1.35, 1.4, 1.45, 1.5] },
    { type: OakItemType.Exp_Share, cap: 15, final: 2.05, old: [1.15, 1.18, 1.21, 1.24, 1.27, 1.3] },
    { type: OakItemType.Sprayduck, cap: 15, final: 2.75, old: [1.25, 1.3, 1.35, 1.4, 1.45, 1.5] },
    { type: OakItemType.Shiny_Charm, cap: 15, final: 4, old: [1.5, 1.6, 1.7, 1.8, 1.9, 2] },
    { type: OakItemType.Magma_Stone, cap: 15, final: 4, old: [1.5, 1.6, 1.7, 1.8, 1.9, 2] },
    { type: OakItemType.Cell_Battery, cap: 15, final: 4, old: [1.5, 1.6, 1.7, 1.8, 1.9, 2] },
    { type: OakItemType.Squirtbottle, cap: 10, final: 4.5, old: [1.25, 1.5, 1.75, 2, 2.25, 2.5] },
    { type: OakItemType.Sprinklotad, cap: 15, final: 4.5, old: [1.25, 1.4, 1.55, 1.7, 1.85, 2] },
    { type: OakItemType.Explosive_Charge, cap: 10, final: 24, old: [1, 2, 3, 6, 8, 10] },
    { type: OakItemType.Treasure_Scanner, cap: 10, final: 50, old: [4, 8, 12, 16, 20, 24] },
];

function setup() {
    const multiplier = new Multiplier();
    const oakItems = new OakItems(multiplier);
    const funds = new Map([[Currency.money, 100_000_000], [Currency.farmPoint, 10_000_000]]);
    const wallet = {
        hasAmount: vi.fn((cost: Amount) => funds.get(cost.currency) >= cost.amount),
        loseAmount: vi.fn((cost: Amount) => funds.set(cost.currency, funds.get(cost.currency) - cost.amount)),
    };
    const challenge = ko.observable(false);
    vi.stubGlobal('App', { game: {
        oakItems, wallet,
        party: { caughtPokemon: Array(100) },
        statistics: { oakItemUses: expected.map(() => ko.observable(0)) },
        challenges: { list: { disableOakItems: { active: challenge } } },
    } });
    oakItems.initialize();
    return { oakItems, wallet, funds, multiplier, challenge };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('extended Oak Item progression', () => {
    it.each(expected)('preserves original levels and supports the new cap for $type', ({ type, cap, final, old }) => {
        const { oakItems } = setup();
        const item = oakItems.itemList[type];
        expect(item.bonusList.slice(0, 6)).toEqual(old);
        expect(item.expList.slice(0, 5)).toEqual(type === OakItemType.Cell_Battery ? [5, 10, 30, 60, 150] : [500, 1000, 2500, 5000, 10000]);
        expect(item.maxLevel).toBe(cap);
        expect(item.bonusList).toHaveLength(cap + 1);
        expect(item.expList).toHaveLength(cap);
        expect(item.costList).toHaveLength(cap);
        expect(item.calculateBonusIfActive(cap)).toBe(final);
        for (let level = 5; level < cap; level++) {
            expect(item.expList[level]).toBeGreaterThan(item.expList[level - 1]);
            expect(item.costList[level]).toEqual(item.costList[4]);
            expect(item.calculateBonusIfActive(level + 1)).toBeGreaterThan(item.calculateBonusIfActive(level));
        }
    });

    it('applies the approved experience curves as incremental XP, including Cell Battery', () => {
        const { oakItems } = setup();
        const coin = oakItems.itemList[OakItemType.Amulet_Coin];
        const magic = oakItems.itemList[OakItemType.Magic_Ball];
        const battery = oakItems.itemList[OakItemType.Cell_Battery];
        const deltas = (values: number[]) => values.slice(5).map((value, index) => value - values[index + 4]);
        expect(deltas(coin.expList)).toEqual([20000, 35000, 55000, 85000, 130000, 190000, 270000, 365000, 485000, 625000]);
        expect(deltas(magic.expList)).toEqual([100000, 225000, 400000, 625000, 900000]);
        expect(deltas(battery.expList)).toEqual([360, 630, 990, 1530, 2340, 3420, 4860, 6570, 8730, 11250]);
        expect(coin.expList[14]).toBe(2270000);
        expect(magic.expList[9]).toBe(2260000);
        expect(battery.expList[14]).toBe(40830);
    });

    it.each(expected)('upgrades $type from an old level-5 save through the new cap at a fixed cost', ({ type, cap, final }) => {
        const { oakItems, funds, wallet } = setup();
        const item = oakItems.itemList[type];
        const oldSave = { level: 5, exp: item.expList[4], isActive: true, ...(item instanceof BoughtOakItem ? { purchased: true } : {}) };
        item.fromJSON(oldSave);
        expect(item.toJSON()).toEqual(oldSave);
        expect(item.isMaxLevel()).toBe(false);
        const fee = item.costList[4];
        const initialBalance = funds.get(fee.currency);
        for (let level = 5; level < cap; level++) {
            expect(item.level).toBe(level);
            expect(item.normalizedExp).toBe(0);
            expect(item.expPercentage).toBe(0);
            expect(item.canBuy()).toBe(false);
            item.buy();
            expect(item.level).toBe(level);
            expect(item.nextBonusText).toBe(`${item.bonusList[level + 1]}${item.bonusSymbol}`);
            const needed = item.expList[level] - item.expList[level - 1];
            item.use(needed);
            expect(item.expPercentage).toBe(100);
            expect(item.canBuy()).toBe(true);
            item.buy();
        }
        expect(funds.get(fee.currency)).toBe(initialBalance - (cap - 5) * fee.amount);
        expect(wallet.loseAmount).toHaveBeenCalledTimes(cap - 5);
        expect(item.calculateBonus()).toBe(final);
        expect(item.isMaxLevel()).toBe(true);
        expect(item.hasEnoughExp()).toBe(false);
        expect(item.canBuy()).toBe(false);
        expect(item.expPercentage).toBe(100);
        expect(item.progressString).toBe('MAX LEVEL!');
        expect(item.nextBonusText).toBe('MAX LEVEL!');
        const savedAtCap = item.toJSON();
        item.use(1_000_000);
        item.buy();
        expect(item.toJSON()).toEqual(savedAtCap);
        item.fromJSON(JSON.parse(JSON.stringify(savedAtCap)));
        expect(item.level).toBe(cap);
        expect(item.calculateBonus()).toBe(final);
        expect(wallet.loseAmount).toHaveBeenCalledTimes(cap - 5);
    });

    it('keeps the original currencies and fees and requires payment after XP is ready', () => {
        const { oakItems, funds, wallet } = setup();
        const farm = oakItems.itemList[OakItemType.Squirtbottle];
        const bomb = oakItems.itemList[OakItemType.Explosive_Charge];
        expect(farm.costList[9]).toEqual(new Amount(50000, Currency.farmPoint));
        expect(bomb.costList[9]).toEqual(new Amount(2000000, Currency.money));
        expect(oakItems.itemList[OakItemType.Amulet_Coin].costList[14]).toEqual(new Amount(1000000, Currency.money));
        farm.fromJSON({ level: 5, exp: farm.expList[5], purchased: true, isActive: true });
        funds.set(Currency.farmPoint, 49999);
        farm.buy();
        expect(farm.level).toBe(5);
        expect(wallet.loseAmount).not.toHaveBeenCalled();
        funds.set(Currency.farmPoint, 50000);
        farm.buy();
        expect(farm.level).toBe(6);
        expect(funds.get(Currency.farmPoint)).toBe(0);
    });

    it('preserves level-5 achievements while separately counting actual new maximum levels', () => {
        const { oakItems } = setup();
        const save = Object.fromEntries(oakItems.itemList.map(item => [OakItemType[item.name], {
            level: 5, exp: item.expList[4], isActive: false, ...(item instanceof BoughtOakItem ? { purchased: true } : {}),
        }]));
        oakItems.fromJSON(save);
        expect(oakItems.toJSON()).toEqual(save);
        expect(oakItems.maxLevelOakItems()).toBe(0);
        const achievement = new MaxLevelOakItemRequirement(12);
        expect(achievement.getProgress()).toBe(12);
        expect(achievement.hint()).toContain('level 5');
        const first = oakItems.itemList[0];
        first.level = first.maxLevel;
        expect(oakItems.maxLevelOakItems()).toBe(1);
        expect(achievement.getProgress()).toBe(12);
        oakItems.itemList[1].level = 4;
        expect(achievement.getProgress()).toBe(11);
    });

    it('retains purchase requirements, inactive bonuses, unlimited equipment and multiplier integration', () => {
        const { oakItems, multiplier, challenge } = setup();
        const coin = oakItems.itemList[OakItemType.Amulet_Coin];
        coin.fromJSON({ level: 15, exp: coin.expList[14], isActive: false });
        expect(multiplier.getBonus('money')).toBe(1);
        oakItems.itemList.forEach((item) => oakItems.activate(item.name));
        expect(oakItems.activeCount()).toBe(8);
        expect(oakItems.isActive(OakItemType.Squirtbottle)).toBe(false);
        expect(multiplier.getBonus('money')).toBe(2.75);
        oakItems.deactivateAll();
        challenge(true);
        oakItems.activate(OakItemType.Amulet_Coin);
        expect(oakItems.activeCount()).toBe(0);
    });
});
