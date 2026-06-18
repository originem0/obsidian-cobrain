import { Plugin, Notice } from "obsidian";
import { LTSettings, DEFAULT_SETTINGS, LTSettingTab } from "./settings";

export default class LearningTutorPlugin extends Plugin {
  settings!: LTSettings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new LTSettingTab(this.app, this));
    this.addCommand({
      id: "lt-hello",
      name: "LT: Hello（脚手架自检）",
      callback: () => new Notice("Learning Tutor 已加载"),
    });
    console.log("Learning Tutor loaded");
  }

  onunload() { console.log("Learning Tutor unloaded"); }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() { await this.saveData(this.settings); }
}
