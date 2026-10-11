import Settings from '../settings/Settings';
import Setting from '../settings/Setting';
import SettingOption from '../settings/SettingOption';
import Notifier from '../notifications/Notifier';

// The legacy script is loaded after modules and exposes a global lexical binding.
declare const DungeonGuides: { hired: () => unknown };

export const dungeonChestTiers = ['common', 'rare', 'epic', 'legendary', 'mythic'] as const;
export type DungeonChestTier = typeof dungeonChestTiers[number];

const names = {
    pricing: 'ggzz.private.pricingMode',
    vitamins: 'ggzz.private.fixedVitaminPurchased',
    pathfinding: 'ggzz.private.guidePathfinding',
    drakeChestPriority: 'ggzz.private.drakeChestPriority',
    guideFee: 'ggzz.private.guideFeeRate',
    // Retain the released save key so existing enabled/disabled preferences survive.
    autoFillHatcheryQueue: 'ggzz.private.autoFillEggSlots',
    hatcherySlotLimit: 'ggzz.private.hatcherySlotLimit',
    autoClickAttack: 'ggzz.private.autoClickAttack',
    autoClickRate: 'ggzz.private.autoClickRate',
    autoMine: 'ggzz.private.autoMine',
};

function guideIsHired(): boolean {
    return typeof DungeonGuides !== 'undefined' && !!DungeonGuides.hired();
}

class PrivateSetting<T> extends Setting<T> {
    set(value: T): void {
        let next = value;
        if (!this.validValue(value)) {
            console.warn(`Invalid private setting: ${this.name}; using a safe value.`);
            next = this.name === names.vitamins ? true as T : this.defaultValue;
        }
        // Loading global defaults must not erase a purchase made in this save.
        // A real save load explicitly calls resetForLoad before applying its JSON.
        if (this.name === names.vitamins && this.value === true && next === false) {
            return;
        }
        if (this.name === names.guideFee && next !== this.value && guideIsHired()) {
            Notifier.notify({ message: '助手正在执行已付费任务，费用比例请在任务结束或解雇后调整。' });
            this._observable.valueHasMutated();
            return;
        }
        super.set(next);
    }

    resetForLoad(): void {
        this._observable(this.defaultValue);
    }
}

export default class PrivateGameplay {
    static registerSettings(): void {
        Settings.add(new PrivateSetting(names.autoMine, '矿场自动点击', [
            new SettingOption('关闭', false),
            new SettingOption('开启', true),
        ], true, undefined, false));
        Settings.add(new PrivateSetting(names.autoClickAttack, '自动点击攻击', [
            new SettingOption('关闭', false),
            new SettingOption('开启', true),
        ], true, undefined, false));
        Settings.add(new PrivateSetting(names.autoClickRate, '自动点击频率',
            [1, 5, 10, 20].map(value => new SettingOption(`${value} 次/秒${value === 20 ? '（最大）' : ''}`, value)), 20, undefined, false));
        Settings.add(new PrivateSetting(names.hatcherySlotLimit, '同时孵化槽位上限',
            [4, 8, 12, 16].map(value => new SettingOption(`${value} 个`, value)), 8, undefined, false));
        Settings.add(new PrivateSetting(names.autoFillHatcheryQueue, '自动补满孵化队列', [
            new SettingOption('关闭', false),
            new SettingOption('开启', true),
        ], false, undefined, false));
        Settings.add(new PrivateSetting(names.pricing, '道具价格', [
            new SettingOption('官方动态价格', 'official'),
            new SettingOption('固定基础价（购买不涨价）', 'base-price'),
        ], 'official', undefined, false));
        Settings.add(new PrivateSetting(names.pathfinding, '地牢助手寻路', [
            new SettingOption('官方寻路', 'official'),
            new SettingOption('优化寻路', 'optimized'),
        ], 'official', undefined, false));
        Settings.add(new PrivateSetting<DungeonChestTier | 'off'>(names.drakeChestPriority, 'Drake 宝箱优先', [
            new SettingOption('关闭（优先通关）', 'off'),
            new SettingOption('普通及以上（common）', 'common'),
            new SettingOption('稀有及以上（rare）', 'rare'),
            new SettingOption('史诗及以上（epic）', 'epic'),
            new SettingOption('传说及以上（legendary）', 'legendary'),
            new SettingOption('神话（mythic）', 'mythic'),
        ], 'off', undefined, false));
        Settings.add(new PrivateSetting(names.guideFee, '地牢助手服务费', [
            new SettingOption('原价的 1%（门票原价）', 0.01),
            new SettingOption('官方原价', 1),
        ], 0.01, undefined, false));
        Settings.add(new PrivateSetting(names.vitamins, '固定价维生素购买记录', [
            new SettingOption('未购买', false),
            new SettingOption('已购买', true),
        ], false, undefined, false));
    }

    static fixedItemPrices(): boolean {
        return Settings.getSetting(names.pricing)?.observableValue() === 'base-price';
    }

    static autoClickEnabled(): boolean {
        return Settings.getSetting(names.autoClickAttack)?.observableValue() === true;
    }

    static autoClickRate(): number {
        return Settings.getSetting(names.autoClickRate)?.observableValue() ?? 20;
    }

    static toggleAutoClick(): void {
        Settings.getSetting(names.autoClickAttack)?.set(!this.autoClickEnabled());
    }

    static autoMineEnabled(): boolean {
        return Settings.getSetting(names.autoMine)?.observableValue() === true;
    }

    static toggleAutoMine(): void {
        Settings.getSetting(names.autoMine)?.set(!this.autoMineEnabled());
    }

    static autoFillHatcheryQueue(): boolean {
        return Settings.getSetting(names.autoFillHatcheryQueue)?.observableValue() === true;
    }

    static hatcherySlotLimit(): number {
        return Settings.getSetting(names.hatcherySlotLimit)?.observableValue() ?? 8;
    }

    static optimizedPathfinding(): boolean {
        return Settings.getSetting(names.pathfinding)?.observableValue() === 'optimized';
    }

    static guideFeeRate(): number {
        return Settings.getSetting(names.guideFee)?.observableValue() === 1 ? 1 : 0.01;
    }

    static drakeChestPriority(): DungeonChestTier | undefined {
        const value = Settings.getSetting(names.drakeChestPriority)?.observableValue();
        return dungeonChestTiers.find(tier => tier === value);
    }

    static guideIsHired(): boolean {
        return guideIsHired();
    }

    static fixedVitaminsPurchased(): boolean {
        return Settings.getSetting(names.vitamins)?.observableValue() === true;
    }

    static markFixedVitaminPurchase(): void {
        Settings.getSetting(names.vitamins)?.set(true);
    }

    static resetSettingsForLoad(): void {
        Object.values(names).forEach((name) => {
            (Settings.getSetting(name) as PrivateSetting<unknown>)?.resetForLoad();
        });
    }
}
