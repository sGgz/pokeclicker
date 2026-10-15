class FarmLayoutController {
    public static selectedPreset = ko.observable('lum-mutation');
    public static productionBerry = ko.observable(BerryType.Liechi);
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

    public static get presets() {
        return FarmLayoutPlan.presets;
    }

    public static get roles() {
        return FarmLayoutPlan.roles;
    }

    public static get mulches() {
        return FarmLayoutPlan.mulches;
    }

    public static preset() {
        return this.presets.find(preset => preset.id === this.selectedPreset());
    }

    public static needsProductionBerry(): boolean {
        return ['passho-rows', 'passho-ring', 'wacan-lum'].includes(this.selectedPreset());
    }

    public static berryOptions() {
        const farming = App.game.farming;
        return [
            { value: BerryType.None, text: '请选择树果' },
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

    public static generate() {
        try {
            const requirements = this.selectedPreset() === 'enigma-directions' ? EnigmaMutation.getReqs() : undefined;
            this.layout().setPlan(FarmLayoutPlan.createPreset(this.selectedPreset(), this.productionBerry(), requirements));
            this.selectedCell(0);
            this.hasError(false);
            this.feedback('预设已载入当前田的布局预览。现有作物和肥料未被改动。');
        } catch (error) {
            this.showError(error);
        }
    }

    public static importPlan() {
        try {
            this.layout().setPlan(FarmLayoutPlan.parse(this.importText()));
            this.selectedCell(0);
            this.hasError(false);
            this.feedback('导入成功，请核对每格角色后启用。模拟器中的植物年龄不会写入农田。');
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
            return cell.targetBerry >= 0 ? BerryType[cell.targetBerry] : '等待突变';
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
        return `第 ${Math.floor(index / 5) + 1} 行第 ${index % 5 + 1} 列，${this.roleText(index)}，${this.berryText(index)}，${this.currentText(index)}，${this.layout().status(index)}`;
    }
}
