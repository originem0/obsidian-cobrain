# Cobrain（创作副脑）

**Cobrain** is an Obsidian plugin that turns the notes you've already written into "prior knowledge" for an AI thinking partner — a Socratic *midwife*, not a lecturer. Instead of handing you answers, it surfaces your own related notes and throws questions back at you, so you think things through yourself.

- **Asks before it explains** — based on what your notes show you already know, it uses differential questioning and dialectical reversal to put the ball back in your court.
- **Resurfaces your forgotten notes** — every turn it retrieves your vault and explicitly lists "notes you've written (click to revisit)", so your second brain's associations actually happen instead of being silently stuffed into the model's context.
- **Explicit, on-demand actions** — generate a Mermaid concept map, an illustrative image, or distill the conversation into a structured note with backlinks to the related notes.

Bring your own OpenAI-compatible endpoints (chat / image / embeddings); API keys are stored locally only. The desktop app is the sole index writer; mobile is read-only retrieval over the synced index. Method and philosophy are inspired by Tang Zhi's *《高手的黑箱》* ("The Expert's Black Box"). The full guide below is in Chinese.

---

> 懂你 vault 的 Obsidian 创作副脑——不是讲给你听的「导师」，而是逼你自己想的「助产士」。

一个独立的 Obsidian 插件（TypeScript，桌面 + 移动端）。它把你写过的笔记当作喂给 AI 的「前知识」，对话时：

- **回抛问题，而不是灌输**：基于你已有的笔记判断你知道什么，用差异性发问 / 辩证逆转把球踢回给你，先问后讲。
- **把你忘了的旧笔记撞到眼前**：每轮检索 vault，显式列出「你写过的（点开撞一撞）」，让第二大脑的「联想」真正发生，而不是悄悄塞进模型上下文。

灵感与方法论来自汤质《高手的黑箱：AI 时代的学习、思考与创作》，尤其「记忆 / 知识管理（2.4）」与「AI 作为深度理解的助产士（3.5）」。一条铁律贯穿设计：**逼你想，不替你想**——工具是顺手的「厨房」，不是摆功能的「客厅」。

## 功能

- **对话面板（助产士）**：侧栏 ItemView，系统人设可在设置里改。
- **vault 前知识联想**：RAG 检索（云端 OpenAI 兼容 embeddings），命中的旧笔记显式呈现、可点开。
- **显式触发的三件事**（按需，不自动）：
  - `概念图`：LLM 出 Mermaid（焦点问题→概念→关系），方向 / 详细度可配。
  - `配图`：LLM 扩写视觉提示词 → 可编辑 → gpt-image 出图（次要功能）。
  - `存为笔记`：把对话综述成结构化笔记，双链回相关旧笔记。
- **设置页**：折叠分区；三套 OpenAI 兼容端点（文本 / 图像 / 嵌入）+ key + 模型，每套都能「检测」端点实际可用模型并下拉选择（文本可一键「测试」连通、嵌入按真实试嵌入筛选）；笔记目录 / 标签；可编辑的提示词。密钥只存本地，绝不入库。

> 想快速看懂它怎么用、能达到什么效果：[实践演练](docs/实践演练.md) 有一遍真实实录（完整对话 / 概念图 / 笔记）；原则与最佳实践见 [使用手册](docs/使用手册.md)。

## Installation

### From Obsidian Community Plugins (Recommended)

1. Open Settings → Community plugins → Browse
2. Search for "Cobrain"
3. Click Install, then Enable
4. Configure API endpoints in plugin settings
5. Run command "Cobrain: Rebuild Index"

### Manual Installation (for development or testing unreleased versions)

Desktop Obsidian:

1. Build: `npm install && npm run build` (produces `main.js`)
2. Copy `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/cobrain/`
3. Settings → Community plugins → Enable **Cobrain**
4. Fill in API endpoints and keys in settings, detect and select an embed model, run **Rebuild Index** command

Development: `npm run dev` (watch), `npm run deploy` (build + copy to vault plugin dir specified by `LT_VAULT_PLUGIN_DIR`), `npm test` (Jest, pure functions only).

---

## 安装

### 从 Obsidian 社区插件安装（推荐）

1. 设置 → 第三方插件 → 浏览
2. 搜索「Cobrain」
3. 点击安装，然后启用
4. 在插件设置页配置 API 端点
5. 运行命令「Cobrain: 重建索引」

### 手动安装（开发或测试未发布版本）

桌面端 Obsidian：

1. 构建：`npm install && npm run build`（产物 `main.js`）。
2. 把 `main.js` 与 `manifest.json` 放进 `<vault>/.obsidian/plugins/cobrain/`。
3. 设置 → 第三方插件 → 启用 **Cobrain**。
4. 在设置页填好三套 API 端点与 key，「检测」并选一个嵌入模型，跑命令 **重建索引**。

开发：`npm run dev`（watch）、`npm run deploy`（构建 + 拷到 `LT_VAULT_PLUGIN_DIR` 指定的 vault 插件目录）、`npm test`（Jest，仅纯函数）。

## 跨设备使用（桌面 + 移动端）

Cobrain 桌面端与移动端通用（一份代码，`isDesktopOnly: false`）。多设备协作的约定：

- **桌面端是唯一的索引写入方**：自动重嵌（编辑后防抖）与「重建索引」都在桌面端进行。
- **移动端只读检索**：移动端不做后台重嵌、绝不写索引分片（在移动端运行「重建索引」只会提示「请在桌面端重建」）。它读的是随 vault 同步过来、桌面端建好的索引。
- **换设备安装**：若你用 iCloud/Dropbox/OneDrive 等同步整个 vault，`.obsidian/plugins/cobrain/`（代码 + 索引）会自动到新设备——无需上架、无需额外操作。移动端 Obsidian 需**重启/强退**才会加载新同步来的 `main.js`。
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
| 嵌入 | OpenAI 兼容 `/embeddings`（默认 `BAAI/bge-m3`） |

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
- The default free endpoints in settings are for trial only; replace them with your own API keys or self-hosted instances for production use.
- If syncing `.obsidian` across devices (for cross-device installation), ensure your sync service is encrypted and trusted.

---

## 隐私边界

- 笔记全文会发往**嵌入代理**（索引时分块嵌入）。
- 聊天上下文 + 检索片段发往**文本 LLM 代理**。
- 配图提示词发往**图像代理**（不含笔记原文）。
- 三套 key 只存本地 `data.json`（已 gitignore），不入库。

## 已知问题

- **索引按文件分片**：向量索引存在插件目录的 `index/` 下，每篇笔记一个小分片 `index/<hash>.json`，向量按 **int8 量化**存储（约 273 篇笔记 ≈ 10 MB，较未量化的全精度小一个数量级）。改一篇笔记只重写它那个小分片、不再整份重写——块级增量 diff 留待后续（文件级已是 80/20）。
- 首次升级会迁移：旧单文件 `index.json` 在加载时一次性迁成 `index/` 分片并删除旧文件，这一次加载稍慢，之后变快。

## 致谢

方法论来自汤质《高手的黑箱》。RAG / 第二大脑思路参考 [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)。

---

个人自用项目，桌面 + 移动端，WIP。
