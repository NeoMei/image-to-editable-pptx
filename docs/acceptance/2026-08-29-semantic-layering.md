# 语义分层验收记录（2026-08-29）

分支 `codex/general-semantic-layering`，HEAD 至 `7107f15`。本文记录 Task 14 的真实验收证据：命令、非密工件路径、请求计数、视觉检查、WPS 结果、已知安全回退，以及规格完成定义（`docs/superpowers/specs/2026-08-29-general-semantic-layering-design.md` 第 12 节）逐条对照。

## 1. 凭证与离线边界

- 阿里云凭证仅通过环境变量 `DASHSCOPE_API_KEY` / `DASHSCOPE_WORKSPACE_ID` 提供，工作树与提交内容不含凭证；命令输出未回显密钥或签名 URL。
- 离线证明：所有 `build` 命令均以 `env -u DASHSCOPE_API_KEY -u DASHSCOPE_WORKSPACE_ID` 运行（构建期不读取凭证），全部 exit 0。build 发起网络请求会直接失败（Task 8/12 的离线守卫测试在 358 项测试内持续覆盖）。

## 2. 命令与请求计数

analyze（在线，一次性）与 build（离线）分别执行。分析台账记录的请求计数：

| 输入 | 格式/宽高比 | ocr | fullVision | regionalVision | completion |
| --- | --- | --- | --- | --- | --- |
| 演示页 slide-07（已确认原图） | PNG 1280×720 | 1 | 1 | 8 | 0 |
| fixtures/canvas-4x3 | JPEG 4:3 | 1 | 1 | 0 | 0 |
| fixtures/canvas-portrait | PNG 竖版 9:16 | 1 | 1 | 0 | 0 |
| fixtures/must-fallback | PNG 16:9 | 1 | 1 | 2 | 0 |
| fixtures/text-backing | PNG 16:9 | 1 | 1 | 1 | 0 |

build 阶段请求计数为 0（离线）。演示页 build 的补全（completion）为 0：本期所有候选均为源可见像素提取，无生成式补全。

关键命令（工作目录为 worktree 根）：

```sh
# 离线构建演示页（analysis 目录来自此前已完成的在线 analyze）
env -u DASHSCOPE_API_KEY -u DASHSCOPE_WORKSPACE_ID \
  npm run cli --silent -- build \
  --analysis .codex-tmp/acceptance/slide07/run8-analysis \
  --out .codex-tmp/acceptance/slide07/run8-build3 \
  --required-text-count 10

# 用当前代码离线重建四个格式/宽高比 fixture
for d in canvas-4x3 canvas-portrait must-fallback text-backing; do
  env -u DASHSCOPE_API_KEY -u DASHSCOPE_WORKSPACE_ID \
    npm run cli --silent -- build \
    --analysis .codex-tmp/acceptance/fixtures/$d/analysis \
    --out .codex-tmp/acceptance/fixtures/$d/build2
done
```

## 3. 测试总量

最后一次验收修复后全门禁：

- `npm run lint:types`：通过。
- `npm test`：358/358 通过（含本分支新增的 compound 成员回退回归测试）。
- `npm run build`：通过。
- `npm run test:compiled`：358/358 通过（编译产物测试）。
- PPTX 边界检查（packed-file gate、目录替换拒绝、所有权/完成标记校验）包含在上述测试内（Task 10/13 引入）。

## 4. 演示页（slide-07）视觉发现

工件目录：`.codex-tmp/acceptance/slide07/run8-build3/`（`manifest.json`、`run-ledger.json`、`recomposition-preview.png`、`layer-review.png`、`exploded-preview.png`、`slide-editable.pptx`、`assets/`）。

manifest 共 18 个元素：8 个可移动资产层 + 10 个可编辑文字层。

| 资产 | 内容 | 说明 |
| --- | --- | --- |
| `group-1` | 雷达（compound） | 眼睛与雷达成功分离 |
| `fg-1` | 眼睛 | 独立层 |
| `group-2:fg-3` | 扳手 | compound 成员回退救出，独立可移动 |
| `group-3:fg-5` | 实心对话气泡 | 与空心气泡分离 |
| `group-3:fg-6` | 空心对话气泡 | 与实心气泡分离 |
| `group-4:fg-7` | MCP 插头 | 独立层 |
| `group-5:fg-8` | 闪电 | 与时钟分离 |
| `group-5:fg-9` | 时钟 | 与闪电分离 |

10 条 OCR 文字（标题、橙条、四个面板标题、MCP 生态、事件驱动异步 Agent、底部结论句）全部为可编辑文字层。

三图目检结论：

- `recomposition-preview.png`：与原图逐像素观感一致，无缺层、无错位、无双重文字。
- `layer-review.png`：8 个资产均带透明背景独立成图；`group-2:fg-3` 含一小片盾牌上沿像素（该区域在原图中与扳手 bbox 重叠且不含文字，属于 bbox 内可见像素，回贴仍严格一致）。
- `exploded-preview.png`：层级与 z 序正确，文字层已从背景剥离。

已知安全回退（写入决策台账，均为通用守卫触发，无对象名/坐标特判）：

| 候选 | 原因 | 根因 |
| --- | --- | --- |
| `group-2`..`group-5`（整组） | `semantic_mask_unavailable` | 整组掩码含受保护文字，守卫拒绝；成员级回退已将可安全提取的成员救出 |
| `group-2:fg-4`（盾牌+文字垫底） | `semantic_mask_unavailable` | 盾牌内含 OCR 文字，成员级掩码与受保护文字重叠被守卫拒绝（用户确认的取舍边界：文字优先，其余可取舍） |
| `text-backing-1` | `surface_unstable` | 橙色横幅内含白色文字与装饰，平面拟合残差 p95 超阈值 |
| `text-backing-2` | `backing_mask_invalid` | 深蓝横幅掩码完整性/非携带文字重叠检查未通过 |

## 5. 格式与宽高比 fixture

用当前代码（含最近三个修复 commit）离线重建，全部 exit 0，回贴验收通过（build 内回贴失败会抛错终止）：

| fixture | 结果 |
| --- | --- |
| canvas-4x3（JPEG 4:3） | 通过；新代码额外救出 1 个前景资产（`fg-1`，成员回退收益），回贴图目检无回归 |
| canvas-portrait（PNG 竖版） | 通过；0 资产 0 文字，与旧代码一致（简单测试图） |
| must-fallback | 通过；0 资产，预期回退路径维持 |
| text-backing | 通过；1 资产，与旧代码一致 |

## 6. WPS 实测

环境：WPS Office 12.1.26055（macOS）。

已完成并留证：

- `open -a wpsoffice .codex-tmp/acceptance/slide07/run8-build3/slide-editable.pptx` 打开成功，画布渲染与原图一致（截图核对了标题、橙条文字、四面板图标与文字均存在且位置正确），状态栏显示“幻灯片 1 / 1”。
- 方向键在对象间轮选：实心气泡、空心气泡、MCP 插头被逐一独立选中（分别出现选择框，功能区切换到图片工具并显示各自尺寸）。空心气泡（`group-3:fg-6`）与实心气泡（`group-3:fg-5`）可被分别选中，直接证明两者已拆分为独立可移动层。

未能在本会话内自动完成的部分（如实记录）：

- `osascript` 的鼠标点击被 macOS 辅助访问权限拦截（错误 -25211），无法自动选中指定对象；键盘事件又受前台应用焦点漂移影响（会话期间焦点多次被其他应用夺走，且用户正在其他窗口输入，继续发送合成键盘事件不安全）。因此“移动前景对象 → 移动文字垫底 → 编辑关联文字 → undo → 显式保存/放弃 → 关闭重开”的完整交互链未能自动留证。

待人工执行的剩余步骤（文档已在 WPS 中打开，约 1 分钟）：

1. 在 WPS 中单击任一图标（建议扳手或空心气泡），按方向键移动，确认背景无残影。
2. 双击任意文字（如“协作工具”），修改一个字，确认文字层可编辑。
3. 连按 Cmd+Z 撤销全部改动，关闭文档并在提示时选择“不保存”，重新打开确认与原始产物一致。

完成定义第 10 条在本报告中标记为“部分完成（打开/渲染/独立选中已留证，编辑-撤销-重开待人工执行）”。

## 7. 完成定义逐条对照

| # | 标准 | 结论 |
| --- | --- | --- |
| 1 | 不依赖验收页特定 label/坐标/颜色/对象名 | 满足。修复均为 kind/角色级泛化，AST 守卫测试持续存在 |
| 2 | PNG/JPEG 任意受支持尺寸宽高比同一流水线 | 满足。第 5 节 fixture 覆盖 JPEG、4:3、竖版 |
| 3 | OCR/对象/复合/底板/遮挡通用契约 | 满足。scene graph、plan、manifest v2 契约测试覆盖 |
| 4 | 未遮挡不用生成式；补全不改可见像素 | 满足。本期 completion 计数为 0；严格层零容忍归因测试在护 |
| 5 | 分层后无双重文字/残留字形/白边/接缝 | 满足。回贴预览逐像素观感一致 |
| 6 | 接受层过整页保真门；不可靠候选安全回退 | 满足。8 资产 + 10 文字回贴 exit 0；回退候选全部保留背景 |
| 7 | 补全像素显式标记+人工检查 | 满足（本期无补全）；explode 预览人工检查完成 |
| 8 | build 离线；哈希/原子发布/脱敏/失败保留 | 满足。env -u 离线构建通过；Task 10/12/13 守卫测试在护 |
| 9 | 源/编译测试、类型、构建、边界检查、真实图片验收 | 满足。358/358×2、lint、build 全绿；5 个真实图片验收完成 |
| 10 | WPS 真实编辑+撤销+重开 | 部分完成。打开/渲染/独立选中已留证；交互链待人工执行（见第 6 节） |

## 8. 结论

Task 14 除完成定义第 10 条的 WPS 交互链留证外全部完成；该链条的自动化受阻原因明确（辅助访问权限 + 前台焦点漂移），已提供精确的手动步骤。本地分支干净、无 push/tag/publish 动作。

## 9. 图标白边修复轮（验收后追加）

用户反馈：图标资产出现白边碎片；取舍原则确认为"呈现效果 > 拆分力度，所有文字分层是硬约束"。

根因：盾牌碎片（1575px + 610px 两个独立连通分量）落在扳手资产 bbox 内。此前按 completeness 排序时完整掩码总是胜过剥离变体，卫星碎片被带入资产，渲染为悬浮白边。

修复（`src/image/extract.ts`，均为颜色/几何级通用判据，无 label/坐标特判）：

- `stripDetachedSatelliteFragments`：主导分量占前景 ≥60% 时，剥离与主导分量欧氏间隙 > max(4px, 资产对角线×10%) 的卫星分量；标记 removed 使新暴露边缘获得软边。
- `zeroRgbBehindFullyTransparentPixels`：全透明像素 RGB 清零，消除渲染链白带隐患。
- 保留守卫：面积均衡的多部件图标（如暂停键双条，share<0.6）整体跳过剥离；近距细节保留（钟表指针 12px、刻度 2-3px、眼睛虹膜 5px）。
- 评审加固：`componentBounds` + `squaredBoundsDistance` 包围盒剪枝，全出血大图的远距卫星判定跳过 O(n×m) 逐像素对扫描（包围盒距离 ≤ 像素距离，语义严格等价）。
- 测试兼容修复：npm 12 的 `pack --json` 输出为对象而非数组，`tests/package-scripts.test.ts` 双格式兼容。

证据：

- 门禁：lint:types ✓；源码测试 361/361 ✓；build ✓；编译测试 361/361 ✓（均 env -u 离线）。
- run8-build5 重建与 build4 等价：manifest.json 与资产 PNG 逐字节一致；slide1.xml 在规范化每次构建的随机 staging 目录名后一致；pptx 条目列表与全部内嵌媒体一致；ledger 差异仅为耗时/inode/ownerToken。
- 四个 fixture 重建（build3）与 build2 元素结构一致（canvas-4x3: 1 资产；canvas-portrait: 0（刻意空画布）；must-fallback: 0（分析被拒记录，非回归）；text-backing: 1 资产）。
- 扳手资产剥离后为 1 个连通分量；盾牌本体（fg-4）按"呈现优先"授权仍保留在背景（无法独立拖动但呈现完整）。

## 10. 文字拆分失败安全降级轮（验收后追加）

用户反馈：拖动过的整页插画风 PPT 中，图像/文字拆分容易整单翻车；取舍原则为"效果是重点，拆不好不如不拆"。

根因（实证 4 张真实样张）：`buildSemanticLayers` 文字循环裸调 `buildTightTextMask`，任何一条 OCR 文字的 mask 守卫失败（如 deck00-11 的 `Text mask fringe would remove too much outside the OCR box`、deck01-04 的 `Text mask surface is not locally consistent`）都会让整个 build 抛错退出，零产物。

修复（通用机制，无 label/坐标特判）：

- 文字 mask 构建失败 → 该文字候选记为 `kept_in_background`（reason `text_mask_unavailable`），像素不从背景移除，其余文字/资产照常分层；contracts reason 枚举新增 `text_mask_unavailable`。
- 语义构建依赖新增 `buildTextMask` 注入 seam（与 v1 路径同款），用于测试注入失败。
- 候选屏障：降级文字的 OCR bbox 以填充矩形并入 `chooseSemanticMask` 使用的保护掩码，任何 mask 与之重叠的资产候选被守卫拒绝（`semantic_mask_unavailable`），防止图标抠图带走降级文字墨迹，并避免整页 recomposition 失败的非确定性归因回滚波及全页资产。`ignoredMask`（像素级验证）保持仅含成功文字 mask，验证严格性不变。
- 关联底板安全链不受影响：降级文字不再进入 `textElementsForBacking`，其底板因 carried-text 关联失效被拒（`resolveCarriedTexts`），不会抹除背景文字。
- 明确不做：修复阶段（`repairCommittedUnion`）文字失败仍抛错；v1 legacy 路径不变；`--required-text-count` 语义不变。

证据：

- 门禁：lint:types ✓；源码测试 363/363 ✓（新增 2 例：文字 mask 失败降级、降级区域候选屏障）；build ✓；编译测试 363/363 ✓（均 env -u 离线）。
- 三张此前翻车/中断页用保留的分析包离线重建全部 exit 0：deck00-11（11 文字分层 + ocr-12 留背景 + 5 资产）、deck01-04（20 文字 + ocr-21 留背景）、deck01-07（21 文字 + ocr-22 留背景 + 5 资产）；三条降级文字墨迹经像素对比确认完整保留在 clean-background 中，与 barrier 前结果逐项一致（barrier 为纯安全网）。
- deck00-11 exploded 预览人工目检：机器人×3、灯泡、星星独立分层，标题栏/底部色条/降级文字留在背景，整页观感完整。
