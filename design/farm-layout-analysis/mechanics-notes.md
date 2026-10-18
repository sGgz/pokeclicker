# 农场布局的执行机制与特殊树果审计

本文件根据本仓库当前代码核对，日期为 2026-10-18。分析对象是本分支实现的农场与布局助手，不把其他版本的 Wiki 参数直接当作当前事实。本文只整理机制，不修改游戏规则；具体布局的收益还应以实际动作预算、成熟时间、突变资格和库存扣种验证。

## 1. 满级助手的真实能力

满级为 50 级。满级体力为基础容量加 245，每个工作周期恢复 2 点体力，实际工作固定消耗 2 点，持续工作净耗体力为 0。体力为 0 时会先恢复一轮。`accuracy` 在当前采收、种植执行逻辑中没有成功率判定，不能据此乘一个产量折扣。

| 助手 | 满级体力容量 | 每轮动作上限 | 公式周期（秒） | 实际周期（秒） | 原始工资／实际扣款（币／小时） | 理论动作吞吐（次／小时） |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Alex | 255 | 25 | 750 | 750 | 140 | 120.00 |
| Logan | 260 | 25 | 385.135135 | 385.2 | 440 | 233.64 |
| Joey | 255 | 25 | 202.702703 | 202.8 | 630 | 443.79 |
| Charlie | 275 | 25 | 141.891892 | 141.9 | 910 | 634.25 |
| Bailey | 255 | 25 | 101.351351 | 101.4 | 1,300 | 887.57 |
| Kerry | 295 | 25 | 70.945946 | 71 | 1,900 | 1,267.61 |
| Riley | 315 | 50 | 50.675676 | 50.7 | 4,000 | 3,550.30 |
| Jamie | 310 | 25 | 30.405405 | 30.5 | 4,000 | 2,950.82 |
| Jessie | 345 | 50 | 20.270270 | 20.3 | 8,300 | 8,867.00 |

工资公式是 `+Math.pow(100, 1 + cost * 0.08).toPrecision(2)`，没有满级工资折扣。工作周期使用 `基础周期 / (1 + 0.04 × 49)`，实际每 100ms 检查一次，达到阈值后归零，因此周期向上取整到 0.1 秒。理论动作吞吐只是持续每轮用满动作的上界，不能直接当作作物收获频率。

雇用时立即扣一次工资，随后每小时再次扣款；雇用后的下一游戏 tick 立即安排首轮工作。因此短时试跑不能把首轮即时工作当作长期平均周期，也要把首次雇用费和长期时薪区分。

源码：`src/scripts/farming/FarmHand.ts:34-55、85-88、120、129-133、150-170、192-215、219-224、320-326、449-458`；游戏 tick 为 `src/modules/GameConstants.ts:12`。

## 2. 多人分工、动作预算和复制布局的实际边界

- 每田最多雇 3 人，最多 16 块田，每田 25 格。不同田的同名助手共享经验，工作计时、体力、工资独立。
- 同一格归助手名单中第一个“已雇用、已解锁、勾选该格”的助手所有，名单顺序就是上表顺序。多位助手全部勾全田时，后面的人无法分摊布局动作。需要多人时必须设置互不重叠的工作范围。
- 布局先执行，之后普通采收、播种、抓漫游宝可梦共用剩余动作预算。托管格被普通采收和播种策略跳过。托管执行本身不依赖普通 `shouldHarvest` 或 `focus` 设置。
- 成功播种、采收、施肥各算 1 次动作；一次施多袋肥仍只算 1 次动作。每次成功动作之后重新计算下一动作。
- 优先级依次是冻结续肥、采收与成熟作物施 Rich、播种、普通续肥。同级先看最紧急的期限，再看较长的生长时间，再按巡格索引轮换。
- 满级 Jessie 的 50 动作可完成 25 格采收加补种。若 25 格成熟作物全部刚好缺 Rich，这轮可能先执行 25 次施肥、25 次采收，补种推迟到下一轮。肥料尚未到期的普通循环不需要额外施肥动作。
- 导入 JSON 只保存布局意图，不会自动雇用助手、调整助手勾选格子、增加种子或肥料。完整使用说明必须另列助手名单和负责格子。

源码：`src/scripts/farming/FarmHand.ts:228-318、400-418、425-427`；`src/scripts/farming/FarmLayout.ts:59-65、334-423`；`src/scripts/farming/Farming.ts:20、36-45、68-69`；`src/modules/farming/FarmLayoutPlan.ts:220-230`。

## 3. 肥料、辅助株与光环不能混算

Boost 生长乘数为 1.5，Rich 产量乘数为 2，Amaze 生长乘数为 1.25、产量乘数为 1.5；每袋肥基础持续 300 秒，Sprinklotad 延长持续时间。收获只清除植物与年龄，不清除肥料。

Rich 仅在准备采收时施加。布局只会往空肥格施肥，或追加同种肥；不会自动把 Boost 切换成 Rich。选择固定 Boost 的导入布局不能按“生长用 Boost、收获瞬间用 Rich”的收益计算。旧肥需要自然耗尽，或手动使用肥料铲；指定 Rich 但缺少肥料时可能阻塞采收。

Freeze 将生长速度设为 0，同时关闭被冻植物发出的全部光环。冻结 Passho 不再增产，冻结 Wacan 不再加速，冻结 Lum 不再强化，冻结 Babiri 不再保护邻格。冻结不阻止植物作为突变配方原料，也不阻止寄生者发动寄生。Petaya 的全田保鲜要求成熟且没有 Freeze，冻结 Petaya 同样失去保鲜作用。

布局要求全部 `keep` 格成熟后，`cycle` 格才正常收获；临近枯萎时可抢救采收。辅助株与生产株还会按成熟窗口错峰播种。`keep` 格没有冻结或 Petaya 保护时并不是永久保留，临近枯萎会被收掉重种。所以长期光环阵通常需要成熟、未冻结的 Petaya，并且要单独保障 Petaya 本身的更新窗口。Petaya 不能保护同田任何 Petaya，包括另一棵 Petaya。

源码：`src/modules/GameConstants.ts:174-181`；`src/scripts/farming/Plot.ts:64-80、316-359、397-444、488-521、579`；`src/scripts/farming/Farming.ts:707-708、1038-1051、1150-1151`；`src/scripts/farming/FarmLayout.ts:78-81、203-241、267-296、321-384`。

## 4. 毛收获、净新增和农场币的正确口径

每格收获颗数为 `floor(max(1, 基础 harvestAmount × 肥料产量乘数 × 邻格收获光环乘积))`，播种扣 1 颗种子。因此长期净新增等于毛收获减去实际播种消耗，不能把保本回种算成新增产量。

| 基础单株产量 | 树果 | 没有增产时 | 开始获得正净新增的条件 |
| --- | --- | --- | --- |
| 1 | Lum、Kebia、Kasib、Micle、Custap、Jaboca、Rowap、Kee、Maranga、Hopo | 收 1、种 1，净新增 0 | 总产量乘数至少 2 |
| 0.5 | Liechi、Ganlon、Salac、Petaya、Apicot、Lansat、Starf、Enigma | 下限保护后仍只收 1，净新增 0 | 总产量乘数至少 4 |

0.5 组即便只用 Rich 的 2 倍产量，仍是 `floor(0.5 × 2) = 1`，净新增依旧为 0；Amaze 单独使用也不能解决。必须结合足够的 Passho 收获光环，或通过另一种不消耗目标种子的特殊机制获得目标树果。

每次采收一格的农场币只等于该树果的 `farmValue`，与该格获得几颗树果无关。Rich、Passho 的增产光环不会直接增加农场币。农场币方案需要优化的是单位时间的有效采收次数与单次 `farmValue`，然后扣助手工资和实际采购肥料成本。

`Wallet.gainFarmPoints` 调用 `addAmount`，但 `calcBonus` 对 `farmPoint` 明确返回 1，不调用 `multiplier.getBonus`。当前普通采收的实际入账等于 `floor(farmValue × 1)`；工资按原始金额扣除。`getBonus('money', true)` 与 `getBonus('dungeonToken', true)` 属于另外两种货币，不能套到农场币。`GameConstants.LuxuryBallCurrencyRate` 的农场币数值 900 是 Luxury Ball 的货币汇率，也不是收益倍率。

漫游宝可梦有独立的额外农场币入口：处理一次时给 `floor(farmValue / (4 + 成熟时间 / 1800))`，闪光再乘 5。该机制依赖成熟留株时间、随机出现和助手抓捕动作，不应无条件加到“种植采收稳定收益”中；若纳入币优化，需要另建随机收益模型。

源码：`src/scripts/farming/Plot.ts:389-390、511-521`；`src/scripts/farming/Farming.ts:933-971、1289-1299`；`src/modules/farming/BerryList.ts:301-303、692-694、810-812、947-1188`；`src/modules/wallet/Wallet.ts:41-42、53-78、116-128`；`src/modules/GameConstants.ts:502-509`。

## 5. 突变的共通边界

每 1 秒执行突变判定，顺序是先更新作物生长、枯萎和肥料，再按注册顺序跑突变，最后才执行助手。因此“助手成熟立刻收”的模拟也有可能先经过一次突变窗口。突变属于概率事件，不能把概率不大当成永远不会发生。

空格型突变 `GrowMutation` 只占据空格，不替换已生长作物；原株型突变 `EvolveMutation` 从 Taller 阶段起就能替换原株，保留原阶段并重设为新种对应的阶段初始年龄。Babiri 自身不接受 `EvolveMutation`，其他树果即使有安全锁或 Freeze，也不因此获得原株突变免疫。

成熟、未冻结 Babiri 的邻格突变光环乘数为 0，能令邻格所有通过 `getTotalMutationChance` 的突变概率归零。Babiri 的保护范围是自身外的八邻格，不是全田；幼株阶段只能降低概率。它不会抹掉已经出现的错误作物，也不能挡住自然枯萎分支直接生成的 Kasib 或捕获闪光漫游者直接种出的 Starf。

源码：`src/modules/GameConstants.ts:27`；`src/scripts/farming/Farming.ts:739-791`；`src/scripts/farming/mutation/Mutation.ts:105-133`；`src/scripts/farming/mutation/mutationTypes/GrowMutation.ts:16-39`；`src/scripts/farming/mutation/mutationTypes/EvolveMutation.ts:20-59`；`src/modules/farming/BerryList.ts:871-886`；`src/scripts/farming/Plot.ts:543-559、614-637`。

## 6. 会直接破坏原株的全部注册规则

下表覆盖 `Farming.initialize` 中所有 `EvolveMutation` 后代规则。只有满足对应邻格、阶段与解锁要求时才会发生，不能把表中每个树果无条件都判成必须加 Babiri。

| 原株或来源 | 变成什么 | 触发条件 | 稳定生产的处理方式 |
| --- | --- | --- | --- |
| Razz | Tamato | 相邻成熟 Pomeg，原株达到 Taller | 普通只用 Wacan／Passho／Lum 的阵无该来源；混种 Pomeg 时隔离或保护 |
| Aspear | Rabuta | 相邻成熟 Aguav，原株达到 Taller | 不把 Aguav 摆到 Aspear 生产格旁，或用 Babiri 保护 |
| Tamato | Spelon | 邻格辣味 130–160，其他四味各 0–80 | 密植同种也可能凑足辣味；按实际阶段检查味道总和，或保护 |
| Cornn | Pamtre | 邻格干味 130–160，其他四味各 0–80 | 密植同种可能达到；不能只检查成熟期的最终阵型 |
| Magost | Watmel | 邻格甜味 130–160，其他四味各 0–80 | 同上 |
| Rabuta | Durin | 邻格苦味 130–160，其他四味各 0–80 | 同上 |
| Nomel | Belue | 邻格酸味 130–160，其他四味各 0–80 | 同上 |
| Passho | Yache | 周围没有任何植物，原株达到 Taller | 正常有邻格辅助株的阵通常不满足；避免建立阶段长期孤株 |
| Spelon | Chople | 周围恰好 3 棵至少 Taller 的 Spelon，没有其他至少 Taller 作物 | 全田纯种的角落有 3 邻格，存在风险；混入不同辅助株可破坏条件 |
| Pamtre | Kebia | 周围恰好 3 棵至少 Taller 的 Pamtre，没有其他至少 Taller 作物 | 尤其危险：产物 Kebia 随后会寄生辅助株；必须检查建阵阶段 |
| Watmel | Shuca | 周围恰好 3 棵至少 Taller 的 Watmel，没有其他至少 Taller 作物 | 通过几何、异种邻株或 Babiri 排除 |
| Cornn | Charti | 周围恰好 3 棵至少 Taller 的 Cornn，没有其他至少 Taller 作物 | Cornn 同时还有味道型进化，两个规则都需排除 |
| Chople | Chilan | 相邻至少 3 棵成熟 Chople | 密植会触发；把每格成熟同类邻数压到 2 以下，或覆盖 Babiri |
| 任意非 Babiri、非同种原株 | Occa、Kebia、Colbur | 相邻有对应成熟寄生树果，受害株达到 Taller | 受害辅助格覆盖成熟 Babiri，或完全隔离；只冻寄生源无效 |
| Passho | Liechi | 相邻成熟 Enigma，且 Liechi 已解锁 | Enigma 增产阵的 Passho 必须保护或隔离 |
| Shuca | Ganlon | 相邻成熟 Enigma，且 Ganlon 已解锁 | 同上 |
| Coba | Salac | 相邻成熟 Enigma，且 Salac 已解锁 | 同上 |
| Payapa | Petaya | 相邻成熟 Enigma，且 Petaya 已解锁 | 同上 |
| Chilan | Apicot | 相邻成熟 Enigma，且 Apicot 已解锁 | 同上 |
| Roseli | Lansat | 相邻成熟 Enigma，且 Lansat 已解锁 | 同上 |
| Haban | Starf | 相邻成熟 Enigma，且 Starf 已解锁 | 同上 |

味道型进化对邻株的 Taller、Bloom、Berry 三阶段分别使用 0.5、0.75、1 的味道权重，因此只检查成熟后最终味道会漏掉中间阶段的进化窗口。严格同种数量规则也会忽略比规定阶段更幼小的其他作物，建阵中“异种已经种下”不代表它已能破坏配方。

寄生规则排除寄生树果自身同种，不会让 Occa 侵占 Occa；但 Occa、Kebia、Colbur 混种时可能互相侵占。保护目标应该是被侵占的辅助株，而不是寄生源本身。Kebia 另有 1.6 倍成熟突变光环，会放大没有 Babiri 保护的附近风险。

源码：`src/scripts/farming/Farming.ts:345、361、369-394、427、456-475、500-503、522、531-534、634-660`；`src/scripts/farming/mutation/mutationTypes/ParasiteMutation.ts:8-20`；`EvolveNearBerryMutation.ts:20-42`；`EvolveNearBerryStrictMutation.ts:21-42`；`EvolveNearBerryMinMutation.ts:19-34`；`EvolveNearFlavorMutation.ts:29-48`。上述类文件均在 `src/scripts/farming/mutation/mutationTypes/` 下。

## 7. 什么时候确实需要 Babiri

以下“需要”指要在现有混种结构中获得长期确定性的稳定生产；若可以通过重新布局完全去掉触发条件，就不一定必须占用 Babiri 格子。

1. **Occa、Kebia、Colbur 搭配 Wacan、Passho、Lum、Petaya 等邻接辅助株：**必须让每个可能被寄生的辅助格落在成熟、未冻结 Babiri 的八邻格内，或让寄生株与辅助株完全不相邻。Babiri 自身免疫原株进化。不能只保护寄生生产格。
2. **Enigma 搭配邻接 Passho：**Passho 是 Enigma 的进化受害者，必须保护 Passho，或不用这组邻接结构；Enigma 配 Wacan／Lum 本身不触发该组进化。若阵里还有 Shuca、Coba、Payapa、Chilan、Roseli、Haban，也逐格保护相应受害株。
3. **Chople 密植且任一生产格有至少 3 个成熟 Chople 邻居：**需要 Babiri，或改变几何避免该条件。Babiri 不是所有 Chople 布局的绝对前置条件。
4. **味道型或严格三邻株型受害目标：**Tamato、Cornn、Magost、Rabuta、Nomel、Spelon、Pamtre、Watmel 的具体布局若能触发表中条件，需要保护或调整结构。不能仅按树果名字统一下结论。

本仓库已经禁止直接把寄生树果套进普通 `passho-rows`、`passho-ring`、`wacan-lum` 预设，也禁止把 Enigma 套进普通 Passho 生产预设，错误提示明确要求带 Babiri 的自定义布局。这是实际已有校验，而不是本文新增限制。

源码：`src/modules/farming/FarmLayoutPlan.ts:266-275`；`src/modules/farming/FarmLayoutPlan.test.ts:393-399`。

## 8. 空格突变、自然枯萎与其他特殊生产

`GrowMutation` 系规则只会占据空格。普通循环若采收后同一轮立即补种，空窗较短；若动作不足把补种推到下一轮，空位会完整经历突变判定，有机会被非目标品种占据。布局会等错位作物成熟后再回收并重种，不会免费清除幼株，阻塞可能很久。

- **Pamtre、Rindo 蔓延：**成熟同种旁的空格可长出同种。对目标本身有时是免费种苗，但不能把概率苗当作固定补种；对隔离留空格或其他目标是占位风险。Rindo 被八棵同种包围的空位还可能变成 Tanga。
- **数量型空格突变：**至少 20 棵成熟 Babiri 可让空格产生 Snover；23 棵成熟 Passho、Shuca、Coba、Chilan、Roseli 分别可让空格产生 Liechi、Ganlon、Salac、Apicot、Lansat。它们不会直接把这些原株换掉。任务解锁条件仍然适用。
- **味道总量型空格突变：**全田干、甜、苦、酸味分别达到 600，空格可能长出 Micle、Custap、Jaboca、Rowap；Taller、Bloom、Berry 的味道权重仍是 0.5、0.75、1。
- **Petaya 的原始配方：**同田集齐 18 种第四代属性树果成熟后在空格生成，不是普通循环生产条件。获得种子后可按 `cycle` 重种，但它基础产量 0.5，仍需满足净增阈值。
- **Enigma 的原始配方：**空格必须有北、西、东、南四个成熟指定树果，配方由训练家 ID 固定生成。随机池排除 Occa、Kebia、Colbur、Babiri。获得种子后可普通播种，但长期辅助株仍会受它的附带进化规则影响。
- **Hopo 的原始配方：**2 棵 Lansat、2 棵 Apicot、Micle／Custap／Jaboca／Rowap 各 4 棵成熟后，空格才有生成机会；这与获得 Hopo 后重种是两个不同阶段。
- **Kasib：**自然枯萎先掉半产量并判自播，若未自播且已到 Occa 解锁阶段，再有 5% 机会原地变 Kasib。同田成熟 Colbur 抑制这个分支，冻结 Colbur 仍然有效。该分支不调用普通突变概率，Babiri 不能挡。
- **Starf：**抓到闪光漫游宝可梦时，随机选择同田一个已解锁、未锁定空格直接种出 Starf，不调用普通突变概率；Babiri 不能挡。稳定生产率若不包括该随机来源，应明确排除。
- **自播与半产量：**自然枯萎会获得 `max(1, ceil(收获量 / 2))`，然后按自播概率决定是否免种子重长，但不给普通采收农场币。Kebia、Kasib、Shuca 的基础自播率为 100%；Rich、Amaze、邻格重种光环还可改变其他树果自播率。以“果实最高”为目标时，自然枯萎／免种子循环也属于需要另行比较的策略，不能只遍历手动采收型 `cycle` 就宣称全局最优。

源码：`src/scripts/farming/Farming.ts:202-676、1340-1347`；`src/scripts/farming/mutation/mutationTypes/FieldMutation.ts:20-40`；`FieldFlavorMutation.ts:20-44`；`PetayaMutation.ts:16-41`；`EnigmaMutation.ts:26-69`；`src/scripts/farming/Plot.ts:397-438、525-535`；`src/modules/farming/BerryList.ts:692-716、810-813`。

## 9. 会影响产量或存活窗口的特殊光环

| 树果 | 实际影响 | 计算时的处理 |
| --- | --- | --- |
| Tanga | 邻格收获光环为 0.9／0.8／0.7，按乘积叠加 | 密植严重减产；采收相邻 Tanga 会移除负光环，所以同轮收获顺序也改变产量 |
| Kasib | 仅成熟阶段衰老受到死亡光环，阶段倍率 1.25／1.5／2；多个取最大值 | 不加快幼株生长；Kasib 自身免疫 Kasib 死亡光环；要检查辅助株的成熟寿命 |
| Yache、Haban | 延缓成熟后的衰老，不加快种植到成熟 | 可以增加来得及采收或保留辅助株的机会，不能当作生长加成 |
| Charti | 邻格自播乘数 0.99／0.98／0.97 | 对正常采收补种无直接产量影响；自然枯萎策略需要计入 |
| Kebia、Payapa | 提高邻格突变概率 | 不直接增加目标普通采收量；会放大布局中未排除的变异风险 |
| Babiri | 邻格突变乘数 0.5／0.25／0 | 只有成熟且未冻时才是确定性保护；不影响已经发生的占位 |
| Lum | 强化附近光环；多个 Lum 取最大而非相乘，Lum 自身不吃 Lum 强化 | 正负光环都可能被强化：大于 1 的光环乘强化，小于等于 1 的光环除强化 |
| Chilan、Micle | 定义分别是低于 1 的全局孵化、吸引倍率 | 当前跨田聚合用 `max(1, 每田乘积)`，单独负倍率会被下限 1 抵消；不要把它们误当成本地减产光环 |

Wacan、Passho 同时作为生产株与辅助株时，要按各自 Taller／Bloom／Berry 三阶段重新计算光环；同轮被收掉的株不再为后来收获的邻株提供光环。冻结辅助株并不会保持成熟光环。各田的局部光环、配方、寄生只作用于本田；跨田外部光环取最强的一整块田，不是把 16 田的乘区再相乘。

源码：`src/modules/farming/Aura.ts:10-14`；`src/modules/farming/BerryList.ts:316、607、627、667、708、765、785、805、825、845、886、903、962`；`src/scripts/farming/Plot.ts:64-80、139-158、488-505、556-563`；`src/scripts/farming/Farming.ts:151-166、865-868`。

## 10. 本分支私有规则的边界

`src/modules/privateGameplay/settings.ts` 当前没有关闭农场突变、提升农场币收入、折扣农场助手工资的选项。不可把地牢助手服务费比例误套到农场助手。

私有“固定基础价”会影响肥料采购：`PricingPolicy.fixedPricesEnabled` 来自 `PrivateGameplay.fixedItemPrices()`；开启后采购按基础价计算。Boost／Rich／Surprise／Amaze／Freeze 的基础单价分别为 50／100／150／200／350 农场币。官方动态价格模式仍保留原价倍率，连续采购的实际成本不能直接固定为这些基础价。每次采收会按树果 `exp` 降低 Berry 类道具价格倍率，所以含采购的长期净币模型还需说明价格模式与采购节奏。

源码：`src/modules/privateGameplay/settings.ts:12-25、74-77、94-105`；`src/modules/privateGameplay/PricingPolicy.ts:10-22`；`src/modules/items/MulchItem.ts:10-11`；`src/modules/items/ItemList.ts:85-89`；`src/scripts/farming/Farming.ts:969`。

## 11. 对最终优化结论的约束

可以直接确认的事实是助手数值、执行顺序、动作成本、钱包倍率、产量取整与各特殊规则。某个布局是否“最高”仍取决于搜索范围：必须说明是否覆盖自然枯萎、自播、寄生复制、Enigma 进化、手动操作，以及橡树道具等级和道具价格模式。

若数值程序只比较成熟辅助株已建立后的普通 `cycle`，应称为“在已建立辅助株、指定道具等级与普通助手循环范围内找到的最佳方案”，并且逐格检查上述突变风险。不能把忽略寄生、负光环、免费突变苗或种子消耗的连续公式结果直接包装成无条件全局最优。
