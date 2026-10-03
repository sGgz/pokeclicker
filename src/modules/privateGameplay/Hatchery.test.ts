import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/scripts/breeding/BreedingController.ts', 'utf8');
const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
const breedingSource = readFileSync('src/scripts/breeding/Breeding.ts', 'utf8');
const breedingCompiled = transpileModule(breedingSource, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
const helperSource = readFileSync('src/scripts/breeding/HatcheryHelper.ts', 'utf8');
const helperCompiled = transpileModule(helperSource.slice(helperSource.indexOf('class HatcheryHelpers {'), helperSource.indexOf('// Note: Mostly')), {
    compilerOptions: { target: ScriptTarget.ES2020 },
}).outputText;

function setupSlots() {
    class TestEgg {
        type = -1;
        id = 0;
        steps = 0;
        isNone() { return this.type === -1; }
        partyPokemon() { return null; }
        addSteps(amount: number) { if (!this.isNone()) this.steps += amount; }
        canHatch() { return !this.isNone() && this.steps >= 100; }
        hatch() { return this.canHatch(); }
        toJSON() { return { type: this.type, id: this.id, steps: this.steps }; }
        fromJSON(json: { type: number; id: number; steps: number }) { Object.assign(this, json); }
    }
    const limit = ko.observable(8);
    const hired = ko.observableArray([]);
    const wallet = { loseAmount: vi.fn((cost: { amount: number; currency: number }) => cost.amount >= 0) };
    const app = { game: { breeding: null, wallet } };
    const BreedingClass = runInNewContext(`${breedingCompiled}\nBreeding;`, {
        ko, Egg: TestEgg, EggType: { None: -1, Pokemon: 0, EggItem: 1 },
        HatcheryHelpers: class {
            hired = hired;
            addSteps = vi.fn();
            fromJSON = vi.fn();
            toJSON = () => [];
        },
        PrivateGameplay: { hatcherySlotLimit: limit },
        Settings: { getSetting: () => ({ observableValue: ko.observable(-1) }) },
        GameConstants: { EggItemType: {}, Currency: { questPoint: 0 } },
        Amount: class { constructor(public amount: number, public currency: number) {} },
        App: app,
        Notifier: { notify: vi.fn() },
        NotificationConstants: { NotificationOption: { success: 0 }, NotificationSound: { Hatchery: {} }, NotificationSetting: { Hatchery: {} } },
    });
    const breeding = new BreedingClass({ getBonus: () => 1 });
    app.game.breeding = breeding;
    breeding.createEgg = (id: number) => Object.assign(new TestEgg(), { type: 0, id });
    const add = (id: number, steps = 0) => breeding.gainEgg(Object.assign(breeding.createEgg(id), { steps }));
    const eggs = () => breeding.eggList.map(egg => egg()).filter(egg => !egg.isNone());
    const HelperClass = runInNewContext(`${helperCompiled}\nHatcheryHelpers;`, {
        Egg: TestEgg,
        GameHelper: { incrementObservable: (observable, amount) => observable(observable() + amount) },
    });
    breeding.hatcheryHelpers.hatchery = breeding;
    const tickHelpers = () => HelperClass.prototype.addSteps.call(breeding.hatcheryHelpers, 1, {});
    return { breeding, limit, hired, wallet, add, eggs, tickHelpers };
}

describe('configurable incubation slots', () => {
    it('restores a four-slot save with exact egg progress and retains the purchased slot count', () => {
        const { breeding, eggs } = setupSlots();
        breeding.fromJSON({ eggSlots: 4, eggList: [{ type: 0, id: 25, steps: 73 }], queueList: [1, 4], queueSlots: 4 });
        expect(breeding.eggList).toHaveLength(16);
        expect(breeding.eggSlots).toBe(4);
        expect(eggs().map(egg => egg.toJSON())).toEqual([{ type: 0, id: 25, steps: 73 }]);
        expect(breeding.toJSON().queueList).toEqual([1, 4]);
    });

    it('purchases only up to the configured cap and never charges for slots already purchased', () => {
        const { breeding, limit, wallet } = setupSlots();
        breeding.eggSlots = 4;
        for (let slot = 5; slot <= 8; slot++) breeding.buyEggSlot();
        expect(wallet.loseAmount.mock.calls.map(([cost]) => cost.amount)).toEqual([2500, 3000, 3500, 4000]);
        breeding.buyEggSlot();
        expect(wallet.loseAmount).toHaveBeenCalledTimes(4);
        limit(4);
        expect(breeding.eggSlots).toBe(8);
        expect(breeding.usableEggSlots).toBe(4);
        breeding.buyEggSlot();
        limit(16);
        expect(breeding.usableEggSlots).toBe(8);
        expect(breeding.nextEggSlotCost().amount).toBe(4500);
        expect(wallet.loseAmount).toHaveBeenCalledTimes(4);
    });

    it('lets overflow eggs progress and finish without consuming queued eggs until capacity is available', () => {
        const { breeding, limit, add, eggs } = setupSlots();
        breeding.eggSlots = 8;
        for (let id = 1; id <= 8; id++) expect(add(id, 80)).toBe(true);
        limit(4);
        breeding.progressEggs(10);
        expect(eggs()).toHaveLength(8);
        expect(eggs().every(egg => egg.steps === 90)).toBe(true);
        breeding._queueList([[0, 99], [0, 100]]);
        breeding.nextEggFromQueue();
        expect(breeding.queueList()).toHaveLength(2);
        expect(add(55)).toBe(false);
        for (let index = 7; index >= 4; index--) {
            breeding.eggList[index]().steps = 100;
            breeding.hatchPokemonEgg(index);
        }
        expect(eggs()).toHaveLength(4);
        expect(breeding.queueList()).toHaveLength(2);
        breeding.eggList[3]().steps = 100;
        breeding.hatchPokemonEgg(3);
        expect(eggs().map(egg => egg.id)).toEqual([1, 2, 3, 99]);
        expect(breeding.queueList()).toEqual([[0, 100]]);
    });

    it('preserves all sixteen eggs and progress across a save round trip while limited to four', () => {
        const first = setupSlots();
        first.limit(16);
        first.breeding.eggSlots = 16;
        for (let id = 1; id <= 16; id++) first.add(id, id * 3);
        const saved = JSON.parse(JSON.stringify(first.breeding.toJSON()));
        const second = setupSlots();
        second.limit(4);
        second.breeding.fromJSON(saved);
        expect(second.breeding.toJSON()).toEqual(saved);
        expect(second.eggs()).toHaveLength(16);
        expect(second.breeding.hasFreeEggSlot()).toBe(false);
    });

    it('reserves helper slots and stops automatic queue filling at the usable capacity', () => {
        const { breeding, limit, hired, eggs } = setupSlots();
        limit(4);
        breeding.eggSlots = 8;
        hired.push({} as never);
        breeding._queueList(Array.from({ length: 8 }, (_, i) => [0, i + 1]));
        breeding.progressEggs(1);
        expect(eggs()).toHaveLength(3);
        expect(breeding.eggList[0]().isNone()).toBe(true);
        expect(breeding.queueList()).toHaveLength(5);
    });

    it('pauses helper refills during overflow and charges only for successfully placed eggs', () => {
        const { breeding, limit, hired, add, eggs, tickHelpers } = setupSlots();
        breeding.eggSlots = 8;
        for (let id = 1; id <= 8; id++) add(id);
        const helper = {
            stepEfficiency: () => 100, attackEfficiency: () => 100,
            getNextPokemon: vi.fn(() => [{ id: 99 }]), charge: vi.fn(), hatched: ko.observable(0),
        };
        hired.push(helper as never);
        breeding.gainPokemonEgg = vi.fn((pokemon, index) => breeding.gainEgg(breeding.createEgg(pokemon.id), index));
        limit(4);
        breeding.eggList[0]().steps = 100;
        tickHelpers();
        expect(eggs()).toHaveLength(7);
        expect(breeding.gainEgg(breeding.createEgg(55), 0)).toBe(false);
        expect(helper.getNextPokemon).not.toHaveBeenCalled();
        expect(helper.charge).not.toHaveBeenCalled();
        for (let index = 7; index >= 4; index--) {
            breeding.eggList[index]().steps = 100;
            breeding.hatchPokemonEgg(index, false);
        }
        tickHelpers();
        expect(eggs()).toHaveLength(4);
        expect(breeding.eggList[0]().id).toBe(99);
        expect(helper.charge).toHaveBeenCalledTimes(1);
        expect(helper.hatched()).toBe(1);
        breeding.eggList[0]().steps = 100;
        breeding.gainPokemonEgg.mockImplementationOnce(() => false);
        tickHelpers();
        expect(helper.charge).toHaveBeenCalledTimes(1);
        expect(helper.hatched()).toBe(1);
    });
});

function setup() {
    const state = { enabled: false, capacity: 2, accessible: true, categories: false, descending: false, debuff: true, queue: [] as number[] };
    const makePokemon = (id: number, attack: number, match = true, hatchable = true) => ({
        id, attack, match, hatchable,
        matchesHatcheryFilters() { return this.match; },
        isHatchable() { return this.hatchable; },
    });
    const party = [makePokemon(1, 30), makePokemon(2, 5, false), makePokemon(3, 10), makePokemon(4, 1, true, false), makePokemon(5, 20)];
    const added: number[] = [];
    const compareBy = vi.fn((_sort: string, descending: boolean) =>
        (a: typeof party[number], b: typeof party[number]) => (a.attack - b.attack) * (descending ? -1 : 1));
    const breeding = {
        canAccess: () => state.accessible,
        hasFreeQueueSlot: () => state.queue.length < state.capacity,
        queueList: () => state.queue,
        addPokemonToQueue: vi.fn((pokemon: typeof party[number]) => {
            expect(state.queue.length).toBeLessThan(state.capacity);
            state.queue.push(pokemon.id);
            pokemon.hatchable = false;
            added.push(pokemon.id);
            return true;
        }),
        checkCloseModal: vi.fn(),
    };
    const settings = {
        hatcherySort: { observableValue: () => 'attack' },
        hatcherySortDirection: { observableValue: () => state.descending },
        breedingRegionalAttackDebuffSetting: { observableValue: () => 2 },
    };
    const controller = runInNewContext(`${compiled}\nBreedingController;`, {
        ko,
        GameConstants: { SECOND: 1000 },
        DisplayObservables: { modalState: { breedingModal: 'hidden' } },
        PokemonCategories: { categoryAssignEnabled: () => state.categories },
        PrivateGameplay: { autoFillHatcheryQueue: () => state.enabled },
        Settings: { getSetting: (key: keyof typeof settings) => settings[key] },
        PartyController: { compareBy },
        App: { game: { breeding, party: { caughtPokemon: party }, challenges: { list: { regionalAttackDebuff: { active: () => state.debuff } } } } },
    }) as { fillHatcheryQueue: () => void; tickAutoFill: (delta: number) => void };
    return { state, party, added, breeding, controller, compareBy };
}

describe('hatchery queue filling', () => {
    it('uses the real queue insertion path with capacity settings and duplicate protection', () => {
        const limit = ko.observable(2);
        const BreedingClass = runInNewContext(`${breedingCompiled}\nBreeding;`, {
            EggType: { Pokemon: 0 },
            Settings: { getSetting: () => ({ observableValue: limit }) },
        });
        const breeding = Object.assign(Object.create(BreedingClass.prototype), {
            _queueList: ko.observableArray([[0, 99]]),
            queueSlots: ko.observable(4),
            usableQueueSlots: ko.pureComputed(() => limit() < 0 ? 4 : Math.min(limit(), 4)),
            gainPokemonEgg: vi.fn(() => { throw new Error('Queue filling must not insert directly into egg slots'); }),
        });
        const pokemon = (id: number, level = 100) => ({
            id, level, breeding: false,
            isHatchable() { return this.level >= 100 && !this.breeding; },
        });
        const first = pokemon(1);
        expect(breeding.addPokemonToQueue(pokemon(2, 99))).toBe(false);
        expect(breeding.addPokemonToQueue(first)).toBe(true);
        expect(first.breeding).toBe(true);
        expect(breeding.addPokemonToQueue(first)).toBe(false);
        expect(breeding.addPokemonToQueue(pokemon(3))).toBe(false);
        expect(breeding._queueList()).toEqual([[0, 99], [0, 1]]);
        limit(0);
        expect(breeding.hasFreeQueueSlot()).toBeFalsy();
        expect(breeding.addPokemonToQueue(pokemon(3))).toBe(false);
        limit(-1);
        expect(breeding.addPokemonToQueue(pokemon(3))).toBe(true);
        expect(breeding.addPokemonToQueue(pokemon(4))).toBe(true);
        expect(breeding.addPokemonToQueue(pokemon(5))).toBe(false);
        expect(breeding.gainPokemonEgg).not.toHaveBeenCalled();
    });

    it('fills queue capacity with eligible filtered Pokemon in current sort order', () => {
        const s = setup();
        s.controller.fillHatcheryQueue();
        expect(s.added).toEqual([3, 5]);
        expect(s.party.map(p => p.id)).toEqual([1, 2, 3, 4, 5]);
        expect(s.compareBy).toHaveBeenCalledWith('attack', false, 2);
        s.controller.fillHatcheryQueue();
        expect(s.added).toEqual([3, 5]);
        expect(s.breeding.checkCloseModal).toHaveBeenCalledTimes(1);
    });

    it('reads changed filters and sorting without needing an open modal or refreshed view', () => {
        const s = setup();
        s.state.enabled = true;
        s.state.descending = true;
        s.state.debuff = false;
        s.party[0].match = false;
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([5, 3]);
        expect(s.compareBy).toHaveBeenCalledWith('attack', true, -1);
        expect(s.breeding.checkCloseModal).not.toHaveBeenCalled();
    });

    it('is opt-in, checks once a second and resets its timer when disabled', () => {
        const s = setup();
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([]);
        s.state.enabled = true;
        s.controller.tickAutoFill(900);
        expect(s.compareBy).not.toHaveBeenCalled();
        s.state.enabled = false;
        s.controller.tickAutoFill(100);
        s.state.enabled = true;
        s.controller.tickAutoFill(100);
        expect(s.added).toEqual([]);
        s.controller.tickAutoFill(900);
        expect(s.added).toEqual([3, 5]);
    });

    it('appends to a partial queue without reordering it and tops it up after consumption', () => {
        const s = setup();
        s.state.enabled = true;
        s.state.queue = [99];
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([3]);
        expect(s.state.queue).toEqual([99, 3]);
        s.state.queue.shift();
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([3, 5]);
        expect(s.state.queue).toEqual([3, 5]);
    });

    it.each(['inaccessible', 'categories', 'full', 'disabled', 'no matches'])('does nothing when %s', (reason) => {
        const s = setup();
        s.state.enabled = true;
        if (reason === 'inaccessible') s.state.accessible = false;
        if (reason === 'categories') s.state.categories = true;
        if (reason === 'full') s.state.queue = [98, 99];
        if (reason === 'disabled') s.state.capacity = 0;
        if (reason === 'no matches') s.party.forEach(p => { p.match = false; });
        s.controller.fillHatcheryQueue();
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([]);
        expect(s.breeding.checkCloseModal).not.toHaveBeenCalled();
    });

    it('retries when queue capacity increases or an eligible Pokemon becomes available', () => {
        const s = setup();
        s.state.enabled = true;
        s.state.capacity = 1;
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([3]);
        s.state.capacity = 2;
        s.party[1].match = true;
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([3, 2]);
    });

    it('stops when candidates run out, then continues after a filter change', () => {
        const s = setup();
        s.state.enabled = true;
        s.state.capacity = 10;
        s.controller.tickAutoFill(1000);
        expect(s.state.queue).toEqual([3, 5, 1]);
        s.party[1].match = true;
        s.controller.tickAutoFill(1000);
        expect(s.state.queue).toEqual([3, 5, 1, 2]);
    });
});
