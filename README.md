# Cobrain（创作副脑）

**Cobrain** is an Obsidian AI co-brain for creators. When you ask a question, it automatically retrieves related notes from your vault, brings them into the AI conversation, and lets a customizable persona question, critique, and organize your thinking so old experience can grow into new expression.

It is not just a generic chatbot inside Obsidian, and it is not just semantic search. The main loop is: ask with your own notes in context, inspect the related notes it found, think through the follow-up questions, then save the result back as a linked Obsidian note.

- **Creative co-brain** — helps you turn scattered experience, old notes, and current questions into new expression.
- **Vault-grounded thinking** — each turn retrieves related notes and sends only the relevant snippets to the text model.
- **Custom persona prompt** — tune the AI into a midwife, critic, editor, or any other thinking role.
- **Visible retrieval** — matched notes are shown in the panel, not hidden in the prompt.
- **Desktop + mobile** — desktop writes the vector index; mobile reads the synced index.

---

> Cobrain 是面向创作者的 Obsidian AI 副脑。它会在你提问时自动找出 vault 里的相关旧笔记，让可定制人设的 AI 基于你的材料追问、推敲、组织思路，帮助你从旧经验里长出新的表达。

这里的创作不是让 AI 替你生成一篇文章，而是把你的经验、旧知识、当前问题、分析和评价综合起来，形成一个带有你自己判断的新表达。Cobrain 帮的是这条创作链路。

第一，它帮你调取旧材料。不是手动复制材料，而是每次提问都会从 vault 找出相关旧笔记。

第二，它制造旧知识和当前问题的碰撞。差异、失洽、意外、回溯常常是洞见的来源。Cobrain 把你忘掉的旧笔记撞回眼前，让现在的问题和过去写过的东西发生冲突。

第三，它不是直接给答案，而是追问和推敲。创作需要问题意识，也需要评价能力。Cobrain 的人设 Prompt 可定制，你可以让它像助产士、批评者、编辑、外星人类学家一样工作。它可以追问你的前提，也可以用「推敲」检查读者吸引力、论证水平、洞见水平。

第四，它帮你组织思路。概念图不是装饰，它对应创作里的概念地图：把焦点问题、概念、关系摆出来，暴露缺口和断层。它不是替你思考，而是让思考变得可见。

第五，它把一轮思考保存回 vault。这不是最大卖点，但它是闭环。新的笔记会变成下一轮创作的旧材料，让你的创作系统越用越厚。

它和普通 AI 聊天插件的区别：

- **不是把整个 vault 粗暴塞进 prompt**：只检索本轮相关片段，降低噪音和 token 浪费。
- **不是只返回搜索结果**：相关旧笔记会进入模型上下文，LLM 会基于它们回应。
- **来源可见**：命中的旧笔记显示在对话区，可以直接点开检查。
- **结果回到 vault**：`存为笔记` 会生成结构化 Markdown，并自动双链回相关来源。
- **数据边界明确**：你自己配置 OpenAI-compatible 端点；笔记索引走嵌入端点，对话走文本端点，key 只存在本地插件数据里。

## 功能

- **Vault-aware 对话面板**：侧栏里直接提问；每轮把相关旧笔记片段送进模型上下文；回答**流式逐字输出**，「停止」会真正中止在途请求（端点不支持流式/CORS 时自动降级为整段返回，停止仅解锁面板）。
- **多轮检索改写**：追问里的「它 / 这个」等指代会先由文本模型改写成自包含检索查询再去翻旧笔记，改写失败自动回退原文（设置里可关）。
- **长对话不丢上下文**：每轮原文只发最近 20 条；更早的消息后台自动压缩成滚动摘要随对话发送，推敲 / 概念图 / 存笔记同样带上摘要。
- **对话草稿不静默丢失**：最多 3 个对话面板各自保留草稿；关闭面板只是暂停，再打开自动恢复草稿（提示行里可一键「新建对话」），面板内也可显式「清空」。点侧栏图标聚焦已打开的面板；要并行多开，点面板标题栏的 ＋ 图标，或用「新开一个对话面板」命令。
- **相关旧笔记可见**：RAG 检索（云端 OpenAI 兼容 embeddings），命中的旧笔记显式呈现、可点开核对。
- **显式触发的三件事**（按需，不自动）：
  - `概念图`：基于整段对话让 LLM 出 Mermaid（焦点问题→概念→关系），方向 / 详细度可配。
  - `推敲`：按读者吸引力、论证水平、洞见水平指出当前材料的最大落差。
  - `配图`：LLM 扩写视觉提示词 → 可编辑 → gpt-image 出图（次要功能）。
  - `存为笔记`：把对话综述成结构化笔记，双链回相关旧笔记；标题可在保存前就地编辑，保存后一键点开；保存时冻结当轮对话、来源、概念图和配图，避免弹窗期间的新内容串进同一篇。
- **索引状态可查**：命令 `Cobrain: 查看索引状态` 展示已索引笔记数、chunk 数、嵌入模型、运行状态、最近更新时间和失败列表。
- **设置页**：折叠分区；三套 OpenAI 兼容端点（文本 / 图像 / 嵌入）+ key + 模型，每套都能「检测」端点实际可用模型并下拉选择（文本可一键「测试」连通、嵌入按真实试嵌入筛选），图像/嵌入可一键复用文本端点的 URL 和 Key；笔记目录 / 标签；可编辑的提示词。API Key 以密码态显示（可切换明文）、只存本地 `data.json`（已 gitignore，不入库）；若你同步 `.obsidian`，密钥会随之同步，详见下方隐私边界。

> 想快速看懂它怎么用、能达到什么效果：[实践演练](docs/实践演练.md) 有一遍真实实录（完整对话 / 概念图 / 笔记）；原则与最佳实践见 [使用手册](docs/使用手册.md)。

## Installation

### From Obsidian Community Plugins

1. Open Settings → Community plugins → Browse
2. Search for "Cobrain"
3. Click Install, then Enable
4. Configure API endpoints in plugin settings
5. Run command "Cobrain: Rebuild Index"

### Manual Installation

Desktop Obsidian:

1. Build: `npm install && npm run build` (produces `main.js`)
2. Copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/cobrain/`
3. Settings → Community plugins → Enable **Cobrain**
4. Fill in API endpoints and keys in settings, detect and select an embed model, run **Rebuild Index** command

Development: `npm run dev` (watch), `npm run deploy` (build + copy to vault plugin dir specified by `LT_VAULT_PLUGIN_DIR`), `npm test` (Jest coverage for indexing, draft recovery, save snapshots, and retrieval fallback).

---

## 安装

### 从 Obsidian 社区插件安装

1. 设置 → 第三方插件 → 浏览
2. 搜索「Cobrain」
3. 点击安装，然后启用
4. 在插件设置页配置 API 端点
5. 运行命令「Cobrain: 重建索引」

### 手动安装

桌面端 Obsidian：

1. 构建：`npm install && npm run build`（产物 `main.js`）。
2. 把 `main.js` 与 `manifest.json` 放进 `<vault>/.obsidian/plugins/cobrain/`。
3. 设置 → 第三方插件 → 启用 **Cobrain**。
4. 在设置页填好三套 API 端点与 key，「检测」并选一个嵌入模型，跑命令 **重建索引**。

开发：`npm run dev`（watch）、`npm run deploy`（构建 + 拷到 `LT_VAULT_PLUGIN_DIR` 指定的 vault 插件目录）、`npm test`（Jest，覆盖索引、草稿、保存快照、检索降级等关键逻辑）。

## 跨设备使用（桌面 + 移动端）

Cobrain 桌面端与移动端通用（一份代码，`isDesktopOnly: false`）。多设备协作的约定：

- **桌面端是唯一的索引写入方**：自动重嵌（编辑后防抖）与「重建索引」都在桌面端进行。建议固定**一台**桌面端做索引写入——多台桌面端都编辑笔记时，各自重写索引分片可能在同步时冲突（兜底见下）。
- **移动端只读检索**：移动端不做后台重嵌、绝不写索引分片（在移动端运行「重建索引」只会提示「请在桌面端重建」）。它读的是随 vault 同步过来、桌面端建好的索引。
- **换设备安装**：优先在每台设备从 Obsidian 社区插件安装；也可以继续用 vault 同步 `.obsidian/plugins/cobrain/` 或 BRAT 安装开发版。移动端 Obsidian 需**重启/强退**才会加载新同步来的 `main.js`。
- **注意**：移动端新建/编辑的笔记，要等桌面端下次「重建索引」后才进入检索结果。
- **兜底**：若文件同步 `.obsidian` 偶发小文件冲突，可改用 [BRAT](https://github.com/TfTHacker/obsidian42-brat) 从 GitHub 仓库安装/更新插件代码（移动端亦支持），索引仍走 vault 同步。

### 同步设置（以 Remotely Save 为例，实测可用）

- 先开两个开关：**同步配置文件夹（Sync Config Dir）** + **允许同步 `_` 开头的文件/文件夹**（否则 `.obsidian` 与 `_meta` 等目录都不同步）。
- 「允许列表」填两行（每行**顶格、无空格**）：

  ```
  ^[^.]
  ^\.obsidian/
  ```

  `^[^.]` = 你的全部笔记/附件；`^\.obsidian/` = 整个配置目录（含插件代码与索引）。**少了 `^[^.]` 这行笔记会停止同步**——允许列表一旦非空即白名单，只有列出的才同步。
- 只想带 Cobrain 一个插件、不同步其它插件：把 `^\.obsidian/` 换成三行 `^\.obsidian/$`、`^\.obsidian/plugins/$`、`^\.obsidian/plugins/cobrain/`（Remotely Save 对 `.obsidian` 子目录匹配偶有问题，不灵就退回上面的整目录写法）。

## 配置

| 类别 | 端点 |
|---|---|
| 文本 LLM | OpenAI 兼容 `/chat/completions` |
| 图像 | OpenAI 兼容 `/images/generations` |
| 嵌入 | OpenAI 兼容 `/embeddings` |

提示词直接影响对话质量与笔记质量。设置页可编辑三套提示词（副脑人设 / 概念图 / 笔记综述）；源码默认值在 [`src/settings.ts`](src/settings.ts) 的 `DEFAULT_TUTOR_PROMPT`、`DEFAULT_CONCEPT_MAP_PROMPT`、`DEFAULT_NOTE_PROMPT`。已保存的设置会覆盖代码默认值。

## Privacy & Security

**What data leaves your device:**
- **Full note content** → your embedding endpoint (chunked for indexing)
- **Chat context + retrieved snippets** → your text LLM endpoint
- **Image prompts** → your image endpoint (does not include note text)

**What stays local:**
- API keys are stored in `<vault>/.obsidian/plugins/cobrain/data.json` (local only, not synced to git or cloud unless you explicitly sync `.obsidian`)
- Vector index is stored in `<vault>/.obsidian/plugins/cobrain/index/` (local unless synced via vault sync)

**Security recommendations:**
- **Use trusted endpoints only.** Your notes contain your thoughts — send them only to services you trust.
- If using a free proxy or third-party API gateway, understand that your note content will pass through it.
- New installs do not include default proxy endpoints. Configure trusted endpoints explicitly before indexing or chatting.
- If syncing `.obsidian` across devices (for cross-device installation), ensure your sync service is encrypted and trusted.

---

## 隐私边界

- 笔记全文会发往**嵌入代理**（索引时分块嵌入）。
- 聊天上下文 + 检索片段发往**文本 LLM 代理**。
- 配图提示词发往**图像代理**（不含笔记原文）。
- 三套 key 与对话草稿只存本地 `data.json`（已 gitignore），不入库；如果你同步 `.obsidian`，它们会跟随同步工具走。

## 已知问题

- **索引按文件分片**：向量索引存在插件目录的 `index/` 下，每篇笔记一个小分片 `index/<hash>.json`，向量按 **int8 量化**存储（约 273 篇笔记 ≈ 10 MB，较未量化的全精度小一个数量级）。改一篇笔记只重写它那个小分片、不再整份重写；全量重建按 4 路并发嵌入——块级增量 diff 留待后续（文件级已是 80/20）。
- 首次升级会迁移：旧单文件 `index.json` 在加载时一次性迁成 `index/` 分片并删除旧文件，这一次加载稍慢，之后变快。
- 对话上下文每轮把最近 20 条消息原文发给模型；更早的消息在后台自动压缩成滚动摘要（存在草稿里、随对话发送），面板会显示压缩进度。摘要由文本 LLM 生成，极端情况下可能丢失个别细节——关键结论建议「存为笔记」固化。
