import { Plugin, Notice } from "obsidian";

export default class LearningTutorPlugin extends Plugin {
  async onload() {
    this.addCommand({
      id: "lt-hello",
      name: "LT: Hello（脚手架自检）",
      callback: () => new Notice("Learning Tutor 已加载"),
    });
    console.log("Learning Tutor loaded");
  }
  onunload() {
    console.log("Learning Tutor unloaded");
  }
}
