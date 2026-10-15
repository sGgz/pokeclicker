import BerryType from '../enums/BerryType';
import MulchType from '../enums/MulchType';
import PlotStage from '../enums/PlotStage';
import { BerryList } from './BerryList';

export type LayoutRole = 'ignore' | 'empty' | 'mutation' | 'keep' | 'cycle' | 'evolve';

export interface LayoutCell {
    role: LayoutRole;
    berry: number;
    targetBerry: number;
    mulch: number;
    freezeStage: number;
}

export interface LayoutPlan {
    version: 1;
    name: string;
    cells: LayoutCell[];
    notes?: string[];
}

const PLOT_COUNT = 25;
const MAX_TEXT_LENGTH = 64_000;
const NONE = BerryType.None;
const FREEZE = MulchType.Freeze_Mulch;
const SURPRISE = MulchType.Surprise_Mulch;
const RICH = MulchType.Rich_Mulch;
const BOOST = MulchType.Boost_Mulch;

function record(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function berryNumber(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) < NONE || (value as number) >= BerryList.length) {
        throw new Error(`${label}不是有效的树果编号`);
    }
    return value as number;
}

function mulchNumber(value: unknown, label: string): number {
    if (!Number.isInteger(value) || (value as number) < MulchType.None || (value as number) > MulchType.Gooey_Mulch) {
        throw new Error(`${label}不是有效的肥料编号`);
    }
    return value as number;
}

function cell(role: LayoutRole, berry = NONE, mulch = MulchType.None, targetBerry = NONE): LayoutCell {
    return { role, berry, targetBerry, mulch, freezeStage: PlotStage.Berry };
}

function checkedNotes(value: unknown): string[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 20 || value.some(note => typeof note !== 'string' || note.length > 500)) {
        throw new Error('布局说明格式无效，最多允许 20 条，每条不超过 500 字');
    }
    return [...value];
}

function wikiPlan(value: Record<string, unknown>): LayoutPlan {
    const save = record(value.save) ? value.save : value;
    const farming = record(save.farming) ? save.farming : save;
    const plots = farming.plotList ?? farming.plots;
    if (!Array.isArray(plots) || plots.length !== PLOT_COUNT) {
        throw new Error('布局必须包含恰好 25 个格子');
    }
    const notes = ['模拟器年龄仅用于识别布局，不会改变真实作物年龄；导入后请检查各格角色再启用。'];
    let earlyFreeze = false;
    let pendingEvolve = false;
    let pendingProduction = false;
    let ambiguousMulch = false;
    const cells = Array.from(plots, (plot, index) => {
        if (!record(plot)) {
            throw new Error(`第 ${index + 1} 格数据格式无效`);
        }
        const berry = berryNumber(plot.berry, `第 ${index + 1} 格树果`);
        const mulch = mulchNumber(plot.mulch ?? MulchType.None, `第 ${index + 1} 格肥料`);
        if (plot.age !== undefined && (typeof plot.age !== 'number' || !Number.isFinite(plot.age) || plot.age < 0)) {
            throw new Error(`第 ${index + 1} 格模拟年龄无效`);
        }
        if (berry === NONE) {
            if (mulch === SURPRISE) {
                return cell('mutation', NONE, mulch);
            }
            if (mulch === RICH || mulch === BOOST) {
                pendingProduction = true;
                return cell('cycle', NONE, mulch);
            }
            if (mulch === MulchType.Amaze_Mulch || mulch === MulchType.Gooey_Mulch) {
                ambiguousMulch = true;
            }
            if (mulch === FREEZE) {
                earlyFreeze = true;
            }
            return cell('empty');
        }
        if (mulch === SURPRISE) {
            pendingEvolve = true;
            return cell('evolve', berry, mulch);
        }
        if (mulch === RICH) {
            return cell('cycle', berry, mulch);
        }
        if (mulch === BOOST || mulch === MulchType.Amaze_Mulch || mulch === MulchType.Gooey_Mulch) {
            ambiguousMulch = true;
        }
        if (mulch === FREEZE && (typeof plot.age !== 'number' || plot.age < BerryList[berry].growthTime[PlotStage.Bloom])) {
            earlyFreeze = true;
        }
        return cell('keep', berry, mulch);
    });
    if (earlyFreeze) {
        notes.push('原布局含未成熟或空格冻结：当前助手只支持等作物成熟后冻结，早期冻结时序需手动管理。');
    }
    if (pendingEvolve) {
        notes.push('已种植物上的突变肥料按进化格导入；请为每个进化格选择明确的目标树果后再启用。');
    }
    if (pendingProduction) {
        notes.push('带生产辅助肥料的空格按循环生产格导入；请先选择要种植的树果。');
    }
    if (ambiguousMulch) {
        notes.push('Boost、Amaze、Gooey 不能单凭肥料判断用途：现有植物按保留导入，Amaze/Gooey 空位按隔离导入；请按实际用途手动确认角色。');
    }
    return { version: 1, name: '导入的模拟器布局', cells, notes };
}

export default class FarmLayoutPlan {
    static readonly roles: Array<{ value: LayoutRole; text: string }> = [
        { value: 'ignore', text: '不托管' },
        { value: 'empty', text: '隔离留空' },
        { value: 'mutation', text: '突变留空并收获' },
        { value: 'keep', text: '保留原料或光环' },
        { value: 'cycle', text: '循环种植收获' },
        { value: 'evolve', text: '等待原株进化' },
    ];

    static readonly mulches: Array<{ value: number; text: string }> = [
        { value: MulchType.None, text: '不自动施肥' },
        { value: BOOST, text: 'Boost：加速' },
        { value: RICH, text: 'Rich：增产' },
        { value: SURPRISE, text: 'Surprise：突变' },
        { value: MulchType.Amaze_Mulch, text: 'Amaze：综合' },
        { value: FREEZE, text: 'Freeze：成熟后冻结' },
        { value: MulchType.Gooey_Mulch, text: 'Gooey：游荡捕捉' },
    ];

    static readonly presets = [
        { id: 'lum-mutation', name: 'Lum：八种原料四点突变', description: '21 格原料成熟后冻结，4 个空位使用 Surprise。', source: 'https://wiki.pokeclicker.com/#!Berries/Lum' },
        { id: 'passho-mutation', name: 'Passho：四种原料列阵', description: 'Chesto、Oran 成熟后冻结，Kelpsy、Coba 保留，10 个空位尝试突变。', source: 'https://wiki.pokeclicker.com/#!Berries/Passho' },
        { id: 'liechi-mutation', name: 'Liechi：23 株 Passho', description: '保留 23 株成熟 Passho，中央两个空位等待 Liechi；仍需满足任务解锁。', source: 'https://wiki.pokeclicker.com/#!Berries/Liechi' },
        { id: 'yache-mutation', name: 'Yache：九株隔离 Passho', description: '隔离种植 9 株 Passho，保留原株直到进化为 Yache。', source: 'https://wiki.pokeclicker.com/#!Berries/Yache' },
        { id: 'watmel-mutation', name: 'Watmel：Magost 风味进化', description: '外围 16 株 Magost 保留，中央 9 株等待进化为 Watmel。', source: 'https://wiki.pokeclicker.com/#!Berries/Watmel' },
        { id: 'passho-rows', name: 'Passho：双行循环量产', description: '15 株 Passho 光环，10 格循环种植所选树果，收获前施 Rich。', source: 'https://wiki.pokeclicker.com/#!Farm/Setups' },
        { id: 'passho-ring', name: 'Passho＋Lum：单株扩种', description: '中心生产格，八株 Passho 与外侧四株 Lum 提升收获。', source: 'https://wiki.pokeclicker.com/#!Farm/Setups' },
        { id: 'wacan-lum', name: 'Wacan＋Lum：单株生长', description: '中心所选树果使用 Boost，成熟后保留不收；八株 Wacan 与外侧四株 Lum 保留光环。', source: 'https://wiki.pokeclicker.com/#!Farm/Setups' },
        { id: 'enigma-directions', name: 'Enigma：个人四向配方', description: '按本存档的北、西、东、南配方构造两个十字突变区；配方不可套用他人存档。', source: 'https://wiki.pokeclicker.com/#!Berries/Enigma' },
    ];

    static blank(name = '自定义布局'): LayoutPlan {
        return this.normalize({ version: 1, name, cells: Array.from({ length: PLOT_COUNT }, () => cell('ignore')) });
    }

    static normalize(value: unknown): LayoutPlan {
        if (!record(value) || value.version !== 1) {
            throw new Error('布局版本无效，仅支持版本 1');
        }
        if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) {
            throw new Error('布局名称不能为空且不能超过 80 字');
        }
        if (!Array.isArray(value.cells) || value.cells.length !== PLOT_COUNT) {
            throw new Error('布局必须包含恰好 25 个格子');
        }
        const cells = Array.from(value.cells, (item, index) => {
            if (!record(item) || !this.roles.some(role => role.value === item.role)) {
                throw new Error(`第 ${index + 1} 格的角色无效`);
            }
            const berry = berryNumber(item.berry, `第 ${index + 1} 格树果`);
            const target = berryNumber(item.targetBerry, `第 ${index + 1} 格目标树果`);
            const mulch = mulchNumber(item.mulch, `第 ${index + 1} 格肥料`);
            if (item.freezeStage !== PlotStage.Berry) {
                throw new Error(`第 ${index + 1} 格只支持成熟后冻结`);
            }
            const role = item.role as LayoutRole;
            if (role === 'evolve' && target !== NONE && target === berry) {
                throw new Error(`第 ${index + 1} 格的进化目标不能与原株相同`);
            }
            if (role === 'ignore' || role === 'empty') {
                return cell(role);
            }
            return cell(role, role === 'mutation' ? NONE : berry, mulch, role === 'evolve' ? target : NONE);
        });
        const notes = checkedNotes(value.notes);
        return { version: 1, name: value.name.trim(), cells, ...(notes === undefined ? {} : { notes }) };
    }

    static parse(text: string): LayoutPlan {
        if (typeof text !== 'string' || !text.trim()) {
            throw new Error('请粘贴布局 JSON 或模拟器分享码');
        }
        if (text.length > MAX_TEXT_LENGTH) {
            throw new Error(`布局文本过长，最多允许 ${MAX_TEXT_LENGTH} 个字符`);
        }
        let value: unknown;
        try {
            const trimmed = text.trim();
            if (trimmed.startsWith('{')) {
                value = JSON.parse(trimmed);
            } else {
                const encoded = trimmed.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
                if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
                    throw new Error();
                }
                const bytes = atob(encoded);
                const decoded = decodeURIComponent(Array.from(bytes, character => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`).join(''));
                value = JSON.parse(decoded);
            }
        } catch {
            throw new Error('布局内容无法解析，请检查 JSON 或 Base64 分享码是否完整');
        }
        if (record(value) && ('cells' in value || 'version' in value)) {
            return this.normalize(value);
        }
        if (!record(value)) {
            throw new Error('布局内容必须是对象');
        }
        return this.normalize(wikiPlan(value));
    }

    static createPreset(id: string, targetBerry = NONE, enigmaBerries?: number[]): LayoutPlan {
        const preset = this.presets.find(item => item.id === id);
        if (!preset) {
            throw new Error('未知的农场布局预设');
        }
        if (['passho-rows', 'passho-ring'].includes(id) && targetBerry === BerryType.Enigma) {
            throw new Error('Enigma 会把相邻 Passho 进化为 Liechi，不适用普通 Passho 生产阵；请使用带 Babiri 保护的自定义布局');
        }
        if (['passho-rows', 'passho-ring', 'wacan-lum'].includes(id) && [BerryType.Occa, BerryType.Kebia, BerryType.Colbur].includes(targetBerry)) {
            throw new Error('Occa、Kebia、Colbur 是寄生树果，会侵占相邻光环原料，不适用此预设；请使用带 Babiri 保护的自定义布局');
        }
        const plan: LayoutPlan = { version: 1, name: preset.name, cells: Array.from({ length: PLOT_COUNT }, () => cell('empty')) };
        const keep = (index: number, berry: number, mulch = MulchType.None) => { plan.cells[index] = cell('keep', berry, mulch); };
        const mutation = (index: number) => { plan.cells[index] = cell('mutation', NONE, SURPRISE); };
        if (id === 'lum-mutation') {
            [7, 6, 4, 6, 7, 5, -1, 2, -1, 5, 3, 1, 0, 1, 3, 5, -1, 2, -1, 5, 7, 6, 4, 6, 7].forEach((berry, index) => {
                if (berry === NONE) { mutation(index); } else { keep(index, berry, FREEZE); }
            });
            plan.notes = ['短寿命原料可能在慢助手下一轮前枯萎；可先手工完成成熟和冻结，再由助手续肥。'];
        } else if (id === 'passho-mutation') {
            [1, -1, 6, -1, 1, 21, -1, 44, -1, 21, -1, -1, -1, -1, -1, 6, -1, 1, -1, 6, 44, -1, 21, -1, 44].forEach((berry, index) => {
                if ([1, 3, 6, 8, 11, 13, 16, 18, 21, 23].includes(index)) {
                    mutation(index);
                } else if (berry !== NONE) {
                    keep(index, berry, [BerryType.Chesto, BerryType.Oran].includes(berry) ? FREEZE : MulchType.None);
                }
            });
        } else if (id === 'liechi-mutation') {
            plan.cells.forEach((_, index) => {
                if ([12, 13].includes(index)) { mutation(index); } else { keep(index, BerryType.Passho); }
            });
            plan.notes = ['需要完成 Land vs. Water 任务线；23 株 Passho 必须同时成熟。'];
        } else if (id === 'yache-mutation') {
            [0, 2, 4, 10, 12, 14, 20, 22, 24].forEach(index => { plan.cells[index] = cell('evolve', BerryType.Passho, SURPRISE, BerryType.Yache); });
        } else if (id === 'watmel-mutation') {
            plan.cells.forEach((_, index) => {
                const inner = index % 5 > 0 && index % 5 < 4 && index >= 5 && index < 20;
                plan.cells[index] = inner ? cell('evolve', BerryType.Magost, SURPRISE, BerryType.Watmel) : cell('keep', BerryType.Magost);
            });
            plan.notes = ['进化以游戏实际风味与邻株条件为准；其他突变改变原料时会暂停该格，需人工检查。'];
        } else if (id === 'passho-rows') {
            berryNumber(targetBerry, '生产目标');
            plan.cells.forEach((_, index) => {
                plan.cells[index] = Math.floor(index / 5) % 2 === 0 ? cell('keep', BerryType.Passho) : cell('cycle', targetBerry, RICH);
            });
        } else if (id === 'passho-ring' || id === 'wacan-lum') {
            berryNumber(targetBerry, '生产目标');
            [6, 7, 8, 11, 13, 16, 17, 18].forEach(index => keep(index, id === 'wacan-lum' ? BerryType.Wacan : BerryType.Passho));
            [2, 10, 14, 22].forEach(index => keep(index, BerryType.Lum));
            plan.cells[12] = id === 'wacan-lum' ? cell('keep', targetBerry, BOOST) : cell('cycle', targetBerry, RICH);
            plan.notes = [id === 'wacan-lum'
                ? '中心树果成熟后保留、不自动收获；光环株不会冻结，也不自动换阵。需要增产时请手动切换 Passho 预设或编辑布局，等增产光环就绪后再收获。'
                : '光环株不会冻结；请等 Passho 与 Lum 成熟后再收中心树果。'];
        } else if (id === 'enigma-directions') {
            if (enigmaBerries !== undefined && (!Array.isArray(enigmaBerries) || enigmaBerries.length !== 4)) {
                throw new Error('Enigma 配方必须按北、西、东、南提供恰好四种树果');
            }
            const berries = enigmaBerries ?? [NONE, NONE, NONE, NONE];
            berries.forEach(berry => berryNumber(berry, 'Enigma 四向原料'));
            [6, 18].forEach(index => {
                mutation(index);
                [index - 5, index - 1, index + 1, index + 5].forEach((position, direction) => keep(position, berries[direction], FREEZE));
            });
            plan.notes = ['四向顺序为北、西、东、南，只能使用本存档的 Enigma 个人配方；未指定的原料需补全后才能启用。'];
        }
        return this.normalize(plan);
    }
}
