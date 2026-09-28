import { VitaminType } from '../GameConstants';
import PrivateGameplay from './settings';

/** Private pricing rules leave the official item definitions and saved multipliers intact. */
export default class PricingPolicy {
    static isValidQuantity(amount: number): boolean {
        return Number.isSafeInteger(amount) && amount >= 0;
    }

    static fixedPricesEnabled(): boolean {
        return PrivateGameplay.fixedItemPrices();
    }

    static fixedTotal(basePrice: number, amount: number, maxAmount: number): number {
        if (!this.isValidQuantity(amount)) {
            return Infinity;
        }
        if (amount === 0) {
            return 0;
        }
        const total = Math.round(basePrice * Math.min(amount, maxAmount));
        return Number.isFinite(total) && total >= 0 ? total : Infinity;
    }

    static recordPurchase(itemName: string, fixedPrices: boolean): void {
        // Identify vitamins without importing Vitamin, which extends Item itself.
        if (fixedPrices && Object.values(VitaminType).includes(itemName)) {
            PrivateGameplay.markFixedVitaminPurchase();
        }
    }

    static canRefundVitamins(): boolean {
        return !PrivateGameplay.fixedVitaminsPurchased();
    }
}
