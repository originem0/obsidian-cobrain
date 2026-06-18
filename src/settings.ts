import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { detectEmbeddingModels } from "./rag/apiEmbedder";
import type LearningTutorPlugin from "./main";

export interface LTSettings {
  llmBaseUrl: string;
  llmKey: string;
  llmModel: string;
  imageBaseUrl: string;
  imageKey: string;
  imageModel: string;
  embedBaseUrl: string;
  embedKey: string;
  embedModel: string;
  noteFolder: string;
  attachmentFolder: string;
}

export const DEFAULT_SETTINGS: LTSettings = {
  llmBaseUrl: "https://wududu.edu.kg/v1",
  llmKey: "",
  llmModel: "z-ai/glm-5.1",
  imageBaseUrl: "https://freeapi.dgbmc.top/v1",
  imageKey: "",
  imageModel: "gpt-image-2",
  embedBaseUrl: "https://router.tumuer.me/v1",
  embedKey: "",
  embedModel: "BAAI/bge-m3",
  noteFolder: "学习导师",
  attachmentFolder: "学习导师/附件",
};

export class LTSettingTab extends PluginSettingTab {
  private detectedEmbed: { id: string; dim: number }[] = [];
  constructor(app: App, private plugin: LearningTutorPlugin) { super(app, plugin); }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;

    const text = (name: string, desc: string, key: keyof LTSettings, ph = "") =>
      new Setting(containerEl).setName(name).setDesc(desc).addText(t =>
        t.setPlaceholder(ph).setValue(s[key]).onChange(async v => {
          s[key] = v.trim() as any;
          await this.plugin.saveSettings();
        })
      );

    containerEl.createEl("h3", { text: "文本 LLM（对话）" });
    text("Base URL", "OpenAI 兼容端点", "llmBaseUrl");
    text("API Key", "仅存本地，不入库", "llmKey", "sk-...");
    text("Model", "", "llmModel");

    containerEl.createEl("h3", { text: "图像（gpt-image-2）" });
    text("Base URL", "OpenAI 兼容端点", "imageBaseUrl");
    text("API Key", "仅存本地，不入库", "imageKey", "sk-...");
    text("Model", "", "imageModel");

    containerEl.createEl("h3", { text: "嵌入 API（语义检索）" });
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
          new Notice(`已切到 ${v}，索引已清空，请运行「LT: 重建索引」`);
        });
      });

    containerEl.createEl("h3", { text: "目录" });
    text("笔记目录", "存为笔记的目标目录", "noteFolder");
    text("附件目录", "配图保存目录", "attachmentFolder");
  }
}
