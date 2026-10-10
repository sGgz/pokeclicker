import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as GameConstants from '../GameConstants';
import PokemonType from '../enums/PokemonType';
import '../koExtenders';

const compiled = transpileModule([
    'src/scripts/battleFrontier/BattleFrontierMilestone.ts',
    'src/scripts/battleFrontier/BattleFrontierMilestoneItem.ts',
    'src/scripts/battleFrontier/BattleFrontierMilestonePokemon.ts',
    'src/scripts/battleFrontier/BattleFrontierMilestones.ts',
    'src/scripts/battleFrontier/BattleFrontierAutomation.ts',
    'src/scripts/battleFrontier/BattleFrontierRunner.ts',
    'src/scripts/battleFrontier/BattleFrontierBattle.ts',
    'src/scripts/battleFrontier/BattleFrontier.ts',
].map(file => readFileSync(file, 'utf8')).join('\n'), { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;

function setup(highestStage = 2000) {
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const gainBattlePoints = vi.fn(amount => ({ amount }));
    const gainMoney = vi.fn(amount => ({ amount }));
    const defeat = vi.fn();
    const progressEggsBattle = vi.fn();
    const statistics = {
        battleFrontierHighestStageCompleted: ko.observable(highestStage),
        battleFrontierTotalStagesCompleted: ko.observable(0),
    };
    const app = {
        game: {
            statistics,
            wallet: { gainBattlePoints, gainMoney },
            party: { calculatePokemonAttack: vi.fn<(_type1?: number, ..._args: unknown[]) => number>(() => 100) },
            breeding: { progressEggsBattle },
            logbook: { newLog: vi.fn() },
            gameState: GameConstants.GameState.town,
        },
    };
    let now = 10000;
    class BattleBase {
        static enemyPokemon = ko.observable(null);
        static lastPokemonAttack = 0;
    }
    class Enemy {
        type1 = 0;
        type2 = 0;
        hitpoints = 100;
        defeat = defeat;

        constructor(_name, _id, type1, type2, health) {
            this.type1 = type1;
            this.type2 = type2;
            this.hitpoints = health;
        }

        isAlive() { return this.hitpoints > 0; }
        damage(amount: number) { this.hitpoints -= amount; }
    }
    class LockedRequirement {
        isCompleted() { return false; }
    }
    const factory = { routeHealth: vi.fn<(_route?: number, _region?: number) => number>(() => 100), generateShiny: () => false, generateGender: () => 0 };
    const species = [{ name: 'Pidgey', id: 16, type: [0, 0], nativeRegion: 0, gender: {}, exp: 10 }];
    const classes = runInNewContext(`${compiled}\n({ BattleFrontierRunner, BattleFrontierBattle, BattleFrontier, BattleFrontierMilestones, BattleFrontierMilestone, BattleFrontierAutomation });`, {
        ko, GameConstants, PokemonType, App: app,
        Date: { now: () => now },
        Battle: BattleBase,
        BattlePokemon: Enemy,
        Amount: class {},
        EncounterType: { trainer: 0 },
        WeatherType: { Clear: 0 },
        player: { highestRegion: () => 0 },
        pokemonMap: { randomRegion: () => species[0] },
        pokemonList: species,
        PokemonFactory: factory,
        ItemList: new Proxy({}, { get: (_, name) => ({ displayName: name, image: '', gain: vi.fn() }) }),
        QuestLineStepCompletedRequirement: LockedRequirement,
        ObtainedPokemonRequirement: LockedRequirement,
        MaxRegionRequirement: LockedRequirement,
        MultiRequirement: LockedRequirement,
        Rand: { fromArray: values => values[0] },
        GameHelper: { incrementObservable: (observable, amount = 1) => observable(observable() + amount) },
        Notifier: { confirm, notify },
        NotificationConstants: { NotificationOption: {}, NotificationSetting: { General: {} }, NotificationSound: { General: {} } },
        LogBookTypes: { FRONTIER: 0 },
        createLogContent: { gainBattleFrontierPoints: values => values, gainBattleFrontierReward: values => values },
    });
    const runner = classes.BattleFrontierRunner;
    const battle = classes.BattleFrontierBattle;
    const milestones = classes.BattleFrontierMilestones;
    milestones.milestoneRewards.forEach(m => m.obtained(true));
    const feature = new classes.BattleFrontier();
    const saved = () => JSON.parse(JSON.stringify(feature.toJSON()));
    const clearStages = (amount: number) => {
        for (let i = 0; i < amount * 3; i++) {
            now += 1000;
            battle.pokemonAttack();
        }
    };
    const addMilestone = (stage: number, unlocked = ko.observable(true)) => {
        const gain = vi.fn();
        const milestone = new classes.BattleFrontierMilestone(stage, gain, { isCompleted: () => unlocked() }, '', `Reward ${stage}`);
        milestones.addMilestone(milestone);
        return { milestone, gain, unlocked };
    };
    const advance = (milliseconds: number) => {
        for (let i = 0; i < milliseconds; i += 100) {
            now += 100;
            if (now % 500 === 0 && runner.started()) {
                battle.pokemonAttack();
            }
            runner.tick();
        }
    };
    return {
        runner, battle, routeBattle: BattleBase, feature, milestones, statistics, confirm, notify, gainBattlePoints, gainMoney,
        defeat, progressEggsBattle, saved, clearStages, addMilestone, app, advance, factory, species,
        automation: runner.automation, planner: classes.BattleFrontierAutomation,
    };
}

describe('Battle Frontier quick challenges and settlement', () => {
    it('switches away from the route view before clearing the shared enemy on entry', () => {
        const h = setup();
        const gameState = ko.observable(GameConstants.GameState.fighting);
        Object.defineProperty(h.app.game, 'gameState', { get: () => gameState(), set: value => gameState(value) });
        h.routeBattle.enemyPokemon({ displayName: 'Route enemy' });
        const index = readFileSync('src/index.html', 'utf8');
        const routeContainer = index.match(/<div id="routeBattleContainer"[^>]*>/)[0];
        const nameBinding = index.match(/<knockout data-bind="template: \{ name: 'pokemonNameTemplate'.*?<\/knockout>/)[0];
        const host = document.createElement('div');
        host.innerHTML = readFileSync('src/components/templates/pokemonNameTemplate.html', 'utf8')
            + '<script type="text/html" id="pokemonGenderTemplate"></script>'
            + routeContainer + nameBinding + '</div>';
        document.body.appendChild(host);
        ko.applyBindings({ App: h.app, GameConstants, Battle: h.routeBattle }, host);
        try {
            expect(host.textContent).toContain('Route enemy');
            expect(() => h.feature.enter()).not.toThrow();
            expect(gameState()).toBe(GameConstants.GameState.battleFrontier);
            expect(h.routeBattle.enemyPokemon()).toBeNull();
            expect(host.textContent).not.toContain('Route enemy');
        } finally {
            ko.cleanNode(host);
            host.remove();
        }
    });

    it('skips cleared low stages without awarding resources or increasing completion statistics', async () => {
        const h = setup();
        await h.runner.start(false, true);
        expect(h.runner.stage()).toBe(1901);
        expect(h.runner.checkpoint()).toBe(1901);
        expect(h.runner.runStartStage()).toBe(1901);
        expect(h.runner.pendingRewards()).toEqual({ stages: 0, battlePoints: 0, money: 0 });
        expect(h.statistics.battleFrontierHighestStageCompleted()).toBe(2000);
        expect(h.statistics.battleFrontierTotalStagesCompleted()).toBe(0);
        expect(h.defeat).not.toHaveBeenCalled();
        expect(h.progressEggsBattle).not.toHaveBeenCalled();
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
        expect(h.gainMoney).not.toHaveBeenCalled();
    });

    it.each([0, 50, 100, 101])('keeps the first 100 stages accessible with highest stage %s', async highest => {
        const h = setup(highest);
        await h.runner.start(false, true);
        expect(h.runner.stage()).toBe(Math.max(1, highest - 99));
        expect(h.runner.pendingRewards().stages).toBe(0);
    });

    it('starts at the earliest unlocked, unclaimed milestone and awards it only after beating its stage', async () => {
        const h = setup();
        const locked = h.addMilestone(100, ko.observable(false));
        const earlier = h.addMilestone(386);
        const later = h.addMilestone(666);
        expect(h.runner.quickStartStage()).toBe(386);
        await h.runner.start(false, true);
        expect(earlier.gain).not.toHaveBeenCalled();
        h.clearStages(1);
        expect(earlier.gain).toHaveBeenCalledOnce();
        expect(earlier.milestone.obtained()).toBe(true);
        expect(later.gain).not.toHaveBeenCalled();
        expect(locked.gain).not.toHaveBeenCalled();
        expect(h.runner.quickStartStage()).toBe(666);
        later.milestone.obtained(true);
        locked.unlocked(true);
        expect(h.runner.quickStartStage()).toBe(100);
    });

    it('claims only completed stages in a quick run and clears the checkpoint exactly once', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(100);
        // Two defeated enemies in the next stage do not count as a cleared stage.
        h.battle.defeatPokemon();
        h.battle.defeatPokemon();
        expect(h.runner.pendingRewards()).toEqual({ stages: 100, battlePoints: 3900, money: 390000 });
        expect(h.statistics.battleFrontierTotalStagesCompleted()).toBe(100);
        await h.runner.battleFinish();
        expect(h.gainBattlePoints).toHaveBeenCalledExactlyOnceWith(3900);
        expect(h.gainMoney).toHaveBeenCalledExactlyOnceWith(390000, true);
        expect(h.runner.started()).toBe(false);
        expect(h.runner.checkpoint()).toBe(1);
        expect(h.runner.runStartStage()).toBe(1);
        expect(h.battle.enemyPokemon()).toBeNull();
        await h.runner.battleFinish();
        h.runner.battleLost();
        expect(h.gainBattlePoints).toHaveBeenCalledOnce();
        expect(h.app.game.gameState).toBe(GameConstants.GameState.battleFrontier);
    });

    it('preserves quick-run rewards through pause, save/load and resume', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(50);
        await h.runner.battleQuit();
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
        const restored = setup();
        restored.feature.fromJSON(h.saved());
        expect(restored.runner.runStartStage()).toBe(1901);
        expect(restored.runner.checkpoint()).toBe(1951);
        await restored.runner.start(true);
        restored.clearStages(50);
        await restored.runner.battleFinish();
        expect(restored.gainBattlePoints).toHaveBeenCalledExactlyOnceWith(3900);
        expect(restored.gainMoney).toHaveBeenCalledExactlyOnceWith(390000, true);
    });

    it('allows a saved run to be claimed without resuming its battle', async () => {
        const h = setup();
        h.feature.fromJSON({ checkpoint: 2001, runStartStage: 1901 });
        await h.runner.battleFinish();
        expect(h.gainBattlePoints).toHaveBeenCalledExactlyOnceWith(3900);
        expect(h.runner.hasCheckpoint()).toBe(false);
        const restored = setup();
        restored.feature.fromJSON(h.saved());
        await restored.runner.battleFinish();
        expect(restored.gainBattlePoints).not.toHaveBeenCalled();
    });

    it('retains the original payout for old saves and for runs starting at stage one', async () => {
        const h = setup();
        h.feature.fromJSON({ checkpoint: 151 });
        expect(h.runner.runStartStage()).toBe(1);
        await h.runner.start(true);
        h.runner.battleLost();
        expect(h.gainBattlePoints).toHaveBeenCalledExactlyOnceWith(225);
        expect(h.gainMoney).toHaveBeenCalledExactlyOnceWith(22500, true);
        await h.runner.start(false);
        h.clearStages(3);
        await h.runner.battleFinish();
        expect(h.gainBattlePoints).toHaveBeenLastCalledWith(3);
        expect(h.gainMoney).toHaveBeenLastCalledWith(300, true);
    });

    it('settles defeat in a quick run without paying for skipped stages', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(100);
        h.runner.timeLeft(-1);
        h.runner.tick();
        h.runner.tick();
        expect(h.gainBattlePoints).toHaveBeenCalledExactlyOnceWith(3900);
        expect(h.gainMoney).toHaveBeenCalledExactlyOnceWith(390000, true);
        expect(h.runner.started()).toBe(false);
    });

    it('keeps the incremental money reward exact when the BP curve contains fractions', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(2);
        expect(h.runner.pendingRewards()).toEqual({ stages: 2, battlePoints: 76, money: 7604 });
        await h.runner.battleFinish();
        expect(h.gainMoney).toHaveBeenCalledExactlyOnceWith(7604, true);
    });

    it.each([false, true])('does not send zero rewards to the wallet when ending an empty run (quick: %s)', async quick => {
        const h = setup();
        await h.runner.start(false, quick);
        await h.runner.battleFinish();
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
        expect(h.gainMoney).not.toHaveBeenCalled();
        expect(h.runner.hasCheckpoint()).toBe(false);
    });

    it('does not claim, pause or replace a run when its confirmation is cancelled', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(1);
        h.confirm.mockResolvedValue(false);
        await h.runner.battleFinish();
        await h.runner.battleQuit();
        expect(h.runner.started()).toBe(true);
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
        h.confirm.mockResolvedValue(true);
        await h.runner.battleQuit();
        const before = h.saved();
        h.confirm.mockResolvedValue(false);
        await h.runner.start(false);
        expect(h.saved()).toEqual(before);
        expect(h.runner.confirmationPending()).toBe(false);
    });

    it('blocks overlapping actions and does not pay twice if defeat occurs while confirming a claim', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(1);
        let resolve: (confirmed: boolean) => void;
        h.confirm.mockImplementation(() => new Promise<boolean>(callback => { resolve = callback; }));
        const finish = h.runner.battleFinish();
        await h.runner.battleFinish();
        await h.runner.battleQuit();
        await h.runner.start(false);
        expect(h.confirm).toHaveBeenCalledOnce();
        h.runner.battleLost();
        await h.runner.start(false, true);
        expect(h.runner.started()).toBe(false);
        resolve(true);
        await finish;
        expect(h.gainBattlePoints).toHaveBeenCalledOnce();
        expect(h.runner.confirmationPending()).toBe(false);
    });

    it('discards a paused quick run when explicitly starting again from stage one', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(1);
        await h.runner.battleQuit();
        await h.runner.start(false);
        expect(h.runner.stage()).toBe(1);
        expect(h.runner.runStartStage()).toBe(1);
        expect(h.runner.pendingRewards()).toEqual({ stages: 0, battlePoints: 0, money: 0 });
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
    });

    it.each([undefined, null, -1, 0, 1.5, Infinity, '1901', 2002])('loads an invalid run start %s as a legacy run', runStartStage => {
        const h = setup();
        h.feature.fromJSON({ checkpoint: 2001, runStartStage });
        expect(h.runner.runStartStage()).toBe(1);
        expect(h.runner.pendingRewards().battlePoints).toBe(40000);
    });

    it.each([undefined, null, -1, 0, 1.5, Infinity, '2001'])('loads an invalid checkpoint %s without a pending reward', checkpoint => {
        const h = setup();
        h.feature.fromJSON({ checkpoint, runStartStage: 1901 });
        expect(h.runner.checkpoint()).toBe(1);
        expect(h.runner.pendingRewards()).toEqual({ stages: 0, battlePoints: 0, money: 0 });
    });

    it('renders the quick entry, live rewards and separate finish/pause controls in the actual component', async () => {
        const h = setup();
        h.app.game.gameState = GameConstants.GameState.battleFrontier;
        const host = document.createElement('div');
        host.innerHTML = readFileSync('src/components/battleFrontierInfo.html', 'utf8');
        ko.applyBindings({ App: h.app, GameConstants, BattleFrontierRunner: h.runner, BattleFrontierMilestones: h.milestones }, host);
        try {
            expect(host.textContent).toContain('Quick Challenge (Stage 1,901)');
            await h.runner.start(false, true);
            h.clearStages(2);
            expect(host.textContent).toContain('This run: 2 stages completed');
            expect(host.textContent).toContain('7,604');
            const buttons = Array.from(host.querySelectorAll<HTMLButtonElement>('#battleFrontierRewards button'));
            expect(buttons.map(button => button.textContent)).toEqual(['Finish & Claim Rewards', 'Pause & Save Progress']);
            h.runner.confirmationPending(true);
            expect(buttons.every(button => button.disabled)).toBe(true);
            h.runner.confirmationPending(false);
            await h.runner.battleQuit();
            expect(host.textContent).toContain('Resume (Stage 1,903)');
            expect(host.textContent).toContain('This run: 2 stages completed');
            await h.runner.battleFinish();
            expect(host.textContent).not.toContain('Available to claim');
            expect(host.textContent).not.toContain('Resume (Stage');
        } finally {
            ko.cleanNode(host);
        }
    });
});

describe('Battle Frontier adaptive automation', () => {
    it('keeps one simulated hour of unattended loops and hatchery progress exactly accounted', () => {
        const h = setup();
        h.automation.mode('fixed');
        h.automation.fixedEndStage(5);
        h.automation.start();
        h.advance(GameConstants.HOUR);
        expect(h.automation.cycles()).toBe(423);
        expect(h.gainBattlePoints).toHaveBeenCalledTimes(423);
        expect(h.gainBattlePoints.mock.calls.reduce((sum, [amount]) => sum + amount, 0)).toBe(2115);
        expect(h.gainMoney.mock.calls.reduce((sum, [amount]) => sum + amount, 0)).toBe(211500);
        expect(h.runner.pendingRewards().stages).toBe(3);
        expect(h.statistics.battleFrontierTotalStagesCompleted()).toBe(2118);
        expect(h.progressEggsBattle).toHaveBeenCalledTimes(6354);
        expect(h.automation.active()).toBe(true);
    });

    it('claims fixed runs and restarts after a delay without confirmations or duplicate rewards', () => {
        const h = setup();
        h.automation.mode('fixed');
        h.automation.fixedEndStage(2);
        h.automation.start();
        expect(h.runner.stage()).toBe(1);
        h.advance(3000);
        expect(h.gainBattlePoints).toHaveBeenCalledExactlyOnceWith(2);
        expect(h.gainMoney).toHaveBeenCalledExactlyOnceWith(200, true);
        expect(h.runner.started()).toBe(false);
        expect(h.automation.active()).toBe(true);
        expect(h.confirm).not.toHaveBeenCalled();
        expect(h.notify).not.toHaveBeenCalled();
        h.advance(1000);
        expect(h.runner.started()).toBe(true);
        expect(h.runner.pendingRewards().stages).toBe(0);
        h.advance(3000);
        expect(h.gainBattlePoints).toHaveBeenCalledTimes(2);
        expect(h.automation.earnedPoints()).toBe(4);
        expect(h.automation.cycles()).toBe(2);
        expect(h.statistics.battleFrontierTotalStagesCompleted()).toBe(4);
    });

    it('can stop during the restart delay and cannot restart behind the user', () => {
        const h = setup();
        h.automation.mode('fixed');
        h.automation.fixedEndStage(1);
        h.automation.start();
        h.advance(1500);
        h.automation.stop();
        h.advance(5000);
        expect(h.runner.started()).toBe(false);
        expect(h.gainBattlePoints).toHaveBeenCalledOnce();
    });

    it('stopping automation leaves an active run and its pending rewards intact', async () => {
        const h = setup();
        h.automation.start();
        h.advance(3000);
        const before = h.runner.pendingRewards();
        h.automation.stop();
        expect(h.runner.started()).toBe(true);
        expect(h.runner.pendingRewards()).toEqual(before);
        await h.runner.battleFinish();
        expect(h.gainBattlePoints).toHaveBeenCalledExactlyOnceWith(before.battlePoints);
    });

    it.each(['battleQuit', 'battleFinish'])('a confirmed manual %s stops automation', async action => {
        const h = setup();
        h.automation.start();
        h.advance(3000);
        await h.runner[action]();
        expect(h.automation.active()).toBe(false);
        expect(h.runner.started()).toBe(false);
        h.advance(5000);
        expect(h.runner.started()).toBe(false);
        expect(h.runner.hasCheckpoint()).toBe(action === 'battleQuit');
    });

    it('cancelled confirmation keeps automation, but pending dialogs block automatic settlement', async () => {
        const h = setup();
        h.automation.mode('fixed');
        h.automation.fixedEndStage(2);
        h.automation.start();
        let resolve: (value: boolean) => void;
        h.confirm.mockImplementation(() => new Promise<boolean>(callback => { resolve = callback; }));
        const pending = h.runner.battleQuit();
        h.advance(3000);
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
        expect(h.runner.started()).toBe(true);
        resolve(false);
        await pending;
        expect(h.automation.active()).toBe(true);
        h.advance(1500);
        expect(h.gainBattlePoints).toHaveBeenCalledOnce();
    });

    it('defeat during a confirmation settles once and prevents a hidden restart', async () => {
        const h = setup();
        h.automation.start();
        h.advance(1500);
        let resolve: (value: boolean) => void;
        h.confirm.mockImplementation(() => new Promise<boolean>(callback => { resolve = callback; }));
        const pending = h.runner.battleFinish();
        h.runner.timeLeft(-1);
        h.runner.tick();
        expect(h.automation.active()).toBe(false);
        resolve(true);
        await pending;
        h.advance(5000);
        expect(h.gainBattlePoints).toHaveBeenCalledOnce();
        expect(h.runner.started()).toBe(false);
    });

    it('preserves a paused run when starting automation, and saves preferences without auto-start on reload', async () => {
        const h = setup();
        await h.runner.start(false, true);
        h.clearStages(2);
        await h.runner.battleQuit();
        h.automation.mode('fixed');
        h.automation.fixedEndStage(2000);
        h.automation.start();
        expect(h.runner.runStartStage()).toBe(1901);
        expect(h.runner.stage()).toBe(1903);
        expect(h.runner.pendingRewards().battlePoints).toBe(76);
        const restored = setup();
        restored.feature.fromJSON(h.saved());
        expect(restored.automation.active()).toBe(false);
        expect(restored.automation.mode()).toBe('fixed');
        expect(restored.automation.fixedEndStage()).toBe(2000);
        expect(restored.runner.pendingRewards()).toEqual(h.runner.pendingRewards());
    });

    it.each([null, { mode: 'bogus', fixedEndStage: '999' }, { fixedEndStage: Infinity }])('sanitizes invalid automation preferences %s', automation => {
        const h = setup();
        h.feature.fromJSON({ automation });
        expect(h.automation.mode()).toBe('efficiency');
        expect(h.automation.fixedEndStage()).toBe(1000);
        expect(h.automation.active()).toBe(false);
    });

    it('does not skip unlocked unclaimed milestones when choosing a farming range', () => {
        const h = setup();
        const milestone = h.addMilestone(386);
        h.automation.start();
        expect(h.automation.plannedStart()).toBeGreaterThan(386);
        expect(h.runner.runStartStage()).toBe(386);
        h.advance(1500);
        expect(milestone.gain).toHaveBeenCalledOnce();
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
    });

    it('uses current attack to move the next range down and back up as hatchery output changes', () => {
        const h = setup();
        h.factory.routeHealth.mockImplementation(route => Math.floor((route - 10) ** 2.53));
        h.app.game.party.calculatePokemonAttack.mockReturnValue(1000000);
        h.automation.start();
        const originalEnd = h.automation.plannedEnd();
        h.app.game.party.calculatePokemonAttack.mockReturnValue(10000);
        h.advance(5000);
        expect(h.automation.plannedEnd()).toBeLessThan(originalEnd);
        const reducedEnd = h.automation.plannedEnd();
        h.app.game.party.calculatePokemonAttack.mockReturnValue(1000000);
        h.advance(5000);
        expect(h.automation.plannedEnd()).toBeGreaterThan(reducedEnd);
        expect(h.progressEggsBattle).toHaveBeenCalled();
    });

    it('automatically settles an inefficient run after attack falls, then starts the lower range', () => {
        const h = setup();
        h.factory.routeHealth.mockImplementation(route => Math.floor((route - 10) ** 2.53));
        h.app.game.party.calculatePokemonAttack.mockReturnValue(1000000);
        h.automation.start();
        const initialStart = h.runner.runStartStage();
        // The replacement team can finish these stages, but a lower range yields more BP/min.
        h.app.game.party.calculatePokemonAttack.mockReturnValue(400000);
        h.advance(60000);
        expect(h.automation.cycles()).toBeGreaterThan(0);
        expect(h.runner.runStartStage()).toBeLessThan(initialStart);
        expect(h.gainBattlePoints).toHaveBeenCalled();
        expect(h.automation.active()).toBe(true);
    });

    it('pauses safely if no range is viable after all attack leaves for breeding', () => {
        const h = setup();
        h.automation.start();
        h.advance(1500);
        const rewards = h.runner.pendingRewards();
        h.app.game.party.calculatePokemonAttack.mockReturnValue(0);
        h.advance(5000);
        expect(h.automation.active()).toBe(false);
        expect(h.runner.started()).toBe(false);
        expect(h.runner.pendingRewards()).toEqual(rewards);
        expect(h.gainBattlePoints).not.toHaveBeenCalled();
        expect(h.automation.status()).toContain('No safe farming range');
    });

    it('record mode claims defeat and stops, whereas fixed mode retries and guards empty failures', () => {
        const h = setup();
        h.automation.mode('record');
        h.automation.start();
        h.advance(1500);
        h.runner.battleLost();
        expect(h.automation.active()).toBe(false);
        expect(h.gainBattlePoints).toHaveBeenCalledOnce();
        expect(h.automation.cycles()).toBe(1);
        h.automation.mode('fixed');
        h.automation.start();
        for (let i = 0; i < 3; i++) {
            h.runner.battleLost();
            h.advance(1000);
        }
        expect(h.automation.active()).toBe(false);
        expect(h.runner.started()).toBe(false);
        expect(h.gainBattlePoints).toHaveBeenCalledOnce();
        expect(h.automation.status()).toContain('3 runs');
    });

    it('stops when leaving and never skips uncleared layers for a fixed target', () => {
        const h = setup(50);
        h.automation.mode('fixed');
        h.automation.fixedEndStage(2000);
        h.automation.start();
        expect(h.runner.runStartStage()).toBeLessThanOrEqual(51);
        h.feature.leave();
        expect(h.automation.active()).toBe(false);
    });

    it('supports a new save without any completed frontier stages', () => {
        const h = setup(0);
        h.automation.start();
        expect(h.runner.runStartStage()).toBe(1);
        expect(h.automation.active()).toBe(true);
        h.advance(3000);
        expect(h.statistics.battleFrontierHighestStageCompleted()).toBeGreaterThan(0);
    });

    it('models the double attack interval for uncleared layers and prices restart overhead', () => {
        const h = setup();
        const profile = [{ damage: 100, weight: 1 }];
        expect(h.planner.stageMilliseconds(2000, 2000, profile)).toBe(1500);
        expect(h.planner.stageMilliseconds(2001, 2000, profile)).toBe(3000);
        const normal = h.planner.plan(2000, profile, 1, 1000);
        const slowRestart = h.planner.plan(2000, profile, 1, 10000);
        expect(normal.start).toBe(1951);
        expect(normal.rate).toBeCloseTo(1975 * 60000 / 76000);
        expect(slowRestart.start).toBe(1901);
        expect(slowRestart.rate).toBeLessThan(normal.rate);
        expect(h.planner.plan(2000, [{ damage: 0, weight: 1 }])).toBeNull();
    });

    it('weights base IDs and forms like the real enemy generator, including resistant matchups', () => {
        const h = setup();
        h.species.push(
            { name: 'Form A', id: 16.1, type: [1, 0], nativeRegion: 0, gender: {}, exp: 10 },
            { name: 'Other', id: 17, type: [2, 0], nativeRegion: 0, gender: {}, exp: 10 },
        );
        h.app.game.party.calculatePokemonAttack.mockImplementation(type1 => type1 === 0 ? 100 : 50);
        h.automation.start();
        // 25% one-hit, 75% two-hit, three enemies; no form-count weighting bias.
        const expectedTime = 3 * 500 * (0.25 + 0.75 * 2) * 50 + 1000;
        expect(h.automation.estimatedRate()).toBeCloseTo(1975 * 60000 / expectedTime);
        expect(h.app.game.party.calculatePokemonAttack).toHaveBeenCalledWith(2, 0, true, GameConstants.Region.none, false, false, 0);
    });

    it('renders and operates automation controls using the actual Knockout component', () => {
        const h = setup();
        h.app.game.gameState = GameConstants.GameState.battleFrontier;
        const host = document.createElement('div');
        host.innerHTML = readFileSync('src/components/battleFrontierInfo.html', 'utf8');
        ko.applyBindings({ App: h.app, GameConstants, BattleFrontierRunner: h.runner, BattleFrontierMilestones: h.milestones }, host);
        try {
            const mode = host.querySelector<HTMLSelectElement>('#frontierAutomationMode');
            mode.value = 'fixed';
            mode.dispatchEvent(new Event('change'));
            const target = host.querySelector<HTMLInputElement>('#frontierAutomationTarget');
            target.value = '2';
            target.dispatchEvent(new Event('change'));
            host.querySelector<HTMLButtonElement>('#battleFrontierAutomation button').click();
            expect(h.automation.active()).toBe(true);
            expect(mode.disabled).toBe(true);
            h.advance(3000);
            expect(host.textContent).toContain('Claimed: 2 BP');
            host.querySelector<HTMLButtonElement>('#battleFrontierAutomation button').click();
            h.advance(2000);
            expect(h.automation.active()).toBe(false);
            expect(h.runner.started()).toBe(false);
        } finally {
            ko.cleanNode(host);
        }
    });
});
