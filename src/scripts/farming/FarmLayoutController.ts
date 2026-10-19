class FarmLayoutController {
    public static selectedSavedId = ko.observable<number>();
    public static savedLayoutName = ko.observable('');
    public static savedLayouts = ko.pureComputed(() => App.game.farming.savedLayouts());
    public static selectedCell = ko.observable(0);
    public static importText = ko.observable('');
    private static feedbackText = ko.observable('');
    private static feedbackFarm = ko.observable(-1);
    public static feedback = ko.pureComputed({
        read: () => FarmLayoutController.feedbackFarm() === App.game.farming.selectedFarm() ? FarmLayoutController.feedbackText() : '',
        write: (message: string) => {
            FarmLayoutController.feedbackFarm(App.game.farming.selectedFarm());
            FarmLayoutController.feedbackText(message);
        },
    });
    public static hasError = ko.observable(false);

    public static layout() {
        const farming = App.game.farming;
        return farming.farms()[farming.selectedFarm()].layout;
    }

    // 同一份状态供格子标题和无障碍说明共用，倒计时刷新最多每秒四次。
    public static statuses = ko.pureComputed(() => {
        const layout = FarmLayoutController.layout();
        return layout.plan().cells.map((_, index) => layout.status(index));
    }).extend({ rateLimit: 250 });

    public static status(index: number): string {
        return this.statuses()[index];
    }

    public static get roles() {
        return FarmLayoutPlan.roles;
    }

    public static get mulches() {
        return FarmLayoutPlan.mulches;
    }

    public static selectedSavedLayout() {
        return this.savedLayouts().find(saved => saved.id === this.selectedSavedId());
    }

    public static selectSavedLayout() {
        this.savedLayoutName(this.selectedSavedLayout()?.plan.name ?? '');
    }

    private static namedSavedPlan(plan: ReturnType<typeof FarmLayoutPlan.blank>, exceptId?: number) {
        const named = FarmLayoutPlan.normalize({ ...plan, name: this.savedLayoutName() });
        if (this.savedLayouts().some(saved => saved.id !== exceptId && saved.plan.name === named.name)) {
            throw new Error('已有同名收藏，请使用其他名称。');
        }
        return named;
    }

    public static saveCurrentLayout() {
        try {
            const saved = App.game.farming.savedLayouts;
            if (saved().length >= FarmLayoutPlan.MAX_SAVED_LAYOUTS) {
                throw new Error(`最多保存 ${FarmLayoutPlan.MAX_SAVED_LAYOUTS} 份布局，请先删除不需要的收藏。`);
            }
            // 复制编辑器中的完整任务意图，不从现场植物或肥料推断角色。
            const plan = this.namedSavedPlan(this.layout().plan());
            let id = 1;
            while (saved().some(item => item.id === id)) {
                id++;
            }
            saved.push({ id, plan });
            this.selectedSavedId(id);
            this.savedLayoutName(plan.name);
            this.hasError(false);
            this.feedback(`已保存收藏“${plan.name}”。`);
        } catch (error) {
            this.showError(error);
        }
    }

    public static applySavedLayout() {
        try {
            const saved = this.selectedSavedLayout();
            if (!saved) {
                throw new Error('请先选择已保存的布局。');
            }
            this.layout().setPlan(saved.plan);
            this.selectedCell(0);
            this.hasError(false);
            this.feedback(`已应用“${saved.plan.name}”为暂停预览，核对后可启用布局。`);
        } catch (error) {
            this.showError(error);
        }
    }

    public static renameSavedLayout() {
        try {
            const saved = this.selectedSavedLayout();
            if (!saved) {
                throw new Error('请先选择要重命名的布局。');
            }
            const plan = this.namedSavedPlan(saved.plan, saved.id);
            const collection = App.game.farming.savedLayouts;
            collection.splice(collection().findIndex(item => item.id === saved.id), 1, { id: saved.id, plan });
            this.savedLayoutName(plan.name);
            this.hasError(false);
            this.feedback(`收藏已重命名为“${plan.name}”。`);
        } catch (error) {
            this.showError(error);
        }
    }

    public static deleteSavedLayout() {
        const saved = this.selectedSavedLayout();
        if (!saved) {
            return;
        }
        App.game.farming.savedLayouts.remove(saved);
        this.selectedSavedId(undefined);
        this.savedLayoutName('');
        this.hasError(false);
        this.feedback(`已删除收藏“${saved.plan.name}”，当前田的布局保持原样。`);
    }

    public static berryOptions(emptyText = '请选择树果') {
        const farming = App.game.farming;
        return [
            { value: BerryType.None, text: emptyText },
            ...Object.values(BerryType).filter((berry): berry is BerryType => typeof berry === 'number' && berry >= 0).map(berry => ({
                value: berry,
                text: `${BerryType[berry]} · ${farming.unlockedBerries[berry]() ? farming.berryInventory[berry]().toLocaleString('en-US') : '未解锁'}`,
            })),
        ];
    }

    public static planName = ko.pureComputed({
        read: () => FarmLayoutController.layout().plan().name,
        write: (name: string) => FarmLayoutController.editPlan({ name }),
    });

    public static role = ko.pureComputed({
        read: () => FarmLayoutController.cell().role,
        write: (role: ReturnType<typeof FarmLayoutPlan.blank>['cells'][number]['role']) => {
            const cell = FarmLayoutController.cell();
            const needsBerry = ['keep', 'cycle', 'evolve'].includes(role);
            const plot = App.game.farming.getFarmPlots(App.game.farming.selectedFarm())[FarmLayoutController.selectedCell()];
            const berry = needsBerry && cell.berry === BerryType.None ? (plot.berry === BerryType.None ? BerryType.Cheri : plot.berry) : cell.berry;
            FarmLayoutController.editCell({ role, berry });
        },
    });

    public static berry = ko.pureComputed({
        read: () => FarmLayoutController.cell().berry,
        write: (berry: BerryType) => FarmLayoutController.editCell({ berry }),
    });

    public static targetBerry = ko.pureComputed({
        read: () => FarmLayoutController.cell().targetBerry,
        write: (targetBerry: BerryType) => FarmLayoutController.editCell({ targetBerry }),
    });

    public static mulch = ko.pureComputed({
        read: () => FarmLayoutController.cell().mulch,
        write: (mulch: MulchType) => FarmLayoutController.editCell({ mulch }),
    });

    public static cell() {
        return this.layout().plan().cells[this.selectedCell()];
    }

    public static editPlan(change: Partial<ReturnType<typeof FarmLayoutPlan.blank>>) {
        try {
            this.layout().setPlan(FarmLayoutPlan.normalize({ ...this.layout().plan(), ...change }));
            this.hasError(false);
            this.feedback('布局已保存为预览，自动执行已暂停。确认格子和提示后可启用。');
        } catch (error) {
            this.showError(error);
        }
    }

    public static editCell(change: Partial<ReturnType<typeof FarmLayoutPlan.blank>['cells'][number]>) {
        const cells = this.layout().plan().cells.map((cell, index) => index === this.selectedCell() ? { ...cell, ...change } : { ...cell });
        this.editPlan({ cells });
    }

    public static importPlan() {
        try {
            this.layout().setPlan(FarmLayoutPlan.parse(this.importText()));
            this.selectedCell(0);
            this.hasError(false);
            this.feedback('导入成功，请核对每格角色和突变目标后启用。未指定目标时停止追加突变肥，模拟器中的植物年龄不会写入农田。');
        } catch (error) {
            this.showError(error);
        }
    }

    public static reset() {
        this.layout().setPlan(FarmLayoutPlan.blank());
        this.selectedCell(0);
        this.hasError(false);
        this.feedback('当前布局已清空为不托管，田里的作物和肥料未被改动。');
    }

    public static toggle() {
        try {
            const wasEnabled = this.layout().enabled();
            this.layout().toggle();
            this.hasError(false);
            this.feedback(this.layout().enabled() ? '布局已启用，雇用助手将在工作范围内执行。' : wasEnabled ? '布局已暂停，助手恢复普通工作规则。' : '请先补全下方配置提示，再启用布局。');
        } catch (error) {
            this.showError(error);
        }
    }

    private static showError(error: unknown) {
        this.hasError(true);
        this.feedback(error instanceof Error ? error.message : '布局处理失败，请检查导入内容。');
    }

    public static exportText = ko.pureComputed(() => JSON.stringify(FarmLayoutController.layout().plan(), null, 2));

    public static roleText(index: number): string {
        return this.roles.find(role => role.value === this.layout().plan().cells[index].role)?.text ?? '未设置';
    }

    public static berryText(index: number): string {
        const cell = this.layout().plan().cells[index];
        if (cell.role === 'ignore') {
            return '沿用助手规则';
        }
        if (cell.role === 'empty') {
            return '隔离留空';
        }
        if (cell.role === 'mutation') {
            return cell.targetBerry >= 0 ? `等待 ${BerryType[cell.targetBerry]}` : '未指定突变目标';
        }
        if (cell.role === 'evolve') {
            return `${cell.berry >= 0 ? BerryType[cell.berry] : '未选'} → ${cell.targetBerry >= 0 ? BerryType[cell.targetBerry] : '未选'}`;
        }
        return cell.berry >= 0 ? BerryType[cell.berry] : '请选择树果';
    }

    public static mulchText(index: number): string {
        const cell = this.layout().plan().cells[index];
        if (cell.role === 'ignore') {
            return '';
        }
        if (cell.mulch === MulchType.Freeze_Mulch) {
            return '成熟后 Freeze';
        }
        if (cell.mulch === MulchType.Rich_Mulch) {
            return '收获前 Rich';
        }
        if (['mutation', 'evolve'].includes(cell.role) && [MulchType.Surprise_Mulch, MulchType.Amaze_Mulch].includes(cell.mulch)) {
            return `有目标突变机会时 ${cell.mulch === MulchType.Surprise_Mulch ? 'Surprise' : 'Amaze'}`;
        }
        return this.mulches.find(mulch => mulch.value === cell.mulch)?.text ?? '不追加肥料';
    }

    public static currentText(index: number): string {
        const plot = App.game.farming.getFarmPlots(App.game.farming.selectedFarm())[index];
        if (!plot.isUnlocked) {
            return '当前：未解锁';
        }
        if (plot.berry === BerryType.None) {
            return '当前：空格';
        }
        return `当前：${BerryType[plot.berry]}${plot.stage() === PlotStage.Berry ? '（成熟）' : ''}`;
    }

    public static blocked(index: number): boolean {
        const cell = this.layout().plan().cells[index];
        const plot = App.game.farming.getFarmPlots(App.game.farming.selectedFarm())[index];
        if (cell.role === 'ignore') {
            return false;
        }
        if (!plot.isUnlocked || plot.isSafeLocked) {
            return true;
        }
        if (plot.berry === BerryType.None || cell.role === 'mutation') {
            return false;
        }
        return cell.role === 'empty' || (plot.berry !== cell.berry && !(cell.role === 'evolve' && plot.berry === cell.targetBerry));
    }

    public static cellLabel(index: number): string {
        return `第 ${Math.floor(index / 5) + 1} 行第 ${index % 5 + 1} 列，${this.roleText(index)}，${this.berryText(index)}，${this.currentText(index)}，${this.status(index)}`;
    }
}
