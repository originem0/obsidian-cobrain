import { Plugin, Notice, TFile, Modal, App } from "obsidian";
import { LTSettings, DEFAULT_SETTINGS, LTSettingTab } from "./settings";
import { ApiEmbedder } from "./rag/apiEmbedder";
import { VectorStore } from "./rag/vectorStore";
import { Indexer } from "./rag/indexer";
import { Retriever } from "./rag/retriever";

export default class LearningTutorPlugin extends Plugin {
  settings!: LTSettings;
  store!: VectorStore;
  embedder!: ApiEmbedder;
  indexer!: Indexer;
  retriever!: Retriever;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new LTSettingTab(this.app, this));

    this.store = new VectorStore();
    const data = await this.loadData();
    this.store.deserialize(data?.index ?? null);
    // 嵌入模型变更 → 旧向量维度/空间不兼容，清空待重建
    if (data?.embedModel && data.embedModel !== this.settings.embedModel) {
      this.store.deserialize(null);
      new Notice("嵌入模型已变更，旧索引已清空，请重新「LT: 重建索引」");
    }
    this.embedder = new ApiEmbedder(this.settings.embedBaseUrl, this.settings.embedKey, this.settings.embedModel);
    this.indexer = new Indexer(this.app, this.embedder, this.store);
    this.retriever = new Retriever(this.embedder, this.store);

    this.addCommand({
      id: "lt-reindex",
      name: "LT: 重建索引",
      callback: () => this.indexer.reindexAll(() => this.persistIndex()),
    });

    this.addCommand({
      id: "lt-test-retrieval",
      name: "LT: 测试检索",
      callback: () => new QueryModal(this.app, async (q) => {
        const hits = await this.retriever.retrieve(q);
        console.log("检索结果：", hits);
        new Notice(hits.map(h => `${h.score.toFixed(2)} ${h.path}`).join("\n") || "无命中");
      }).open(),
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
    // 直接整体写入，不再 loadData 读一遍（避免索引增大后每次持久化的 O(n²) I/O）
    // 记录嵌入模型，换模型时据此判断旧索引失效
    await this.saveData({ settings: this.settings, index: this.store.serialize(), embedModel: this.settings.embedModel });
  }

  // 把随插件分发的 patched glue + wasm 所在目录转成 onnxruntime-web 可用的 app:// 前缀。
  // 必须用字符串前缀（而非对象）——ORT 用 wasmPaths 前缀拼 .mjs 文件名；对象形式它只认 .wasm，
  // .mjs 会退回默认 base（app://obsidian.md/）导致 404。
  loadOrtWasmPrefix(): string | undefined {
    const dir = this.manifest.dir;
    if (!dir) return undefined;
    // getResourcePath 返回 app://<hash>/<绝对路径>?<ver>，去掉文件名与查询串得到目录前缀
    const res = this.app.vault.adapter.getResourcePath(`${dir}/ort-wasm-simd-threaded.jsep.wasm`);
    return res.replace(/ort-wasm-simd-threaded\.jsep\.wasm.*$/, "");
  }
}

class QueryModal extends Modal {
  constructor(app: App, private onSubmit: (q: string) => void) { super(app); }
  onOpen() {
    this.contentEl.createEl("h3", { text: "测试检索" });
    const input = this.contentEl.createEl("input", { type: "text" });
    input.style.width = "100%";
    input.focus();
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) { this.close(); this.onSubmit(input.value.trim()); }
    });
  }
  onClose() { this.contentEl.empty(); }
}
