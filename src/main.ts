import { Plugin, Notice, TFile, Modal, App } from "obsidian";
import { LTSettings, DEFAULT_SETTINGS, LTSettingTab } from "./settings";
import { ApiEmbedder } from "./rag/apiEmbedder";
import { VectorStore, type QueryHit } from "./rag/vectorStore";
import { Indexer } from "./rag/indexer";
import { Retriever } from "./rag/retriever";
import { ChatClient } from "./llm/chatClient";
import { Tutor } from "./tutor/tutor";
import { ChatView, VIEW_TYPE_LT_CHAT } from "./ui/chatView";
import { ImageClient } from "./llm/imageClient";

export default class LearningTutorPlugin extends Plugin {
  settings!: LTSettings;
  store!: VectorStore;
  embedder!: ApiEmbedder;
  indexer!: Indexer;
  retriever!: Retriever;
  tutor!: Tutor;
  image!: ImageClient;
  // 按路径防抖「modify → 嵌入」的定时器，避免编辑期间反复触发 modify 反复打嵌入接口
  private modifyTimers = new Map<string, ReturnType<typeof setTimeout>>();

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
    this.embedder = new ApiEmbedder(this.settings);
    this.indexer = new Indexer(this.app, this.embedder, this.store);
    this.retriever = new Retriever(this.embedder, this.store);
    const chatClient = new ChatClient(this.settings);
    this.tutor = new Tutor(this.retriever, chatClient, this.settings);
    this.image = new ImageClient(this.settings);

    this.registerView(VIEW_TYPE_LT_CHAT, (leaf) => new ChatView(leaf, this));
    this.addRibbonIcon("graduation-cap", "学习导师", () => this.activateChatView());
    this.addCommand({
      id: "lt-open-tutor",
      name: "LT: 打开导师",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "lt-reindex",
      name: "LT: 重建索引",
      callback: () => this.indexer.reindexAll(() => this.persistIndex()),
    });

    this.addCommand({
      id: "lt-test-retrieval",
      name: "LT: 测试检索",
      callback: () => new QueryModal(this.app, async (q) => {
        const hits = await this.retriever.retrieve(q, 8);
        new ResultsModal(this.app, q, hits).open();
      }).open(),
    });

    this.registerEvent(this.app.vault.on("modify", (f) => {
      if (f instanceof TFile && f.extension === "md") this.scheduleReindex(f);
    }));
    this.registerEvent(this.app.vault.on("delete", (f) => {
      // 文件在防抖窗口内被删：清掉待嵌入定时器，否则会把已删文件重新嵌回索引
      const t = this.modifyTimers.get(f.path);
      if (t) { clearTimeout(t); this.modifyTimers.delete(f.path); }
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

  // 防抖重嵌：编辑停顿约 2.5s 才嵌入变更文件。失败冒泡为 Notice，不再静默吞掉（旧代码无 catch）。
  private scheduleReindex(file: TFile): void {
    const prev = this.modifyTimers.get(file.path);
    if (prev) clearTimeout(prev);
    this.modifyTimers.set(
      file.path,
      setTimeout(() => {
        this.modifyTimers.delete(file.path);
        this.indexer
          .onModify(file)
          .then(() => this.persistIndex())
          .catch((e) =>
            new Notice(`索引更新失败：${file.path}：${e instanceof Error ? e.message : String(e)}`),
          );
      }, 2500),
    );
  }

  async activateChatView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_LT_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_LT_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
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

// 检索结果弹窗：展示分数 + 路径 + 标题 + 正文片段，便于人工判断检索质量
class ResultsModal extends Modal {
  constructor(app: App, private query: string, private hits: QueryHit[]) { super(app); }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: `检索：${this.query}` });
    if (!this.hits.length) {
      contentEl.createEl("p", { text: "无命中（索引为空？先「LT: 重建索引」）" });
      return;
    }
    this.hits.forEach((h, i) => {
      const div = contentEl.createDiv();
      div.style.margin = "0 0 12px";
      const head = div.createEl("div", {
        text: `${i + 1}. ${h.score.toFixed(3)} · ${h.path}${h.heading ? " › " + h.heading : ""}`,
      });
      head.style.fontWeight = "600";
      const body = div.createEl("div", {
        text: h.text.slice(0, 220) + (h.text.length > 220 ? "…" : ""),
      });
      body.style.opacity = "0.7";
      body.style.fontSize = "0.85em";
      body.style.marginTop = "2px";
    });
  }
  onClose() { this.contentEl.empty(); }
}
