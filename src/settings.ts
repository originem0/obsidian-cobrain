import { App, PluginSettingTab, Setting } from "obsidian";
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
  embedModel: "text-embedding-3-small",
  noteFolder: "学习导师",
  attachmentFolder: "学习导师/附件",
};

export class LTSettingTab extends PluginSettingTab {
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
    text("Model", "如 text-embedding-3-small / BAAI/bge-m3", "embedModel");

    containerEl.createEl("h3", { text: "目录" });
    text("笔记目录", "存为笔记的目标目录", "noteFolder");
    text("附件目录", "配图保存目录", "attachmentFolder");
  }
}
