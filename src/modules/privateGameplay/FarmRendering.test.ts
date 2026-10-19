import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ScriptTarget, transpileModule } from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function panel(file: string, selector: string, shown: boolean, tab = 'berryFarmView') {
    const documentSource = document.createElement('div');
    documentSource.innerHTML = readFileSync(`src/components/${file}`, 'utf8');
    const element = documentSource.querySelector(selector) as HTMLElement;
    // 使用真实容器绑定，仅将内部业务控件替换为可计数的昂贵界面读取。
    element.innerHTML = '<span data-bind="text: readFarmUi()"></span>';
    document.body.appendChild(element);
    const visibility = ko.observable(shown ? 'show' : 'hidden');
    const selected = ko.observable(tab);
    const age = ko.observable(0);
    const readFarmUi = vi.fn(() => age());
    ko.applyBindings({
        readFarmUi,
        FarmController: { farmingModalTabSelected: selected },
        DisplayObservables: {
            modalState: { get farmModal() { return visibility(); } },
            collapseState: { get plotListCard() { return visibility(); } },
        },
        GameController: { keyHeld: { Shift: ko.observable(false) } },
    }, element);
    return { element, visibility, selected, age, readFarmUi, dispose: () => ko.removeNode(element) };
}

describe('农场界面的可见性与订阅生命周期', () => {
    it('关闭详情时不绑定内部内容，重新打开只恢复一份订阅', () => {
        const view = panel('farmModal.html', '.modal-content', false);
        expect(view.readFarmUi).not.toHaveBeenCalled();
        view.age(1);
        expect(view.readFarmUi).not.toHaveBeenCalled();
        view.visibility('show');
        expect(view.element.textContent).toBe('1');
        view.visibility('hidden');
        const calls = view.readFarmUi.mock.calls.length;
        view.age(2);
        expect(view.readFarmUi).toHaveBeenCalledTimes(calls);
        view.visibility('show');
        expect(view.element.textContent).toBe('2');
        view.dispose();
    });

    it('折叠主界面农场后停止内部读取，展开后恢复最新内容', () => {
        const view = panel('farmDisplay.html', '#plotListCard', false);
        expect(view.readFarmUi).not.toHaveBeenCalled();
        view.age(7);
        view.visibility('show');
        expect(view.element.textContent).toBe('7');
        view.visibility('hidden');
        const calls = view.readFarmUi.mock.calls.length;
        view.age(8);
        expect(view.readFarmUi).toHaveBeenCalledTimes(calls);
        view.dispose();
    });

    it.each(['berryFarmView', 'farmHandsView', 'farmLayoutView', 'berryDexView', 'helpView'])('只挂载当前页签：%s', (tab) => {
        const view = panel('farmModal.html', `#${tab}`, true, 'other');
        expect(view.readFarmUi).not.toHaveBeenCalled();
        view.age(3);
        view.selected(tab);
        expect(view.element.textContent).toBe('3');
        view.selected('other');
        const calls = view.readFarmUi.mock.calls.length;
        view.age(4);
        expect(view.readFarmUi).toHaveBeenCalledTimes(calls);
        view.dispose();
    });
});

describe('农场提示按需订阅', () => {
    it('没有悬停时不计算，悬停期间更新，隐藏和销毁后停止订阅', () => {
        vi.useFakeTimers();
        const source = readFileSync('src/modules/koBindingHandlers.ts', 'utf8');
        const start = source.indexOf('const lazyTooltipHandler =');
        const end = source.indexOf('\nObject.assign(ko.bindingHandlers,', start);
        expect(start).toBeGreaterThan(0);
        const events = new Map<string, () => void>();
        const inner = document.createElement('span');
        const tip = document.createElement('div');
        inner.className = 'tooltip-inner';
        tip.appendChild(inner);
        let options;
        let disposed = false;
        const jquery = {
            tooltip(value) { if (value === 'dispose') disposed = true; else options = value; return jquery; },
            on(name, handler) { events.set(name, handler); return jquery; },
            off() { events.clear(); return jquery; },
            data: () => ({ tip }),
        };
        const javascript = transpileModule(source.slice(start, end), { compilerOptions: { target: ScriptTarget.ES2020 } }).outputText;
        const scopedKo = Object.create(ko);
        Object.defineProperty(scopedKo, 'bindingHandlers', { value: { tooltip: { options: {} } } });
        const handler = runInNewContext(`${javascript}\nlazyTooltipHandler`, { ko: scopedKo, $: () => jquery });
        const element = document.createElement('div');
        document.body.appendChild(element);
        const age = ko.observable(0);
        const title = vi.fn(() => `剩余 ${age()} 秒`);
        try {
            handler.init(element, () => ({ title, html: true }));
            age(1);
            vi.advanceTimersByTime(300);
            expect(title).not.toHaveBeenCalled();
            expect(options.title()).toBe('剩余 1 秒');
            events.get('show.bs.tooltip.farmLazyTooltip')();
            age(2);
            vi.advanceTimersByTime(300);
            expect(inner.textContent).toBe('剩余 2 秒');
            events.get('hidden.bs.tooltip.farmLazyTooltip')();
            const calls = title.mock.calls.length;
            age(3);
            vi.advanceTimersByTime(300);
            expect(title).toHaveBeenCalledTimes(calls);
            ko.removeNode(element);
            expect(disposed).toBe(true);
            expect(events.size).toBe(0);
        } finally {
            if (element.parentNode) ko.removeNode(element);
            vi.useRealTimers();
        }
    });
});
