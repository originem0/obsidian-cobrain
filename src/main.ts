import { Plugin, Notice, TFile, Modal, App, normalizePath, debounce } from "obsidian";
import { CobrainSettings, DEFAULT_SETTINGS, CobrainSettingTab } from "./settings";
import { ApiEmbedder } from "./rag/apiEmbedder";
import { VectorStore, type QueryHit } from "./rag/vectorStore";
import { Indexer } from "./rag/indexer";
import { Retriever } from "./rag/retriever";
import { ChatClient } from "./llm/chatClient";
import { Tutor } from "./tutor/tutor";
import { ChatView, VIEW_TYPE_COBRAIN_CHAT } from "./ui/chatView";
import { ImageClient } from "./llm/imageClient";

export default class CobrainPlugin extends Plugin {
  settings!: CobrainSettings;
  store!: VectorStore;
  embedder!: ApiEmbedder;
  indexer!: Indexer;
  retriever!: Retriever;
  tutor!: Tutor;
  image!: ImageClient;
  // 按路径防抖「modify → 嵌入」的定时器，避免编辑期间反复触发 modify 反复打嵌入接口
  private modifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 设置页逐字符 onChange 走这个防抖版：停顿 400ms 才落盘，避免每键一次写。
  // 索引已拆出 data.json（见 persistIndex），settings 本身已很小，这里再省掉高频小写入。
  saveSettingsDebounced = debounce(() => void this.saveSettings(), 400, true);
  private disposed = false; // 卸载后置位：阻止已排队的防抖回调在插件卸载后继续写盘

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CobrainSettingTab(this.app, this));

    this.store = new VectorStore();
    // 索引从独立的 index.json 加载（旧版本塞在 data.json 里的会在此一次性迁移过来）
    await this.loadIndex();
    this.embedder = new ApiEmbedder(this.settings);
    this.indexer = new Indexer(this.app, this.embedder, this.store);
    this.retriever = new Retriever(this.embedder, this.store);
    const chatClient = new ChatClient(this.settings);
    this.tutor = new Tutor(this.retriever, chatClient, this.settings);
    this.image = new ImageClient(this.settings);

    this.registerView(VIEW_TYPE_COBRAIN_CHAT, (leaf) => new ChatView(leaf, this));
    // 改名收尾：清掉旧视图类型 "lt-chat" 残留的孤儿面板（改名后该类型已不再注册）
    this.app.workspace.onLayoutReady(() => this.app.workspace.detachLeavesOfType("lt-chat"));
    this.addRibbonIcon("brain", "创作副脑", () => this.activateChatView());
    this.addCommand({
      id: "cobrain-open-tutor",
      name: "Cobrain: 打开创作副脑",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "cobrain-reindex",
      name: "Cobrain: 重建索引",
      callback: () => this.indexer.reindexAll(() => this.persistIndex()),
    });

    this.addCommand({
      id: "cobrain-test-retrieval",
      name: "Cobrain: 测试检索",
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

    console.log("Cobrain loaded");
  }

  onunload() {
    // 清掉所有挂起的防抖重嵌定时器：用的是裸 setTimeout（非 registerInterval），
    // 不主动清的话，插件卸载/更新后回调仍会 fire，对已卸载实例 saveData。
    this.disposed = true;
    for (const t of this.modifyTimers.values()) clearTimeout(t);
    this.modifyTimers.clear();
    console.log("Cobrain unloaded");
  }

  // data.json 现在只存设置；向量索引已拆到独立的 index.json（见 loadIndex/persistIndex）。
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
  }

  // 只写设置（极小）。索引不再混在 data.json 里，故无需 read-modify-write，也不会与 persistIndex 互踩。
  async saveSettings() {
    await this.saveData({ settings: this.settings });
  }

  // 索引独立持久化到插件目录的 index.json，与 data.json（设置）彻底解耦：
  // 改设置不再重写整份索引，两条写路径也不会再 lost-update 互踩。
  async persistIndex(): Promise<void> {
    const payload = { ...this.store.serialize(), embedModel: this.settings.embedModel };
    await this.app.vault.adapter.write(this.indexPath(), JSON.stringify(payload));
  }

  // 索引文件路径：插件目录下 index.json（manifest.dir 缺省时回退到 configDir 下的标准插件路径）。
  private indexPath(): string {
    const dir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(`${dir}/index.json`);
  }

  // 启动加载索引：优先读 index.json；不存在则尝试从旧版 data.json.index 一次性迁移并剥离。
  private async loadIndex(): Promise<void> {
    // 宽松结构：既能装下 v2 序列化输出，也能装下迁移自旧 data.json.index 的旧格式
    type IndexFile = {
      v?: number;
      entries?: unknown[];
      mtimes?: Record<string, number>;
      hashes?: Record<string, string>;
      embedModel?: string;
    };
    const path = this.indexPath();
    let payload: IndexFile | null = null;
    if (await this.app.vault.adapter.exists(path)) {
      try {
        payload = JSON.parse(await this.app.vault.adapter.read(path));
      } catch (e) {
        console.error("Cobrain: index.json 解析失败，按空索引处理", e);
      }
    } else {
      // 迁移：旧版本把索引塞在 data.json 里。搬到独立文件，并把 index/embedModel 从 data.json 剥掉。
      const data = (await this.loadData()) ?? {};
      if (data.index) {
        payload = { ...data.index, embedModel: data.embedModel };
        await this.app.vault.adapter.write(path, JSON.stringify(payload));
        delete data.index;
        delete data.embedModel;
        await this.saveData(data);
        console.log("Cobrain: 已把旧索引从 data.json 迁移到 index.json");
      }
    }
    this.store.deserialize(payload ?? null);
    // 换嵌入模型 → 维度/空间不兼容，清空待重建
    if (payload?.embedModel && payload.embedModel !== this.settings.embedModel) {
      this.store.deserialize(null);
      new Notice("嵌入模型已变更，旧索引已清空，请重新「Cobrain: 重建索引」");
    }
  }

  // 防抖重嵌：编辑停顿约 2.5s 才嵌入变更文件。失败冒泡为 Notice，不再静默吞掉（旧代码无 catch）。
  private scheduleReindex(file: TFile): void {
    const prev = this.modifyTimers.get(file.path);
    if (prev) clearTimeout(prev);
    this.modifyTimers.set(
      file.path,
      setTimeout(() => {
        this.modifyTimers.delete(file.path);
        if (this.disposed) return; // 卸载后不再写盘
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
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_COBRAIN_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_COBRAIN_CHAT, active: true });
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
      contentEl.createEl("p", { text: "无命中（索引为空？先「Cobrain: 重建索引」）" });
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
