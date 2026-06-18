import { Plugin, Notice, TFile, Modal, App } from "obsidian";
import { LTSettings, DEFAULT_SETTINGS, LTSettingTab } from "./settings";
import { LocalEmbedder } from "./rag/localEmbedder";
import { VectorStore } from "./rag/vectorStore";
import { Indexer } from "./rag/indexer";
import { Retriever } from "./rag/retriever";

export default class LearningTutorPlugin extends Plugin {
  settings!: LTSettings;
  store!: VectorStore;
  embedder!: LocalEmbedder;
  indexer!: Indexer;
  retriever!: Retriever;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new LTSettingTab(this.app, this));

    this.store = new VectorStore();
    const data = await this.loadData();
    this.store.deserialize(data?.index ?? null);
    this.embedder = new LocalEmbedder(this.settings.embedModel, true, await this.loadOrtWasmPaths());
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
    const data = (await this.loadData()) ?? {};
    data.index = this.store.serialize();
    await this.saveData(data);
  }

  // 读取随插件分发的 patched onnxruntime-web glue + wasm，做成 blob URL 喂给 onnxruntime-web，
  // 杜绝其从 CDN 取多线程 glue（会 import worker_threads，在渲染进程解析失败）。
  async loadOrtWasmPaths(): Promise<Record<string, string> | undefined> {
    try {
      const dir = this.manifest.dir;
      if (!dir) return undefined;
      const glueText = await this.app.vault.adapter.read(`${dir}/ort-wasm-simd-threaded.jsep.mjs`);
      const wasmBin = await this.app.vault.adapter.readBinary(`${dir}/ort-wasm-simd-threaded.jsep.wasm`);
      const glueUrl = URL.createObjectURL(new Blob([glueText], { type: "text/javascript" }));
      const wasmUrl = URL.createObjectURL(new Blob([wasmBin], { type: "application/wasm" }));
      return {
        "ort-wasm-simd-threaded.jsep.mjs": glueUrl,
        "ort-wasm-simd-threaded.jsep.wasm": wasmUrl,
      };
    } catch (e) {
      console.error("Learning Tutor: 本地 ort wasm 资源加载失败，回退默认", e);
      return undefined;
    }
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
