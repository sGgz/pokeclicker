/// <reference path="../declarations/battles/Battle.d.ts" />

/** Online attacks and mining; movement and encounter transitions belong to the runners. */
class AutoClicker {
    private static timer: ReturnType<typeof setTimeout>;
    private static running = false;
    private static nextAttackAt = 0;
    private static nextMineAt = 0;
    private static rate = 0;

    static isSupportedState(state: GameConstants.GameState): boolean {
        return [
            GameConstants.GameState.fighting, GameConstants.GameState.gym,
            GameConstants.GameState.dungeon, GameConstants.GameState.temporaryBattle,
        ].includes(state);
    }

    static start(): void {
        this.stop();
        this.running = true;
        this.tick();
    }

    static stop(): void {
        clearTimeout(this.timer);
        this.running = false;
        this.nextAttackAt = 0;
        this.nextMineAt = 0;
        this.rate = 0;
    }

    private static currentBattle(): typeof Battle | undefined {
        switch (App.game.gameState) {
            case GameConstants.GameState.fighting:
                return Battle;
            case GameConstants.GameState.gym:
                return GymRunner.running() ? GymBattle : undefined;
            case GameConstants.GameState.dungeon:
                return DungeonRunner.fighting() ? DungeonBattle : undefined;
            case GameConstants.GameState.temporaryBattle:
                return TemporaryBattleRunner.running() ? TemporaryBattleBattle : undefined;
            default:
                return undefined;
        }
    }

    private static tick(): void {
        if (!this.running) {
            return;
        }
        const enabled = PrivateGameplay.autoClickEnabled();
        const rate = PrivateGameplay.autoClickRate();
        if (rate !== this.rate || !PrivateGameplay.autoMineEnabled()) {
            this.nextMineAt = 0;
        }
        if (!enabled || rate !== this.rate) {
            this.nextAttackAt = 0;
            this.rate = rate;
        }
        let delay = Battle.CLICK_ATTACK_INTERVAL;
        const now = performance.now();
        if (PrivateGameplay.autoMineEnabled() && App.game.gameState !== GameConstants.GameState.paused && now >= this.nextMineAt) {
            UndergroundController.autoMine();
            this.nextMineAt = now + GameConstants.SECOND / rate;
        }
        if (enabled && now >= this.nextAttackAt) {
            const battle = this.currentBattle();
            if (battle && !battle.catching() && battle.enemyPokemon()?.isAlive()) {
                // Manual clicks use the same cooldown. Retry at its deadline, never bypass it.
                const cooldown = battle.lastClickAttack + battle.CLICK_ATTACK_INTERVAL - Date.now();
                if (cooldown > 0) {
                    delay = cooldown;
                } else {
                    battle.clickAttack();
                    // Schedule from now: suspended timers never accumulate a burst of attacks.
                    this.nextAttackAt = now + GameConstants.SECOND / rate;
                    delay = GameConstants.SECOND / rate;
                }
            }
        } else if (enabled) {
            delay = this.nextAttackAt - now;
        }
        // Poll settings within 50ms, including while paused or set to a slower rate.
        this.timer = setTimeout(() => this.tick(), Math.max(1, Math.min(Battle.CLICK_ATTACK_INTERVAL, delay)));
    }
}
