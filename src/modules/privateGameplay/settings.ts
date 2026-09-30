import Settings from '../settings/Settings';
import Setting from '../settings/Setting';
import SettingOption from '../settings/SettingOption';
import Notifier from '../notifications/Notifier';

// The legacy script is loaded after modules and exposes a global lexical binding.
declare const DungeonGuides: { hired: () => unknown };

const names = {
    pricing: 'ggzz.private.pricingMode',
    vitamins: 'ggzz.private.fixedVitaminPurchased',
    pathfinding: 'ggzz.private.guidePathfinding',
    guideFee: 'ggzz.private.guideFeeRate',
    // Retain the released save key so existing enabled/disabled preferences survive.
    autoFillHatcheryQueue: 'ggzz.private.autoFillEggSlots',
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

    static autoFillHatcheryQueue(): boolean {
        return Settings.getSetting(names.autoFillHatcheryQueue)?.observableValue() === true;
    }

    static optimizedPathfinding(): boolean {
        return Settings.getSetting(names.pathfinding)?.observableValue() === 'optimized';
    }

    static guideFeeRate(): number {
        return Settings.getSetting(names.guideFee)?.observableValue() === 1 ? 1 : 0.01;
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
