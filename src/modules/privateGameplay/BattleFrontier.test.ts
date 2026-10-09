import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as GameConstants from '../GameConstants';

const compiled = transpileModule([
    'src/scripts/battleFrontier/BattleFrontierMilestone.ts',
    'src/scripts/battleFrontier/BattleFrontierMilestoneItem.ts',
    'src/scripts/battleFrontier/BattleFrontierMilestonePokemon.ts',
    'src/scripts/battleFrontier/BattleFrontierMilestones.ts',
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
            party: { calculatePokemonAttack: () => 100 },
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

        isAlive() { return this.hitpoints > 0; }
        damage(amount: number) { this.hitpoints -= amount; }
    }
    class LockedRequirement {
        isCompleted() { return false; }
    }
    const classes = runInNewContext(`${compiled}\n({ BattleFrontierRunner, BattleFrontierBattle, BattleFrontier, BattleFrontierMilestones, BattleFrontierMilestone });`, {
        ko, GameConstants, App: app,
        Date: { now: () => now },
        Battle: BattleBase,
        BattlePokemon: Enemy,
        Amount: class {},
        EncounterType: { trainer: 0 },
        WeatherType: { Clear: 0 },
        player: { highestRegion: () => 0 },
        pokemonMap: { randomRegion: () => ({ name: 'Pidgey', id: 16, type: [0, 0], gender: {}, exp: 10 }) },
        PokemonFactory: { routeHealth: () => 100, generateShiny: () => false, generateGender: () => 0 },
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
    return {
        runner, battle, routeBattle: BattleBase, feature, milestones, statistics, confirm, notify, gainBattlePoints, gainMoney,
        defeat, progressEggsBattle, saved, clearStages, addMilestone, app,
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
            const buttons = Array.from(host.querySelectorAll('button'));
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
