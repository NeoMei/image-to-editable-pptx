# 图片式 PPT 增强可编辑原型

这个 Node.js 原型把一张 1280×720 的幻灯片 PNG 重建为单页 16:9 PPTX：OCR 文字是必须成功的可编辑层，只有通过透明提取、文字遮罩重叠、本地修复和重组校验的图标才成为可移动 PNG 资产；面板、色条等结构家具保留在背景中。背景修复完全在本地完成，默认路径不调用万相或其他图像编辑模型。当前验收目标是《深入理解 AI-Agent》第 7 页，其 10 个 OCR 文字候选必须全部成为可编辑文字。

## 准备

需要 Node.js 22.6 或更高版本（测试脚本使用该版本起支持的原生 glob），然后安装依赖：

```bash
npm ci
```

在阿里云百炼中创建 API Key，并取得该 Key 所属的业务空间 ID。可参考阿里云的 [API Key 设置](https://help.aliyun.com/zh/model-studio/get-api-key) 和 [权限管理](https://help.aliyun.com/zh/model-studio/permission-management-overview)。

```bash
export DASHSCOPE_API_KEY='<your-api-key>'
export DASHSCOPE_WORKSPACE_ID='<your-workspace-id>'
```

`DASHSCOPE_WORKSPACE_ID` 必须是可用作 DNS 单个 label 的字符串。服务地址由代码固定组成为该空间的阿里云北京地域 HTTPS 地址；不支持从命令行覆盖基础 URL。不要把密钥写入代码、README、录制文件或提交到 Git。

## CLI

三种模式都会在发起网络请求前验证两个必需环境变量。

```bash
# 只做 OCR 和视觉分析；输出目录必须不存在或为空
npm run cli -- analyze --image <png> --out <analysis-dir> [--record]

# 使用已有分析结果做本地保真分层、背景修复和 PPTX 导出
npm run cli -- build --image <png> --analysis <analysis-dir> --out <output-dir>

# 一次完成 analyze 和 build
npm run cli -- run --image <png> --out <output-dir> [--record]
```

不论是否加 `--record`，分析目录都会保存经 schema 验证和递归脱敏后的统一 `ocr.json`/`vision.json`，以及 `analysis-ledger.json`。该 analysis ledger 保存 live/replay 模式、模型 ID、OCR/Vision/总分析耗时、告警、record 标记和输入/结果 SHA-256。后续 `build` 会先验证该 ledger 与三项哈希，再将其 provenance 原样带入最终 run ledger，不会把 split build 伪记成 replay/0 ms。为避免混入旧分析结果，独立 `analyze` 只接受新目录或空目录。

加 `--record` 时，还会创建 `recordings/ocr.json` 和 `recordings/vision.json`：它们是供审计和离线 replay 的统一、可验证快照，不是包含 HTTP 头的原始网络包。Live 与内部 replay 模式都支持该行为；快照不包含 API Key、Authorization 或 DashScope 头。

第 7 页的固定验收命令是：

```bash
bash scripts/accept-slide-07.sh
```

脚本使用已检查的源 PNG 绝对路径，并输出到 `output/slide-07`。如果任一凭证缺失，脚本会在调用 `npm`、进而在任何网络访问之前失败。

## 输出

`run` 或 `build` 的输出目录包含：

- `ocr.json`：统一 OCR 文本行和坐标；
- `vision.json`：统一视觉元素候选；
- `analysis-ledger.json`：经验证的分析 provenance、耗时、模型与哈希；
- `recordings/*.json`：仅在 `--record` 时产生的脱敏、统一 replay 快照；
- `.image-ppt-layers-output.json`：版本化的 pipeline ownership marker，用于安全识别可由本工具替换的输出目录；
- `manifest.json`：manifest v1；默认保真路径只包含已接受的 OCR 文字和透明图标，不包含结构形状；
- `removal-mask.png`：已接受文字和图标遮罩的逐像素并集，不包含被拒绝图标；
- `clean-background.png`：对已接受遮罩做确定性本地修复后的背景；
- `assets/*.png`：通过全部安全门、可单独移动和缩放的透明图标；矩形资产不会发布；
- `<source-name>-editable.pptx`：可编辑的宽屏 PowerPoint；
- `run-ledger.json`：ledger v2，包含每个文字/图标候选的接受或保留背景决策、修复/重组指标、模型 ID、阶段耗时、告警、输出路径及所有主要产物的 SHA-256；默认路径的 `taskIds` 为空。

ledger 和 JSON 录制使用同一个递归脱敏写入器，不写入 API Key、`Authorization`、access token 或 `x-dashscope-*` 头。Live OCR/Vision 响应会在解析前写入 staging；正常解析后该临时原始响应被移除，如果 schema/JSON 解析失败，脱敏的 `raw-responses/<provider>.json` 与 `parse-errors/<provider>.json` 会一起留在失败运行目录中。

`run` 和独立 `build` 都不会直接改写固定输出目录。它们先在目标的同级文件系统中建立 staging 目录；只有 clean background、PPTX、ledger、ownership marker 和所有中间产物都完成后才提升为目标。重跑失败时，上一个成功目标保持逐字节不变，本次失败产物保留在 `<output-dir>.failed-runs/`，不会与成功产物混淆。成功的小 manifest 重跑会整体替换旧目录，因此不会残留旧 asset 或 recording。

为避免误删用户文件，已存在的输出目录只有在 marker 是目标目录内的普通文件、且其 `markerVersion`/`appId`/`artifactKind` 通过严格 schema 验证时才能被替换。未标记、损坏、伪版本或符号链接 marker 的目录会被拒绝且内容保持不变。临时 backup 也会在移动后重新验证 marker，只有得到该 ownership 证据的 backup 才会递归删除。

输出路径会经过 realpath/canonical 检查。文件系统根目录、空路径、`.`/项目根及其任一祖先、源图本身、源图父目录或其任一祖先都会被拒绝，即使其中放置了伪造 marker 也不例外。已存在的目标本身不能是符号链接，并且父路径中的链接别名会解析到真实位置后再判定，不能用于绕过上述边界。

## 发送到阿里云的数据

每次完整 `run` 默认只进行两类模型调用：

1. 向 `qwen3.5-ocr` 发送整页 PNG 的 Base64 Data URL，使用 `advanced_recognition` 获取 `ocr_result.words_info[]` 文字与坐标；
2. 向 `qwen3-vl-plus` 发送同一张整页 PNG 和固定结构化提示词，用于候选元素分析；

随后所有文字遮罩、透明图标提取、局部背景修复、重组校验和 PPTX 导出都在本地执行。默认路径不会向万相/图像编辑服务提交源图或遮罩，也不会产生 Wanx task ID。仓库仍保留隔离的可选 legacy Wanx provider 及其安全测试，但 CLI 的 `run`/`build` 和第 7 页验收脚本均不调用它。

文件不会上传到项目自建服务，也不会在用户机器上运行模型。请在使用前确认源图内容符合组织的数据合规要求。

## 费用估算

每页默认产生 1 次 `qwen3.5-ocr` 和 1 次 `qwen3-vl-plus` 调用，不产生图像编辑计费。截至 2026-08-26，阿里云官方页面显示这两个模型均按输入/输出 token 计费，且视觉模型会随单次请求的 token 区间采用不同档位；免费额度、活动、模型版本和价格都可能变化。因此本项目不承诺或虚构固定单页成本。执行前请根据实际图片折算 token、输出 token、地域和账户权益，在 [`qwen3.5-ocr` 模型页](https://help.aliyun.com/zh/model-studio/qwen3-5-ocr) 与 [阿里云百炼官方计费页](https://help.aliyun.com/zh/model-studio/model-pricing) 重新核算。

## 已知局限

- 只接受精确 1280×720 PNG，只导出单页，没有整套 PPT 批处理、排队或人工校正界面；
- OCR 文本是权威内容，但字体统一回退为 Microsoft YaHei，不能还原未提供的原始字体文件；
- 只有垂直间隔不超过较小行高的 75%、左边对齐误差不超过较小估算字号的 50%（最少 4 px）且估算字号比不超过 1.2 的相邻 OCR 行才合并为保留换行的段落；
- 默认保真路径不重建原生结构形状；面板、色条和复杂插画保留在背景中；
- 图标是可选层。本地透明化依赖边缘颜色一致性，透明比例、边框、文字重叠、修复或重组任一安全门失败时，该图标保留在背景中；矩形回退资产不会进入 manifest 或 PPTX；
- 本版未集成阿里云 VIAPI 通用分割，不需要第二套 AccessKey/Secret；
- 文字是必须层。第 7 页固定验收要求 10 个 OCR 文字全部通过；任一文字无法安全本地修复时整页失败并保留 failed-run 证据，不会发布部分成功页面；
- 不同 PowerPoint/WPS 版本的字体替换和文本度量可能造成小范围布局偏差，真实交付前仍需在目标客户端打开验收。

## 离线验证

```bash
npm test
npm run lint:types
npm run build
npm run test:compiled
```

`npm test` 只运行 TypeScript 源测试；`npm run test:compiled` 在 build 后单独验证编译产物。端到端 pipeline 测试使用脱敏 OCR/Vision fixture 与注入的确定性 fidelity builder，真实 fidelity 集成测试使用程序化生成的本地图片；这些测试都不会访问网络或调用万相。
