import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Settings from '../settings/Settings';
import Setting from '../settings/Setting';
import SettingOption from '../settings/SettingOption';
import SearchSetting from '../settings/SearchSetting';
import MultiSelectSetting from '../settings/MultiSelectSetting';
import BooleanSetting from '../settings/BooleanSetting';
import { SortOptions, SortOptionConfigs } from '../settings/SortOptions';

const settingsSource = readFileSync('src/modules/settings/index.ts', 'utf8');
const source = settingsSource.slice(settingsSource.indexOf('// Party Sorting'), settingsSource.indexOf('// Hatchery Sorting'))
    + settingsSource.slice(settingsSource.indexOf('// Hatchery Filters'), settingsSource.indexOf('// Hatchery display settings'))
    + readFileSync('src/scripts/party/PartyPokemon.ts', 'utf8')
    + readFileSync('src/scripts/party/PartyController.ts', 'utf8');
const compiled = transpileModule(source.replace(/^export /gm, ''), { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
const previous = Settings.list;

afterEach(() => { Settings.list = previous; vi.useRealTimers(); });

function setup() {
    Settings.list = [];
    const party = [
        { id: 1, name: 'Bulbasaur', displayName: 'Bulbasaur', shiny: true, pokerus: 0, region: 0, category: [1], attack: 20, type: [1, -1] },
        { id: 4, name: 'Charmander', displayName: 'Charmander', shiny: false, pokerus: 2, region: 1, category: [2], attack: 40, type: [2, -1] },
    ].map(pokemon => ({ ...pokemon, breeding: false, evs: () => pokemon.id * 10, getEggSteps: () => 100, getBreedingAttackBonus: () => 5 }));
    const map = Object.fromEntries(party.map(pokemon => [pokemon.name, pokemon]));
    const result = runInNewContext(`${compiled}\n({ PartyPokemon, PartyController });`, {
        ko, Settings, Setting, SettingOption, SearchSetting, MultiSelectSetting, BooleanSetting, SortOptions, SortOptionConfigs,
        PokemonCategories: { categories: () => [{ id: 1, name: ko.observable('First') }, { id: 2, name: ko.observable('Second') }] },
        regionOptionsNoneLast: [new SettingOption('Kanto', 0), new SettingOption('Johto', 1)],
        PokemonType: { Grass: 1, Fire: 2, None: -1 }, Pokerus: { Uninfected: 0, Resistant: 2 }, Region: { kalos: 5 },
        MaxRegionRequirement: class { isCompleted() { return true; } },
        PokemonHelper: {
            matchPokemonByNames: (regex: RegExp, name: string) => regex.test(name),
            calcNativeRegion: (name: string) => map[name].region,
            getPokemonById: (id: number) => party.find(pokemon => pokemon.id === id),
            matchesTypeFilter: (types: number[], selected: number[]) => !selected.length || selected.some(type => types.includes(type)),
        },
        pokemonMap: map, pokemonList: party,
        App: { game: { party: { caughtPokemon: party } } },
    });
    const matches = (pokemon, prefix = 'party') => result.PartyPokemon.prototype.matchesListFilters.call(pokemon, prefix);
    party.forEach(pokemon => Object.assign(pokemon, { matchesListFilters: prefix => matches(pokemon, prefix) }));
    return { party, matches, controller: result.PartyController };
}

describe('independent external Pokemon list', () => {
    it('shares filter semantics while keeping hatchery choices independent, including JSON restoration', () => {
        const { party, matches } = setup();
        Settings.setSettingByName('partyRegionFilter', [1]);
        Settings.setSettingByName('partyShinyFilter', 0);
        Settings.setSettingByName('partyCategoryFilter', [2]);
        Settings.setSettingByName('partyType1Filter', [2]);
        Settings.setSettingByName('partyPokerusFilter', 2);
        expect(party.filter(p => matches(p)).map(p => p.id)).toEqual([4]);
        expect(party.filter(p => matches(p, 'breeding')).map(p => p.id)).toEqual([1, 4]);
        const saved = JSON.parse(JSON.stringify(Settings.toJSON()));
        Settings.setSettingByName('partyCategoryFilter', [1]);
        Settings.fromJSON(saved);
        expect(party.filter(p => matches(p)).map(p => p.id)).toEqual([4]);
        expect(Settings.getSetting('breedingRegionFilter').value).toEqual([]);
    });

    it('searches by name or species ID and resets only external filters', () => {
        const { party, matches, controller } = setup();
        Settings.setSettingByName('breedingShinyFilter', 1);
        controller.listSearch('4');
        expect(party.filter(p => matches(p)).map(p => p.id)).toEqual([4]);
        controller.listSearch('bulba');
        expect(party.filter(p => matches(p)).map(p => p.id)).toEqual([1]);
        expect(controller.listFiltersActive()).toBe(true);
        controller.resetListFilters();
        expect(party.filter(p => matches(p))).toHaveLength(2);
        expect(controller.listFiltersActive()).toBe(false);
        expect(Settings.getSetting('breedingShinyFilter').value).toBe(1);
    });

    it('displays the selected sort metric and supports a separately selected metric', () => {
        const { party, controller } = setup();
        Settings.setSettingByName('partySort', SortOptions.evs);
        expect(controller.getListDisplayValue(party[0])).toBe('EVs: 10');
        Settings.setSettingByName('partyDisplayValue', SortOptions.attack);
        expect(controller.getListDisplayValue(party[0])).toBe('Attack: 20');
        Settings.setSettingByName('partyDisplayValue', SortOptions.category);
        expect(controller.getListDisplayValue(party[0])).toBe('Category: First');
        Settings.setSettingByName('partyDisplayValue', SortOptions.stepsPerAttack);
        expect(controller.getListDisplayValue(party[0])).toBe('Steps per Attack Bonus: 20');
    });

    it('sorts the filtered list and excludes breeding Pokemon without mutating the party', () => {
        vi.useFakeTimers();
        const { party, controller } = setup();
        Settings.setSettingByName('partySort', SortOptions.attack);
        Settings.setSettingByName('partySortDirection', true);
        expect(controller.getSortedList().map(p => p.id)).toEqual([4, 1]);
        Settings.setSettingByName('partyShinyFilter', 1);
        vi.advanceTimersByTime(600);
        expect(controller.getSortedList().map(p => p.id)).toEqual([1]);
        expect(party.map(p => p.id)).toEqual([1, 4]);
    });
});
