import { describe, expect, it } from 'vitest';
import BerryType from '../enums/BerryType';
import MulchType from '../enums/MulchType';
import PlotStage from '../enums/PlotStage';
import { BerryList } from './BerryList';
import FarmLayoutPlan from './FarmLayoutPlan';

// 官方 Wiki 的 Lum 优化阵分享码，固定保留用于验证真实导入兼容。
const WIKI_LUM = 'eyJzYXZlIjp7ImZhcm1pbmciOnsicGxvdExpc3QiOlt7ImJlcnJ5Ijo3LCJhZ2UiOjEyMDAsIm11bGNoIjo0fSx7ImJlcnJ5Ijo2LCJhZ2UiOjYwMCwibXVsY2giOjR9LHsiYmVycnkiOjQsImFnZSI6MjQwLCJtdWxjaCI6NH0seyJiZXJyeSI6NiwiYWdlIjo2MDAsIm11bGNoIjo0fSx7ImJlcnJ5Ijo3LCJhZ2UiOjEyMDAsIm11bGNoIjo0fSx7ImJlcnJ5Ijo1LCJhZ2UiOjQ4MCwibXVsY2giOjR9LHsiYmVycnkiOi0xLCJhZ2UiOjAsIm11bGNoIjoyfSx7ImJlcnJ5IjoyLCJhZ2UiOjEyMCwibXVsY2giOjR9LHsiYmVycnkiOi0xLCJhZ2UiOjAsIm11bGNoIjoyfSx7ImJlcnJ5Ijo1LCJhZ2UiOjQ4MCwibXVsY2giOjR9LHsiYmVycnkiOjMsImFnZSI6MTYwLCJtdWxjaCI6NH0seyJiZXJyeSI6MSwiYWdlIjo4MCwibXVsY2giOjR9LHsiYmVycnkiOjAsImFnZSI6NjAsIm11bGNoIjo0fSx7ImJlcnJ5IjoxLCJhZ2UiOjgwLCJtdWxjaCI6NH0seyJiZXJyeSI6MywiYWdlIjoxNjAsIm11bGNoIjo0fSx7ImJlcnJ5Ijo1LCJhZ2UiOjQ4MCwibXVsY2giOjR9LHsiYmVycnkiOi0xLCJhZ2UiOjAsIm11bGNoIjoyfSx7ImJlcnJ5IjoyLCJhZ2UiOjEyMCwibXVsY2giOjR9LHsiYmVycnkiOi0xLCJhZ2UiOjAsIm11bGNoIjoyfSx7ImJlcnJ5Ijo1LCJhZ2UiOjQ4MCwibXVsY2giOjR9LHsiYmVycnkiOjcsImFnZSI6MTIwMCwibXVsY2giOjR9LHsiYmVycnkiOjYsImFnZSI6NjAwLCJtdWxjaCI6NH0seyJiZXJyeSI6NCwiYWdlIjoyNDAsIm11bGNoIjo0fSx7ImJlcnJ5Ijo2LCJhZ2UiOjYwMCwibXVsY2giOjR9LHsiYmVycnkiOjcsImFnZSI6MTIwMCwibXVsY2giOjR9XX19fQ==';

function encoded(value: unknown): string {
    return btoa(unescape(encodeURIComponent(JSON.stringify(value))));
}

// 用户提供的 Wiki Rabuta 模板：四株 Aguav 与二十一株施 Surprise 的 Aspear。
const WIKI_RABUTA = encoded({
    save: {
        farming: {
            plotList: Array.from({ length: 25 }, (_, index) => [6, 9, 21, 24].includes(index)
                ? { berry: BerryType.Aguav, age: 700, mulch: MulchType.None }
                : { berry: BerryType.Aspear, age: 240, mulch: MulchType.Surprise_Mulch }),
        },
    },
});

function simulator(first: Record<string, unknown> = {}) {
    return {
        save: {
            farming: {
                plotList: Array.from({ length: 25 }, (_, index) => ({ berry: BerryType.None, mulch: MulchType.None, age: 0, ...(index === 0 ? first : {}) })),
            },
        },
    };
}

function adjacent(index: number): number[] {
    return Array.from({ length: 25 }, (_, i) => i).filter(i => i !== index && Math.abs(i % 5 - index % 5) <= 1 && Math.abs(Math.floor(i / 5) - Math.floor(index / 5)) <= 1);
}

describe('农场布局分享码与持久化意图', () => {
    it('收藏逐项恢复，跳过损坏数据、重复编号和重复名称，保留完整任务副本', () => {
        const first = FarmLayoutPlan.blank('收藏甲');
        first.cells[0] = { role: 'evolve', berry: BerryType.Aspear, targetBerry: BerryType.Rabuta, mulch: MulchType.Surprise_Mulch, freezeStage: PlotStage.Berry };
        first.notes = ['保留原株进化目标'];
        const second = FarmLayoutPlan.blank('收藏乙');
        const saved = FarmLayoutPlan.normalizeSavedLayouts([
            null, { id: -1, plan: first }, { id: 1, plan: { version: 1 } },
            { id: 1, plan: first }, { id: 1, plan: second },
            { id: 2, plan: { ...first, name: ' 收藏甲 ' } }, { id: 3, plan: second },
        ]);
        expect(saved.map(item => item.id)).toEqual([1, 3]);
        expect(saved[0].plan).toEqual(first);
        expect(saved[0].plan).not.toBe(first);
        expect(saved[0].plan.cells[0]).not.toBe(first.cells[0]);
        expect(saved[0].plan.notes).not.toBe(first.notes);
        first.cells[0].targetBerry = BerryType.Yache;
        expect(saved[0].plan.cells[0].targetBerry).toBe(BerryType.Rabuta);
        expect(FarmLayoutPlan.normalizeSavedLayouts(undefined)).toEqual([]);
        expect(FarmLayoutPlan.normalizeSavedLayouts({ presets: [] })).toEqual([]);
    });

    it('收藏恢复遵守数量上限，旧档不生成任何默认收藏', () => {
        const saved = FarmLayoutPlan.normalizeSavedLayouts(Array.from({ length: 101 }, (_, index) => ({
            id: index + 1, plan: FarmLayoutPlan.blank(`收藏${index + 1}`),
        })));
        expect(saved).toHaveLength(FarmLayoutPlan.MAX_SAVED_LAYOUTS);
        expect(FarmLayoutPlan.normalizeSavedLayouts([])).toEqual([]);
    });

    it('导入真实 Lum 分享码且不携带年龄或模拟器库存', () => {
        const plan = FarmLayoutPlan.parse(WIKI_LUM);
        expect(plan.cells.filter(cell => cell.role === 'mutation')).toHaveLength(4);
        expect(plan.cells.filter(cell => cell.role === 'keep')).toHaveLength(21);
        [6, 8, 16, 18].forEach(index => {
            expect(plan.cells[index]).toMatchObject({ role: 'mutation', berry: -1, mulch: MulchType.Surprise_Mulch });
            expect(new Set(adjacent(index).map(i => plan.cells[i].berry))).toEqual(new Set(Array.from({ length: 8 }, (_, i) => i)));
        });
        expect(plan.cells.every(cell => !('age' in cell) && cell.freezeStage === PlotStage.Berry)).toBe(true);
        expect(plan.notes).toHaveLength(1);
    });

    it('完整 Wiki Rabuta 模板为 Aspear 绑定 Rabuta 进化目标并保留 Aguav 原料', () => {
        const plan = FarmLayoutPlan.parse(WIKI_RABUTA);
        expect(plan.cells.filter(cell => cell.role === 'evolve')).toHaveLength(21);
        plan.cells.forEach((cell, index) => {
            if ([6, 9, 21, 24].includes(index)) {
                expect(cell).toMatchObject({ role: 'keep', berry: BerryType.Aguav, targetBerry: BerryType.None, mulch: MulchType.None });
            } else {
                expect(cell).toMatchObject({ role: 'evolve', berry: BerryType.Aspear, targetBerry: BerryType.Rabuta, mulch: MulchType.Surprise_Mulch });
                expect(adjacent(index).some(i => plan.cells[i].berry === BerryType.Aguav)).toBe(true);
            }
            expect(cell).not.toHaveProperty('age');
        });
        expect(FarmLayoutPlan.parse(JSON.stringify(plan))).toEqual(plan);
        expect(plan.notes.some(note => note.includes('选择明确的目标'))).toBe(false);
    });

    it('已知 Rabuta 拓扑补全旧版缺失目标时保留手工指定的目标', () => {
        const legacy = FarmLayoutPlan.parse(WIKI_RABUTA);
        legacy.name = '改过名称的原株阵';
        legacy.notes = ['已种植物上的突变肥料按进化格导入；请为每个进化格选择明确的目标树果后再启用。'];
        legacy.cells.filter(cell => cell.role === 'evolve').forEach(cell => { cell.targetBerry = BerryType.None; });
        legacy.cells[0].targetBerry = BerryType.Tamato;
        const normalized = FarmLayoutPlan.normalize(legacy);
        expect(normalized.cells[0].targetBerry).toBe(BerryType.Tamato);
        expect(normalized.cells.filter(cell => cell.role === 'evolve').slice(1).every(cell => cell.targetBerry === BerryType.Rabuta)).toBe(true);
        expect(normalized.notes).toEqual([]);
        expect(FarmLayoutPlan.normalize(normalized)).toEqual(normalized);
    });

    it.each(['role', 'berry', 'mulch'])('改过 Rabuta 的%s后不按预设猜测进化目标', field => {
        const imported = FarmLayoutPlan.parse(WIKI_RABUTA);
        imported.cells.filter(cell => cell.role === 'evolve').forEach(cell => { cell.targetBerry = BerryType.None; });
        if (field === 'role') { imported.cells[6].role = 'cycle'; }
        if (field === 'berry') { imported.cells[6].berry = BerryType.Figy; }
        if (field === 'mulch') { imported.cells[6].mulch = MulchType.Freeze_Mulch; }
        const plan = FarmLayoutPlan.normalize(imported);
        expect(plan.cells.filter(cell => cell.role === 'evolve').every(cell => cell.targetBerry === BerryType.None)).toBe(true);
        expect(plan.notes.some(note => note.includes('选择明确的目标'))).toBe(true);
    });

    it('原生 JSON 和含中文名称的 Base64 均保留明确的角色意图', () => {
        const original = FarmLayoutPlan.createPreset('yache-mutation');
        original.name = '我的树果阵 🍓';
        original.notes = ['只等待指定进化'];
        expect(FarmLayoutPlan.parse(JSON.stringify(original))).toEqual(original);
        expect(FarmLayoutPlan.parse(encoded(original))).toEqual(original);
        expect(FarmLayoutPlan.parse(encoded(original).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))).toEqual(original);
    });

    it('原生分享与重复规范化保留空位突变和原株进化的明确目标', () => {
        const original = FarmLayoutPlan.blank('明确目标');
        original.cells[0] = { role: 'mutation', berry: BerryType.None, targetBerry: BerryType.Lum, mulch: MulchType.Surprise_Mulch, freezeStage: PlotStage.Berry };
        original.cells[1] = { role: 'evolve', berry: BerryType.Passho, targetBerry: BerryType.Yache, mulch: MulchType.Surprise_Mulch, freezeStage: PlotStage.Berry };
        expect(FarmLayoutPlan.normalize(original)).toEqual(original);
        expect(FarmLayoutPlan.parse(JSON.stringify(original))).toEqual(original);
        expect(FarmLayoutPlan.parse(encoded(original))).toEqual(original);
        expect(FarmLayoutPlan.normalize(FarmLayoutPlan.normalize(original))).toEqual(original);
    });

    it.each(['lum-mutation', 'passho-mutation', 'liechi-mutation'])('完整旧预设按布局拓扑补全突变目标：%s', id => {
        const current = FarmLayoutPlan.createPreset(id);
        const legacy = { ...current, name: '改过的名称', cells: current.cells.map(cell => ({ ...cell, targetBerry: BerryType.None })) };
        const normalized = FarmLayoutPlan.normalize(legacy);
        expect(normalized.name).toBe('改过的名称');
        expect(normalized.cells).toEqual(current.cells);
        expect(FarmLayoutPlan.parse(JSON.stringify(legacy)).cells).toEqual(current.cells);
        expect(legacy.cells.every(cell => cell.targetBerry === BerryType.None)).toBe(true);
    });

    it('补全已知预设的缺失目标时保留手工明确指定的竞争目标', () => {
        const legacy = FarmLayoutPlan.createPreset('lum-mutation');
        legacy.cells.filter(cell => cell.role === 'mutation').forEach(cell => { cell.targetBerry = BerryType.None; });
        legacy.cells[6].targetBerry = BerryType.Persim;
        const normalized = FarmLayoutPlan.normalize(legacy);
        expect(normalized.cells[6].targetBerry).toBe(BerryType.Persim);
        [8, 16, 18].forEach(index => expect(normalized.cells[index].targetBerry).toBe(BerryType.Lum));
    });

    it.each(['role', 'berry', 'mulch'])('改过任意格的%s就不按完整预设猜测目标', field => {
        const legacy = FarmLayoutPlan.createPreset('lum-mutation');
        legacy.cells.filter(cell => cell.role === 'mutation').forEach(cell => { cell.targetBerry = BerryType.None; });
        if (field === 'role') { legacy.cells[0].role = 'cycle'; }
        if (field === 'berry') { legacy.cells[0].berry = BerryType.Oran; }
        if (field === 'mulch') { legacy.cells[0].mulch = MulchType.None; }
        expect(FarmLayoutPlan.normalize(legacy).cells.filter(cell => cell.role === 'mutation').every(cell => cell.targetBerry === BerryType.None)).toBe(true);
    });

    it('布局名称不能用于猜测目标，未知分享码先保留待选并提示施肥门槛', () => {
        const source = simulator({ mulch: MulchType.Surprise_Mulch });
        const imported = FarmLayoutPlan.parse(JSON.stringify(source));
        imported.name = FarmLayoutPlan.presets.find(preset => preset.id === 'lum-mutation').name;
        const normalized = FarmLayoutPlan.normalize(imported);
        expect(normalized.cells[0]).toMatchObject({ role: 'mutation', targetBerry: BerryType.None });
        expect(normalized.notes.some(note => note.includes('先选择目标树果') && note.includes('Surprise 或 Amaze'))).toBe(true);
        expect(FarmLayoutPlan.normalize(normalized)).toEqual(normalized);
    });

    it('不从旧 Enigma 阵猜测个人目标，提示按本存档重新确认', () => {
        const plan = FarmLayoutPlan.createPreset('enigma-directions', undefined, [BerryType.Pomeg, BerryType.Kelpsy, BerryType.Qualot, BerryType.Hondew]);
        plan.cells.filter(cell => cell.role === 'mutation').forEach(cell => { cell.targetBerry = BerryType.None; });
        const normalized = FarmLayoutPlan.normalize(plan);
        expect(normalized.cells.filter(cell => cell.role === 'mutation').every(cell => cell.targetBerry === BerryType.None)).toBe(true);
        expect(normalized.notes.some(note => note.includes('Enigma') && note.includes('本存档'))).toBe(true);
    });

    it('自动提示不会使最多 20 条自定义说明变成无法再次读取的布局', () => {
        const plan = FarmLayoutPlan.blank();
        plan.cells[0].role = 'mutation';
        plan.notes = Array(20).fill('自定义说明');
        const normalized = FarmLayoutPlan.normalize(plan);
        expect(normalized.notes).toHaveLength(20);
        expect(FarmLayoutPlan.normalize(normalized)).toEqual(normalized);
    });

    it('接受带换行的 Wiki 分享码', () => {
        expect(FarmLayoutPlan.parse(`  ${WIKI_LUM.slice(0, 400)}\n${WIKI_LUM.slice(400)}  `).cells).toEqual(FarmLayoutPlan.parse(WIKI_LUM).cells);
    });

    it('兼容旧版 plots 和直接 farming 包装', () => {
        const fixture = simulator({ berry: BerryType.Chesto, mulch: MulchType.Freeze_Mulch, age: 80 });
        const plots = fixture.save.farming.plotList;
        expect(FarmLayoutPlan.parse(JSON.stringify({ plots })).cells[0].role).toBe('keep');
        expect(FarmLayoutPlan.parse(JSON.stringify({ farming: { plots } })).cells[0].role).toBe('keep');
        expect(FarmLayoutPlan.parse(JSON.stringify(fixture.save.farming)).cells[0].berry).toBe(BerryType.Chesto);
    });

    it('空位不同肥料推断为隔离、突变或待选树果的生产格', () => {
        const parse = (mulch: MulchType) => FarmLayoutPlan.parse(JSON.stringify(simulator({ mulch })));
        expect(parse(MulchType.None).cells[0].role).toBe('empty');
        expect(parse(MulchType.Surprise_Mulch).cells[0].role).toBe('mutation');
        expect(parse(MulchType.Amaze_Mulch).cells[0].role).toBe('empty');
        [MulchType.Rich_Mulch, MulchType.Boost_Mulch].forEach(mulch => {
            expect(parse(mulch).cells[0]).toMatchObject({ role: 'cycle', berry: BerryType.None, mulch });
            expect(parse(mulch).notes.some(note => note.includes('选择要种植'))).toBe(true);
        });
    });

    it('原株突变格不擅自猜测目标，并提示用户选择', () => {
        const plan = FarmLayoutPlan.parse(JSON.stringify(simulator({ berry: BerryType.Passho, mulch: MulchType.Surprise_Mulch })));
        expect(plan.cells[0]).toMatchObject({ role: 'evolve', berry: BerryType.Passho, targetBerry: BerryType.None });
        expect(plan.notes.some(note => note.includes('选择明确的目标'))).toBe(true);
    });

    it('早期 Freeze 不导入年龄并明确提示只在成熟后冻结', () => {
        const plan = FarmLayoutPlan.parse(JSON.stringify(simulator({ berry: BerryType.Cheri, mulch: MulchType.Freeze_Mulch, age: 10 })));
        expect(plan.cells[0]).toMatchObject({ role: 'keep', freezeStage: PlotStage.Berry, mulch: MulchType.Freeze_Mulch });
        expect(plan.cells[0]).not.toHaveProperty('age');
        expect(plan.notes.some(note => note.includes('早期冻结时序需手动管理'))).toBe(true);
    });

    it('无肥料、Boost、Amaze 或 Gooey 的现有光环株保留，不擅自转成循环收获', () => {
        [MulchType.None, MulchType.Boost_Mulch, MulchType.Amaze_Mulch, MulchType.Gooey_Mulch].forEach(mulch => {
            const plan = FarmLayoutPlan.parse(JSON.stringify(simulator({ berry: BerryType.Wacan, mulch })));
            expect(plan.cells[0]).toMatchObject({ role: 'keep', berry: BerryType.Wacan, mulch });
        });
    });

    it('多义肥料的空格保守隔离并提示检查用途', () => {
        [MulchType.Amaze_Mulch, MulchType.Gooey_Mulch].forEach(mulch => {
            const plan = FarmLayoutPlan.parse(JSON.stringify(simulator({ mulch })));
            expect(plan.cells[0].role).toBe('empty');
            expect(plan.notes.some(note => note.includes('手动确认角色'))).toBe(true);
        });
    });

    it('规范化生成独立对象且清掉不托管和隔离格的无效意图', () => {
        const plan = FarmLayoutPlan.blank();
        plan.cells[0] = { role: 'empty', berry: BerryType.Liechi, targetBerry: BerryType.Yache, mulch: MulchType.Rich_Mulch, freezeStage: PlotStage.Berry };
        const result = FarmLayoutPlan.normalize(plan);
        expect(result.cells[0]).toEqual({ role: 'empty', berry: -1, targetBerry: -1, mulch: -1, freezeStage: 4 });
        result.cells[1].role = 'cycle';
        expect(plan.cells[1].role).toBe('ignore');
        expect(result.cells[1]).not.toBe(result.cells[2]);
    });

    it('保留与生产格继续清除无关目标字段，不把它解释成突变角色', () => {
        const plan = FarmLayoutPlan.blank();
        plan.cells[0] = { role: 'keep', berry: BerryType.Passho, targetBerry: BerryType.Yache, mulch: MulchType.None, freezeStage: PlotStage.Berry };
        plan.cells[1] = { ...plan.cells[0], role: 'cycle' };
        const normalized = FarmLayoutPlan.normalize(plan);
        expect(normalized.cells.slice(0, 2).map(cell => cell.targetBerry)).toEqual([BerryType.None, BerryType.None]);
    });

    it.each([
        '', '   ', 'not a layout', '{}', '[]', '{"version":2}', 'e30=', '!!!!', 'null', 'a'.repeat(64_001),
    ])('拒绝非法或过长的分享内容：%s', value => {
        expect(() => FarmLayoutPlan.parse(value)).toThrow(/[\u4e00-\u9fff]/);
    });

    it.each([24, 26])('拒绝 %i 格布局，避免平移或丢失格子', length => {
        const original = FarmLayoutPlan.blank();
        const cells = Array.from({ length }, () => original.cells[0]);
        expect(() => FarmLayoutPlan.normalize({ ...original, cells })).toThrow('25');
        expect(() => FarmLayoutPlan.parse(JSON.stringify({ plots: cells }))).toThrow('25');
    });

    it.each([
        { role: 'unknown' }, { berry: -2 }, { berry: BerryList.length }, { berry: '0' }, { berry: NaN },
        { targetBerry: Infinity }, { targetBerry: 0.5 }, { mulch: -2 }, { mulch: 6 }, { mulch: '1' },
        { freezeStage: 2 }, { freezeStage: 5 },
    ])('拒绝非法字段 %#', change => {
        const plan = FarmLayoutPlan.blank();
        expect(() => FarmLayoutPlan.normalize({ ...plan, cells: [{ ...plan.cells[0], ...change }, ...plan.cells.slice(1)] })).toThrow(/[\u4e00-\u9fff]/);
    });

    it('拒绝空名称、过长名称、无效说明及稀疏格子', () => {
        const plan = FarmLayoutPlan.blank();
        ['', ' '.repeat(3), '果'.repeat(81)].forEach(name => expect(() => FarmLayoutPlan.normalize({ ...plan, name })).toThrow('名称'));
        [[1], ['a'.repeat(501)], Array(21).fill('说明')].forEach(notes => expect(() => FarmLayoutPlan.normalize({ ...plan, notes })).toThrow('说明'));
        expect(() => FarmLayoutPlan.normalize({ ...plan, cells: Array(25) })).toThrow('角色');
    });

    it('允许待补全原株和目标，但禁止进化成自身', () => {
        const plan = FarmLayoutPlan.blank();
        plan.cells[0].role = 'evolve';
        expect(FarmLayoutPlan.normalize(plan).cells[0].targetBerry).toBe(BerryType.None);
        plan.cells[0].berry = BerryType.Passho;
        plan.cells[0].targetBerry = BerryType.Passho;
        expect(() => FarmLayoutPlan.normalize(plan)).toThrow('不能与原株相同');
    });

    it.each([-1, Infinity, '0'])('拒绝无效模拟年龄 %s', age => {
        expect(() => FarmLayoutPlan.parse(JSON.stringify(simulator({ age })))).toThrow('年龄');
    });
});

describe('Wiki 布局预设结构', () => {
    it.each([
        ['lum-mutation', BerryType.Lum], ['passho-mutation', BerryType.Passho],
        ['liechi-mutation', BerryType.Liechi], ['enigma-directions', BerryType.Enigma],
    ])('%s 的突变格记录主目标，不使用竞争产物作为施肥依据', (id, target) => {
        const cells = FarmLayoutPlan.createPreset(id as string).cells.filter(cell => cell.role === 'mutation');
        expect(cells.length).toBeGreaterThan(0);
        expect(cells.every(cell => cell.targetBerry === target)).toBe(true);
    });

    it('所有预设都能独立规范化且具有来源', () => {
        FarmLayoutPlan.presets.forEach(preset => {
            const plan = FarmLayoutPlan.createPreset(preset.id, BerryType.Liechi, [BerryType.Pomeg, BerryType.Kelpsy, BerryType.Qualot, BerryType.Hondew]);
            expect(plan.cells).toHaveLength(25);
            expect(FarmLayoutPlan.normalize(plan)).toEqual(plan);
            expect(preset.source).toMatch(/^https:\/\/wiki.pokeclicker.com\//);
        });
        expect(() => FarmLayoutPlan.createPreset('invalid')).toThrow('未知');
    });

    it('Lum 预设与真实 Wiki 分享码的布局一致', () => {
        expect(FarmLayoutPlan.createPreset('lum-mutation').cells).toEqual(FarmLayoutPlan.parse(WIKI_LUM).cells);
    });

    it('Rabuta 预设与用户 Wiki 分享码一致，21 个进化位均邻接 Aguav', () => {
        const preset = FarmLayoutPlan.createPreset('rabuta-mutation');
        expect(preset.cells).toEqual(FarmLayoutPlan.parse(WIKI_RABUTA).cells);
        expect(preset.cells.filter(cell => cell.role === 'keep')).toHaveLength(4);
        expect(preset.cells.filter(cell => cell.role === 'evolve')).toHaveLength(21);
        preset.cells.forEach((cell, index) => {
            if (cell.role === 'evolve') {
                expect(cell).toMatchObject({ berry: BerryType.Aspear, targetBerry: BerryType.Rabuta, mulch: MulchType.Surprise_Mulch });
                expect(adjacent(index).some(i => preset.cells[i].berry === BerryType.Aguav)).toBe(true);
            }
        });
    });

    it('Passho 每个突变格都邻接四种指定原料', () => {
        const plan = FarmLayoutPlan.createPreset('passho-mutation');
        const mutationCells = plan.cells.map((cell, index) => cell.role === 'mutation' ? index : -1).filter(index => index >= 0);
        expect(mutationCells).toHaveLength(10);
        mutationCells.forEach(index => {
            const berries = adjacent(index).map(i => plan.cells[i].berry);
            [BerryType.Chesto, BerryType.Oran, BerryType.Kelpsy, BerryType.Coba].forEach(berry => expect(berries).toContain(berry));
        });
    });

    it('Liechi 预设恰好保留 23 株 Passho 和两个空目标', () => {
        const plan = FarmLayoutPlan.createPreset('liechi-mutation');
        expect(plan.cells.filter(cell => cell.berry === BerryType.Passho && cell.role === 'keep')).toHaveLength(23);
        expect(plan.cells.filter(cell => cell.role === 'mutation')).toHaveLength(2);
        expect(plan.cells.every(cell => cell.mulch !== MulchType.Freeze_Mulch)).toBe(true);
    });

    it('Yache 九个进化位彼此隔离，不会把 Passho 提前收掉', () => {
        const plan = FarmLayoutPlan.createPreset('yache-mutation');
        expect(plan.cells.filter(cell => cell.role === 'evolve')).toHaveLength(9);
        plan.cells.forEach((cell, index) => {
            if (cell.role === 'evolve') {
                expect(cell).toMatchObject({ berry: BerryType.Passho, targetBerry: BerryType.Yache });
                expect(adjacent(index).every(i => plan.cells[i].role === 'empty')).toBe(true);
            }
        });
    });

    it('Watmel 只给中央九个 Magost 设进化目标', () => {
        const plan = FarmLayoutPlan.createPreset('watmel-mutation');
        expect(plan.cells.filter(cell => cell.role === 'keep')).toHaveLength(16);
        expect(plan.cells.filter(cell => cell.role === 'evolve')).toHaveLength(9);
        plan.cells.filter(cell => cell.role === 'evolve').forEach(cell => expect(cell).toMatchObject({ berry: BerryType.Magost, targetBerry: BerryType.Watmel }));
    });

    it.each(['passho-rows', 'passho-ring'])('生产目标只替换生产格，辅助光环不冻结：%s', id => {
        const first = FarmLayoutPlan.createPreset(id, BerryType.Liechi);
        const second = FarmLayoutPlan.createPreset(id, BerryType.Cheri);
        first.cells.forEach((cell, index) => {
            if (cell.role === 'cycle') {
                expect(cell.berry).toBe(BerryType.Liechi);
                expect(second.cells[index].berry).toBe(BerryType.Cheri);
            } else {
                expect(cell).toEqual(second.cells[index]);
            }
        });
        expect(first.cells.every(cell => cell.mulch !== MulchType.Freeze_Mulch)).toBe(true);
        expect(first.cells.filter(cell => cell.role === 'cycle')).toHaveLength(id === 'passho-rows' ? 10 : 1);
    });

    it('单株生长阵只替换中心目标，成熟后保留等待换阵', () => {
        const first = FarmLayoutPlan.createPreset('wacan-lum', BerryType.Liechi);
        const second = FarmLayoutPlan.createPreset('wacan-lum', BerryType.Cheri);
        expect(first.cells[12]).toMatchObject({ role: 'keep', berry: BerryType.Liechi, mulch: MulchType.Boost_Mulch });
        expect(second.cells[12]).toMatchObject({ role: 'keep', berry: BerryType.Cheri, mulch: MulchType.Boost_Mulch });
        first.cells.forEach((cell, index) => {
            if (index !== 12) {
                expect(cell).toEqual(second.cells[index]);
            }
        });
        expect(first.cells.every(cell => cell.role !== 'cycle' && cell.mulch !== MulchType.Freeze_Mulch)).toBe(true);
        expect(first.notes.some(note => note.includes('成熟后保留') && note.includes('不自动换阵'))).toBe(true);
    });

    it('Enigma 两处十字按北西东南映射个人配方，未提供时保留待选', () => {
        const berries = [BerryType.Pomeg, BerryType.Kelpsy, BerryType.Qualot, BerryType.Hondew];
        const plan = FarmLayoutPlan.createPreset('enigma-directions', undefined, berries);
        [6, 18].forEach(index => {
            expect(plan.cells[index].role).toBe('mutation');
            expect([index - 5, index - 1, index + 1, index + 5].map(i => plan.cells[i].berry)).toEqual(berries);
        });
        expect(FarmLayoutPlan.createPreset('enigma-directions').cells.filter(cell => cell.role === 'keep').every(cell => cell.berry === -1)).toBe(true);
        expect(() => FarmLayoutPlan.createPreset('enigma-directions', undefined, berries.slice(1))).toThrow('四种');
        expect(() => FarmLayoutPlan.createPreset('enigma-directions', undefined, [-2, ...berries.slice(1)])).toThrow('编号');
    });

    it('拒绝把 Enigma 套到会腐蚀 Passho 光环株的普通增产阵', () => {
        ['passho-rows', 'passho-ring'].forEach(id => expect(() => FarmLayoutPlan.createPreset(id, BerryType.Enigma)).toThrow('Babiri'));
        expect(FarmLayoutPlan.createPreset('wacan-lum', BerryType.Enigma).cells[12].berry).toBe(BerryType.Enigma);
    });

    it.each(['passho-rows', 'passho-ring', 'wacan-lum'])('拒绝寄生树果破坏辅助光环阵：%s', id => {
        [BerryType.Occa, BerryType.Kebia, BerryType.Colbur].forEach(berry => {
            expect(() => FarmLayoutPlan.createPreset(id, berry)).toThrow('Babiri');
        });
    });
});
