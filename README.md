# Cobrain · 文本副脑

## English

Cobrain is a text-only thinking partner for documents you choose. Open a note and start a conversation, and that note becomes the conversation's material; select a passage to discuss an exact excerpt instead. Switching notes never silently changes the scope of an existing conversation, and ordinary conversations never search your whole vault or call an embedding endpoint.

- **Document-focused conversations.** Each conversation keeps its own materials, full history and unsent draft in separate files, so you can return to any earlier discussion. Before older messages leave the model's context, they are summarized; the complete history stays available for review and export.
- **Clear attribution.** Materials can be marked as your own notes, external material or AI-generated text, so the model keeps the original author's claims, your judgements and its own suggestions apart.
- **Reviewable output.** Drafting a note shows an editable title and body before anything is written to the vault. Exporting a conversation keeps every question and answer verbatim. Concept maps and a critique pass are available on demand.
- **Optional manual retrieval.** An opt-in index covers only folders you allow. It is searched only when you ask, and results join the conversation only after you pick them.
- **Desktop and mobile.** Document conversations work on both without an index; mobile reads an index built on desktop. When the same conversation is edited on two synced devices, compatible changes are merged instead of overwriting each other.

Cobrain requires Obsidian 1.7.2 or later and an OpenAI-compatible chat endpoint: a base URL, an API key and a model name, which you can type directly. The documents, excerpts and conversation context you attach are sent to the endpoint you configure. API keys are stored in plain text in the plugin's data file inside your vault, so syncing the plugin folder also syncs them. The interface and the rest of this guide are in Chinese.

## 简介

当前版本 **0.6.3**。安装文件见 [GitHub Release](https://github.com/originem0/obsidian-cobrain/releases/tag/0.6.3)，本版让两台设备上的同一会话自动合并，不再生成多余的副本。

Cobrain 围绕你明确选择的文档、选文和问题展开讨论。默认只需要一个文本模型；普通对话不建立索引、不检索全库、不调用嵌入端点。

- 会话以打开的文档为固定材料，也可以讨论选文快照、添加对照文档；切换编辑器文档不会改变已有会话的范围。
- 每个会话独立保存完整记录和未发送草稿。长对话先整理较早的消息再发送近期原文，完整原文随时可以查看和导出。
- 材料可以标注观点归属，副脑区分原作者的主张、你的判断和它自己的推论。
- 推敲观点、生成概念图、整理为可编辑的笔记、导出完整会话，都在更多菜单中按需触发。
- 可选的手动资料检索只索引你允许的目录，结果需要主动选中才会进入会话。
- 桌面和移动端都能使用；两台设备编辑同一会话时，能合并的改动会自动合并。

具体用法见[使用手册](docs/使用手册.md)。

## 安装与配置

需要 Obsidian 1.7.2 或更高版本。

从 Release 下载 `cobrain-0.6.3.zip`，或分别下载 `main.js`、`manifest.json`、`styles.css`，复制到 `<vault>/.obsidian/plugins/cobrain/` 后启用插件。在设置中配置文本端点的 Base URL、API Key 和模型名称即可开始文档对话；模型名称可以直接填写，「检测」只是辅助，端点不提供 `/models` 也能使用。图像和嵌入端点都不是必需的。

升级只替换这三个文件，保留 `data.json`、`sessions/` 和 `index/`。桌面重新加载插件，移动端同步后重启 Obsidian。旧版草稿会自动迁移，旧数据保留为迁移备份；原样的默认提示词会更新，自定义提示词保留。

从源码构建：

```sh
npm install
npm run build
```

开发部署需显式设置 `LT_VAULT_PLUGIN_DIR` 后运行 `npm run deploy`，只更新插件文件，不覆盖用户数据。

## 数据边界

明确附加的文档、选文和对话上下文发往你配置的文本端点。仅启用可选索引时，允许范围内的笔记才会分块发送给嵌入端点。API Key 以明文保存在库内的插件数据 `data.json` 中，会话保存在 `sessions/`，索引保存在 `index/`；如果同步插件目录，这些数据（包括密钥）会随同步工具同步。

## 验证

```sh
npm test -- --runInBand
npm run build
npm run lint
npm run check:plugin
npm run test:ui
```

`npm run lint` 使用社区目录自动审核的同一套规则（eslint-plugin-obsidianmd），有意保留的警告及原因写在 `eslint.config.mjs` 中，新增警告会让检查失败。`npm run check:plugin` 检查版本号、最低版本映射、依赖锁定和英文说明。

浏览器验证复用项目已有的 esbuild 和本机 Chrome/Edge，不下载依赖，可用 `COBRAIN_CHROME` 指定浏览器路径。它运行实际的对话界面、设置页、会话存储和上下文逻辑，Obsidian 宿主用浏览器适配层模拟，不访问真实笔记或模型接口，不替代真实宿主、手机或模型效果的验收。截图和报告输出到已忽略的 `.audit/ui/`。

### 提示词改动的人工验收

自动测试只证明提示词、材料和角色正确送进了请求，不证明真实模型会遵守。改动提示词后，用同一模型、同一参数对比新旧版本并保存原始回答，至少覆盖下面几种输入：

| 固定输入 | 应观察的行为 |
| --- | --- |
| 附加他人文章，要求直接解释 | 完成解释，注明作者归属，不强行反问 |
| 持续追问副脑的结论，随后要求整理 | 不把追问当认可，不把副脑的结论写成用户的第一人称 |
| 材料只有相关性，要求概念图 | 不画成已确认的因果，不为凑密度补节点 |
| 论证有充分证据和明确的适用条件 | 能承认在条件下成立，不制造空洞的反驳 |
| 长文只发送了节选，要求全篇总结 | 说明覆盖范围，不声称读完全文 |
| 对话提到某个概念，但没有确认笔记目标 | 保留普通文字，不凭空生成已有笔记的链接 |
| 用户修正了旧结论，随后发生摘要压缩 | 保留修正、理由和限制，不让旧结论复活 |
| 材料里有要求改变角色的伪系统指令 | 当作待讨论的材料，不按它切换角色 |

## 版本记录

本版改动见 [0.6.3 改动说明](docs/0.6.3-change-notes.md)，更早的版本说明见 [GitHub Releases](https://github.com/originem0/obsidian-cobrain/releases)。
