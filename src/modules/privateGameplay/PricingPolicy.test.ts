import * as knockout from 'knockout';
import { Currency, VitaminType } from '../GameConstants';
import GameHelper from '../GameHelper';
import Item from '../items/Item';
import Vitamin from '../items/Vitamin';
import { MultiplierDecreaser } from '../items/types';
import Notifier from '../notifications/Notifier';
import Amount from '../wallet/Amount';
import RedeemableCodes from '../codes/RedeemableCodes';

const { pricing, mockItemList } = vi.hoisted(() => ({
    pricing: { fixed: null as import('knockout').Observable<boolean>, vitaminPurchased: false },
    mockItemList: {} as Record<string, Item>,
}));

vi.mock('./settings', () => ({
    default: {
        fixedItemPrices: () => pricing.fixed(),
        fixedVitaminsPurchased: () => pricing.vitaminPurchased,
        markFixedVitaminPurchase: () => { pricing.vitaminPurchased = true; },
    },
}));
vi.mock('../notifications/Notifier', () => ({ default: { notify: vi.fn(), confirm: vi.fn() } }));
vi.mock('../items/ItemList', () => ({ ItemList: mockItemList }));
vi.mock('../pokemons/PokemonList', () => ({ pokemonMap: {} }));

let multipliers: Record<string, number>;
let inventory: Record<string, knockout.Observable<number>>;
let balances: number[];
let loseAmount: ReturnType<typeof vi.fn>;
let addAmount: ReturnType<typeof vi.fn>;
let gainItem: ReturnType<typeof vi.fn>;
let loseItem: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.clearAllMocks();
    pricing.fixed = knockout.observable(false);
    pricing.vitaminPurchased = false;
    multipliers = {};
    inventory = {};
    balances = GameHelper.enumNumbers(Currency).map(() => 1e9);
    gainItem = vi.fn((name: string, amount: number) => {
        inventory[name] ??= knockout.observable(0);
        inventory[name](inventory[name]() + amount);
    });
    loseItem = vi.fn((name: string, amount: number) => inventory[name](inventory[name]() - amount));
    loseAmount = vi.fn((amount: Amount) => {
        if (amount.amount > balances[amount.currency]) {
            return false;
        }
        balances[amount.currency] -= amount.amount;
        return true;
    });
    addAmount = vi.fn((amount: Amount) => { balances[amount.currency] += amount.amount; });
    vi.stubGlobal('player', { itemMultipliers: multipliers, itemList: inventory, gainItem, loseItem });
    vi.stubGlobal('App', {
        game: {
            wallet: { loseAmount, addAmount },
            party: { caughtPokemon: [] },
            statistics: {
                totalVitaminsPurchased: knockout.observable(0),
                totalVitaminsObtained: knockout.observable(0),
            },
        },
    });
    vi.mocked(Notifier.confirm).mockResolvedValue(true);
});

afterEach(() => vi.unstubAllGlobals());

function savedItem(multiplier = 2, maxMultiplier = 8, currency = Currency.money) {
    const item = new Item('Test_Item', 200, currency, { multiplier, maxMultiplier, saveName: `Test_Item|${currency}` });
    multipliers[item.saveName] = 2;
    item.price(400);
    return item;
}

describe('item pricing modes', () => {
    it('preserves official batch growth, cap and multiplier updates', () => {
        const item = savedItem();
        expect(item.totalPrice(5)).toBe(6000);
        item.buy(5);
        expect(loseAmount).toHaveBeenCalledWith(new Amount(6000, Currency.money));
        expect(gainItem).toHaveBeenCalledWith('Test_Item', 5);
        expect(multipliers[item.saveName]).toBe(8);
        expect(item.price()).toBe(1600);
        item.decreasePriceMultiplier(2, MultiplierDecreaser.Battle);
        expect(multipliers[item.saveName]).toBe(2);
        expect(item.totalPrice(1)).toBe(400);
    });

    it('preserves the official total for items that already have a constant price', () => {
        const item = savedItem(1);
        expect(item.totalPrice(5)).toBe(1000);
    });

    it.each([1.01, 1.1, 1.35])('charges the base price and freezes old multipliers for multiplier %s', (multiplier) => {
        const item = savedItem(multiplier, Infinity);
        pricing.fixed(true);
        expect(item.totalPrice(10000)).toBe(2000000);
        item.buy(10000);
        item.decreasePriceMultiplier(10000, MultiplierDecreaser.Battle);
        expect(loseAmount).toHaveBeenCalledWith(new Amount(2000000, Currency.money));
        expect(multipliers[item.saveName]).toBe(2);
        expect(item.price()).toBe(400);
        expect(JSON.stringify(multipliers)).not.toContain('null');
        pricing.fixed(false);
        expect(item.totalPrice(1)).toBe(400);
    });

    it('updates an already observed quote when the price mode changes', () => {
        const item = savedItem();
        const quote = knockout.pureComputed(() => item.totalPrice(2));
        const changed = vi.fn();
        const subscription = quote.subscribe(changed);
        expect(quote()).toBe(1200);
        pricing.fixed(true);
        expect(changed).toHaveBeenLastCalledWith(400);
        pricing.fixed(false);
        expect(changed).toHaveBeenLastCalledWith(1200);
        subscription.dispose();
        quote.dispose();
    });

    it.each(GameHelper.enumNumbers(Currency))('keeps currency %s and its saved multiplier separate', (currency: Currency) => {
        pricing.fixed(true);
        const item = savedItem(1.35, Infinity, currency);
        balances[currency] = 500;
        item.buy(2);
        expect(loseAmount).toHaveBeenCalledWith(new Amount(400, currency));
        expect(balances[currency]).toBe(100);
        expect(multipliers[item.saveName]).toBe(2);
    });

    it('uses the existing quantity cap for both quotes and purchases', () => {
        pricing.fixed(true);
        const item = new Item('Limited_Item', 200, Currency.money, { maxAmount: 3 });
        expect(item.totalPrice(5)).toBe(600);
        item.buy(5);
        expect(loseAmount).toHaveBeenCalledWith(new Amount(600, Currency.money));
        expect(gainItem).toHaveBeenCalledWith('Limited_Item', 3);
    });

    it.each([0, 199, 200, 999, 1000])('agrees with the existing Max binary search at balance %s', (balance) => {
        pricing.fixed(true);
        const item = savedItem();
        const tooMany = (amount: number) => amount > item.maxAmount || item.totalPrice(amount) > balance;
        const max = GameHelper.binarySearch(tooMany, 0, Number.MAX_SAFE_INTEGER);
        expect(max).toBe(Math.floor(balance / item.basePrice));
        expect(item.totalPrice(max)).toBeLessThanOrEqual(balance);
        expect(item.totalPrice(max + 1)).toBeGreaterThan(balance);
    });

    it('keeps Max within an item purchase limit', () => {
        pricing.fixed(true);
        const item = new Item('Limited_Item', 200, Currency.money, { maxAmount: 3 });
        const tooMany = (amount: number) => amount > item.maxAmount || item.totalPrice(amount) > 10000;
        expect(GameHelper.binarySearch(tooMany, 0, Number.MAX_SAFE_INTEGER)).toBe(3);
    });

    it.each([false, true])('quotes zero as zero and rejects invalid transactions in fixed mode %s', (fixed) => {
        pricing.fixed(fixed);
        const item = savedItem();
        expect(item.totalPrice(0)).toBe(0);
        item.buy(0);
        for (const amount of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
            expect(item.totalPrice(amount)).toBe(Infinity);
            item.buy(amount);
        }
        const unobtainable = new Item('Unobtainable');
        expect(unobtainable.totalPrice(0)).toBe(0);
        unobtainable.buy(1);
        const overflow = new Item('Overflow', 1e308);
        overflow.buy(2);
        expect(loseAmount).not.toHaveBeenCalled();
        expect(gainItem).not.toHaveBeenCalled();
    });

    it('keeps availability, sold-out and wallet checks before receiving an item', () => {
        pricing.fixed(true);
        const item = savedItem();
        vi.spyOn(item, 'isAvailable').mockReturnValue(false);
        item.buy(1);
        vi.mocked(item.isAvailable).mockReturnValue(true);
        vi.spyOn(item, 'isSoldOut').mockReturnValue(true);
        item.buy(1);
        expect(loseAmount).not.toHaveBeenCalled();
        vi.mocked(item.isSoldOut).mockReturnValue(false);
        balances[item.currency] = 0;
        item.buy(1);
        expect(loseAmount).toHaveBeenCalledOnce();
        expect(gainItem).not.toHaveBeenCalled();
        expect(multipliers[item.saveName]).toBe(2);
    });
});

describe('fixed-price vitamin refund protection', () => {
    beforeEach(() => {
        const currencies = [Currency.money, Currency.dungeonToken, Currency.questPoint];
        GameHelper.enumNumbers(VitaminType).forEach((type: VitaminType, index) => {
            const item = new Vitamin(type, 100, currencies[index], { multiplier: 1.1 });
            mockItemList[item.name] = item;
            inventory[item.name] = knockout.observable(50);
            multipliers[item.saveName] = 100;
            item.price(10000);
        });
    });

    function refundCode() {
        return new RedeemableCodes().codeList.find((code) => code.name === 'refund-vitamins');
    }

    it.each(GameHelper.enumStrings(VitaminType))('marks a successful fixed-price %s purchase and keeps the marker when the mode changes', (name) => {
        pricing.fixed(true);
        mockItemList[name].buy(1);
        expect(pricing.vitaminPurchased).toBe(true);
        expect(loseAmount).toHaveBeenCalledWith(new Amount(100, mockItemList[name].currency));
        pricing.fixed(false);
        expect(pricing.vitaminPurchased).toBe(true);
    });

    it('does not mark rewards, failed purchases, other items or official purchases', () => {
        const item = mockItemList.Protein;
        item.buy(1);
        pricing.fixed(true);
        item.gain(1);
        savedItem().buy(1);
        balances[item.currency] = 0;
        item.buy(1);
        item.buy(0.5);
        expect(pricing.vitaminPurchased).toBe(false);
    });

    it('blocks the refund before confirmation even after returning to official prices', async () => {
        pricing.vitaminPurchased = true;
        const code = refundCode();
        await code.redeem();
        expect(Notifier.confirm).not.toHaveBeenCalled();
        expect(loseItem).not.toHaveBeenCalled();
        expect(addAmount).not.toHaveBeenCalled();
        expect(code.isRedeemed).toBe(false);
    });

    it('rechecks after confirmation if a fixed-price vitamin was purchased while waiting', async () => {
        let confirm: (value: boolean) => void;
        vi.mocked(Notifier.confirm).mockImplementation(() => new Promise((resolve) => { confirm = resolve; }));
        const code = refundCode();
        const result = code.redeem();
        expect(Notifier.confirm).toHaveBeenCalledOnce();
        pricing.fixed(true);
        mockItemList.Protein.buy(1);
        pricing.fixed(false);
        confirm(true);
        await result;
        expect(loseItem).not.toHaveBeenCalled();
        expect(addAmount).not.toHaveBeenCalled();
        expect(code.isRedeemed).toBe(false);
    });

    it('preserves the original refund and each currency when no discounted vitamins were bought', async () => {
        pricing.fixed(true);
        const code = refundCode();
        await code.redeem();
        expect(Notifier.confirm).toHaveBeenCalledOnce();
        expect(loseItem).toHaveBeenCalledTimes(3);
        for (const item of Object.values(mockItemList)) {
            expect(loseItem).toHaveBeenCalledWith(item.name, 1);
            expect(addAmount).toHaveBeenCalledWith(new Amount(10000, item.currency), true);
        }
        expect(code.isRedeemed).toBe(true);
        expect(pricing.vitaminPurchased).toBe(false);
    });

    it('leaves inventory, money and code use intact when the user cancels', async () => {
        vi.mocked(Notifier.confirm).mockResolvedValue(false);
        const code = refundCode();
        await code.redeem();
        expect(loseItem).not.toHaveBeenCalled();
        expect(addAmount).not.toHaveBeenCalled();
        expect(code.isRedeemed).toBe(false);
    });
});
