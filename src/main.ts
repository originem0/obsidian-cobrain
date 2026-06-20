import { Plugin, Notice, TFile, Modal, App, debounce, Platform, Editor, MarkdownFileInfo } from "obsidian";
import { CobrainSettings, DEFAULT_SETTINGS, CobrainSettingTab } from "./settings";
import { ApiEmbedder } from "./rag/apiEmbedder";
import { VectorStore, type QueryHit } from "./rag/vectorStore";
import { Indexer } from "./rag/indexer";
import { Retriever } from "./rag/retriever";
import { ChatClient } from "./llm/chatClient";
import { Tutor } from "./tutor/tutor";
import { ChatView, VIEW_TYPE_COBRAIN_CHAT } from "./ui/chatView";
import { ImageClient } from "./llm/imageClient";
import { buildQuote, findHeadingAbove, extractContext } from "./util/quote";
import { IndexStore } from "./rag/indexStore";

export default class CobrainPlugin extends Plugin {
  settings!: CobrainSettings;
  store!: VectorStore;
  embedder!: ApiEmbedder;
  indexer!: Indexer;
  retriever!: Retriever;
  tutor!: Tutor;
  image!: ImageClient;
  indexStore!: IndexStore;
  // 按路径防抖「modify → 嵌入」的定时器，避免编辑期间反复触发 modify 反复打嵌入接口
  private modifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // 设置页逐字符 onChange 走这个防抖版：停顿 400ms 才落盘，避免每键一次写。
  // 索引在 index/ 分片里（见 IndexStore），settings 本身已很小，这里再省掉高频小写入。
  saveSettingsDebounced = debounce(() => void this.saveSettings(), 400, true);
  private disposed = false; // 卸载后置位：阻止已排队的防抖回调在插件卸载后继续写盘
  // 索引加载较重（数百分片 + 上万向量反量化），不放进 onload 关键路径，否则 Obsidian 报「加载耗时过长」。
  // onload 后台启动加载，检索/重嵌前先 await 它，确保不会查到半截索引。
  private indexReady: Promise<void> = Promise.resolve();

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CobrainSettingTab(this.app, this));

    this.store = new VectorStore();
    // 索引从 index/ 分片加载（旧 index.json 会在此一次性迁移为分片）——见下方后台 loadIndex()
    this.indexStore = new IndexStore(this.app, this.manifest, this.store);
    this.embedder = new ApiEmbedder(this.settings);
    this.indexer = new Indexer(this.app, this.embedder, this.store);
    // retriever 检索前会 await indexReady：启动后立刻查询也不会落空
    this.retriever = new Retriever(this.embedder, this.store, () => this.indexReady);
    const chatClient = new ChatClient(this.settings);
    this.tutor = new Tutor(this.retriever, chatClient, this.settings);
    this.image = new ImageClient(this.settings);

    this.registerView(VIEW_TYPE_COBRAIN_CHAT, (leaf) => new ChatView(leaf, this));
    this.app.workspace.onLayoutReady(() => {
      // 改名收尾：清掉旧视图类型 "lt-chat" 残留的孤儿面板（改名后该类型已不再注册）
      this.app.workspace.detachLeavesOfType("lt-chat");
      // 新建笔记自动入索引：放 onLayoutReady 内注册，避开启动时对每个已存文件触发 create 的风暴。
      // 「存为笔记」/模板/同步进来的新笔记走 vault.create → 由此自动入索引（移动端只读，不注册）。
      if (!Platform.isMobile) {
        this.registerEvent(this.app.vault.on("create", (f) => {
          if (f instanceof TFile && f.extension === "md") this.scheduleReindex(f);
        }));
      }
    });
    this.addRibbonIcon("brain", "创作副脑", () => this.activateChatView());
    this.addCommand({
      id: "cobrain-open-tutor",
      name: "Cobrain: 打开创作副脑",
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: "cobrain-reindex",
      name: "Cobrain: 重建索引",
      callback: async () => {
        // 移动端为只读检索：不重建（避免蜂窝网重嵌 + 改写索引引发同步冲突），索引在桌面端建。
        if (Platform.isMobile) { new Notice("移动端为只读检索，索引请在桌面端重建"); return; }
        await this.indexReady; // 别在索引还没加载完时就重建（否则会把所有文件当"新文件"全量重嵌）
        this.indexer.reindexAll(this.indexStore, this.settings.embedModel);
      },
    });

    this.addCommand({
      id: "cobrain-test-retrieval",
      name: "Cobrain: 测试检索",
      callback: () => new QueryModal(this.app, async (q) => {
        const hits = await this.retriever.retrieve(q, 8);
        new ResultsModal(this.app, q, hits).open();
      }).open(),
    });

    this.addCommand({
      id: "cobrain-quote-selection",
      name: "Cobrain: 引用选中文本",
      editorCallback: (editor, ctx) => void this.quoteSelection(editor, ctx),
    });

    // 移动端只读：不注册自动重嵌（否则每改一篇笔记都走蜂窝网打嵌入接口，并重写 10MB 索引引发同步冲突）。
    // 索引只在桌面端建，移动端读同步过来的索引做检索。
    if (!Platform.isMobile) {
      this.registerEvent(this.app.vault.on("modify", (f) => {
        if (f instanceof TFile && f.extension === "md") this.scheduleReindex(f);
      }));
      this.registerEvent(this.app.vault.on("delete", async (f) => {
        await this.indexReady; // 避免与后台加载竞争 store/分片
        // 文件在防抖窗口内被删：清掉待嵌入定时器，否则会把已删文件重新嵌回索引
        const t = this.modifyTimers.get(f.path);
        if (t) { clearTimeout(t); this.modifyTimers.delete(f.path); }
        this.indexer.onDelete(f.path);
        this.indexStore.removeFile(f.path);
      }));
      this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
        // 改名/移动：内容没变，不重嵌——把索引条目改键到新路径，挪分片(删旧分片、写新分片)。
        if (!(file instanceof TFile) || file.extension !== "md") return;
        await this.indexReady; // 改键前确保索引已加载，否则改的是空 store
        const t = this.modifyTimers.get(oldPath);
        if (t) { clearTimeout(t); this.modifyTimers.delete(oldPath); }
        this.store.renameFile(oldPath, file.path);
        this.indexStore.removeFile(oldPath);
        this.indexStore.saveFile(file.path);
      }));
    }

    // 选中文本 → 引用进 Cobrain（右键菜单；仅编辑模式有 editor 时出现，移动端编辑模式同样可用）
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, ctx) => {
      if (!editor.getSelection().trim()) return;
      menu.addItem(item =>
        item.setTitle("引用进 Cobrain").setIcon("brain").onClick(() => void this.quoteSelection(editor, ctx)),
      );
    }));

    // onload 已把视图/命令/事件全部接好，最后才后台启动索引加载——onload 不被它阻塞，告警消失。
    this.indexReady = this.loadIndex();
    console.log("Cobrain loaded");
  }

  // 后台加载索引分片 + 换模型检测。onload 不 await 它（只存其 Promise 供检索/重嵌前 await）。
  private async loadIndex(): Promise<void> {
    // 先等布局就绪：索引加载有 ~130ms 同步主线程工作（解析 + 反量化），别在「打开软件」的启动窗口里抢主线程，
    // 让 Obsidian 先渲染可用，重活儿挪到 app 已经能用之后再做。
    await new Promise<void>(resolve => this.app.workspace.onLayoutReady(resolve));
    if (this.disposed) return;
    const storedModel = await this.indexStore.load();
    if (this.disposed) return; // 加载期间插件被卸载：不再动设置/盘
    if (storedModel && storedModel !== this.settings.embedModel) {
      // 换过嵌入模型 → 维度/空间不兼容，清空待重建
      this.store.deserialize(null);
      await this.indexStore.clearAll();
      new Notice("嵌入模型已变更，旧索引已清空，请重新「Cobrain: 重建索引」");
    }
  }

  onunload() {
    // 清掉所有挂起的防抖重嵌定时器：用的是裸 setTimeout（非 registerInterval），
    // 不主动清的话，插件卸载/更新后回调仍会 fire，对已卸载实例 saveData。
    this.disposed = true;
    for (const t of this.modifyTimers.values()) clearTimeout(t);
    this.modifyTimers.clear();
    console.log("Cobrain unloaded");
  }

  // data.json 现在只存设置；向量索引在 index/ 分片里（见 IndexStore）。
  async loadSettings() {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
  }

  // 只写设置（极小）。索引在 index/ 分片里，与设置彻底解耦。
  async saveSettings() {
    await this.saveData({ settings: this.settings });
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
        // 先 await indexReady：避免索引还没加载完就 onModify，把条目写进半截 store
        this.indexReady
          .then(() => this.indexer.onModify(file))
          .then((changed) => { if (changed) return this.indexStore.saveFile(file.path); })
          .catch((e) =>
            new Notice(`索引更新失败：${file.path}：${e instanceof Error ? e.message : String(e)}`),
          );
      }, 2500),
    );
  }

  async activateChatView(): Promise<ChatView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_COBRAIN_CHAT)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false)!;
      await leaf.setViewState({ type: VIEW_TYPE_COBRAIN_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view instanceof ChatView ? leaf.view : null;
  }

  // 选中文本 → 引用进 Cobrain：取选区 + 来源链接 + 最近标题 + 所在小节，预填进面板（不自动发）。
  private async quoteSelection(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
    const sel = editor.getSelection();
    if (!sel.trim()) { new Notice("先选中一段文字"); return; }
    const file = ctx.file;
    if (!file) { new Notice("无法确定来源文件"); return; }
    const linktext = this.app.metadataCache.fileToLinktext(file, "", true);
    const lines = editor.getValue().split("\n");
    const fromLine = editor.getCursor("from").line;
    const heading = findHeadingAbove(lines, fromLine);
    const sourceContext = extractContext(lines, fromLine);
    const view = await this.activateChatView();
    view?.quoteIntoInput(buildQuote(sel, linktext, heading), sourceContext);
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
