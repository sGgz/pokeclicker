import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Battle from '../battles/Battle';
import * as GameConstants from '../GameConstants';
import Settings from '../settings/Settings';
import PrivateGameplay from './settings';
import { UndergroundController } from '../underground/UndergroundController';
import UndergroundToolType from '../underground/tools/UndergroundToolType';

const code = transpileModule(readFileSync('src/scripts/AutoClicker.ts', 'utf8'), {
    compilerOptions: { target: ScriptTarget.ES2020 },
}).outputText;
const previousSettings = Settings.list;
let controller: { start(): void; stop(): void; isSupportedState(state: GameConstants.GameState): boolean };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
    vi.setSystemTime(0);
    Settings.list = [];
    PrivateGameplay.registerSettings();
});

afterEach(() => {
    controller?.stop();
    Settings.list = previousSettings;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function setup(state = GameConstants.GameState.fighting) {
    const attacks = ko.observable(0);
    const disabled = ko.observable(false);
    const game = {
        gameState: state,
        statistics: { clickAttacks: attacks },
        challenges: { list: { disableClickAttack: { active: disabled } } },
        party: { calculateClickAttack: vi.fn(() => 10) },
    };
    vi.stubGlobal('App', { game });
    vi.stubGlobal('player', { regionStarters: [() => GameConstants.Starter.Grass] });
    const battles = Array.from({ length: 4 }, () => {
        let health = 10000;
        class Target extends Battle {}
        const damage = vi.fn((amount: number) => { health -= amount; });
        Object.assign(Target, {
            enemyPokemon: ko.observable({ isAlive: () => health > 0, damage }),
            catching: ko.observable(false), lastClickAttack: -50, defeatPokemon: vi.fn(),
        });
        return { target: Target, damage, kill: () => { health = 0; }, setHealth: (value: number) => { health = value; } };
    });
    const running = ko.observable(true);
    const runner = { running, fighting: running };
    controller = runInNewContext(`${code}\nAutoClicker`, {
        GameConstants, PrivateGameplay, App: { game }, performance, Date, setTimeout, clearTimeout,
        Battle: battles[0].target, GymBattle: battles[1].target, DungeonBattle: battles[2].target,
        TemporaryBattleBattle: battles[3].target, GymRunner: runner, DungeonRunner: runner, TemporaryBattleRunner: runner,
        UndergroundController,
    });
    return { controller, game, battles, running, attacks, disabled };
}

describe('built-in online click attacks', () => {
    it.each([
        [GameConstants.GameState.fighting, 0],
        [GameConstants.GameState.gym, 1],
        [GameConstants.GameState.dungeon, 2],
        [GameConstants.GameState.temporaryBattle, 3],
    ])('attacks only the active battle at state %i at the existing 20/s maximum', (state, index) => {
        const h = setup(state);
        h.controller.start();
        vi.advanceTimersByTime(999);
        expect(h.attacks()).toBe(20);
        h.battles.forEach((battle, i) => expect(battle.damage).toHaveBeenCalledTimes(i === index ? 20 : 0));
        expect(h.game.party.calculateClickAttack).toHaveBeenCalledWith(true);
    });

    it.each([GameConstants.GameState.battleFrontier, GameConstants.GameState.town,
        GameConstants.GameState.paused, GameConstants.GameState.safari])('excludes state %i even with a living enemy', state => {
        const h = setup(state);
        h.controller.start();
        vi.advanceTimersByTime(1000);
        expect(h.attacks()).toBe(0);
        expect(h.controller.isSupportedState(state)).toBe(false);
    });

    it.each([GameConstants.GameState.gym, GameConstants.GameState.dungeon,
        GameConstants.GameState.temporaryBattle])('waits for the runner in state %i', state => {
        const h = setup(state);
        h.running(false);
        h.controller.start();
        vi.advanceTimersByTime(1000);
        expect(h.attacks()).toBe(0);
        h.running(true);
        vi.advanceTimersByTime(50);
        expect(h.attacks()).toBe(1);
    });

    it.each([1, 5, 10])('uses %i clicks/s and updates the rate without restarting', rate => {
        const h = setup();
        Settings.setSettingByName('ggzz.private.autoClickRate', rate);
        h.controller.start();
        vi.advanceTimersByTime(999);
        expect(h.attacks()).toBe(rate);
        Settings.setSettingByName('ggzz.private.autoClickRate', 20);
        vi.advanceTimersByTime(100);
        expect(h.attacks()).toBe(rate + 2);
    });

    it('stops attacks when disabled and resumes using the retained rate', () => {
        const h = setup();
        Settings.setSettingByName('ggzz.private.autoClickRate', 5);
        h.controller.start();
        PrivateGameplay.toggleAutoClick();
        vi.advanceTimersByTime(1000);
        expect(h.attacks()).toBe(1);
        PrivateGameplay.toggleAutoClick();
        vi.advanceTimersByTime(250);
        expect(h.attacks()).toBe(3);
    });

    it('shares the original cooldown with manual clicks and counts a defeat once', () => {
        const h = setup();
        const battle = h.battles[0];
        battle.target.clickAttack();
        h.controller.start();
        vi.advanceTimersByTime(49);
        expect(h.attacks()).toBe(1);
        vi.advanceTimersByTime(1);
        expect(h.attacks()).toBe(2);
        battle.target.clickAttack();
        expect(h.attacks()).toBe(2);
        battle.setHealth(10);
        vi.advanceTimersByTime(500);
        expect(h.attacks()).toBe(3);
        expect(battle.target.defeatPokemon).toHaveBeenCalledTimes(1);
    });

    it('waits during capture and after defeat, then follows a changed scene', () => {
        const h = setup();
        h.battles[0].target.catching(true);
        h.controller.start();
        vi.advanceTimersByTime(500);
        expect(h.attacks()).toBe(0);
        h.battles[0].target.catching(false);
        h.battles[0].kill();
        vi.advanceTimersByTime(500);
        expect(h.attacks()).toBe(0);
        h.game.gameState = GameConstants.GameState.dungeon;
        vi.advanceTimersByTime(50);
        expect(h.battles[2].damage).toHaveBeenCalledTimes(1);
        h.game.gameState = GameConstants.GameState.battleFrontier;
        vi.advanceTimersByTime(500);
        expect(h.attacks()).toBe(1);
    });

    it('respects the disable-click challenge', () => {
        const h = setup();
        h.disabled(true);
        h.controller.start();
        vi.advanceTimersByTime(1000);
        expect(h.attacks()).toBe(0);
        h.disabled(false);
        vi.advanceTimersByTime(50);
        expect(h.attacks()).toBe(1);
    });

    it('does not stack timers on repeated starts and removes all timers on stop', () => {
        const h = setup();
        h.controller.start();
        h.controller.start();
        h.controller.start();
        vi.advanceTimersByTime(999);
        expect(h.attacks()).toBe(20);
        expect(vi.getTimerCount()).toBe(1);
        h.controller.stop();
        expect(vi.getTimerCount()).toBe(0);
        vi.advanceTimersByTime(10_000);
        expect(h.attacks()).toBe(20);
    });

    it('does not repay missed clicks when a suspended timer resumes', () => {
        const h = setup();
        let time = 0;
        vi.spyOn(performance, 'now').mockImplementation(() => time);
        h.controller.start();
        time = 10_000;
        vi.setSystemTime(time);
        vi.advanceTimersByTime(50);
        expect(h.attacks()).toBe(2);
    });
});

describe('built-in online mining clicks', () => {
    function mining() {
        const h = setup(GameConstants.GameState.town);
        const grid = [{ layerDepth: 0 }, { layerDepth: 1000 }, { layerDepth: 3 }];
        const mine = { grid, completed: false, timeUntilDiscovery: 0, getCoordinateForGridIndex: (index: number) => ({ x: index, y: 0 }) };
        const ready = ko.observable(true);
        const charges = ko.observable(0);
        const battery = { maxCharges: 10, canDischarge: vi.fn(() => charges() >= 10), discharge: vi.fn(() => charges(0)) };
        const useTool = vi.fn((_tool: UndergroundToolType, x: number) => { grid[x].layerDepth--; });
        const underground = { canAccess: vi.fn(() => true), mine, battery, tools: {
            selectedToolType: UndergroundToolType.Chisel,
            getTool: () => ({ canUseTool: ready }), useTool,
        } };
        Object.assign(h.game, { underground });
        Object.assign(UndergroundController, { lastMineClick: -50 });
        Settings.setSettingByName('ggzz.private.autoClickAttack', false);
        return { ...h, underground, mine, ready, useTool, battery, charges };
    }

    it('discharges a full battery once through the manual entry and resumes digging on the next pulse', () => {
        const h = mining();
        h.charges(9);
        h.controller.start();
        expect(h.battery.discharge).not.toHaveBeenCalled();
        h.useTool.mockClear();
        h.charges(10);
        vi.advanceTimersByTime(50);
        expect(h.battery.discharge).toHaveBeenCalledTimes(1);
        expect(h.charges()).toBe(0);
        expect(h.useTool).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(h.battery.discharge).toHaveBeenCalledTimes(1);
        expect(h.useTool).toHaveBeenCalledTimes(2);
    });

    it.each([UndergroundToolType.Chisel, UndergroundToolType.Survey])('discharges independently of tool %i and its durability', tool => {
        const h = mining();
        h.ready(false);
        h.underground.tools.selectedToolType = tool;
        h.charges(10);
        h.controller.start();
        expect(h.battery.discharge).toHaveBeenCalledTimes(1);
        expect(h.useTool).not.toHaveBeenCalled();
    });

    it.each(['locked', 'discovering', 'completed', 'paused', 'disabled'])('retains full charges while %s', condition => {
        const h = mining();
        h.charges(10);
        if (condition === 'locked') h.underground.canAccess.mockReturnValue(false);
        if (condition === 'discovering') h.mine.timeUntilDiscovery = 1;
        if (condition === 'completed') h.mine.completed = true;
        if (condition === 'paused') h.game.gameState = GameConstants.GameState.paused;
        if (condition === 'disabled') PrivateGameplay.toggleAutoMine();
        h.controller.start();
        vi.advanceTimersByTime(1000);
        expect(h.battery.discharge).not.toHaveBeenCalled();
        expect(h.charges()).toBe(10);
        expect(h.useTool).not.toHaveBeenCalled();
    });

    it('does not dig again when the discharge completes the layer', () => {
        const h = mining();
        h.charges(10);
        h.battery.discharge.mockImplementation(() => { h.charges(0); h.mine.completed = true; return 0; });
        h.controller.start();
        vi.advanceTimersByTime(1000);
        expect(h.battery.discharge).toHaveBeenCalledTimes(1);
        expect(h.useTool).not.toHaveBeenCalled();
    });

    it('defaults on and uses the real manual entry at 20/s without inspecting hidden rewards', () => {
        const h = mining();
        Object.defineProperty(h.mine.grid[1], 'reward', { get() { throw new Error('Hidden reward inspected'); } });
        h.controller.start();
        vi.advanceTimersByTime(999);
        expect(h.useTool).toHaveBeenCalledTimes(20);
        expect(h.useTool).toHaveBeenLastCalledWith(UndergroundToolType.Chisel, 1, 0);
        expect(h.attacks()).toBe(0);
    });

    it.each([1, 5, 10])('uses the shared %i/s rate with its independent toggle', rate => {
        const h = mining();
        Settings.setSettingByName('ggzz.private.autoClickRate', rate);
        h.controller.start();
        vi.advanceTimersByTime(999);
        expect(h.useTool).toHaveBeenCalledTimes(rate);
        PrivateGameplay.toggleAutoMine();
        vi.advanceTimersByTime(1000);
        expect(h.useTool).toHaveBeenCalledTimes(rate);
        expect(PrivateGameplay.autoClickRate()).toBe(rate);
        PrivateGameplay.toggleAutoMine();
        vi.advanceTimersByTime(50);
        expect(h.useTool).toHaveBeenCalledTimes(rate + 1);
    });

    it('waits for access, discovery, durability, survey selection and completed mines', () => {
        const h = mining();
        h.underground.canAccess.mockReturnValue(false);
        h.controller.start();
        vi.advanceTimersByTime(100);
        h.underground.canAccess.mockReturnValue(true);
        h.mine.timeUntilDiscovery = 1;
        vi.advanceTimersByTime(100);
        h.mine.timeUntilDiscovery = 0;
        h.ready(false);
        vi.advanceTimersByTime(100);
        h.ready(true);
        h.underground.tools.selectedToolType = UndergroundToolType.Survey;
        vi.advanceTimersByTime(100);
        h.underground.tools.selectedToolType = UndergroundToolType.Hammer;
        h.mine.completed = true;
        vi.advanceTimersByTime(100);
        expect(h.useTool).not.toHaveBeenCalled();
        h.mine.completed = false;
        vi.advanceTimersByTime(50);
        expect(h.useTool).toHaveBeenCalledWith(UndergroundToolType.Hammer, 1, 0);
    });

    it('shares the manual mining cooldown and pauses without stacking or catching up', () => {
        const h = mining();
        UndergroundController.clickModalMineSquare(1);
        h.controller.start();
        expect(h.useTool).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(50);
        expect(h.useTool).toHaveBeenCalledTimes(2);
        h.game.gameState = GameConstants.GameState.paused;
        vi.advanceTimersByTime(1000);
        expect(h.useTool).toHaveBeenCalledTimes(2);
        h.game.gameState = GameConstants.GameState.town;
        h.controller.start();
        h.controller.start();
        expect(vi.getTimerCount()).toBe(1);
        let now = 10_000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        vi.setSystemTime(now);
        const before = h.useTool.mock.calls.length;
        vi.advanceTimersByTime(50);
        expect(h.useTool).toHaveBeenCalledTimes(before + 1);
        h.controller.stop();
        now += 1000;
        vi.advanceTimersByTime(1000);
        expect(h.useTool).toHaveBeenCalledTimes(before + 1);
    });
});
