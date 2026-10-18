/* 将已计算的数据整理成可离线使用的农场手册，不修改游戏或真实存档。 */
const fs = require('node:fs');
const path = require('node:path');

const defaults = { production: path.join(__dirname, 'production-2.75.json'), berries: path.join(__dirname, 'berry-data.json'),
    auras: path.join(__dirname, 'aura-data.json'), mechanics: path.join(__dirname, 'mechanics-notes.md'), outputDir: path.resolve(__dirname, '..') };
const mulchNames = { '-2': '混合肥料，逐格配置', '-1': '不施肥', 0: 'Boost', 1: 'Rich', 2: 'Surprise', 3: 'Amaze', 4: 'Freeze', 5: 'Gooey' };
const roleNames = { cycle: '循环生产', keep: '保留辅助', empty: '隔离留空', ignore: '不托管', evolve: '原株进化', mutation: '突变留空' };
const helperData = [
    ['Alex', 750, 25, 140], ['Logan', 385.2, 25, 440], ['Joey', 202.8, 25, 630],
    ['Charlie', 141.9, 25, 910], ['Bailey', 101.4, 25, 1300], ['Kerry', 71, 25, 1900],
    ['Riley', 50.7, 50, 4000], ['Jamie', 30.5, 25, 4000], ['Jessie', 20.3, 50, 8300],
];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const fmt = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '未提供';
const strings = value => typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : [];
const unique = list => [...new Set(list.filter(Boolean))];
const json = value => JSON.stringify(value, null, 2);
const isPlan = value => value && value.version === 1 && Array.isArray(value.cells) && value.cells.length === 25;

function argumentsFrom(argv) {
    const options = { ...defaults };
    const flags = { '--production': 'production', '--berries': 'berries', '--auras': 'auras', '--mechanics': 'mechanics', '--output-dir': 'outputDir' };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--help') return null;
        if (!flags[argv[i]] || !argv[i + 1]) throw new Error(`无法识别参数：${argv[i]}；使用 --help 查看用法`);
        options[flags[argv[i]]] = path.resolve(argv[++i]);
    }
    return options;
}

function buildReport(options) {
    const production = JSON.parse(fs.readFileSync(options.production, 'utf8'));
    const berries = JSON.parse(fs.readFileSync(options.berries, 'utf8'));
    const auras = JSON.parse(fs.readFileSync(options.auras, 'utf8'));
    const mechanics = fs.readFileSync(options.mechanics, 'utf8');
    const coinsPath = path.join(path.dirname(options.production), 'coins-data.json');
    const coinsData = fs.existsSync(coinsPath) ? JSON.parse(fs.readFileSync(coinsPath, 'utf8')) : {};
    const berryById = new Map(berries.map(berry => [berry.id, berry]));
    const berryName = id => id < 0 ? '留空' : berryById.get(id)?.name ?? `树果 ${id}`;
    const sourceOptions = production.options ?? {};
    const cards = [];
    const positionRows = plots => Array.from({ length: 5 }, (_, row) => {
        const columns = plots.filter(index => Math.floor(index / 5) === row).map(index => index % 5 + 1);
        return columns.length ? `第 ${row + 1} 行：第 ${columns.join('、')} 列` : '';
    }).filter(Boolean);
    const normalizeAssignments = (plan, source) => source?.length ? source.map(hand => ({ ...hand, rows: positionRows(hand.plots) })) : [
        { name: 'Jessie', plots: Array.from({ length: 25 }, (_, index) => index), wages: 8300, rows: positionRows(Array.from({ length: 25 }, (_, index) => index)) },
    ];
    const genericNotes = [
        '导入只设置这块农田的布局，随后仍须雇用表中助手，并按行列勾选 Allowed Plots。多人负责范围必须互不重叠。',
        '导入或编辑后布局暂停，核对 25 格、已有作物、安全锁和肥料后点击启用。种子与肥料需要真实库存。',
        '所有 keep 格均正确且成熟后，cycle 格才正常采收；光环提供者不能使用 Freeze。',
        '助手临枯会采收 keep 原株并重种。Petaya 只保护同田非 Petaya，自身仍需续种，不能保证全天保持成熟阵。',
    ];
    const productionNotes = [
        '本项是成熟辅助阵平台上的候选搜索最佳与产出估算；以普通 cycle 种收、指定道具倍率和有限候选比较，不是全部生产策略的全局最优证明。',
        '数值不包含从空田建阵的等待与投入，不覆盖自然枯萎自播、寄生复制、Enigma 原株进化或手动换肥的全策略优化。',
        '仿真关闭随机突变，从全部辅助株成熟的平台开始，让生产株真实扣种播种；按 0.1 秒游戏边界做事件跳跃近似，测量窗口依作物自适应为 0.5–32 小时，详见本项窗口。',
        '寄生、味道进化、空位突变和其他意外占位仍需按机制审计核对，不能据估算宣称随机环境永久稳定；需防护的特殊树果采用四株成熟 Babiri 保护模板，保护建立前仍需观察。',
        '毛收获是所得树果总量；净新增已扣播种消耗。果实方案忽略助手工资和肥料成本来选优，但仍列出实际消耗。',
    ];
    const addProductionCard = (record, category, index) => {
        const best = record.best ?? record;
        const plan = best.plan ?? best.layout;
        if (!isPlan(plan)) throw new Error(`${category} 第 ${index + 1} 项缺少完整 25 格布局`);
        const name = record.name ?? berryName(best.berry ?? record.berry);
        const metric = best.measured ?? record.measured ?? {};
        const actualBerry = berryName(best.berry ?? record.berry);
        const title = category === 'berries' ? name : `农场币方案 ${index + 1} · ${name}${name.includes(actualBerry) ? '' : ` · ${actualBerry}`}`;
        const safetyNotes = unique([...strings(record.notes), ...strings(best.notes), ...strings(record.limitations), ...strings(best.limitations), ...strings(record.warnings), ...strings(best.warnings)]);
        const calculationNotes = category === 'coins' ? [
            `本项按普通助手种收的有限候选比较，仿真窗口 ${fmt(metric.hours)} 小时，不是全部生产机制的全局最优证明。`,
            Number(metric.hours) > 32 ? '本项连续运行跨过 Petaya 的通常寿命，记录维护与补种空档；长时结果仅在明确列出的对照方案中选优。' : '本项从辅助株成熟的平台开始，短窗口最高收入不代表跨越 Petaya 更新后的永久平均。',
            '仿真使用当前源码的种植、采收、肥料和助手动作规则，关闭随机突变与漫游事件，采用 0.1 秒边界的事件推进近似。',
            '每次采收按单株 farmValue 发放农场币；净收入扣除助手工资与 Boost 50、Rich 100、Amaze 200 的基础采购价。采用该净币口径时使用自用玩法中的固定基础价；动态价格采购需要替换实际成本。',
            '初次建阵、解锁和购买农田的投入未计入，期末在田种子不预支未来收成。',
        ] : productionNotes;
        cards.push({ id: `${category}-${index}`, category, title, subtitle: category === 'berries' ? '树果净新增候选搜索最佳' : '普通种收的农场币候选',
            berry: best.berry ?? record.berry, berryName: name, plan, metric, objectiveMetric: record.metric,
            notes: [...calculationNotes, ...safetyNotes, ...strings(plan.notes), ...genericNotes],
            assignments: normalizeAssignments(plan, metric.assignments), alternatives: record.alternatives ?? [], searched: record.searched,
            search: unique([title, name, record.chineseName, record.zhName, ...plan.cells.map(cell => berryName(cell.berry)), ...(metric.assignments ?? []).map(hand => hand.name)]).join(' ') });
    };
    (production.berries ?? []).slice().sort((a, b) => a.berry - b.berry).forEach((record, index) => addProductionCard(record, 'berries', index));
    (production.coins?.length ? production.coins : coinsData.coins ?? []).forEach((record, index) => addProductionCard(record, 'coins', index));
    const auraVariants = [['protectedRecommendation', 'Babiri 保护推荐'], ['maintenanceRecommendation', 'Petaya 成熟保活窗口'], ['nonParasiticRecommendation', '非寄生推荐'], ['suppressionRecommendation', '抑制突变'], ['negativeVariant', '负面效果演示']];
    (auras.auras ?? []).forEach((aura, index) => {
        const addAura = (entry, suffix = '', key = 'peak') => {
            const plan = entry.layout ?? entry.plan;
            if (!isPlan(plan)) throw new Error(`光环 ${aura.auraName} 缺少完整 25 格布局`);
            const notes = unique([...strings(entry.proof), ...strings(entry.limitations), ...strings(entry.note), ...strings(plan.notes),
                ...(key === 'peak' ? [] : strings(aura.limitations)), '本项仅为全部指定作物成熟时的静态倍率，不是永久挂机收益，也不代表从空田启动的平均倍率。', ...genericNotes]);
            const title = `${aura.chineseName} · ${suffix || '成熟峰值'}`;
            cards.push({ id: `auras-${index}-${key}`, category: 'auras', title, subtitle: aura.scope, plan,
                multiplier: entry.multiplier, objective: entry.objective ?? aura.objective, emitter: entry.emitter ?? aura.emitter,
                notes, assignments: normalizeAssignments(plan), auraName: aura.auraName, proof: entry.proof ?? aura.proof,
                search: [title, aura.auraName, entry.emitter ?? aura.emitter, ...plan.cells.map(cell => berryName(cell.berry)), 'Jessie'].join(' ') });
        };
        addAura(aura);
        auraVariants.forEach(([key, title]) => { if (aura[key]) addAura(aura[key], title, key); });
    });
    cards.forEach(card => {
        const seeds = new Map();
        card.plan.cells.forEach(cell => {
            if (cell.berry >= 0 && ['cycle', 'keep', 'evolve'].includes(cell.role)) seeds.set(cell.berry, (seeds.get(cell.berry) ?? 0) + 1);
        });
        card.notes.unshift(`从空田直接铺满所需种子：${[...seeds].map(([berry, count]) => `${berryName(berry)} ${count} 颗`).join('；')}。库存不足会等待，导入不会生成种子。`);
        if (card.category === 'coins' && card.berry === 60) card.notes.unshift('Maranga 配 Boost 时单次只返还 1 颗，不能靠此币方案自行扩种；完整铺阵需准备足够 Maranga 库存，不足时先使用树果量产方案。');
    });
    const productionCards = cards.filter(card => card.category === 'berries');
    const measuredHours = unique(cards.filter(card => card.category !== 'auras').map(card => card.metric.hours));
    const incomplete = productionCards.length !== berries.length;
    const warnings = [incomplete ? `当前输入只覆盖 ${productionCards.length}/${berries.length} 种树果，尚未计算的树果没有被凭空补齐。` : '',
        !cards.some(card => card.category === 'coins') ? '农场币数据尚未写入，本分类暂不提供候选结果。' : ''].filter(Boolean);
    const counts = { berries: productionCards.length, coins: cards.filter(card => card.category === 'coins').length, auras: cards.filter(card => card.category === 'auras').length };
    const table = (head, rows) => `<div class="table-scroll"><table><thead><tr>${head.map(text => `<th>${escapeHtml(text)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(text => `<td>${escapeHtml(text)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
    const lines = list => `<ul>${list.map(text => `<li>${escapeHtml(text)}</li>`).join('')}</ul>`;
    const composition = plan => {
        const groups = new Map();
        plan.cells.forEach(cell => { const label = `${berryName(cell.berry)} · ${roleNames[cell.role]}`; groups.set(label, (groups.get(label) ?? 0) + 1); });
        return [...groups].map(([label, count]) => `${label} ${count} 格`);
    };
    const gridHtml = card => `<div class="farm-grid" role="group" aria-label="${escapeHtml(card.title)}，左上为第 1 行第 1 列"><span class="grid-axis grid-axis--origin">行／列</span>${[1, 2, 3, 4, 5].map(n => `<span class="grid-axis">${n}</span>`).join('')}${Array.from({ length: 5 }, (_, row) => `<span class="grid-axis">${row + 1}</span>${card.plan.cells.slice(row * 5, row * 5 + 5).map((cell, col) => {
        const className = cell.role === 'cycle' || cell.role === 'evolve' || cell.role === 'mutation' ? 'target' : cell.berry === 51 ? 'guard' : cell.berry === 19 ? 'lum' : 'support';
        const label = `第 ${row + 1} 行第 ${col + 1} 列，${berryName(cell.berry)}，${roleNames[cell.role]}，${mulchNames[cell.mulch]}`;
        return `<div class="farm-cell farm-cell--${className}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><span class="cell-position">${row + 1}·${col + 1}</span><strong>${escapeHtml(berryName(cell.berry))}</strong><small>${cell.role === 'cycle' ? '循环' : cell.role === 'keep' ? '保留' : escapeHtml(roleNames[cell.role])} · ${escapeHtml(mulchNames[cell.mulch])}</small></div>`;
    }).join('')}`).join('')}</div>`;
    const assignmentsHtml = card => `<div class="assignments"><h4>助手与负责范围</h4>${card.assignments.map(hand => `<div class="assignment"><div class="assignment-name"><strong>${escapeHtml(hand.name)} <span>Lv.50</span></strong><small>${hand.plots.length} 格 · ${fmt(hand.wages, 0)} 币／小时</small></div><p>${hand.rows.map(escapeHtml).join('；<wbr>')}</p></div>`).join('')}${card.category === 'auras' ? '<p class="fine-print">Jessie 用于建阵与维护，成熟峰值由植物决定。工资不计入光环倍率。</p>' : ''}</div>`;
    const metricsHtml = card => card.category === 'auras' ? `<div class="metric-primary"><span>${escapeHtml(card.objective)}</span><strong>×${fmt(card.multiplier, 8)}</strong><small>${escapeHtml(card.emitter || '')} 发射，全部辅助成熟时</small></div>` : `<div class="metric-primary"><span>${card.category === 'coins' ? (card.objectiveMetric === 'coinsPerHour' ? '采收农场币毛收入／小时' : '扣工资与基础肥价后的净币') : '净新增树果／小时'}</span><strong>${fmt(card.category === 'coins' ? card.metric[card.objectiveMetric || 'netCoinsBaseMulch'] : card.metric.netPerHour)}</strong><small>${card.category === 'coins' ? '净币使用固定基础价采购口径；动态采购成本另算' : '毛收获扣去真实播种消耗，忽略农场币支出来选优'}</small></div>${table(card.category === 'coins' ? ['收益口径', '币／小时'] : ['仿真指标', '数值'], card.category === 'coins' ? [
        ['采收毛币', fmt(card.metric.coinsPerHour)], ['助手工资', fmt(card.metric.wagesPerHour)],
        ['扣工资净币', fmt(card.metric.netCoinsBeforeMulch)], ['再扣基础肥价', fmt(card.metric.netCoinsBaseMulch)],
        ['肥料用量（袋／小时）', fmt(card.metric.mulchUnitsPerHour)], ['验证窗口（小时）', fmt(card.metric.hours)],
    ] : [['毛收获（颗／小时）', fmt(card.metric.grossPerHour)], ['采收次数（次／小时）', fmt(card.metric.harvestsPerHour)],
        ['肥料消耗（袋／小时）', fmt(card.metric.mulchUnitsPerHour)], ['助手工资（币／小时）', fmt(card.metric.wagesPerHour)], ['验证窗口（小时）', fmt(card.metric.hours)]])}`;
    const cardHtml = card => `<article class="plan-card" id="${escapeHtml(card.id)}" data-category="${card.category}" data-search="${escapeHtml(card.search.toLowerCase())}">
        <header class="card-heading"><div><p class="eyebrow">${escapeHtml(card.subtitle)}</p><h3>${escapeHtml(card.title)}</h3></div><button type="button" class="copy-button" data-copy aria-label="复制 ${escapeHtml(card.title)} 的完整布局 JSON">复制布局 JSON <span aria-hidden="true">↗</span></button></header>
        <div class="plan-body"><div class="plan-map">${gridHtml(card)}<div class="legend"><span class="legend-target">循环／目标格</span><span class="legend-support">辅助／光环格</span><span class="legend-guard">Babiri 保护格</span></div><p class="composition">${composition(card.plan).map(escapeHtml).join(' · ')}</p></div><div class="plan-summary">${metricsHtml(card)}${assignmentsHtml(card)}</div></div>
        <details class="explanation-details"><summary>完整说明、执行边界与依据 <span>展开阅读</span></summary>${lines(card.notes)}${card.alternatives?.length ? `<h4>已仿真的其他候选</h4>${table(['生产助手', '肥料', '净新增／小时', '扣工资净币／小时'], card.alternatives.map(item => [item.hand, mulchNames[item.mulch], fmt(item.measured?.netPerHour), fmt(item.measured?.netCoinsBeforeMulch)]))}<p class="fine-print">候选表用于了解有限搜索中的比较范围；上方复制按钮对应当前推荐的完整布局。</p>` : ''}</details>
        <details class="json-details"><summary>完整可导入 JSON <span>25 格，含角色与肥料</span></summary><textarea readonly spellcheck="false" rows="10" aria-label="${escapeHtml(card.title)} 的完整布局 JSON">${escapeHtml(json(card.plan))}</textarea><button type="button" class="select-button" data-select>选中全部 JSON</button></details>
    </article>`;
    const css = `
:root{--paper:#f4f0e5;--page:#fffdf6;--ink:#173e2e;--muted:#5f6e61;--green:#1f513a;--pale:#e6eddf;--line:#c7d0bd;--orange:#d86d32;--orange-pale:#f9e6d1;--serif:"STSong","SimSun","Noto Serif CJK SC",Georgia,serif;--sans:"Microsoft YaHei","PingFang SC",sans-serif;--mono:"Cascadia Code",Consolas,monospace}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:110px}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.65}button,input,textarea{font:inherit}button,a,input,summary{touch-action:manipulation}button{cursor:pointer}a{color:var(--green)}button:focus-visible,a:focus-visible,summary:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid var(--orange);outline-offset:3px}button{transition:background .15s,transform .15s}button:active{transform:translateY(1px)}[hidden]{display:none!important}.topbar{padding:16px max(24px,calc((100vw - 1320px)/2));display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);font-size:12px;letter-spacing:.08em}.topbar strong{font-family:var(--serif);font-size:17px;letter-spacing:.1em}.topbar a{text-underline-offset:4px}.hero{max-width:1320px;margin:26px auto 0;background:var(--ink);color:var(--page);padding:46px 44px;position:relative;overflow:hidden;border-top:6px solid var(--orange)}.hero::after{content:"";position:absolute;width:235px;height:235px;right:-22px;top:-18px;opacity:.16;transform:rotate(-14deg);background:repeating-linear-gradient(0deg,transparent 0 43px,var(--page) 43px 46px),repeating-linear-gradient(90deg,transparent 0 43px,var(--page) 43px 46px);pointer-events:none}.hero .eyebrow{color:#cddbc7}.hero h1{font-family:var(--serif);font-size:clamp(32px,4vw,52px);line-height:1.25;font-weight:600;letter-spacing:.03em;max-width:830px;margin:16px 0}.hero p{position:relative;max-width:850px;margin:0;color:#e0e8dc}.hero-meta{display:flex;gap:12px;flex-wrap:wrap;margin-top:27px}.hero-meta span{border:1px solid #66836c;padding:5px 10px;font-size:12px}.hero-meta b{color:#ffbd83}.eyebrow{margin:0;font-size:11px;letter-spacing:.1em;font-weight:600}.scope{max-width:1320px;margin:0 auto;padding:24px 28px;background:#fff8e7;border:1px solid #dbbb87;border-top:0;display:grid;grid-template-columns:1fr 1fr;gap:24px}.scope strong{display:block;color:#8e431e;margin-bottom:6px;font-size:15px}.scope p{margin:0;font-size:13px}.data-warning{max-width:1320px;margin:16px auto;padding:16px 24px;background:var(--orange-pale);border-left:4px solid var(--orange);font-size:14px}.workspace{display:grid;grid-template-columns:235px minmax(0,1fr);max-width:1320px;margin:30px auto;gap:30px}.sidebar{align-self:start;position:sticky;top:24px}.sidebar-number{font-family:var(--serif);font-size:43px;line-height:1.1;color:var(--orange)}.sidebar h2{font-family:var(--serif);font-size:24px;line-height:1.35;margin:10px 0 18px}.sidebar p,.sidebar li{font-size:13px}.sidebar ol{padding-left:20px}.sidebar .rule{height:1px;background:var(--line);margin:20px 0}.sidebar a{display:inline-block;margin-bottom:8px}.toolbar{position:sticky;top:0;z-index:4;background:var(--paper);padding:0 0 14px;border-bottom:2px solid var(--ink);margin-bottom:24px}.toolbar-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.tab-button{border:1px solid var(--line);padding:11px 15px;background:var(--page);color:var(--ink);font-size:14px}.tab-button[aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:var(--page)}.tab-count{margin-left:8px;font-size:11px;opacity:.75}.search-row{display:flex;align-items:center;gap:12px}.search-wrap{flex:1;position:relative}.search-wrap input{display:block;width:100%;background:var(--page);border:1px solid var(--line);padding:11px 14px;border-radius:0;min-width:0;font-size:14px}.search-wrap label{display:block;font-size:11px;color:var(--muted);margin-bottom:5px}.result-count{align-self:end;padding-bottom:12px;white-space:nowrap;font-size:12px;color:var(--muted)}.print-button{align-self:end;border:0;background:none;color:var(--green);text-decoration:underline;text-underline-offset:4px;font-size:12px;padding:12px 0}.category-intro{font-size:14px;margin:0 0 22px;color:var(--muted)}.plan-card{background:var(--page);border:1px solid var(--line);margin-bottom:24px;scroll-margin-top:155px}.card-heading{padding:20px 22px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--line)}.card-heading h3{font-family:var(--serif);font-size:27px;font-weight:600;margin:4px 0 0;line-height:1.3}.card-heading .eyebrow{font-size:11px;color:var(--muted);letter-spacing:.02em}.copy-button{background:var(--green);color:var(--page);border:1px solid var(--green);padding:10px 13px;white-space:nowrap;font-size:12px}.copy-button:hover{background:#123524}.copy-button span{margin-left:12px}.plan-body{padding:23px 22px;display:grid;grid-template-columns:minmax(300px,1.05fr) minmax(220px,1fr);gap:26px}.farm-grid{display:grid;grid-template-columns:22px repeat(5,minmax(0,1fr));gap:4px}.grid-axis{display:flex;justify-content:center;align-items:center;min-height:20px;font-size:11px;color:var(--muted)}.grid-axis--origin{font-size:8px;white-space:nowrap}.farm-cell{min-height:70px;padding:7px 2px 5px;border:1px solid var(--line);display:flex;flex-direction:column;justify-content:center;align-items:center;position:relative;text-align:center;min-width:0}.farm-cell strong{font-size:12px;line-height:1.3;overflow-wrap:anywhere;font-weight:600;position:relative}.farm-cell small{font-size:8px;margin-top:6px;line-height:1.2;color:var(--muted)}.cell-position{position:absolute;top:2px;left:3px;font-size:7px;line-height:1;color:var(--muted);opacity:.65}.farm-cell--target{background:var(--orange-pale);border-color:#d9a479}.farm-cell--support{background:var(--pale)}.farm-cell--lum{background:var(--green);border-color:var(--green);color:var(--page)}.farm-cell--lum small,.farm-cell--lum .cell-position{color:#e5ebd9}.farm-cell--guard{background:repeating-linear-gradient(135deg,#f1f1e5 0 4px,#e6ead9 4px 8px)}.legend{display:flex;flex-wrap:wrap;gap:8px 12px;font-size:10px;margin-top:13px;color:var(--muted)}.legend span::before{content:"";display:inline-block;width:8px;height:8px;margin-right:4px;border:1px solid var(--line)}.legend-target::before{background:var(--orange-pale)}.legend-support::before{background:var(--pale)}.legend-guard::before{background:#d7dfc7}.composition{font-size:11px;color:var(--muted);margin:12px 0 0;line-height:1.8}.metric-primary{padding:0 0 14px;border-bottom:1px solid var(--line);margin-bottom:14px}.metric-primary>span{font-size:11px;display:block;color:var(--muted)}.metric-primary>strong{font-family:var(--serif);font-size:37px;line-height:1.3;display:block;font-weight:600;font-variant-numeric:tabular-nums;margin:4px 0}.metric-primary>small{font-size:10px;color:var(--muted);line-height:1.5;display:block}table{border-collapse:collapse;width:100%;font-size:11px;text-align:left}td,th{padding:8px 5px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--muted)}td:last-child,th:last-child{text-align:right;font-variant-numeric:tabular-nums}.table-scroll{overflow-x:auto}.assignments h4{font-size:12px;margin:16px 0 8px}.assignment{border-left:2px solid var(--orange);padding-left:10px;margin-bottom:10px}.assignment-name{display:flex;align-items:center;justify-content:space-between;gap:8px}.assignment-name strong{font-size:12px}.assignment-name strong span{font-size:9px;color:var(--muted);font-weight:400}.assignment-name small{font-size:9px;color:var(--muted);text-align:right}.assignment p{font-size:10px;line-height:1.9;margin:4px 0;color:var(--muted)}.fine-print{font-size:10px;color:var(--muted);line-height:1.8}details{border-top:1px solid var(--line);padding:0 22px}summary{padding:14px 0;cursor:pointer;font-size:12px;font-weight:600}summary span{font-size:10px;font-weight:400;color:var(--muted);margin-left:8px}details ul{font-size:12px;padding-left:19px;line-height:1.9;margin-top:0}details li{margin-bottom:7px}details h4{font-size:12px}.json-details textarea{display:block;width:100%;min-height:225px;resize:vertical;background:#eef0e6;color:var(--ink);border:1px solid var(--line);font:11px/1.6 var(--mono);padding:12px;tab-size:2;white-space:pre}.select-button{font-size:11px;border:1px solid var(--line);background:var(--page);color:var(--green);padding:7px 10px;margin:10px 0 15px}.empty-state{border:1px dashed var(--line);padding:35px 20px;text-align:center;color:var(--muted);background:var(--page)}.appendix{max-width:1320px;margin:30px auto 60px;background:var(--page);border:1px solid var(--line);padding:27px 30px}.appendix h2{font-family:var(--serif);font-size:28px}.appendix p,.appendix li{font-size:13px}.appendix>details{border:1px solid var(--line);margin-top:20px}.reference-text{white-space:pre-wrap;font-size:12px;line-height:1.9;font-family:var(--sans);overflow-wrap:anywhere;padding-bottom:20px}.helper-table td,.helper-table th{font-size:12px}.page-footer{max-width:1320px;margin:0 auto 25px;display:flex;justify-content:space-between;gap:20px;font-size:11px;color:var(--muted);border-top:1px solid var(--line);padding-top:16px}.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--ink);color:var(--page);padding:12px 20px;font-size:13px;z-index:10;max-width:calc(100vw - 32px);text-align:center;border-left:4px solid var(--orange)}.skip-link{position:absolute;left:12px;top:-60px;padding:10px;background:var(--page);z-index:20}.skip-link:focus{top:12px}.no-script{padding:20px;background:var(--orange-pale)}
.scope .scope-assumptions{grid-column:1/-1;border-top:1px solid #dbbb87;padding-top:15px;font-size:12px;color:#754321}.scope-assumptions b{font-weight:600}
.workspace main,.plan-map,.plan-summary{min-width:0}.topbar a{white-space:nowrap}.helper-table{max-width:100%}
@media(min-width:1100px){.hero{animation:reveal .35s ease-out}.plan-card{animation:reveal .25s ease-out}}@keyframes reveal{from{transform:translateY(5px)}to{transform:translateY(0)}}@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}*{animation:none!important;transition:none!important}}
@media(max-width:1360px){.hero,.scope,.workspace,.appendix,.page-footer,.data-warning{margin-left:24px;margin-right:24px}.workspace{grid-template-columns:190px minmax(0,1fr);gap:22px}.plan-body{grid-template-columns:minmax(270px,1fr) minmax(210px,1fr);gap:20px}}
@media(max-width:1080px){.workspace{grid-template-columns:1fr}.sidebar{position:static;display:none}.plan-body{grid-template-columns:minmax(300px,1fr) minmax(250px,1fr)}.hero{padding:34px 28px}.card-heading h3{font-size:25px}}
@media(max-width:700px){.hero,.scope,.workspace,.appendix,.page-footer,.data-warning{margin-left:12px;margin-right:12px}.topbar{padding:13px 16px}.topbar>span{display:none}.topbar strong{font-size:13px}.topbar a{font-size:10px}.hero{padding:27px 21px;margin-top:12px}.hero h1{font-size:34px}.hero p{font-size:13px}.hero-meta{gap:7px;margin-top:20px}.hero-meta span{font-size:10px}.scope{grid-template-columns:1fr;gap:16px;padding:19px 20px}.workspace{margin-top:21px}.toolbar-tabs{gap:4px}.tab-button{padding:10px 11px;font-size:12px}.tab-count{margin-left:4px}.search-row{gap:8px;flex-wrap:wrap}.search-wrap{min-width:65%}.search-wrap input{font-size:12px}.result-count{font-size:10px}.print-button{display:none}.card-heading{padding:18px 16px;align-items:flex-start;gap:10px}.card-heading h3{font-size:23px}.card-heading .eyebrow{font-size:10px}.copy-button{font-size:10px;padding:9px 10px}.copy-button span{display:none}.plan-body{grid-template-columns:1fr;padding:17px 16px;gap:18px}.farm-grid{gap:4px;grid-template-columns:19px repeat(5,minmax(0,1fr))}.farm-cell{min-height:67px}.farm-cell strong{font-size:12px}.farm-cell small{font-size:8px}.plan-summary{display:grid;grid-template-columns:1fr;gap:0}.metric-primary>strong{font-size:36px}.assignment p{font-size:11px}.assignment-name small{font-size:10px}details{padding:0 16px}summary{font-size:11px}summary span{font-size:9px}.appendix{padding:20px 16px}.appendix h2{font-size:24px}.page-footer{display:block}.hero::after{opacity:.08}.helper-table table{min-width:500px}}
@media(max-width:370px){.farm-cell{min-height:61px}.farm-cell strong{font-size:10px}.farm-cell small{font-size:7px}.hero h1{font-size:30px}.copy-button{font-size:9px}.tab-button{padding:10px 9px}}
@media print{body{background:white;color:#111;font-size:10pt}.topbar,.toolbar,.sidebar,.copy-button,.select-button,.json-details,.toast,.skip-link,.legend,.no-script{display:none!important}.hero,.scope,.workspace,.appendix,.page-footer,.data-warning{margin:0 0 12pt;max-width:none}.hero{color:#111;background:white;border-top:3pt solid #333;padding:12pt 0;break-inside:avoid}.hero p,.hero .eyebrow{color:#333}.hero h1{font-size:27pt;max-width:none}.hero::after{display:none}.hero-meta span{border:1px solid #aaa;color:#111}.hero-meta b{color:#111}.scope{padding:12pt;background:white;break-inside:avoid}.scope strong{color:#111}.workspace{display:block}.plan-card{break-inside:avoid;page-break-inside:avoid;margin-bottom:14pt}.card-heading{padding:10pt 12pt}.card-heading h3{font-size:20pt}.plan-body{grid-template-columns:1fr 1fr;padding:12pt;gap:18pt}.farm-cell{min-height:45pt;print-color-adjust:exact;-webkit-print-color-adjust:exact}.farm-cell strong{font-size:9pt}.farm-cell small{font-size:6pt}.metric-primary>strong{font-size:25pt}.explanation-details{font-size:8pt}.explanation-details ul{font-size:8pt}summary{font-size:9pt}.appendix{break-before:page;padding:0;border:0}.appendix>details{padding:8pt 12pt}.reference-text{font-size:8pt}.page-footer{font-size:8pt}.table-scroll{overflow:visible}.helper-table{min-width:0}.category-intro{font-size:9pt}}
`;
    const script = `
(() => {
    const cards = Array.from(document.querySelectorAll('.plan-card'));
    const tabs = Array.from(document.querySelectorAll('[data-category-tab]'));
    const search = document.querySelector('#plan-search');
    const result = document.querySelector('#result-count');
    const empty = document.querySelector('#empty-state');
    const intro = document.querySelector('#category-intro');
    let category = 'berries';
    const introductions = {
        berries: '每种树果保留一个经真实工作链复核的候选。主数字是每小时净新增，已经扣除播种种子。',
        coins: '同时查看采收毛币、助手工资、扣工资净币、按基础肥价计算的净币。树果增产不会直接增加每株农场币。',
        auras: '全部结果为成熟静态峰值。Egg 的 Babiri 保护推荐、非寄生突变推荐与负面效果另外标注。',
        all: '当前显示全部推荐，搜索可同时匹配树果、辅助株、光环名称与助手。'
    };
    const applyFilter = () => {
        const words = search.value.trim().toLowerCase().split(/\\s+/).filter(Boolean);
        let shown = 0;
        cards.forEach(card => {
            const visible = (category === 'all' || card.dataset.category === category) && words.every(word => card.dataset.search.includes(word));
            card.hidden = !visible;
            if (visible) shown++;
        });
        tabs.forEach(tab => tab.setAttribute('aria-pressed', String(tab.dataset.categoryTab === category)));
        result.textContent = shown + ' 个方案';
        intro.textContent = introductions[category];
        empty.hidden = shown !== 0;
    };
    tabs.forEach(tab => tab.addEventListener('click', () => { category = tab.dataset.categoryTab; applyFilter(); }));
    search.addEventListener('input', applyFilter);
    const toast = document.querySelector('#toast');
    let toastTimer;
    const announce = message => { clearTimeout(toastTimer); toast.textContent = message; toast.hidden = false; toastTimer = setTimeout(() => { toast.hidden = true; }, 4500); };
    const selectJson = card => {
        const details = card.querySelector('.json-details');
        const field = details.querySelector('textarea');
        details.open = true;
        field.focus();
        field.select();
        field.setSelectionRange(0, field.value.length);
        return field;
    };
    document.addEventListener('click', async event => {
        const copy = event.target.closest('[data-copy]');
        const select = event.target.closest('[data-select]');
        if (select) { selectJson(select.closest('.plan-card')); announce('已选中完整布局，可按 Ctrl+C 或使用系统复制。'); return; }
        if (!copy) return;
        const card = copy.closest('.plan-card');
        const text = card.querySelector('textarea').value;
        try {
            if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('剪贴板不可用');
            await navigator.clipboard.writeText(text);
            announce('已复制完整 25 格布局。前往农场 → 布局 → 导入。');
        } catch {
            selectJson(card);
            let copied = false;
            try { copied = document.execCommand('copy'); } catch {}
            announce(copied ? '已复制完整 25 格布局。' : '浏览器未开放剪贴板，已选中完整 JSON，请按 Ctrl+C 复制。');
        }
    });
    document.querySelector('#print-current').addEventListener('click', () => window.print());
    let openedForPrint = [];
    window.addEventListener('beforeprint', () => { openedForPrint = Array.from(document.querySelectorAll('.plan-card:not([hidden]) .explanation-details')).filter(node => !node.open); openedForPrint.forEach(node => { node.open = true; }); });
    window.addEventListener('afterprint', () => { openedForPrint.forEach(node => { node.open = false; }); openedForPrint = []; });
    applyFilter();
})();`;
    const metadata = { generatedDate: '2026-10-18', sourceFiles: [path.basename(options.production), path.basename(options.berries), path.basename(options.auras), path.basename(options.mechanics), path.basename(coinsPath)], options: sourceOptions, counts, measuredHours,
        coinSearch: coinsData.scope,
        scope: '生产为成熟辅助阵平台上、0.5–32 小时自适应窗口中的候选搜索最佳估算，不是全部策略全局证明；光环是成熟静态峰值，不是永久效果。',
        defaultAssumptions: '用户没有另外指定倍率，默认采用本分支满级 Sprayduck 生长 ×2.75、Sprinklotad 肥效时长 ×4.5；未读取用户真实存档。' };
    const helperTableHtml = table(['助手 Lv.50', '周期／秒', '每轮动作', '工资／小时'], helperData.map(([name, seconds, actions, wages]) => [name, fmt(seconds, 1), actions, fmt(wages, 0)]));
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><meta name="description" content="PokéClicker 满级农场助手种植与光环布局手册，内嵌可直接复制的完整 JSON。"><title>农场满级助手布局大全 · PokéClicker</title><style>${css}</style></head><body>
<a class="skip-link" href="#plans">跳到布局方案</a><div class="topbar"><strong>POKÉCLICKER ／ 农场工作手册</strong><span>本地资料 · 无需联网 · 2026.10.18</span><a href="#reference">机制与计算依据 ↓</a></div>
<header class="hero"><p class="eyebrow">25 格农田 · Lv.50 助手 · 可直接复制</p><h1>把每一格，<br>种在合适的位置。</h1><p>按树果查产量，按收益查农场币，再为不同目标配置光环。每一份布局都带有完整 JSON、5×5 田格与助手负责行列。</p><div class="hero-meta"><span><b>${counts.berries}</b> 种树果</span><span><b>${counts.coins}</b> 份农场币方案</span><span><b>${counts.auras}</b> 份光环方案</span><span>生长 <b>×${fmt(sourceOptions.growth ?? 2.75)}</b></span><span>肥效时长 <b>×${fmt(sourceOptions.duration ?? 4.5)}</b></span></div></header>
<div class="scope"><div><strong>生产方案：成熟平台的候选搜索最佳</strong><p>以辅助株已经成熟的 0.5–32 小时自适应窗口估算普通助手循环。有限候选搜索不等于全机制全局证明，建阵时间、随机突变与其他生产路径需要另算。</p></div><div><strong>光环方案：成熟静态峰值</strong><p>倍率描述全部指定植物成熟时的效果，不是永久峰值。补种、衰败、寄生和助手救种会改变现场；冻结会直接关闭光环。</p></div><p class="scope-assumptions"><b>默认倍率：</b>未另行指定时，采用本分支满级 Sprayduck 生长 ×2.75、Sprinklotad 肥效时长 ×4.5；未读取真实存档。<br><b>复制只包含布局：</b>助手雇用、负责格子、种子和肥料库存不包含在 JSON 中，必须手动配置。</p></div>
${warnings.length ? `<div class="data-warning" role="note"><strong>数据完整性提示</strong>${lines(warnings)}</div>` : ''}
<noscript><p class="no-script">浏览器脚本未启用，仍可阅读下方全部方案并手动选择 JSON；分类筛选与复制按钮需要 JavaScript。</p></noscript>
<div class="workspace"><aside class="sidebar"><div class="sidebar-number">01—25</div><h2>一块田，<br>一份明确分工。</h2><p>行列从左上角开始，先行后列。橙色格是循环或突变目标，其余格保持指定辅助植物。</p><div class="rule"></div><ol><li>在游戏中打开目标农田。</li><li>复制需要的完整布局。</li><li>在「布局」页导入。</li><li>按说明分配助手格子。</li><li>检查种子、肥料和安全锁。</li><li>启用后等待真实建阵。</li></ol><div class="rule"></div><p>JSON 不会自动雇用助手、设定负责范围，或改变作物年龄。</p><a href="#helper-reference">查看满级助手能力 →</a><br><a href="#reference">查看完整机制审计 →</a></aside>
<main id="plans"><div class="toolbar"><nav class="toolbar-tabs" aria-label="方案分类"><button type="button" class="tab-button" data-category-tab="berries" aria-pressed="true">树果量产<span class="tab-count">${counts.berries}</span></button><button type="button" class="tab-button" data-category-tab="coins" aria-pressed="false">农场币<span class="tab-count">${counts.coins}</span></button><button type="button" class="tab-button" data-category-tab="auras" aria-pressed="false">各种光环<span class="tab-count">${counts.auras}</span></button><button type="button" class="tab-button" data-category-tab="all" aria-pressed="false">全部</button></nav><div class="search-row"><div class="search-wrap"><label for="plan-search">查找树果、光环或助手</label><input id="plan-search" type="search" autocomplete="off" placeholder="例如 Enigma、Passho、Jessie、突变"></div><span class="result-count" id="result-count" aria-live="polite">${cards.length} 个方案</span><button type="button" id="print-current" class="print-button">打印当前分类</button></div></div><p class="category-intro" id="category-intro">每种树果的候选方案，包含完整种植与助手分工。</p><div id="empty-state" class="empty-state" hidden>当前分类没有匹配的方案。可清空搜索，或切换「全部」。</div>${cards.map(cardHtml).join('\n')}</main></div>
<section class="appendix" id="reference"><p class="eyebrow">附录 ／ 让数字有出处</p><h2>读懂这些布局，再让助手接手。</h2><p>基础单株农场币与收获颗数无关。果实排名使用净新增；农场币同时列出毛币、工资和采购成本口径。动态肥价模式不能直接套用固定基础肥价后的净收入。</p><div id="helper-reference" class="helper-table">${helperTableHtml}</div><p>同一格归助手名单中首位符合条件的助手负责。多人全选 25 格不会自动分摊工作；必须照各方案行列设置互不重叠的负责范围。满级每轮恢复 2 体力，实际工作消耗 2，体力充足时可持续工作。</p><details><summary>完整机制审计与源码位置 <span>包括特殊树果、随机事件与计算边界</span></summary><div class="reference-text">${escapeHtml(mechanics)}</div></details><details><summary>光环计算方法与验证 <span>几何枚举与真实源码重算</span></summary>${lines([auras.scope, auras.globalEnumeration?.algorithm, ...strings(auras.mutationAudit), ...Object.values(auras.verification ?? {}).filter(value => typeof value === 'string')])}</details><details><summary>本报告的输入与计算参数</summary><div class="reference-text">${escapeHtml(json(metadata))}</div></details></section>
<footer class="page-footer"><span>农场满级助手布局大全 · 当前工作区源码 · 游戏 0.10.27</span><span>所有资料与脚本均内嵌，保存此 HTML 即可离线使用。</span></footer><div class="toast" id="toast" role="status" aria-live="polite" hidden></div><script type="application/json" id="report-metadata">${JSON.stringify(metadata).replace(/</g, '\\u003c')}</script><script>${script}</script></body></html>`;

    const mdTable = (head, rows) => `| ${head.join(' | ')} |\n| ${head.map(() => '---').join(' | ')} |\n${rows.map(row => `| ${row.map(text => String(text).replace(/\|/g, '\\|').replace(/\n/g, '<br>')).join(' | ')} |`).join('\n')}\n`;
    const markdownCard = card => {
        const metrics = card.category === 'auras' ? `**成熟倍率：×${fmt(card.multiplier, 8)}。${card.objective}。**\n\n${card.subtitle}\n` : mdTable(['指标', '数值'], [
            ['净新增树果／小时', fmt(card.metric.netPerHour)], ['毛收获／小时', fmt(card.metric.grossPerHour)], ['采收次数／小时', fmt(card.metric.harvestsPerHour)],
            ['采收毛币', fmt(card.metric.coinsPerHour)], ['助手工资', fmt(card.metric.wagesPerHour)],
            ['扣工资净币', fmt(card.metric.netCoinsBeforeMulch)], ['按基础肥价净币', fmt(card.metric.netCoinsBaseMulch)],
            ['肥料消耗／小时', fmt(card.metric.mulchUnitsPerHour)], ['验证窗口／小时', fmt(card.metric.hours)],
        ]);
        const gridRows = Array.from({ length: 5 }, (_, row) => [`第 ${row + 1} 行`, ...card.plan.cells.slice(row * 5, row * 5 + 5).map(cell => `${berryName(cell.berry)}<br>${cell.role === 'cycle' ? '循环' : roleNames[cell.role]}／${mulchNames[cell.mulch]}`)]);
        return `### ${card.title}\n\n${metrics}\n${mdTable(['行／列', '第 1 列', '第 2 列', '第 3 列', '第 4 列', '第 5 列'], gridRows)}\n**助手分工：**\n\n${card.assignments.map(hand => `- ${hand.name} Lv.50，${hand.plots.length} 格，工资 ${fmt(hand.wages, 0)} 币／小时：${hand.rows.join('；')}。`).join('\n')}\n\n**说明与边界：**\n\n${card.notes.map(note => `- ${note}`).join('\n')}\n\n**可直接导入的完整布局 JSON：**\n\n\`\`\`json\n${json(card.plan)}\n\`\`\`\n`;
    };
    const markdown = `# 农场满级助手布局大全\n\n依据当前工作区源码计算，游戏版本 0.10.27，日期 2026-10-18。\n\n**生产方案是成熟辅助阵平台上、0.5–32 小时自适应窗口内的候选搜索最佳估算，不是全机制全局最优证明。光环方案是成熟静态峰值，不是永久挂机倍率。**\n\n未另行指定倍率时，默认采用本分支满级 Sprayduck 与 Sprinklotad：生长倍率 ×${fmt(sourceOptions.growth ?? 2.75)}，肥料持续时间倍率 ×${fmt(sourceOptions.duration ?? 4.5)}。已计算 ${counts.berries}/${berries.length} 种树果、${counts.coins} 份农场币方案、${counts.auras} 份光环方案。\n\n${warnings.length ? `> 数据提示：${warnings.join(' ')}\n\n` : ''}## 使用方法\n\n1. 选择目标农田，复制所需方案的完整 JSON。\n2. 在「农场 → 布局」导入。每份 JSON 都有恰好 25 格，按左上到右下排列。\n3. 雇用对应满级助手，按方案行列分别设置 Allowed Plots，范围不要重叠。\n4. 检查已有作物、种子、肥料、安全锁和所有辅助格，再启用布局。\n5. 导入不会改变真实作物年龄，也不会自动雇用助手或追加库存；需要等待真实建阵。\n\n## 满级助手能力\n\n${mdTable(['助手', '周期／秒', '每轮动作', '工资／小时'], helperData.map(([name, seconds, actions, wages]) => [name, fmt(seconds, 1), actions, fmt(wages, 0)]))}\n## 每种树果的循环生产方案\n\n按每小时净新增选优，已扣播种消耗，不考虑农场币支出。\n\n${cards.filter(card => card.category === 'berries').map(markdownCard).join('\n')}\n## 农场币生产方案\n\n每株农场币等于基础 farmValue，与收获颗数无关。基础肥价净币仅适用于固定基础价采购口径；动态价格需要另算。\n\n${counts.coins ? cards.filter(card => card.category === 'coins').map(markdownCard).join('\n') : '输入尚无农场币候选。\n'}\n## 各种光环的成熟峰值\n\n全局光环各田分别连乘，再取最大值；多田之间不继续连乘。所有提供光环或 Petaya 保活的植物都不能施 Freeze。\n\n${cards.filter(card => card.category === 'auras').map(markdownCard).join('\n')}\n## 光环枚举与验证方法\n\n${[auras.globalEnumeration?.algorithm, ...strings(auras.mutationAudit), ...Object.values(auras.verification ?? {}).filter(value => typeof value === 'string')].filter(Boolean).map(note => `- ${note}`).join('\n')}\n\n## 完整机制审计\n\n${mechanics.replace(/^# /m, '### ')}\n`;
    return { html, markdown, metadata, cards };
}

function main() {
    const options = argumentsFrom(process.argv.slice(2));
    if (!options) {
        console.log('用法：node design/farm-layout-analysis/render-report.cjs [--production 文件] [--berries 文件] [--auras 文件] [--mechanics 文件] [--output-dir 目录]\n默认读取同目录的 production-2.75.json、berry-data.json、aura-data.json、mechanics-notes.md；默认生成 design/农场满级助手布局大全.html 与同名 .md。无需安装依赖。');
        return;
    }
    const result = buildReport(options);
    fs.mkdirSync(options.outputDir, { recursive: true });
    const htmlPath = path.join(options.outputDir, '农场满级助手布局大全.html');
    const markdownPath = path.join(options.outputDir, '农场满级助手布局大全.md');
    fs.writeFileSync(htmlPath, `${result.html.trimEnd()}\n`, 'utf8');
    fs.writeFileSync(markdownPath, `${result.markdown.trimEnd()}\n`, 'utf8');
    console.log(JSON.stringify({ html: htmlPath, markdown: markdownPath, counts: result.metadata.counts }, null, 2));
}

module.exports = { buildReport, argumentsFrom, defaults };
if (require.main === module) main();
