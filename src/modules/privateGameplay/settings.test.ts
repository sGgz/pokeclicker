import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as knockout from 'knockout';
import Settings from '../settings/Settings';
import Setting from '../settings/Setting';
import Notifier from '../notifications/Notifier';
import PrivateGameplay from './settings';

vi.mock('../notifications/Notifier', () => ({ default: { notify: vi.fn() } }));

const prefix = 'ggzz.private.';
const previousSettings = Settings.list;

beforeEach(() => {
    Settings.list = [];
    PrivateGameplay.registerSettings();
});

afterEach(() => {
    Settings.list = previousSettings;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

describe('private gameplay save settings', () => {
    it('preserves official gameplay defaults and uses the requested 1% guide fee', () => {
        expect(PrivateGameplay.fixedItemPrices()).toBe(false);
        expect(PrivateGameplay.optimizedPathfinding()).toBe(false);
        expect(PrivateGameplay.guideFeeRate()).toBe(0.01);
        expect(PrivateGameplay.fixedVitaminsPurchased()).toBe(false);
        PrivateGameplay.registerSettings();
        expect(Settings.list).toHaveLength(4);
    });

    it('reacts immediately to price mode changes and preserves settings through JSON round trips', () => {
        const quoteMode = knockout.pureComputed(() => PrivateGameplay.fixedItemPrices());
        const changes = vi.fn();
        const subscription = quoteMode.subscribe(changes);
        Settings.setSettingByName(`${prefix}pricingMode`, 'base-price');
        Settings.setSettingByName(`${prefix}guidePathfinding`, 'optimized');
        Settings.setSettingByName(`${prefix}guideFeeRate`, 1);
        PrivateGameplay.markFixedVitaminPurchase();
        expect(quoteMode()).toBe(true);
        expect(changes).toHaveBeenCalledWith(true);
        const saved = JSON.parse(JSON.stringify(Settings.toJSON()));
        PrivateGameplay.resetSettingsForLoad();
        Settings.fromJSON(saved);
        expect(PrivateGameplay.fixedItemPrices()).toBe(true);
        expect(PrivateGameplay.optimizedPathfinding()).toBe(true);
        expect(PrivateGameplay.guideFeeRate()).toBe(1);
        expect(PrivateGameplay.fixedVitaminsPurchased()).toBe(true);
        subscription.dispose();
        quoteMode.dispose();
    });

    it('does not inherit settings or purchase history when loading an old slot without these keys', () => {
        const original = new Setting('other.setting', 'Other', [], 'kept');
        Settings.add(original);
        Settings.setSettingByName(`${prefix}pricingMode`, 'base-price');
        Settings.setSettingByName(`${prefix}guidePathfinding`, 'optimized');
        Settings.setSettingByName(`${prefix}guideFeeRate`, 1);
        PrivateGameplay.markFixedVitaminPurchase();
        PrivateGameplay.resetSettingsForLoad();
        Settings.fromJSON({});
        expect(PrivateGameplay.fixedItemPrices()).toBe(false);
        expect(PrivateGameplay.optimizedPathfinding()).toBe(false);
        expect(PrivateGameplay.guideFeeRate()).toBe(0.01);
        expect(PrivateGameplay.fixedVitaminsPurchased()).toBe(false);
        expect(original.value).toBe('kept');
    });

    it('excludes all private preferences from global defaults', () => {
        PrivateGameplay.markFixedVitaminPurchase();
        expect(Object.keys(Settings.toJSON(true))).toEqual([]);
        expect(Object.keys(Settings.toJSON())).toHaveLength(4);
    });

    it('retains vitamin purchase history when loading global defaults, but resets it for a different save', () => {
        PrivateGameplay.markFixedVitaminPurchase();
        Settings.saveDefault();
        Settings.loadDefault();
        expect(PrivateGameplay.fixedVitaminsPurchased()).toBe(true);
        PrivateGameplay.resetSettingsForLoad();
        Settings.fromJSON({});
        expect(PrivateGameplay.fixedVitaminsPurchased()).toBe(false);
        localStorage.removeItem('settings');
    });

    it('rejects malformed imported values without coercing strings or throwing on null', () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
        Settings.fromJSON({
            [`${prefix}pricingMode`]: null,
            [`${prefix}guidePathfinding`]: { mode: 'optimized' },
            [`${prefix}guideFeeRate`]: '0.01',
            [`${prefix}fixedVitaminPurchased`]: 'false',
        });
        expect(PrivateGameplay.fixedItemPrices()).toBe(false);
        expect(PrivateGameplay.optimizedPathfinding()).toBe(false);
        expect(PrivateGameplay.guideFeeRate()).toBe(0.01);
        expect(PrivateGameplay.fixedVitaminsPurchased()).toBe(true);
        warning.mockRestore();
    });

    it('locks fee writes during an active prepaid batch even when bypassing the UI', () => {
        const hired = knockout.observable<unknown>({ name: 'Drake' });
        vi.stubGlobal('DungeonGuides', { hired });
        const fee = Settings.getSetting(`${prefix}guideFeeRate`);
        fee.observableValue(1);
        Settings.setSettingByName(`${prefix}guideFeeRate`, 1);
        expect(PrivateGameplay.guideIsHired()).toBe(true);
        expect(PrivateGameplay.guideFeeRate()).toBe(0.01);
        expect(Notifier.notify).toHaveBeenCalled();
        hired(null);
        fee.observableValue(1);
        expect(PrivateGameplay.guideFeeRate()).toBe(1);
    });
});
