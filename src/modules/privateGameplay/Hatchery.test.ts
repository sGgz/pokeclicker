import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync('src/scripts/breeding/BreedingController.ts', 'utf8');
const compiled = transpileModule(source, { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;

function setup() {
    const state = { enabled: false, slots: 2, accessible: true, categories: false, descending: false, debuff: true, queue: [] as number[] };
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
        hasFreeEggSlot: () => state.slots > 0,
        queueList: () => state.queue,
        addPokemonToHatchery: vi.fn((pokemon: typeof party[number]) => {
            expect(state.slots).toBeGreaterThan(0);
            state.slots--;
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
        PrivateGameplay: { autoFillEggSlots: () => state.enabled },
        Settings: { getSetting: (key: keyof typeof settings) => settings[key] },
        PartyController: { compareBy },
        App: { game: { breeding, party: { caughtPokemon: party }, challenges: { list: { regionalAttackDebuff: { active: () => state.debuff } } } } },
    }) as { fillEmptyEggSlots: () => void; tickAutoFill: (delta: number) => void };
    return { state, party, added, breeding, controller, compareBy };
}

describe('hatchery slot filling', () => {
    it('fills only free slots with eligible filtered Pokemon in current sort order', () => {
        const s = setup();
        s.controller.fillEmptyEggSlots();
        expect(s.added).toEqual([3, 5]);
        expect(s.party.map(p => p.id)).toEqual([1, 2, 3, 4, 5]);
        expect(s.compareBy).toHaveBeenCalledWith('attack', false, 2);
        s.controller.fillEmptyEggSlots();
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

    it('preserves queue priority and retries when queued work has been consumed', () => {
        const s = setup();
        s.state.enabled = true;
        s.state.queue = [99];
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([]);
        expect(s.state.queue).toEqual([99]);
        s.state.queue = [];
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([3, 5]);
    });

    it.each(['inaccessible', 'categories', 'full', 'no matches'])('does nothing when %s', (reason) => {
        const s = setup();
        s.state.enabled = true;
        if (reason === 'inaccessible') s.state.accessible = false;
        if (reason === 'categories') s.state.categories = true;
        if (reason === 'full') s.state.slots = 0;
        if (reason === 'no matches') s.party.forEach(p => { p.match = false; });
        s.controller.fillEmptyEggSlots();
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([]);
        expect(s.breeding.checkCloseModal).not.toHaveBeenCalled();
    });

    it('retries when a slot opens or an eligible Pokemon becomes available', () => {
        const s = setup();
        s.state.enabled = true;
        s.state.slots = 1;
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([3]);
        s.state.slots = 1;
        s.party[1].match = true;
        s.controller.tickAutoFill(1000);
        expect(s.added).toEqual([3, 2]);
    });
});
