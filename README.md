# Image to Editable PPTX

> High-fidelity semantic reconstruction for image-based slides
> 高保真地把图片式幻灯片重构为可编辑 PPTX

Image to Editable PPTX 先通过宿主已注册的 OpenAI/Gemini 工具或可选的 OpenAI、Gemini、阿里云百炼 API 生成 OCR 与通用语义场景图，再在本地把可靠的文字、独立图标、复合前景和文字底板重构成可编辑层。重组或局部验证不达标的候选不会被强行拆出，而是保留在背景中，优先保住视觉保真度。

这不是 Canva Magic Layers 的调用器，也不会把位图导入冒充可编辑。只有实际写入 PPTX 的文字对象和 PNG 资产才算可编辑层。

## 输入范围

- 支持单张 PNG、JPG 或 JPEG（按 magic bytes 识别，不依赖扩展名）；
- 文件最大 50 MiB；
- 宽、高各为 64–8192 px，总像素不超过 40,000,000；
- 最长边与最短边比不超过 56:1；
- 仅处理单帧、单页图片，不接受动画或多页文件。

PPTX 会按源图宽高比创建自定义页面，而不是强制转为 16:9。

## 安装 npm 包

```bash
npm install image-to-editable-pptx
```

npm 包与 GitHub Release 的版本同步。它包含运行时源码、Codex 插件元数据和 Agent Skill，便于在 Node 项目中锁定依赖和审计实现。当前 npm 包不注册全局 CLI，也没有承诺稳定的 JavaScript API；独立命令行和插件安装请使用下面的 Codex 插件或源码运行方式。

## 安装 Codex 插件

```bash
codex plugin marketplace add NeoMei/image-to-editable-pptx
codex plugin add image-to-editable-pptx@image-to-editable-pptx
```

安装后重启 Codex。首次运行需要 Node.js 22.6 或更高版本，并在插件根目录用 `npm ci --include=dev` 安装锁定依赖。

## 安装 OpenCode Skill

OpenCode 与 Codex Marketplace 的插件安装协议不兼容，但可以使用同一个 Agent Skill：

```bash
git clone https://github.com/NeoMei/image-to-editable-pptx.git "$HOME/.local/share/image-to-editable-pptx"
cd "$HOME/.local/share/image-to-editable-pptx"
npm ci --include=dev
mkdir -p "$HOME/.agents/skills"
ln -s "$PWD/skills/image-to-editable-pptx" "$HOME/.agents/skills/image-to-editable-pptx"
opencode debug skill
```

如果目标链接已存在，不要盲目覆盖；先确认它是否指向本仓库。更新时在克隆目录执行 `git pull --ff-only` 和 `npm ci --include=dev`。

## 模型路由与可选凭证

`analyze` 和 `run` 对 `ocr` / `scene` / `completion` 各自按以下固定顺序串行选择：

`host-openai` → `api-openai` → `host-gemini` → `api-gemini` → `api-alibaba`。

默认会通过 `ocx access endpoints --json` 自动发现本地 OpenCodex 公共接口，使用已登录的 OpenAI / Google Antigravity 账号作为宿主候选，无需另配官方 API Key。分析默认使用 `gpt-5.6-sol` / `gemini-3.1-pro`，可通过 `OPENCODEX_OPENAI_ANALYSIS_MODEL` / `OPENCODEX_GEMINI_ANALYSIS_MODEL` 选择对应供应商目录中的视觉模型；`IMAGE_PPT_OPENCODEX=off` 关闭自动发现。显式 `--host-bridge <private-dir>` 优先使用已注册工具的文件桥接。模型目录只用于发现候选，实际响应及内容校验通过才算成功。不会读取或改变 OAuth、cookie、浏览器会话或宿主内部 token。协议、故障分类和桥接示例见 [Host routing and file bridge protocol](docs/host-routing.md)。

API 凭证都是可选的，缺少时跳过该 API 候选：

```bash
export OPENAI_API_KEY='<your-openai-key>'
export GEMINI_API_KEY='<your-gemini-key>' # 也可使用 GOOGLE_API_KEY
export DASHSCOPE_API_KEY='<your-dashscope-key>'
export DASHSCOPE_WORKSPACE_ID='<your-dashscope-workspace-id>'
```

可用 `OPENAI_ANALYSIS_MODEL` / `OPENAI_IMAGE_MODEL` 和 `GEMINI_ANALYSIS_MODEL` / `GEMINI_IMAGE_MODEL` 覆盖 API 默认模型；当前默认分别为 `gpt-4.1` / `gpt-image-2`、`gemini-2.5-flash` / `gemini-3.1-flash-image`，百炼为 `qwen3.5-ocr` / `qwen3-vl-plus` / `wanx2.1-imageedit`。文件桥接记录实际工具元数据中的模型；OpenCodex 记录响应模型，响应未带模型时记录成功请求的明确模型，不用目录标签冒充实际调用证明。

只有 `unavailable`、`auth_unavailable`、`retryable_exhausted` 会推进到下一候选；`policy_refused`、`invalid_input`、`invalid_output`、`local_failure` 是致命边界，会停止整个运行。每个 operation 都有独立的只向前 sticky 游标，成功后下一次从该候选开始，不会在同一运行中回退到更早候选。

凭证只能通过环境变量提供。CLI 不接受 API Key、workspace ID、Authorization 或 provider base URL 参数；不要把凭证写入命令、bridge 文件、仓库、截图或录制文件。

## CLI：网络分析与离线构建

```bash
# 生成 self-contained analysis package v2；自动发现本地 OpenCodex，文件桥接可选
npm run cli -- analyze <source.png> --out <analysis-dir> [--host-bridge <private-dir>] [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>] [--record]

# 只读 analysis package v2 完成分层、修复、QA 和 PPTX 导出；不读取源图，不读取凭证，不访问网络
npm run cli -- build --analysis <analysis-dir> --out <output-dir> [--required-text-count <n>]

# 一次完成 analyze + build
npm run cli -- run <source.jpg> --out <output-dir> [--host-bridge <private-dir>] [--max-region-analysis <0..8>] [--max-occlusion-completions <0..4>] [--required-text-count <n>] [--record]

# 仅用于旧 analysis package v1；v1 不自带源像素，因此必须再提供原图
npm run cli -- build-v1 <source.jpeg> --analysis <legacy-analysis-dir> --out <output-dir> [--required-text-count <n>]
```

`--max-region-analysis` 的默认值为 8，`--max-occlusion-completions` 的默认值为 4。两者只接受所示范围内的严格整数；设为 `0` 可分别禁用局部视觉精修或遮挡补全。不存在 unlimited 模式。离线 `build`/`build-v1` 拒绝这两个网络阶段参数和 `--record`。为兼容旧脚本，`analyze`/`run` 仍接受 `--image <path>` 别名，但新文档统一使用位置图片参数。

## analysis package v2

`analyze` 在新目录中写入经 schema 验证和 SHA-256 绑定的自包含分析包，包括 `source.rgba`、`ocr.json`、`scene-graph.json`、局部精修/遮挡补全资产及 `analysis-ledger.json`。源图的标准 RGBA 像素已包含在包内，所以 v2 `build` 只需 analysis 目录。路径、哈希、尺寸或资产库存不一致时，离线构建会失败而不是使用未验证文件。

`analyze` 默认发起 1 次逻辑 OCR 请求和 1 次逻辑整页视觉分析，然后最多进行 8 次逻辑局部视觉精修和 4 次逻辑遮挡补全。候选 fallback 与有界 API 重试可能使同一源图/裁剪被传输多次；请先确认源图内容符合所有可能候选 provider 的数据合规要求。

`analysis-ledger.json.requests` 记录逻辑请求数，`routing.operations` 记录每次逻辑请求考虑的候选，`routing.transportAttempts` 才记录实际宿主调用与 API 重试；三者数量可以不同。

## 输出与 QA 复核

v2 `run` 或 `build` 会导出 manifest v2，成功输出主要包含：

- `manifest.json`：`manifestVersion: 2` 的元素、关系、z-order、provenance 和 `reviewRequired`；
- `clean-background.png` 与 `removal-mask.png`：只包含已接受候选的背景修复和合并遮罩；
- `assets/*.png`：验证通过的独立/复合前景资产；
- `recomposition-preview.png`：所有已接受层的整页重组结果；
- `layer-review.png`：透明棋盘背景上的分层联系表；
- `exploded-preview.png`：对已接受层做稳定偏移的展开图；
- `run-ledger.json`：请求计数、决策、告警、路径和主要产物哈希；
- `slide-editable.pptx` 或基于旧 v1 源图名生成的 `*-editable.pptx`。

因遮挡补全而包含生成隐藏像素的资产会在 manifest 中标记 `reviewRequired: true`，并仅在 QA 预览中添加可见的 generated-region 复核标记；导出的 PNG 资产和 PPTX 不会被该标记污染。交付前应对照源图查看三张 QA 图，并在 PowerPoint/WPS 中移动代表性前景、编辑文字、撤销后重新打开确认。

文字底板和色条如果被安全拆出，会作为可移动 PNG 位于可编辑文字下方；本工具不会把它们伪装成 PowerPoint 原生形状。无法稳定归属、遮罩或修复的图标、底板、连线和装饰将 fallback 到背景，不会为了可移动性牺牲原图。

## 安全发布边界

analysis 目录必须不存在或为空。最终输出先在同文件系统 staging 目录内完成，通过所有验证后才原子提升。只有携带严格 ownership marker 的旧输出目录可被替换；失败重跑不会覆盖上一个成功结果。不要绕过路径、哈希、ownership 或 `--required-text-count` 检查。

## 开发验证

```bash
npm test
npm run lint:types
npm run build
npm run test:compiled
npm run audit:dependencies
npm pack --dry-run
```

测试使用本地 fixture 和可注入 provider，不应访问网络。
子进程 bridge E2E 使用测试专用 host emulator，真实启动 CLI、写入 v2 分析包并生成 PPTX/三张 QA 图，同时确定性禁止网络。它证明文件协议集成，不是真实 OpenAI/Gemini 验收，也不证明 completion、文字可编辑或 PowerPoint/WPS 验收。
依赖审计仅临时接受 PptxGenJS 4.0.1 未使用的 `image-size` 声明所带来的两个
无可安装修复版本的公告；门禁绑定精确版本、扫描发布代码确认不可达，并于
2026-10-03 到期复审。任何新增公告或依赖变化都会失败。
