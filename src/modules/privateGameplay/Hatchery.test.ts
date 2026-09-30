import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/scripts/breeding/BreedingController.ts', 'utf8');
const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
const breedingSource = readFileSync('src/scripts/breeding/Breeding.ts', 'utf8');
const breedingCompiled = transpileModule(breedingSource, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;

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
