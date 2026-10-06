import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as GameConstants from '../GameConstants';

const compiled = transpileModule([
    'src/scripts/towns/TownContent.ts',
    'src/scripts/towns/DreamOrbController.ts',
    'src/scripts/Game.ts',
].map(file => readFileSync(file, 'utf8')).join('\n'), { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;

function setup() {
    const caught = new Set(['Tornadus', 'Thundurus', 'Landorus']);
    const notify = vi.fn();
    const choose = vi.fn(orbs => orbs[orbs.length - 1]);
    const gainMoney = vi.fn();
    const app = { game: { party: { calculatePokemonAttack: () => 100 }, wallet: { gainMoney }, dreamOrbController: null } };
    const player = { region: 0, route: 1, _lastSeen: Date.now() - 48 * GameConstants.HOUR };
    const classes = runInNewContext(`${compiled}\n({ DreamOrbController, Game });`, {
        ko, GameConstants, Date, player, App: app,
        ItemType: { item: 0 },
        ObtainedPokemonRequirement: class {
            constructor(private name: string) {}
            isCompleted() { return caught.has(this.name); }
        },
        MultiRequirement: class {
            constructor(private requirements: { isCompleted(): boolean }[]) {}
            isCompleted() { return this.requirements.every(r => r.isCompleted()); }
        },
        Rand: { fromArray: choose },
        GameHelper: { incrementObservable: (observable, amount = 1) => observable(observable() + amount) },
        Notifier: { notify },
        NotificationConstants: { NotificationOption: {}, NotificationSetting: { General: {} } },
        MapHelper: { validRoute: () => true },
        RouteHelper: { getAvailablePokemonList: () => ['Pidgey'] },
        PokemonFactory: { routeHealth: () => 100, routeMoney: () => 10 },
        pokemonMap: { Pidgey: { type: [0] } },
        PokemonType: { None: -1 },
    });
    const controller = new classes.DreamOrbController();
    app.game.dreamOrbController = controller;
    const amounts = () => controller.orbs.map(orb => orb.amount());
    const saved = () => JSON.parse(JSON.stringify(controller.toJSON()));
    return { controller, classes, caught, notify, choose, gainMoney, amounts, saved };
}

describe('Dream Orbs from online game time', () => {
    it('awards exactly one orb at each full hour and carries partial progress', () => {
        const h = setup();
        h.controller.tick(GameConstants.HOUR - GameConstants.SECOND);
        expect(h.amounts()).toEqual([0, 0, 0, 0]);
        h.controller.tick(GameConstants.SECOND);
        expect(h.amounts()).toEqual([1, 0, 0, 0]);
        expect(h.controller.onlineTimeMs()).toBe(0);
        h.controller.tick(GameConstants.HOUR + 1234);
        expect(h.amounts()).toEqual([2, 0, 0, 0]);
        expect(h.controller.onlineTimeMs()).toBe(1234);
        expect(h.notify).toHaveBeenCalledTimes(2);
    });

    it('starts accumulating only after all original unlock requirements are met', () => {
        const h = setup();
        h.caught.delete('Landorus');
        h.controller.tick(10 * GameConstants.HOUR);
        expect(h.controller.onlineTimeMs()).toBe(0);
        expect(h.amounts()).toEqual([0, 0, 0, 0]);
        h.caught.add('Landorus');
        h.controller.tick(GameConstants.HOUR);
        expect(h.amounts()).toEqual([1, 0, 0, 0]);
    });

    it('selects from currently unlocked colors, including both blue requirements', () => {
        const h = setup();
        const unlocks = ['Tornadus (Therian)', 'Thundurus (Therian)', 'Landorus (Therian)', 'Enamorus'];
        h.controller.tick(GameConstants.HOUR);
        unlocks.forEach(name => { h.caught.add(name); h.controller.tick(GameConstants.HOUR); });
        expect(h.choose.mock.calls.map(([orbs]) => orbs.map(orb => orb.color))).toEqual([
            ['Pink'], ['Pink', 'Green'], ['Pink', 'Green', 'Orange'],
            ['Pink', 'Green', 'Orange'], ['Pink', 'Green', 'Orange', 'Blue'],
        ]);
        expect(h.amounts()).toEqual([1, 1, 2, 1]);
    });

    it('keeps earned orbs and unfinished time across save/load without double rewards', () => {
        const h = setup();
        h.controller.tick(GameConstants.HOUR + 25 * GameConstants.MINUTE);
        const restored = new h.classes.DreamOrbController();
        restored.fromJSON(h.saved());
        expect(restored.orbs[0].amount()).toBe(1);
        expect(restored.onlineTimeMs()).toBe(25 * GameConstants.MINUTE);
        restored.tick(35 * GameConstants.MINUTE);
        expect(restored.orbs[0].amount()).toBe(2);
        expect(restored.onlineTimeMs()).toBe(0);
        restored.fromJSON(JSON.parse(JSON.stringify(restored.toJSON())));
        restored.tick(GameConstants.SECOND);
        expect(restored.orbs[0].amount()).toBe(2);
    });

    it('loads old orb balances unchanged and starts new progress at zero', () => {
        const h = setup();
        h.controller.tick(1234);
        h.controller.fromJSON({ orbs: [{ color: 'Pink', amount: 42 }, { color: 'Blue', amount: 9 }] });
        expect(h.amounts()).toEqual([42, 0, 0, 9]);
        expect(h.controller.onlineTimeMs()).toBe(0);
        h.controller.tick(GameConstants.HOUR);
        expect(h.amounts()).toEqual([43, 0, 0, 9]);
    });

    it.each([undefined, null, -1, NaN, Infinity, '3600000', GameConstants.HOUR, Number.MAX_VALUE])('discards invalid saved progress %s without granting orbs', progress => {
        const h = setup();
        h.controller.fromJSON({ onlineTimeMs: progress });
        h.controller.tick(GameConstants.SECOND);
        expect(h.controller.onlineTimeMs()).toBe(GameConstants.SECOND);
        expect(h.amounts()).toEqual([0, 0, 0, 0]);
    });

    it('ignores invalid tick deltas and does not impose the old 24-hour offline cap', () => {
        const h = setup();
        [NaN, Infinity, -1, 0].forEach(delta => h.controller.tick(delta));
        expect(h.controller.onlineTimeMs()).toBe(0);
        for (let i = 0; i < 30; i++) h.controller.tick(GameConstants.HOUR);
        expect(h.amounts()).toEqual([30, 0, 0, 0]);
    });

    it('offline settlement still awards money but neither orbs nor online progress', () => {
        const h = setup();
        h.controller.tick(30 * GameConstants.MINUTE);
        const before = h.saved();
        h.classes.Game.prototype.computeOfflineEarnings.call({});
        expect(h.gainMoney).toHaveBeenCalledWith(432000, true);
        expect(h.saved()).toEqual(before);
        expect(h.notify.mock.calls.map(([message]) => message.title)).toEqual(['Offline Bonus']);
    });
});
