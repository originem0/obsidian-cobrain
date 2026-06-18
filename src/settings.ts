import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { detectEmbeddingModels } from "./rag/apiEmbedder";
import type CobrainPlugin from "./main";

export interface CobrainSettings {
  llmBaseUrl: string;
  llmKey: string;
  llmModel: string;
  imageBaseUrl: string;
  imageKey: string;
  imageModel: string;
  imageStyle: string;       // 配图风格预设，拼接到出图提示词尾部
  imageQuality: string;     // 质量档位；空=不发送该参数（兼容不支持的代理）
  imageSize: string;        // 出图尺寸
  embedBaseUrl: string;
  embedKey: string;
  embedModel: string;
  noteFolder: string;
  attachmentFolder: string;
  noteTags: string;             // 逗号分隔，写入笔记 frontmatter tags
  appendConversation: boolean;  // 存笔记时是否附原始对话
  conceptMapDirection: string;  // Mermaid 方向：TD / LR
  conceptMapDetail: string;     // 概念图详细度：简 / 中 / 详
  tutorPrompt: string;          // 导师系统提示词
  conceptMapPrompt: string;     // 概念图系统提示词（方向/详细度另行注入）
  notePrompt: string;           // 笔记综述系统提示词
}

// 提示词默认值即原硬编码文案，移到设置后用户可改（设计文档第 8 条「提示词可定制」）
// 人设是「助产士」而非「讲解员」：基于用户自己的笔记（前知识）回抛问题、逼他自己想，而不是灌输。
// 依据《高手的黑箱》3.5（AI 作为助产士）、5.6（差异性发问/辩证逆转）。
const DEFAULT_TUTOR_PROMPT = `你是用户的「思考助产士」，不是讲解员。你的任务不是把知识灌给他，而是帮他把自己的理解亲手「接生」出来。原则：
- 接地：下面「已有笔记」是用户自己写过的东西（他的前知识）。先据此判断他已经知道什么，把新念头接到他写过的旧念头上，用 [[笔记名]] 引用，别重复他已懂的。
- 先问后讲：每次回应都至少回抛一个真问题，把球先踢回给他，让他自己想一步。优先用「差异性发问」——问 A 和 B 差在哪、为什么这里不一样，而不是泛泛地「X 是什么」；适时用「辩证逆转」——把他眼中的障碍当条件来反问（如「会不会正是这个困扰，才让那件事成立？」）。
- 克制：不要一上来就长篇拆解。只在他明显卡住或明确要答案时，给「够用就停」的解释，剩下的留给追问。宁可点到为止，逼他往深里走。
- 诚实：你给的是启发与流动性，真正的洞见得他自己从卡顿里逼出来。不要替他下判断、替他体会，别把话说圆说满。
- 中文回答，简洁有重点，善用类比和具体例子，可用 Markdown。`;

// 注意：不写死 graph 方向（由 conceptMapDirection 注入），也不写死节点数（由 conceptMapDetail 注入）
const DEFAULT_CONCEPT_MAP_PROMPT =
  "只输出一个 ```mermaid 代码块，不要任何其它文字。顶部一个焦点问题节点，往下是核心概念，用带中文标签的箭头表示概念间关系。节点文字用中文，简短。";

const DEFAULT_NOTE_PROMPT =
  "把下面这段学习对话整理成一篇结构化的中文笔记（不是聊天记录原文）。第一行用 `标题：xxx` 给出简短标题；其后是正文：用小标题和要点组织核心概念、拆解与结论，去掉寒暄口水。Markdown 格式。";

export const DEFAULT_SETTINGS: CobrainSettings = {
  llmBaseUrl: "https://wududu.edu.kg/v1",
  llmKey: "",
  llmModel: "z-ai/glm-5.1",
  imageBaseUrl: "https://freeapi.dgbmc.top/v1",
  imageKey: "",
  imageModel: "gpt-image-2",
  imageStyle: "现代扁平矢量教学插画，简洁有冲击力的构图，高对比柔和配色，主体居中，适度留白",
  imageQuality: "",
  imageSize: "1024x1024",
  embedBaseUrl: "https://router.tumuer.me/v1",
  embedKey: "",
  embedModel: "BAAI/bge-m3",
  noteFolder: "cobrain-note",
  attachmentFolder: "cobrain-note/附件",
  noteTags: "cobrain-note",
  appendConversation: false,
  conceptMapDirection: "TD",
  conceptMapDetail: "中",
  tutorPrompt: DEFAULT_TUTOR_PROMPT,
  conceptMapPrompt: DEFAULT_CONCEPT_MAP_PROMPT,
  notePrompt: DEFAULT_NOTE_PROMPT,
};

// 只允许把值为 string 的设置键传给文本/文本域助手，避免把 boolean 键喂进去
type StringKeys = { [K in keyof CobrainSettings]: CobrainSettings[K] extends string ? K : never }[keyof CobrainSettings];

export class CobrainSettingTab extends PluginSettingTab {
  private detectedEmbed: { id: string; dim: number }[] = [];
  constructor(app: App, private plugin: CobrainPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    const text = (name: string, desc: string, key: StringKeys, ph = "") =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t =>
        t.setPlaceholder(ph).setValue(s[key]).onChange(v => {
          s[key] = v.trim();
          this.plugin.saveSettingsDebounced();
        })
      );

    // 提示词等多行文本：不 trim（保留换行/缩进）
    const textArea = (name: string, desc: string, key: StringKeys) =>
      new Setting(containerEl).setName(name).setDesc(desc).addTextArea(t => {
        t.setValue(s[key]).onChange(v => {
          s[key] = v;
          this.plugin.saveSettingsDebounced();
        });
        t.inputEl.rows = 6;
        t.inputEl.style.width = "100%";
      });

    containerEl.createEl("h3", { text: "文本 LLM（对话）" });
    text("Base URL", "OpenAI 兼容端点", "llmBaseUrl");
    text("API Key", "仅存本地，不入库", "llmKey", "sk-...");
    text("Model", "", "llmModel");

    containerEl.createEl("h3", { text: "图像（gpt-image-2）" });
    text("Base URL", "OpenAI 兼容端点", "imageBaseUrl");
    text("API Key", "仅存本地，不入库", "imageKey", "sk-...");
    text("Model", "", "imageModel");
    text("尺寸", "如 1024x1024", "imageSize");
    text("质量", "如 high/medium/low 或 hd；留空则不发送（部分代理不支持此参数）", "imageQuality");
    textArea("风格预设", "拼到每张配图提示词尾部，统一画风", "imageStyle");

    containerEl.createEl("h3", { text: "嵌入 API（语义检索）" });
    const warn = containerEl.createEl("p", {
      text: "隐私提示：建立索引会把你的笔记全文分块发送到这个嵌入端点。请使用你信任的端点；默认填的免费代理仅供试用，别拿它跑你不愿外传的私密笔记。",
    });
    warn.style.cssText =
      "font-size:0.85em; margin:4px 0 10px; padding:6px 10px; line-height:1.5; border-left:3px solid var(--text-error); background:var(--background-secondary); border-radius:4px;";
    text("Base URL", "OpenAI 兼容 embeddings 端点", "embedBaseUrl");
    text("API Key", "仅存本地，不入库", "embedKey", "sk-...");
    new Setting(containerEl)
      .setName("嵌入模型")
      .setDesc(
        this.detectedEmbed.length
          ? `已检测到 ${this.detectedEmbed.length} 个实际可用模型，下拉选择`
          : "点「检测」自动列出该端点实际可用的嵌入模型（无需手填）",
      )
      .addButton(b =>
        b.setButtonText("检测").onClick(async () => {
          if (!s.embedBaseUrl || !s.embedKey) {
            new Notice("请先填 Base URL 和 API Key");
            return;
          }
          b.setButtonText("检测中…").setDisabled(true);
          const notice = new Notice("正在逐个测试该端点上的嵌入模型…", 0);
          try {
            this.detectedEmbed = await detectEmbeddingModels(s.embedBaseUrl, s.embedKey);
            notice.hide();
            new Notice(
              this.detectedEmbed.length
                ? `检测到 ${this.detectedEmbed.length} 个可用模型`
                : "没检测到可用的嵌入模型",
            );
            this.display();
          } catch (e: any) {
            notice.hide();
            new Notice("检测失败：" + (e?.message ?? String(e)));
            b.setButtonText("检测").setDisabled(false);
          }
        }),
      )
      .addDropdown(d => {
        const list = this.detectedEmbed.length ? this.detectedEmbed : [{ id: s.embedModel, dim: 0 }];
        for (const m of list) d.addOption(m.id, m.dim ? `${m.id} · ${m.dim}维` : m.id);
        d.setValue(s.embedModel).onChange(async v => {
          if (v === s.embedModel) return;
          s.embedModel = v;
          await this.plugin.saveSettings();
          // 换模型 → 旧向量维度/空间不兼容，立即清空，待重建
          this.plugin.store.deserialize(null);
          await this.plugin.persistIndex();
          new Notice(`已切到 ${v}，索引已清空，请运行「Cobrain: 重建索引」`);
        });
      });

    containerEl.createEl("h3", { text: "概念图" });
    new Setting(containerEl)
      .setName("方向")
      .setDesc("Mermaid 布局方向")
      .addDropdown(d => {
        d.addOption("TD", "自上而下 (TD)");
        d.addOption("LR", "自左向右 (LR)");
        d.setValue(s.conceptMapDirection).onChange(async v => {
          s.conceptMapDirection = v;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName("详细度")
      .setDesc("概念图的节点密度")
      .addDropdown(d => {
        d.addOption("简", "简（核心 5-7 节点）");
        d.addOption("中", "中（10 节点左右）");
        d.addOption("详", "详（15+ 节点，含次级关系）");
        d.setValue(s.conceptMapDetail).onChange(async v => {
          s.conceptMapDetail = v;
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "笔记" });
    text("笔记目录", "存为笔记的目标目录", "noteFolder");
    text("附件目录", "配图保存目录", "attachmentFolder");
    text("标签", "逗号分隔，写入 frontmatter tags", "noteTags");
    new Setting(containerEl)
      .setName("附原始对话")
      .setDesc("存笔记时在末尾附上完整对话记录")
      .addToggle(t =>
        t.setValue(s.appendConversation).onChange(async v => {
          s.appendConversation = v;
          await this.plugin.saveSettings();
        }),
      );

    containerEl.createEl("h3", { text: "提示词（可自定义）" });
    textArea("副脑人设", "对话时的系统提示词", "tutorPrompt");
    textArea("概念图", "生成 Mermaid 概念图的提示词（方向/详细度由上方设置注入）", "conceptMapPrompt");
    textArea("笔记综述", "把对话整理成笔记的提示词", "notePrompt");
  }
}
