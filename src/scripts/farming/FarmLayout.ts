/// <reference path="../../declarations/farming/FarmLayoutPlan.d.ts" />

type FarmLayoutIntent = ReturnType<typeof FarmLayoutPlan.blank>;
type FarmLayoutCell = FarmLayoutIntent['cells'][number];
type FarmLayoutAction = {
    index: number;
    kind: 'plant' | 'harvest' | 'mulch';
    priority: number;
    berry?: number;
    mulch?: number;
    amount?: number;
    growSeconds?: number;
    deadlineSeconds?: number;
};

class FarmLayout {
    enabled = ko.observable(false);
    plan = ko.observable<FarmLayoutIntent>(FarmLayoutPlan.blank());
    private nextIndex = 0;

    constructor(public farmId: number) {}

    setPlan(plan: FarmLayoutIntent): void {
        const normalized = FarmLayoutPlan.normalize(plan);
        this.enabled(false);
        this.plan(normalized);
        this.nextIndex = 0;
    }

    validation(): string[] {
        const errors: string[] = [];
        const cells = this.plan().cells;
        if (cells.every(cell => cell.role === 'ignore')) {
            errors.push('请先应用收藏、导入布局或编辑格子。');
        }
        cells.forEach((cell, index) => {
            const position = `${Math.floor(index / 5) + 1} 行 ${index % 5 + 1} 列`;
            if (['keep', 'cycle', 'evolve'].includes(cell.role) && cell.berry < 0) {
                errors.push(`${position}：请选择要种植或保留的树果。`);
            }
            if (cell.role === 'evolve' && (cell.targetBerry < 0 || cell.targetBerry === cell.berry)) {
                errors.push(`${position}：请选择不同于原株的进化目标。`);
            }
            if (cell.mulch === MulchType.Freeze_Mulch && cell.freezeStage !== PlotStage.Berry) {
                errors.push(`${position}：目前只支持成熟后冻结，请将冻结阶段设为成熟。`);
            }
        });
        return errors;
    }

    toggle(): void {
        if (this.enabled()) {
            this.enabled(false);
        } else if (!this.validation().length) {
            this.enabled(true);
        }
    }

    isManaged(index: number): boolean {
        const cell = this.plan().cells[index];
        return this.enabled() && !!cell && cell.role !== 'ignore';
    }

    private owner(index: number): FarmHand | undefined {
        return App.game.farming.farms()[this.farmId]?.hands.list.find(hand => hand.hired() && hand.isUnlocked() && hand.plots().includes(index));
    }

    private matches(cell: FarmLayoutCell, plot: Plot): boolean {
        return plot.berry === BerryType.None || cell.role === 'mutation' || plot.berry === cell.berry
            || (cell.role === 'evolve' && plot.berry === cell.targetBerry);
    }

    private shouldHarvest(cell: FarmLayoutCell, plot: Plot): boolean {
        return plot.berry !== BerryType.None && plot.stage() === PlotStage.Berry
            && (cell.role === 'mutation' || cell.role === 'cycle' || (cell.role === 'evolve' && plot.berry === cell.targetBerry));
    }

    private supportsReady(): boolean {
        const plots = App.game.farming.getFarmPlots(this.farmId);
        return this.plan().cells.every((cell, index) => cell.role !== 'keep'
            || (plots[index]?.berry === cell.berry && plots[index].stage() === PlotStage.Berry));
    }

    private mutationOpportunity(index: number, cell: FarmLayoutCell): { ready: boolean; reason: string } {
        const plot = App.game.farming.getFarmPlots(this.farmId)[index];
        if (cell.role === 'mutation' && plot.berry !== BerryType.None) {
            return { ready: false, reason: '突变产物正在生长，不追加突变肥料' };
        }
        if (cell.targetBerry < 0) {
            return { ready: false, reason: '请选择突变目标，未指定目标时不追加突变肥料' };
        }
        const definitions = App.game.farming.mutations.filter(mutation => mutation.mutatedBerry === cell.targetBerry);
        if (!definitions.length) {
            return { ready: false, reason: '没有匹配目标的突变配方，不追加突变肥料' };
        }
        let unlocked = false;
        let eligible = false;
        // Enigma 查询会重设共用种子，资格预览必须恢复随机数状态。
        const previousSeed = SeededRand.state;
        try {
            const ready = definitions.some(definition => {
                const mutation = definition.forFarm(this.farmId);
                if (!mutation.unlocked) {
                    return false;
                }
                unlocked = true;
                if (!mutation.getMutationPlots().includes(index)) {
                    return false;
                }
                eligible = true;
                return mutation.getTotalMutationChance(index) > 0;
            });
            if (ready) {
                return { ready: true, reason: `已具备 ${BerryType[cell.targetBerry]} 突变机会` };
            }
        } finally {
            SeededRand.state = previousSeed;
        }
        return { ready: false, reason: !unlocked ? '目标配方尚未解锁，检查原料和任务条件'
            : eligible ? '当前目标突变概率为零，不追加突变肥料' : '目标配方条件未满足，不追加突变肥料' };
    }

    private isTimingSource(cell: FarmLayoutCell): boolean {
        return (cell.role === 'keep' || cell.role === 'evolve')
            && this.plan().cells.some(candidate => candidate.role === 'mutation' || candidate.role === 'evolve');
    }

    private isProductionSupport(cell: FarmLayoutCell): boolean {
        return cell.role === 'keep' && this.plan().cells.some(candidate => candidate.role === 'cycle');
    }

    private seedWaitReason(berry: number): string {
        const locations = App.game.farming.getFarmPlots(this.farmId).flatMap((plot, index) => {
            if (plot.berry !== berry) {
                return [];
            }
            const position = `${Math.floor(index / 5) + 1} 行 ${index % 5 + 1} 列`;
            if (plot.isSafeLocked || this.plan().cells[index].role === 'ignore') {
                return [`${position} 有原株，但安全锁或不托管使其需要手动采收`];
            }
            return this.needsRecovery(this.plan().cells[index], plot) ? [`${position} 有错位原株，等待成熟采收回收`] : [];
        });
        return `缺少 ${BerryType[berry]} 种子${locations.length ? `；${locations.join('；')}` : '，等待补充'}`;
    }

    private seedShortage(): string | undefined {
        const farming = App.game.farming;
        const plots = farming.getFarmPlots(this.farmId);
        const needed = new Map<number, number>();
        this.plan().cells.forEach((cell, index) => {
            if ((this.isTimingSource(cell) || this.isProductionSupport(cell)) && cell.berry >= 0
                && plots[index]?.berry !== cell.berry && !(cell.role === 'evolve' && plots[index]?.berry === cell.targetBerry)) {
                needed.set(cell.berry, (needed.get(cell.berry) ?? 0) + 1);
            }
        });
        for (const [berry, count] of needed) {
            if (!farming.unlockedBerries[berry]?.() || farming.berryInventory[berry]() < count) {
                return `${BerryType[berry]} 原料种子不足（需 ${count}，现有 ${farming.berryInventory[berry]()}），等待回收或补充后再播种`;
            }
        }
        return undefined;
    }

    private productionSeconds(): number {
        const farming = App.game.farming;
        const plots = farming.getFarmPlots(this.farmId);
        const times = this.plan().cells.map((cell, index) => {
            if (cell.role !== 'cycle' || !plots[index]?.isUnlocked || plots[index].isSafeLocked || !this.owner(index)
                || !this.matches(cell, plots[index]) || cell.berry < 0) {
                return Infinity;
            }
            if (plots[index].berry === BerryType.None && !farming.hasBerry(cell.berry)) {
                return Infinity;
            }
            return this.maturitySeconds(index, cell);
        });
        return Math.min(...times);
    }

    private maturitySeconds(index: number, cell: FarmLayoutCell): number {
        const farming = App.game.farming;
        const plot = farming.getFarmPlots(this.farmId)[index];
        if (!plot?.isUnlocked || cell.berry < 0 || !this.matches(cell, plot)) {
            return Infinity;
        }
        if (cell.role === 'evolve' && plot.berry === cell.targetBerry) {
            return 0;
        }
        if (plot.berry !== BerryType.None && plot.stage() === PlotStage.Berry) {
            return 0;
        }
        if (plot.berry === BerryType.None && (plot.isSafeLocked || !this.owner(index) || !farming.unlockedBerries[cell.berry]?.() || !farming.hasBerry(cell.berry))) {
            return Infinity;
        }
        const multiplier = farming.getGrowthMultiplier() * plot.getGrowthMultiplier(PlotStage.Seed);
        if (!(multiplier > 0) || !Number.isFinite(multiplier)) {
            return Infinity;
        }
        const age = plot.berry === BerryType.None ? 0 : plot.age;
        return Math.max(0, BerryList[cell.berry].growthTime[PlotStage.Bloom] - age) / multiplier;
    }

    private plantingSchedule(index: number, cell: FarmLayoutCell): { wait: number; growSeconds: number; reason?: string } {
        const productionSupport = this.isProductionSupport(cell);
        if (!this.isTimingSource(cell) && !productionSupport && cell.role !== 'cycle') {
            return { wait: 0, growSeconds: 0 };
        }
        const growSeconds = this.maturitySeconds(index, cell);
        if (!Number.isFinite(growSeconds)) {
            return { wait: Infinity, growSeconds, reason: '原料格无法生长或播种，检查冻结肥料、锁定、种子和助手' };
        }
        const shortage = this.seedShortage();
        if (shortage) {
            return { wait: Infinity, growSeconds, reason: shortage };
        }
        if (productionSupport) {
            const production = this.productionSeconds();
            if (!Number.isFinite(production)) {
                return { wait: Infinity, growSeconds, reason: '缺少可生长的生产株，等待关键种子回收、补种或解除生产格阻塞后再播光环株' };
            }
            // 生长光环要尽早发挥作用，增产光环才按收获窗口安排。
            const growthAura = BerryList[cell.berry].aura?.auraType === AuraType.Growth
                || (BerryList[cell.berry].aura?.auraType === AuraType.Boost && Plot.findNearPlots(index)
                    .some(position => BerryList[this.plan().cells[position].berry]?.aura?.auraType === AuraType.Growth));
            if (growthAura) {
                return { wait: 0, growSeconds };
            }
            return { wait: Math.max(0, production - growSeconds), growSeconds };
        }
        if (cell.role === 'cycle') {
            const supportTimes = this.plan().cells.map((support, position) => support.role === 'keep' ? this.maturitySeconds(position, support) : 0);
            if (supportTimes.some(time => !Number.isFinite(time))) {
                return { wait: Infinity, growSeconds, reason: '生产辅助格存在冲突、锁定或无法生长，等待恢复后再播生产株' };
            }
            return { wait: Math.max(0, Math.max(...supportTimes) - growSeconds), growSeconds };
        }
        const sourceTimes = this.plan().cells.map((source, position) => this.isTimingSource(source) ? this.maturitySeconds(position, source) : 0);
        if (sourceTimes.some(time => !Number.isFinite(time))) {
            return { wait: Infinity, growSeconds, reason: '突变原料存在阻塞，等待处理错种、冻结幼苗、缺种或未分配的格子' };
        }
        return { wait: Math.max(0, Math.max(...sourceTimes) - growSeconds), growSeconds };
    }

    private freezeTimingBlock(index: number, cell: FarmLayoutCell, hand: FarmHand): string | undefined {
        if (!this.isTimingSource(cell) || cell.mulch !== MulchType.Freeze_Mulch) {
            return undefined;
        }
        if (cell.berry !== BerryType.Petaya && App.game.farming.berryInFarm(BerryType.Petaya, PlotStage.Berry, true, this.farmId)) {
            return undefined;
        }
        const plot = App.game.farming.getFarmPlots(this.farmId)[index];
        const growSeconds = this.maturitySeconds(index, cell);
        const decay = App.game.farming.getGrowthMultiplier() * plot.getGrowthMultiplier(PlotStage.Berry);
        if (!(decay > 0) || !Number.isFinite(growSeconds)) {
            return undefined;
        }
        const ripeSeconds = (BerryList[cell.berry].growthTime[PlotStage.Berry] - BerryList[cell.berry].growthTime[PlotStage.Bloom]) / decay;
        const cycle = Math.ceil(hand.workTick / GameConstants.TICK_TIME) * GameConstants.TICK_TIME / GameConstants.SECOND;
        const firstWork = hand.energy() + hand.recovery <= FarmHand.WORK_ENERGY_COST ? cycle * 2 : cycle;
        const firstRipeWork = Math.max(firstWork, Math.ceil(growSeconds / cycle) * cycle);
        if (firstRipeWork + GameConstants.TICK_TIME / GameConstants.SECOND >= growSeconds + ripeSeconds) {
            return '当前助手来不及首次冻结此原料，暂停播种；请改派更快助手或手动完成成熟冻结';
        }
        return undefined;
    }

    private desiredMulch(cell: FarmLayoutCell, plot: Plot, index: number): number {
        if (cell.role === 'ignore' || cell.role === 'empty') {
            return MulchType.None;
        }
        if (this.shouldHarvest(cell, plot) && cell.mulch !== MulchType.Rich_Mulch) {
            return MulchType.None;
        }
        if (plot.berry !== BerryType.None && plot.stage() === PlotStage.Berry
            && (cell.mulch === MulchType.Boost_Mulch || (cell.role === 'keep' && cell.mulch === MulchType.Amaze_Mulch))) {
            return MulchType.None;
        }
        if (cell.mulch === MulchType.Freeze_Mulch && (plot.berry === BerryType.None || plot.stage() !== PlotStage.Berry || this.shouldHarvest(cell, plot))) {
            return MulchType.None;
        }
        // 产量肥只在准备收获时使用，避免长周期作物在生长中白白耗肥。
        if (cell.mulch === MulchType.Rich_Mulch && !this.shouldHarvest(cell, plot)) {
            return MulchType.None;
        }
        const mutationBoost = (cell.role === 'mutation' || cell.role === 'evolve')
            && (cell.mulch === MulchType.Surprise_Mulch || cell.mulch === MulchType.Amaze_Mulch);
        if ((mutationBoost || (cell.role === 'mutation' && plot.berry === BerryType.None)) && !this.mutationOpportunity(index, cell).ready) {
            return MulchType.None;
        }
        return cell.mulch;
    }

    private mulchWindow(hand: FarmHand): number {
        const count = this.plan().cells.filter((cell, index) => cell.role !== 'ignore' && cell.role !== 'empty' && this.owner(index) === hand).length;
        // 预留一次巡田和体力恢复时间，续肥不能只够到紧接着的下一轮。
        return (Math.ceil(count / Math.max(1, hand.efficiency)) + 1) * hand.workTick / GameConstants.SECOND * 2 + 30;
    }

    private freezeDeadlineSeconds(plot: Plot): number {
        if (plot.mulch === MulchType.Freeze_Mulch) {
            return plot.mulchTimeLeft * App.game.farming.getMulchDurationMultiplier();
        }
        const decay = App.game.farming.getGrowthMultiplier() * plot.getGrowthMultiplier(PlotStage.Berry);
        return decay > 0 ? Math.max(0, BerryList[plot.berry].growthTime[PlotStage.Berry] - plot.age) / decay : Infinity;
    }

    private needsRecovery(cell: FarmLayoutCell, plot: Plot): boolean {
        return plot.berry !== BerryType.None && (cell.role === 'empty' || !this.matches(cell, plot));
    }

    private witherSeconds(plot: Plot): number {
        if (plot.berry !== BerryType.Petaya && App.game.farming.berryInFarm(BerryType.Petaya, PlotStage.Berry, true, this.farmId)) {
            return Infinity;
        }
        const frozen = plot.mulch === MulchType.Freeze_Mulch;
        const speed = App.game.farming.getGrowthMultiplier() * plot.getGrowthMultiplier(PlotStage.Berry, frozen ? MulchType.None : plot.mulch);
        const freezeLeft = frozen ? plot.mulchTimeLeft * App.game.farming.getMulchDurationMultiplier() : 0;
        return speed > 0 ? freezeLeft + Math.max(0, BerryList[plot.berry].growthTime[PlotStage.Berry] - plot.age) / speed : Infinity;
    }

    private shouldRescue(cell: FarmLayoutCell, plot: Plot, hand: FarmHand): boolean {
        if (plot.berry === BerryType.None || plot.stage() !== PlotStage.Berry || !['keep', 'evolve', 'cycle'].includes(cell.role)) {
            return false;
        }
        // 刚成熟时至少保留本轮突变窗口，不能因助手周期长就立刻收走整阵母株。
        if (plot.age <= BerryList[plot.berry].growthTime[PlotStage.Bloom]) {
            return false;
        }
        const cycle = Math.ceil(hand.workTick / GameConstants.TICK_TIME) * GameConstants.TICK_TIME / GameConstants.SECOND;
        const nextWork = hand.energy() + hand.recovery <= FarmHand.WORK_ENERGY_COST ? cycle * 2 : cycle;
        return this.witherSeconds(plot) <= nextWork + GameConstants.TICK_TIME / GameConstants.SECOND;
    }

    private nextAction(index: number, hand: FarmHand): FarmLayoutAction | undefined {
        const farming = App.game.farming;
        const plot = farming.getFarmPlots(this.farmId)[index];
        const cell = this.plan().cells[index];
        if (!plot?.isUnlocked || plot.isSafeLocked || !this.isManaged(index) || this.owner(index) !== hand) {
            return undefined;
        }
        // 托管冲突只在成熟后采收回收种子，不铲幼株，也不免费搬迁作物或年龄。
        if (this.needsRecovery(cell, plot)) {
            return plot.stage() === PlotStage.Berry ? { index, kind: 'harvest', priority: 1, deadlineSeconds: this.witherSeconds(plot) } : undefined;
        }
        if (cell.role === 'empty') {
            return undefined;
        }
        if (plot.berry === BerryType.None && ['keep', 'cycle', 'evolve'].includes(cell.role)) {
            if (farming.unlockedBerries[cell.berry]?.() && farming.hasBerry(cell.berry)) {
                const schedule = this.plantingSchedule(index, cell);
                if (schedule.wait > 0.001 || this.freezeTimingBlock(index, cell, hand)) {
                    return undefined;
                }
                return { index, kind: 'plant', berry: cell.berry, priority: 2, growSeconds: schedule.growSeconds };
            }
            return undefined;
        }
        const harvest = this.shouldHarvest(cell, plot);
        if (harvest && cell.role === 'cycle' && !this.supportsReady()) {
            return this.shouldRescue(cell, plot, hand) ? { index, kind: 'harvest', priority: 1, deadlineSeconds: this.witherSeconds(plot) } : undefined;
        }
        const mulch = this.desiredMulch(cell, plot, index);
        const canFreeze = mulch === MulchType.Freeze_Mulch && (plot.mulch === MulchType.None || plot.mulch === mulch) && farming.hasMulch(mulch);
        if (this.shouldRescue(cell, plot, hand) && !canFreeze) {
            return { index, kind: 'harvest', priority: 1, deadlineSeconds: this.witherSeconds(plot) };
        }
        if (mulch !== MulchType.None) {
            const compatible = plot.mulch === MulchType.None || plot.mulch === mulch;
            const duration = farming.getMulchDurationMultiplier();
            const window = this.mulchWindow(hand) / duration;
            const needed = plot.mulch !== mulch || (mulch !== MulchType.Rich_Mulch && plot.mulchTimeLeft <= window);
            if (compatible && needed && farming.hasMulch(mulch)) {
                const amount = mulch === MulchType.Rich_Mulch ? 1 : Math.max(1, Math.ceil((window * 2 - plot.mulchTimeLeft) / GameConstants.MULCH_USE_TIME));
                return {
                    index, kind: 'mulch', mulch, amount, priority: mulch === MulchType.Freeze_Mulch ? 0 : harvest ? 1 : 3,
                    deadlineSeconds: mulch === MulchType.Freeze_Mulch ? this.freezeDeadlineSeconds(plot) : undefined,
                };
            }
            if (harvest && mulch === MulchType.Rich_Mulch && plot.mulch !== mulch) {
                return undefined;
            }
        }
        if (harvest) {
            return { index, kind: 'harvest', priority: 1 };
        }
        return undefined;
    }

    work(hand: FarmHand, budget: number): { actions: number; experience: number } {
        const result = { actions: 0, experience: 0 };
        if (!this.enabled() || !hand.hired() || !hand.isUnlocked() || hand.farmId !== this.farmId || this.validation().length) {
            return result;
        }
        const farming = App.game.farming;
        while (result.actions < budget) {
            const actions = this.plan().cells.map((_, index) => this.nextAction(index, hand)).filter((action): action is FarmLayoutAction => !!action);
            // 冻结先抢救将枯萎或将断肥的原料，其余同优先级轮流巡格。
            actions.sort((left, right) => left.priority - right.priority
                || (left.deadlineSeconds ?? Infinity) - (right.deadlineSeconds ?? Infinity)
                || (right.growSeconds ?? 0) - (left.growSeconds ?? 0)
                || ((left.index - this.nextIndex + 25) % 25) - ((right.index - this.nextIndex + 25) % 25));
            const action = actions[0];
            if (!action) {
                break;
            }
            let success = false;
            if (action.kind === 'plant') {
                success = farming.plant(action.index, action.berry, this.farmId);
            } else if (action.kind === 'harvest') {
                success = farming.harvest(action.index, this.farmId);
            } else {
                const plot = farming.getFarmPlots(this.farmId)[action.index];
                const before = plot.mulchTimeLeft;
                farming.addMulch(action.index, action.mulch, action.amount, this.farmId);
                success = plot.mulchTimeLeft > before;
            }
            if (!success) {
                break;
            }
            result.actions++;
            result.experience += action.kind === 'harvest' ? 2 : action.kind === 'plant' ? 1 : 0;
            this.nextIndex = (action.index + 1) % 25;
        }
        return result;
    }

    status(index: number): string {
        const cell = this.plan().cells[index];
        const farming = App.game.farming;
        const plot = farming.getFarmPlots(this.farmId)[index];
        if (!cell || cell.role === 'ignore') {
            return '交给助手原有策略';
        }
        if (!plot?.isUnlocked) {
            return '格子尚未解锁';
        }
        if (plot.isSafeLocked) {
            return '安全锁开启，助手不会操作';
        }
        if (this.needsRecovery(cell, plot)) {
            const prefix = plot.berry === BerryType.Kasib ? 'Kasib 可能来自自然枯萎后的突变；' : '';
            if (!this.owner(index)) {
                return `${prefix}已有 ${BerryType[plot.berry]} 与布局不符，需分配已雇用助手后才能成熟采收回收`;
            }
            return `${prefix}已有 ${BerryType[plot.berry]} 与布局不符，${!this.enabled() ? '启用后' : ''}${plot.stage() === PlotStage.Berry ? '等待助手采收回收种子后恢复布局' : '保留生长进度，等待成熟采收后恢复布局'}`;
        }
        if (cell.role === 'empty') {
            return '隔离留空，不种植';
        }
        if (['keep', 'cycle', 'evolve'].includes(cell.role) && cell.berry < 0) {
            return '尚未指定种植树果';
        }
        if (cell.role === 'evolve' && cell.targetBerry < 0) {
            return '尚未指定进化目标';
        }
        const hand = this.owner(index);
        if (!hand) {
            return '没有已雇用且允许操作此格的助手';
        }
        if (plot.berry === BerryType.None && cell.role !== 'mutation') {
            if (!farming.unlockedBerries[cell.berry]?.()) {
                return `${BerryType[cell.berry]} 尚未解锁`;
            }
            if (!farming.hasBerry(cell.berry)) {
                return this.seedWaitReason(cell.berry);
            }
            const freezeBlock = this.freezeTimingBlock(index, cell, hand);
            if (freezeBlock) {
                return freezeBlock;
            }
            const schedule = this.plantingSchedule(index, cell);
            if (schedule.reason) {
                return schedule.reason;
            }
            if (schedule.wait > 0.001) {
                return `错峰播种：约 ${GameConstants.formatSecondsToTime(Math.ceil(schedule.wait))} 后进入种植窗口，等待长周期原料`;
            }
            return `等待 ${hand.name} 播种`;
        }
        const canFreeze = cell.mulch === MulchType.Freeze_Mulch
            && (plot.mulch === MulchType.None || plot.mulch === cell.mulch) && farming.hasMulch(cell.mulch);
        if (this.shouldRescue(cell, plot, hand) && !canFreeze) {
            return '作物临近枯萎，等待助手先采收回收种子，再按现场成熟时间补种';
        }
        if ((cell.role === 'mutation' && plot.berry === BerryType.None) || (cell.role === 'evolve' && plot.berry === cell.berry)) {
            const opportunity = this.mutationOpportunity(index, cell);
            if (!opportunity.ready) {
                return opportunity.reason;
            }
        }
        const mulch = this.desiredMulch(cell, plot, index);
        if (mulch !== MulchType.None) {
            if (plot.mulch !== MulchType.None && plot.mulch !== mulch) {
                return '等待现有肥料耗尽，不自动铲肥';
            }
            if ((plot.mulch !== mulch || (mulch !== MulchType.Rich_Mulch && plot.mulchTimeLeft <= this.mulchWindow(hand) / farming.getMulchDurationMultiplier())) && !farming.hasMulch(mulch)) {
                return '缺少指定肥料，无法施肥或续肥';
            }
        }
        if (!this.enabled()) {
            return '预览中，启用后由助手执行';
        }
        if (cell.role === 'mutation' && plot.berry === BerryType.None) {
            return `已具备 ${BerryType[cell.targetBerry]} 突变机会，保持空位等待游戏判定`;
        }
        if (this.shouldHarvest(cell, plot)) {
            if (cell.role === 'cycle' && !this.supportsReady()) {
                return this.shouldRescue(cell, plot, hand) ? '生产株临近枯萎，先采收回收种子，再等待辅助株成熟窗口补种'
                    : '等待布局中的原料或光环株全部成熟后再收获';
            }
            return `等待 ${hand.name} 收获${mulch === MulchType.Rich_Mulch ? '（先施 Rich）' : ''}`;
        }
        if (cell.role === 'evolve' && plot.berry === cell.berry) {
            return `保留 ${BerryType[cell.berry]}，等待进化为 ${BerryType[cell.targetBerry]}`;
        }
        if (cell.mulch === MulchType.Freeze_Mulch && plot.stage() !== PlotStage.Berry) {
            return '保留原料，成熟后再冻结';
        }
        return cell.role === 'keep' ? '保留原料或光环株，不自动收获' : '等待作物成熟';
    }

    toJSON(): { enabled: boolean; plan: FarmLayoutIntent } {
        return { enabled: this.enabled(), plan: this.plan() };
    }

    fromJSON(data: unknown): void {
        this.enabled(false);
        if (!data || typeof data !== 'object') {
            return;
        }
        try {
            const saved = data as { plan?: unknown; enabled?: unknown };
            this.setPlan(FarmLayoutPlan.normalize(saved.plan));
            this.enabled(saved.enabled === true && !this.validation().length);
        } catch {
            // 异常布局单独丢弃，不能阻止其他农场和整个存档加载。
            this.plan(FarmLayoutPlan.blank());
        }
    }
}
