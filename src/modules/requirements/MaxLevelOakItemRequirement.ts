import * as GameConstants from '../GameConstants';
import AchievementRequirement from './AchievementRequirement';
import { OAK_ITEM_BASE_MAX_LEVEL } from '../oakItems/OakItemProgression';

export default class MaxLevelOakItemRequirement extends AchievementRequirement {
    constructor(value: number, option: GameConstants.AchievementOption = GameConstants.AchievementOption.more) {
        super(value, option, GameConstants.AchievementType['Max Level Oak Item']);
    }

    public getProgress() {
        // Preserve the original achievement milestone when extending Oak Item levels.
        const count = App.game.oakItems.itemList.filter((item) => item.level >= OAK_ITEM_BASE_MAX_LEVEL).length;
        return Math.min(count, this.requiredValue);
    }

    public hint(): string {
        return `${this.requiredValue} Oak Items leveled to level ${OAK_ITEM_BASE_MAX_LEVEL} or higher.`;
    }
}
