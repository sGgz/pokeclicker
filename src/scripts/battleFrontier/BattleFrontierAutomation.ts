type FrontierAutomationMode = 'efficiency' | 'fixed' | 'record';
type FrontierAttackProfile = { damage: number; weight: number }[];
type FrontierPlan = { start: number; end: number; rate: number };

/** Owns online automation only; run rewards and checkpoints remain in the runner. */
class BattleFrontierAutomation {
    public mode = ko.observable<FrontierAutomationMode>('efficiency');
    public fixedEndStage = ko.observable(1000).extend({ numeric: 0 });
    public active = ko.observable(false);
    public status = ko.observable('Choose a mode, then start automation.');
    public plannedStart = ko.observable(1);
    public plannedEnd = ko.observable(1);
    public estimatedRate = ko.observable(0);
    public recentRate = ko.observable(0);
    public cycles = ko.observable(0);
    public earnedPoints = ko.observable(0);

    private profile: FrontierAttackProfile = [];
    private profileAt = -Infinity;
    private stageAt = 0;
    private runAt = 0;
    private attacks = 0;
    private attackTime = 0;
    private samples: { points: number; milliseconds: number; timing: number }[] = [];
    private timing = 1;
    private votes = 0;
    private restartAt = 0;
    private failureCap = Infinity;
    private emptyFailures = 0;
    private distributionRegion = -1;
    private distribution: { type1: PokemonType; type2: PokemonType; weight: number }[] = [];
    private readonly restartDelay = 1000;

    public static points(stage: number): number {
        return Math.round(stage * Math.max(stage / 100, 1));
    }

    public static stageMilliseconds(stage: number, highest: number, profile: FrontierAttackProfile): number {
        const health = PokemonFactory.routeHealth(stage + 10, GameConstants.Region.none);
        const interval = GameConstants.BATTLE_FRONTIER_TICK * (stage > highest ? 2 : 1);
        if (!profile.length || profile.some(p => !Number.isFinite(p.damage) || p.damage <= 0)) {
            return Infinity;
        }
        return 3 * interval * profile.reduce((sum, p) => sum + Math.ceil(health / p.damage) * p.weight, 0);
    }

    /** Bounded search of cleared windows and attack-count thresholds, using today's team on both sides. */
    public static plan(highest: number, profile: FrontierAttackProfile, timing = 1, restartDelay = 1000): FrontierPlan | null {
        if (highest < 1 || !profile.length || profile.some(p => p.damage <= 0 || !Number.isFinite(p.damage))) {
            return null;
        }
        const ends = new Set<number>([1, Math.min(100, highest), highest]);
        // A coarse sweep also covers weighted mixtures whose optimum is between thresholds.
        for (let i = 1; i <= 40; i++) {
            ends.add(Math.max(1, Math.floor(highest * i / 40)));
        }
        const thresholds = [...new Set(profile.map(p => p.damage))].sort((a, b) => a - b);
        // Quantiles bound the work even with hundreds of different type matchups.
        for (let i = 0; i < Math.min(12, thresholds.length); i++) {
            const damage = thresholds[Math.floor(i * (thresholds.length - 1) / Math.max(1, Math.min(12, thresholds.length) - 1))];
            for (let hits = 1; hits <= 6; hits++) {
                let low = 0;
                let high = highest;
                while (low < high) {
                    const middle = Math.ceil((low + high) / 2);
                    if (PokemonFactory.routeHealth(middle + 10, GameConstants.Region.none) <= damage * hits) {
                        low = middle;
                    } else {
                        high = middle - 1;
                    }
                }
                if (low > 0) {
                    ends.add(low);
                }
            }
        }
        let best: FrontierPlan = null;
        for (const end of ends) {
            // Leave a margin for three resistant enemies and scheduling jitter.
            const health = PokemonFactory.routeHealth(end + 10, GameConstants.Region.none);
            const slowest = Math.min(...profile.map(p => p.damage));
            if (3 * Math.ceil(health / slowest) * GameConstants.BATTLE_FRONTIER_TICK * timing > GameConstants.GYM_TIME * 0.85) {
                continue;
            }
            for (const window of [10, 25, 50, 100]) {
                const start = Math.max(1, end - window + 1);
                const length = end - start + 1;
                const count = Math.min(20, length);
                let milliseconds = restartDelay;
                for (let i = 0; i < count; i++) {
                    const stage = start + Math.floor((i + 0.5) * length / count);
                    milliseconds += this.stageMilliseconds(stage, highest, profile) * timing * length / count;
                }
                const rate = (this.points(end) - this.points(start - 1)) * 60000 / milliseconds;
                if (!best || rate > best.rate) {
                    best = { start, end, rate };
                }
            }
        }
        return best;
    }

    public start(): void {
        if (this.active() || BattleFrontierRunner.confirmationPending()) {
            return;
        }
        this.fixedEndStage(this.validTarget(this.fixedEndStage()));
        this.mode(this.validMode(this.mode()));
        this.cycles(0);
        this.earnedPoints(0);
        this.emptyFailures = 0;
        this.failureCap = Infinity;
        this.samples = [];
        this.timing = 1;
        this.profileAt = -Infinity;
        this.active(true);
        this.refreshPlan();
        if (!this.active()) {
            return;
        }
        if (BattleFrontierRunner.started()) {
            this.runStarted();
        } else {
            BattleFrontierRunner.startAutomaticRun(this.protectedStart(), BattleFrontierRunner.hasCheckpoint());
        }
    }

    public stop(reason = 'Automation stopped. Current run and rewards are kept.'): void {
        this.active(false);
        this.restartAt = 0;
        this.votes = 0;
        this.status(reason);
    }

    public preferences(): { mode: FrontierAutomationMode; fixedEndStage: number } {
        return { mode: this.validMode(this.mode()), fixedEndStage: this.validTarget(this.fixedEndStage()) };
    }

    public loadPreferences(json?: { mode?: unknown; fixedEndStage?: unknown }): void {
        this.stop('Automation is off. Start it when you are ready.');
        this.mode(this.validMode(json?.mode));
        this.fixedEndStage(this.validTarget(json?.fixedEndStage));
    }

    private validMode(value: unknown): FrontierAutomationMode {
        return value === 'fixed' || value === 'record' ? value : 'efficiency';
    }

    private validTarget(value: unknown): number {
        return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.min(1000000, Math.floor(value))) : 1000;
    }

    private readProfile(): FrontierAttackProfile {
        const region = player.highestRegion();
        if (region !== this.distributionRegion) {
            // Match randomRegion: uniform base IDs, then uniform eligible forms of each ID.
            const families = new Map<number, PokemonListData[]>();
            (pokemonList as PokemonListData[]).filter(p => p.id > 0 && p.nativeRegion >= GameConstants.Region.kanto && p.nativeRegion <= region).forEach(p => {
                const id = Math.floor(p.id);
                families.set(id, [...(families.get(id) || []), p]);
            });
            const types = new Map<string, { type1: PokemonType; type2: PokemonType; weight: number }>();
            families.forEach(forms => forms.forEach(p => {
                const type1 = p.type[0];
                const type2 = p.type[1] ?? PokemonType.None;
                const key = `${type1}/${type2}`;
                const entry = types.get(key) || { type1, type2, weight: 0 };
                entry.weight += 1 / families.size / forms.length;
                types.set(key, entry);
            }));
            this.distribution = [...types.values()];
            this.distributionRegion = region;
        }
        return this.distribution.map(p => ({
            damage: App.game.party.calculatePokemonAttack(p.type1, p.type2, true, GameConstants.Region.none, false, false, WeatherType.Clear),
            weight: p.weight,
        }));
    }

    private refreshPlan(): void {
        const profile = this.readProfile();
        const changed = profile.length !== this.profile.length || profile.some((p, i) =>
            Math.abs(p.damage - this.profile[i].damage) > Math.max(1, this.profile[i].damage * 0.05));
        if (changed) {
            this.samples = [];
            this.recentRate(0);
            this.votes = 0;
            this.failureCap = Infinity;
        }
        this.profile = profile;
        this.profileAt = Date.now();
        const highest = App.game.statistics.battleFrontierHighestStageCompleted();
        if (this.mode() === 'efficiency') {
            const plan = BattleFrontierAutomation.plan(Math.min(highest, this.failureCap), profile, this.timing, this.restartDelay);
            // The first uncleared stage remains available to new saves without a record.
            if (!plan && highest === 0 && BattleFrontierAutomation.stageMilliseconds(1, 0, profile) < GameConstants.GYM_TIME * 0.85) {
                this.plannedStart(1);
                this.plannedEnd(1);
                this.estimatedRate(60000 / (BattleFrontierAutomation.stageMilliseconds(1, 0, profile) + this.restartDelay));
            } else if (!plan) {
                this.stop('No safe farming range for the current team. Run paused; rewards are kept.');
                if (BattleFrontierRunner.started()) {
                    BattleFrontierRunner.end();
                }
                return;
            } else {
                this.plannedStart(plan.start);
                this.plannedEnd(plan.end);
                this.estimatedRate(plan.rate);
            }
        } else {
            const end = this.mode() === 'fixed' ? this.validTarget(this.fixedEndStage()) : highest + 1;
            this.plannedStart(Math.max(1, Math.min(highest + 1, end) - 99));
            this.plannedEnd(end);
            this.estimatedRate(0);
        }
        if (changed) {
            this.status('Team attack changed; recalculating with the current hatchery and bonuses.');
        }
    }

    private protectedStart(): number {
        return BattleFrontierMilestones.milestoneRewards.filter(m => m.isUnlocked() && !m.obtained())
            .reduce((start, m) => m.stage < start ? m.stage : start, this.plannedStart());
    }

    public runStarted(): void {
        this.runAt = Date.now();
        this.stageAt = this.runAt;
        this.attacks = 0;
        this.attackTime = 0;
        this.votes = 0;
        this.samples = [];
        this.recentRate(0);
        this.status('Running. Watching stage times and current team attack.');
    }

    public attacked(): void {
        if (this.active()) {
            this.attacks++;
            this.attackTime += GameConstants.BATTLE_FRONTIER_TICK
                * (BattleFrontierRunner.stage() > App.game.statistics.battleFrontierHighestStageCompleted() ? 2 : 1);
        }
    }

    public stageCompleted(stage: number): void {
        if (!this.active()) {
            return;
        }
        const now = Date.now();
        const elapsed = Math.max(1, now - this.stageAt);
        this.stageAt = now;
        const timing = this.attacks > 0 ? elapsed / this.attackTime : 1;
        this.attacks = 0;
        this.attackTime = 0;
        this.samples.push({ points: BattleFrontierAutomation.points(stage) - BattleFrontierAutomation.points(stage - 1), milliseconds: elapsed, timing });
        this.samples = this.samples.slice(-5);
        this.recentRate(this.samples.reduce((sum, s) => sum + s.points, 0) * 60000 / this.samples.reduce((sum, s) => sum + s.milliseconds, 0));
        if (this.samples.length >= 5) {
            this.timing = Math.max(1, Math.min(4, [...this.samples].map(s => s.timing).sort((a, b) => a - b)[2]));
        }
        if (BattleFrontierRunner.confirmationPending()) {
            return;
        }
        if (this.mode() === 'fixed' && stage >= this.validTarget(this.fixedEndStage())) {
            this.finishCycle('Target stage completed.');
        } else if (this.mode() === 'efficiency') {
            this.considerRestart(stage);
        }
    }

    private considerRestart(stage: number): void {
        // Both estimates use the same current type profile, never a pre-hatch historical BP rate.
        const highest = App.game.statistics.battleFrontierHighestStageCompleted();
        let nextTime = 0;
        for (let next = stage + 1; next <= stage + 5; next++) {
            nextTime += BattleFrontierAutomation.stageMilliseconds(next, highest, this.profile) * this.timing;
        }
        const nextRate = (BattleFrontierAutomation.points(stage + 5) - BattleFrontierAutomation.points(stage)) * 60000 / nextTime;
        const betterToRestart = this.estimatedRate() > nextRate * 1.1;
        this.votes = betterToRestart ? this.votes + 1 : 0;
        const enoughStages = stage - BattleFrontierRunner.runStartStage() + 1 >= Math.min(10, this.plannedEnd() - this.plannedStart() + 1);
        const enoughTime = Date.now() - this.runAt >= 15000;
        if (enoughStages && enoughTime && this.votes >= 3) {
            this.finishCycle('Restarting is more efficient for the current team.');
        } else if (enoughStages && enoughTime && stage >= this.plannedEnd() && !betterToRestart) {
            // Probe beyond the predicted endpoint rather than treating a learned layer as permanent.
            this.status('Continuing: the next stages still compete with restarting.');
        }
    }

    private finishCycle(reason: string): void {
        const rewards = BattleFrontierRunner.pendingRewards();
        this.earnedPoints(this.earnedPoints() + rewards.battlePoints);
        this.cycles(this.cycles() + 1);
        this.emptyFailures = rewards.stages ? 0 : this.emptyFailures;
        BattleFrontierRunner.settleAutomatic();
        this.restartAt = Date.now() + this.restartDelay;
        this.status(`${reason} Claiming rewards; next run starts in 1 second.`);
    }

    public lost(): void {
        const failedStage = BattleFrontierRunner.stage();
        const rewards = BattleFrontierRunner.pendingRewards();
        if (this.mode() === 'record' || BattleFrontierRunner.confirmationPending()) {
            this.earnedPoints(this.earnedPoints() + rewards.battlePoints);
            this.cycles(this.cycles() + 1);
            this.stop(this.mode() === 'record' ? 'Record attempt finished. Rewards claimed.' : 'Run ended while awaiting your confirmation. Automation stopped.');
            BattleFrontierRunner.settleAutomatic();
            return;
        }
        this.emptyFailures = rewards.stages ? 0 : this.emptyFailures + 1;
        this.finishCycle('Stage timed out; reassessing the next range.');
        if (this.mode() === 'efficiency') {
            this.failureCap = Math.min(this.failureCap, failedStage - 1);
        }
        if (this.emptyFailures >= 3) {
            this.stop('Stopped after 3 runs without a completed stage. Check team attack or the target.');
        }
    }

    public tick(): void {
        if (!this.active()) {
            return;
        }
        if (App.game.gameState !== GameConstants.GameState.battleFrontier) {
            this.stop('Automation stopped after leaving Battle Frontier.');
            return;
        }
        if (BattleFrontierRunner.confirmationPending()) {
            return;
        }
        if (Date.now() - this.profileAt >= 5000) {
            this.refreshPlan();
        }
        if (!this.active()) {
            return;
        }
        if (this.restartAt > 0 && Date.now() >= this.restartAt) {
            this.restartAt = 0;
            this.refreshPlan();
            if (this.active()) {
                BattleFrontierRunner.startAutomaticRun(this.protectedStart());
            }
        }
    }
}
