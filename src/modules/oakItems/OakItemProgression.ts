import OakItemType from '../enums/OakItemType';
import Amount from '../wallet/Amount';
import type OakItem from './OakItem';

export const OAK_ITEM_BASE_MAX_LEVEL = 5;

// Explicit values keep upgrades readable and avoid floating-point accumulation.
const extendedBonuses: Record<OakItemType, readonly number[]> = {
    [OakItemType.Magic_Ball]: [11, 12.5, 14, 16, 18],
    [OakItemType.Amulet_Coin]: [1.6, 1.7, 1.8, 1.9, 2, 2.15, 2.3, 2.45, 2.6, 2.75],
    [OakItemType.Rocky_Helmet]: [1.6, 1.7, 1.8, 1.9, 2, 2.15, 2.3, 2.45, 2.6, 2.75,
        2.95, 3.15, 3.35, 3.55, 3.75, 4, 4.25, 4.5, 4.75, 5, 5.3, 5.6, 5.9, 6.2, 6.5],
    [OakItemType.Exp_Share]: [1.35, 1.4, 1.45, 1.5, 1.55, 1.65, 1.75, 1.85, 1.95, 2.05],
    [OakItemType.Sprayduck]: [1.6, 1.7, 1.8, 1.9, 2, 2.15, 2.3, 2.45, 2.6, 2.75],
    [OakItemType.Shiny_Charm]: [2.15, 2.3, 2.45, 2.6, 2.75, 3, 3.25, 3.5, 3.75, 4],
    [OakItemType.Magma_Stone]: [2.15, 2.3, 2.45, 2.6, 2.75, 3, 3.25, 3.5, 3.75, 4],
    [OakItemType.Cell_Battery]: [2.15, 2.3, 2.45, 2.6, 2.75, 3, 3.25, 3.5, 3.75, 4],
    [OakItemType.Squirtbottle]: [2.8, 3.15, 3.55, 4, 4.5],
    [OakItemType.Sprinklotad]: [2.2, 2.4, 2.6, 2.8, 3, 3.3, 3.6, 3.9, 4.2, 4.5],
    [OakItemType.Explosive_Charge]: [12, 14, 17, 20, 24],
    [OakItemType.Treasure_Scanner]: [28, 32, 37, 43, 50],
};

// Each entry scales the experience earned from level 4 to 5, not total XP.
const experienceSteps: Record<number, readonly number[]> = {
    10: [20, 45, 80, 125, 180],
    15: [4, 7, 11, 17, 26, 38, 54, 73, 97, 125],
    30: [4, 7, 11, 17, 26, 38, 54, 73, 97, 125,
        150, 180, 210, 240, 270, 300, 340, 380, 420, 460, 490, 550, 610, 670, 730],
};

// Applied once during initialization, before loading any saved level or XP.
export default function extendOakItemProgression(item: OakItem): void {
    const bonuses = extendedBonuses[item.name as OakItemType];
    const maxLevel = OAK_ITEM_BASE_MAX_LEVEL + bonuses.length;
    // Captures are much less frequent than clicks; use a dedicated Magic Ball curve.
    const steps = item.name === OakItemType.Magic_Ball ? [1, 2, 3.5, 5.5, 8] : experienceSteps[maxLevel];
    if (item.maxLevel !== OAK_ITEM_BASE_MAX_LEVEL
        || item.bonusList.length !== OAK_ITEM_BASE_MAX_LEVEL + 1
        || item.expList.length !== OAK_ITEM_BASE_MAX_LEVEL
        || item.costList.length !== OAK_ITEM_BASE_MAX_LEVEL) {
        throw new Error(`Unexpected base progression for Oak Item ${item.displayName}`);
    }
    const baseExperience = item.expList[4] - item.expList[3];
    const baseCost = item.costList[4];
    let totalExperience = item.expList[4];
    item.expList = [...item.expList, ...steps.map((step) => {
        totalExperience += baseExperience * step;
        return totalExperience;
    })];
    item.costList = [...item.costList, ...steps.map(() => new Amount(baseCost.amount, baseCost.currency))];
    item.bonusList = [...item.bonusList, ...bonuses];
    item.maxLevel = maxLevel;
}
