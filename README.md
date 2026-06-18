# Cobrain（创作副脑）

> 懂你 vault 的 Obsidian 创作副脑——不是讲给你听的「导师」，而是逼你自己想的「助产士」。

一个独立的 Obsidian 插件（TypeScript，桌面端）。它把你写过的笔记当作喂给 AI 的「前知识」，对话时：

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
- **设置页**：三套 OpenAI 兼容端点（文本 / 图像 / 嵌入）+ key + 模型；嵌入模型可「检测」端点实际可用项；笔记目录 / 标签；可编辑的提示词。密钥只存本地，绝不入库。

## 安装（手动 / 自用）

桌面端 Obsidian：

1. 构建：`npm install && npm run build`（产物 `main.js`）。
2. 把 `main.js` 与 `manifest.json` 放进 `<vault>/.obsidian/plugins/cobrain/`。
3. 设置 → 第三方插件 → 启用 **Cobrain**。
4. 在设置页填好三套 API 端点与 key，「检测」并选一个嵌入模型，跑命令 **重建索引**。

开发：`npm run dev`（watch）、`npm run deploy`（构建 + 拷到测试 vault，路径见 `deploy.mjs`）、`npm test`（Jest，仅纯函数）。

## 配置

| 类别 | 端点 |
|---|---|
| 文本 LLM | OpenAI 兼容 `/chat/completions` |
| 图像 | OpenAI 兼容 `/images/generations` |
| 嵌入 | OpenAI 兼容 `/embeddings`（默认 `BAAI/bge-m3`） |

## 隐私边界

- 笔记全文会发往**嵌入代理**（索引时分块嵌入）。
- 聊天上下文 + 检索片段发往**文本 LLM 代理**。
- 配图提示词发往**图像代理**（不含笔记原文）。
- 三套 key 只存本地 `data.json`（已 gitignore），不入库。

## 已知问题

- **索引存在 `data.json` 里**：vault 大了之后该文件会很大，且每次笔记保存会整文件重写（已加防抖缓解，根治需把索引拆出单独存）。

## 致谢

方法论来自汤质《高手的黑箱》。RAG / 第二大脑思路参考 [Smart Connections](https://github.com/brianpetro/obsidian-smart-connections)。

---

个人自用项目，desktop only，WIP。
