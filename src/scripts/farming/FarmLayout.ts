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
            errors.push('请先选择预设、导入布局或编辑格子。');
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

    private desiredMulch(cell: FarmLayoutCell, plot: Plot): number {
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
        return cell.mulch;
    }

    private mulchWindow(hand: FarmHand): number {
        const count = this.plan().cells.filter((cell, index) => cell.role !== 'ignore' && cell.role !== 'empty' && this.owner(index) === hand).length;
        // 预留一次巡田和体力恢复时间，续肥不能只够到紧接着的下一轮。
        return (Math.ceil(count / Math.max(1, hand.efficiency)) + 1) * hand.workTick / GameConstants.SECOND * 2 + 30;
    }

    private nextAction(index: number, hand: FarmHand): FarmLayoutAction | undefined {
        const farming = App.game.farming;
        const plot = farming.getFarmPlots(this.farmId)[index];
        const cell = this.plan().cells[index];
        if (!plot?.isUnlocked || plot.isSafeLocked || !this.isManaged(index) || cell.role === 'empty' || this.owner(index) !== hand || !this.matches(cell, plot)) {
            return undefined;
        }
        if (plot.berry === BerryType.None && ['keep', 'cycle', 'evolve'].includes(cell.role)) {
            if (farming.unlockedBerries[cell.berry]?.() && farming.hasBerry(cell.berry)) {
                return { index, kind: 'plant', berry: cell.berry, priority: 2 };
            }
            return undefined;
        }
        const harvest = this.shouldHarvest(cell, plot);
        if (harvest && cell.role === 'cycle' && !this.supportsReady()) {
            return undefined;
        }
        const mulch = this.desiredMulch(cell, plot);
        if (mulch !== MulchType.None) {
            const compatible = plot.mulch === MulchType.None || plot.mulch === mulch;
            const duration = farming.getMulchDurationMultiplier();
            const window = this.mulchWindow(hand) / duration;
            const needed = plot.mulch !== mulch || (mulch !== MulchType.Rich_Mulch && plot.mulchTimeLeft <= window);
            if (compatible && needed && farming.hasMulch(mulch)) {
                const amount = mulch === MulchType.Rich_Mulch ? 1 : Math.max(1, Math.ceil((window * 2 - plot.mulchTimeLeft) / GameConstants.MULCH_USE_TIME));
                return { index, kind: 'mulch', mulch, amount, priority: mulch === MulchType.Freeze_Mulch ? 0 : harvest ? 1 : 3 };
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
            // 同优先级轮流巡格，防止低效率助手总照顾第一格而饿死后面的格子。
            actions.sort((left, right) => left.priority - right.priority || ((left.index - this.nextIndex + 25) % 25) - ((right.index - this.nextIndex + 25) % 25));
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
        if (cell.role === 'empty') {
            return plot.berry === BerryType.None ? '隔离留空，不种植' : `隔离格已有 ${BerryType[plot.berry]}，保留现场，请手动处理`;
        }
        if (!this.matches(cell, plot)) {
            return `已有 ${BerryType[plot.berry]} 与布局不符，保留现场，请手动处理`;
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
                return `缺少 ${BerryType[cell.berry]} 种子`;
            }
            return `等待 ${hand.name} 播种`;
        }
        const mulch = this.desiredMulch(cell, plot);
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
            return '保持空位，等待游戏规则触发突变';
        }
        if (this.shouldHarvest(cell, plot)) {
            if (cell.role === 'cycle' && !this.supportsReady()) {
                return '等待布局中的原料或光环株全部成熟后再收获';
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
