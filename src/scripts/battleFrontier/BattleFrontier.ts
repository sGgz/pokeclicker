class BattleFrontier implements Feature {
    name = 'BattleFrontier';
    saveKey = 'battleFrontier';

    milestones = BattleFrontierMilestones;

    defaults = {};

    constructor() {}

    initialize(): void {}

    canAccess(): boolean {
        return true;
    }

    public enter(): void {
        // Route and frontier battles share this observable. Dispose the route
        // view before clearing its enemy so its templates never render null.
        App.game.gameState = GameConstants.GameState.battleFrontier;
        BattleFrontierBattle.enemyPokemon(null);
    }

    public start(useCheckpoint: boolean): void {
        BattleFrontierRunner.start(useCheckpoint);
    }

    public leave(): void {
        // Put the user back in the town
        App.game.gameState = GameConstants.GameState.town;
    }

    toJSON(): Record<string, any> {
        return {
            milestones: this.milestones.milestoneRewards.filter(m => m.obtained()).map(m => [m.stage, m.description]),
            checkpoint: BattleFrontierRunner.checkpoint(),
            runStartStage: BattleFrontierRunner.runStartStage(),
        };
    }

    fromJSON(json: Record<string, any>): void {
        if (json == null) {
            return;
        }

        json.milestones?.forEach(([stage, description]) => {
            this.milestones.milestoneRewards.find(m => m.stage == stage && m.description == description)?.obtained(true);
        });

        const checkpoint = Number.isSafeInteger(json.checkpoint) && json.checkpoint >= 1 ? json.checkpoint : 1;
        BattleFrontierRunner.checkpoint(checkpoint);
        // Existing saves started at stage one and keep their full pending rewards.
        const runStartStage = Number.isSafeInteger(json.runStartStage) && json.runStartStage >= 1 && json.runStartStage <= checkpoint
            ? json.runStartStage : 1;
        BattleFrontierRunner.runStartStage(runStartStage);
    }
}
