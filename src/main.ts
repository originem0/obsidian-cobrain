import { Plugin, Notice, TFile } from "obsidian";
import { LTSettings, DEFAULT_SETTINGS, LTSettingTab } from "./settings";
import { LocalEmbedder } from "./rag/localEmbedder";
import { VectorStore } from "./rag/vectorStore";
import { Indexer } from "./rag/indexer";

export default class LearningTutorPlugin extends Plugin {
  settings!: LTSettings;
  store!: VectorStore;
  embedder!: LocalEmbedder;
  indexer!: Indexer;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new LTSettingTab(this.app, this));

    this.store = new VectorStore();
    const data = await this.loadData();
    this.store.deserialize(data?.index ?? null);
    this.embedder = new LocalEmbedder(this.settings.embedModel);
    this.indexer = new Indexer(this.app, this.embedder, this.store);

    this.addCommand({
      id: "lt-reindex",
      name: "LT: 重建索引",
      callback: () => this.indexer.reindexAll(() => this.persistIndex()),
    });

    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "md")
        this.indexer.onModify(f).then(() => this.persistIndex());
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      this.indexer.onDelete(f.path);
      this.persistIndex();
    }));

    console.log("Learning Tutor loaded");
  }

  onunload() { console.log("Learning Tutor unloaded"); }

  // data.json 结构：{ settings, index } 两个独立命名空间，互不覆盖
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
  }

  async saveSettings() {
    const data = (await this.loadData()) ?? {};
    data.settings = this.settings;
    await this.saveData(data);
  }

  async persistIndex() {
    const data = (await this.loadData()) ?? {};
    data.index = this.store.serialize();
    await this.saveData(data);
  }
}
