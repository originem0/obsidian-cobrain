import { Plugin, Notice, TFile, TFolder, Modal, App, debounce, Platform, Editor, MarkdownFileInfo, WorkspaceLeaf, requireApiVersion } from "obsidian";
import { CobrainSettings, CobrainSettingTab, normalizeSettingsData } from "./settings";
import { ApiEmbedder } from "./rag/apiEmbedder";
import { VectorStore, type QueryHit } from "./rag/vectorStore";
import { Indexer, shouldIndexPath } from "./rag/indexer";
import { Retriever } from "./rag/retriever";
import { ChatClient } from "./llm/chatClient";
import { Tutor } from "./tutor/tutor";
import { ChatView, VIEW_TYPE_COBRAIN_CHAT } from "./ui/chatView";
import { buildQuote, findHeadingAbove } from "./util/quote";
import { IndexStore } from "./rag/indexStore";
import type { IndexFailure } from "./rag/indexer";
import { parseFolders, type RetrievalScope } from "./rag/scope";
import { SessionStore } from "./chat/sessionStore";
import { newSession, migrateLegacyDrafts, randomId, validSessionId, type ChatSession, type MaterialReference } from "./chat/session";
import { RetrievalModal } from "./ui/retrievalModal";
export type { SavedNoteState, ContextSummaryState } from "./chat/session";

export default class CobrainPlugin extends Plugin {
  settings!: CobrainSettings;
  store!: VectorStore;
  embedder!: ApiEmbedder;
  indexer!: Indexer;
  retriever!: Retriever;
  tutor!: Tutor;
  indexStore!: IndexStore;
  sessions!: SessionStore;
  private lastSessionId: string | null = null;
  private lastDocumentPath: string | null = null;
  private legacyDrafts: unknown;
  private sessionsMigrated = false;
  private legacyDataIndex: unknown;
  private modifyTimers = new Map<string, number>();
  private sessionTimers = new Map<string, { timer: number; session: ChatSession }>();
  private sessionRequests = new Map<string, symbol>();
  private disposed = false;
  private indexReady: Promise<void> | null = null;
  private indexLoaded = false;
  private indexQueue: Promise<void> = Promise.resolve();
  private settingsQueue: Promise<void> = Promise.resolve();
  saveSettingsDebounced = debounce(() => void this.saveSettings().catch(e => this.reportError(e)), 400, true);

  async onload(): Promise<void> {
    await this.loadSettings();
    const base = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    this.sessions = new SessionStore(this.app.vault.adapter, `${base}/sessions`, message => new Notice(message, 10000),
      (session, previousId) => this.sessionChanged(session, previousId), this.deviceId());
    await this.sessions.init();
    if (!this.sessionsMigrated) {
      for (const session of migrateLegacyDrafts(this.legacyDrafts)) {
        if (!this.sessions.has(session.id)) await this.sessions.save(session);
      }
      this.sessionsMigrated = true;
      await this.saveSettings();
    }
    this.addSettingTab(new CobrainSettingTab(this.app, this));
    this.store = new VectorStore();
    this.indexStore = new IndexStore(this.app, this.manifest, this.store);
    this.embedder = new ApiEmbedder(this.settings);
    this.indexer = new Indexer(this.app, this.embedder, this.store, this.settings);
    this.retriever = new Retriever(this.embedder, this.store, this.settings, () => this.whenIndexReady());
    this.tutor = new Tutor(new ChatClient(this.settings), this.settings);

    this.registerView(VIEW_TYPE_COBRAIN_CHAT, leaf => new ChatView(leaf, this));
    // 旧布局类型继续可恢复；以后新建面板统一使用同一类型，会话不再依赖固定槽位。
    for (let i = 1; i <= 3; i++) {
      const type = `${VIEW_TYPE_COBRAIN_CHAT}-${i}`;
      this.registerView(type, leaf => new ChatView(leaf, this, type));
    }
    this.addRibbonIcon("brain", "副脑", () => void this.revealOrOpenChatView().catch(e => this.reportError(e)));
    this.addCommand({ id: "open-tutor", name: "打开副脑", callback: () => void this.revealOrOpenChatView().catch(e => this.reportError(e)) });
    this.addCommand({ id: "new-conversation", name: "新建对话", callback: () => void this.startConversation().catch(e => this.reportError(e)) });
    this.addCommand({ id: "open-new-chat", name: "新开一个对话面板", callback: () => void this.openNewChatView().catch(e => this.reportError(e)) });
    this.addCommand({ id: "reindex", name: "重建允许范围的索引", callback: () => void this.rebuildIndex().catch(e => this.reportError(e)) });
    this.addCommand({ id: "test-retrieval", name: "手动检索资料", callback: () => this.openRetrievalTest() });
    this.addCommand({ id: "index-status", name: "查看索引状态", callback: () => void this.showIndexStatus().catch(e => this.reportError(e)) });
    this.addCommand({ id: "quote-selection", name: "讨论选中文本", editorCallback: (editor, ctx) => void this.quoteSelection(editor, ctx).catch(e => this.reportError(e)) });
    this.registerEvent(this.app.workspace.on("file-open", file => {
      if (file?.extension === "md") this.lastDocumentPath = file.path;
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, ctx) => {
      if (!editor.getSelection().trim()) return;
      menu.addItem(item => item.setTitle("与副脑讨论选文").setIcon("brain")
        .onClick(() => void this.quoteSelection(editor, ctx).catch(e => this.reportError(e))));
    }));
    this.app.workspace.onLayoutReady(() => {
      this.app.workspace.detachLeavesOfType("lt-chat");
      const file = this.app.workspace.getActiveFile();
      if (file?.extension === "md") this.lastDocumentPath = file.path;
      if (!Platform.isMobile) {
        this.registerEvent(this.app.vault.on("create", f => { if (f instanceof TFile && f.extension === "md") this.scheduleReindex(f); }));
      }
    });
    if (!Platform.isMobile) {
      this.registerEvent(this.app.vault.on("modify", f => { if (f instanceof TFile && f.extension === "md") this.scheduleReindex(f); }));
    }
    // 文档改名同步更新会话材料；选区内容仍保留原文快照。移动端也需要维护这些引用。
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (!(file instanceof TFolder) && (!(file instanceof TFile) || file.extension !== "md")) return;
      if (this.lastDocumentPath === oldPath || this.lastDocumentPath?.startsWith(`${oldPath}/`)) {
        this.lastDocumentPath = file.path + this.lastDocumentPath.slice(oldPath.length);
      }
      void this.updateMaterialPaths(oldPath, file.path).catch(e => this.reportError(e));
      if (Platform.isMobile || !this.settings.indexEnabled) return;
      this.clearModifyTimer(oldPath);
      void this.whenIndexReady().then(() => this.enqueueIndexOperation(async () => {
        const oldPaths = this.store.allPaths().filter(path => path === oldPath || path.startsWith(`${oldPath}/`));
        for (const previous of oldPaths) {
          const next = file.path + previous.slice(oldPath.length);
          if (shouldIndexPath(next, this.settings)) {
            this.store.renameFile(previous, next); await this.indexStore.saveFile(next);
          } else this.store.removeFile(previous);
          await this.indexStore.removeFile(previous);
        }
        if (file instanceof TFile && shouldIndexPath(file.path, this.settings) && this.store.getMtime(file.path) === null) this.scheduleReindex(file);
        this.indexer.recordChange(file.path);
      })).catch(e => this.reportError(e));
    }));
    if (!Platform.isMobile) {
      this.registerEvent(this.app.vault.on("delete", f => {
        for (const path of this.modifyTimers.keys()) if (path === f.path || path.startsWith(`${f.path}/`)) this.clearModifyTimer(path);
        if (!this.indexReady) return;
        void this.whenIndexReady().then(() => this.enqueueIndexOperation(async () => {
          for (const path of this.store.allPaths()) {
            if (path !== f.path && !path.startsWith(`${f.path}/`)) continue;
            this.indexer.onDelete(path); await this.indexStore.removeFile(path);
          }
        })).catch(e => this.reportError(e));
      }));
    }
    // 文档对话不加载索引、不请求嵌入；首次明确检索或允许范围内的编辑才延迟加载。
  }

  async loadSettings(): Promise<void> {
    const data: unknown = await this.loadData();
    const normalized = normalizeSettingsData(data);
    this.settings = normalized.settings;
    this.legacyDataIndex = normalized.legacyIndex;
    const raw = data && typeof data === "object" ? data as Record<string, unknown> : {};
    this.legacyDrafts = raw.chatDrafts;
    this.sessionsMigrated = raw.sessionsMigrated === true;
    this.lastSessionId = typeof raw.lastSessionId === "string" ? raw.lastSessionId : null;
  }
  saveSettings(): Promise<void> {
    const run = this.settingsQueue.catch(() => undefined).then(() => this.saveData({
      settings: this.settings, lastSessionId: this.lastSessionId, sessionsMigrated: this.sessionsMigrated,
      // 保留原草稿作为迁移备份，但不再修改或恢复它们；删除新会话不会使旧草稿复活。
      ...(this.legacyDrafts ? { chatDrafts: this.legacyDrafts } : {}),
      ...(this.legacyDataIndex ? { index: this.legacyDataIndex } : {}),
    }));
    this.settingsQueue = run;
    return run;
  }
  // 恢复快照按设备区分，标识存在本机、不随库同步。1.8.7 以前没有这类存储，每次启动使用临时标识：
  // 合并照常，只是重启后找回中断写入的能力退化。
  private deviceId(): string {
    const key = "cobrain-device-id";
    const saved: unknown = requireApiVersion("1.8.7") ? this.app.loadLocalStorage(key) : null;
    if (validSessionId(saved)) return saved;
    const id = randomId("device");
    if (requireApiVersion("1.8.7")) this.app.saveLocalStorage(key, id);
    return id;
  }
  currentDocument(): TFile | null {
    const active = this.app.workspace.getActiveFile();
    if (active?.extension === "md") this.lastDocumentPath = active.path;
    const file = this.lastDocumentPath ? this.app.vault.getAbstractFileByPath(this.lastDocumentPath) : null;
    return file instanceof TFile && file.extension === "md" ? file : null;
  }
  documentReference(file: TFile): MaterialReference {
    return { id: `document:${file.path}`, path: file.path, kind: "document", origin: "unknown" };
  }
  async createSession(): Promise<ChatSession> {
    const file = this.currentDocument();
    const session = newSession(file ? [this.documentReference(file)] : []);
    await this.sessions.save(session);
    return session;
  }
  async initialSession(viewType = VIEW_TYPE_COBRAIN_CHAT): Promise<ChatSession> {
    const legacy = viewType.match(/-(\d+)$/);
    const id = legacy && this.sessions.has(`legacy-${legacy[1]}`) ? `legacy-${legacy[1]}` : this.lastSessionId;
    if (id && this.sessions.has(id)) return this.sessions.get(id);
    const latest = this.sessions.list()[0];
    return latest ? this.sessions.get(latest.id) : this.createSession();
  }
  async rememberSession(id: string): Promise<void> {
    this.lastSessionId = id;
    await this.saveSettings();
  }
  acquireSessionRequest(id: string): (() => void) | null {
    if (this.sessionRequests.has(id)) return null;
    const token = Symbol(id);
    this.sessionRequests.set(id, token);
    return () => {
      // 同步冲突会把活的会话分流到新 ID，请求锁跟随它直到这一轮真正结束。
      for (const [currentId, currentToken] of this.sessionRequests) if (currentToken === token) this.sessionRequests.delete(currentId);
    };
  }
  private sessionChanged(session: ChatSession, previousId: string): void {
    if (session.id !== previousId) {
      const token = this.sessionRequests.get(previousId);
      if (token) { this.sessionRequests.delete(previousId); this.sessionRequests.set(session.id, token); }
      const pending = this.sessionTimers.get(previousId);
      if (pending?.session === session) { window.clearTimeout(pending.timer); this.sessionTimers.delete(previousId); }
      if (this.lastSessionId === previousId) {
        this.lastSessionId = session.id;
        void this.saveSettings().catch(e => this.reportError(e));
      }
    }
    for (const view of this.chatViews()) {
      if (view.sessionId !== session.id) continue;
      if (session.id !== previousId) view.refreshSessionHeader();
      else void view.refreshStoredSession().catch(e => this.reportError(e));
    }
    void Promise.resolve(this.app.workspace.requestSaveLayout()).catch(e => this.reportError(e));
  }
  async persistSession(session: ChatSession, immediate = true): Promise<void> {
    session.updatedAt = Date.now();
    if (session.title === "新对话") {
      const first = session.history.find(m => m.role === "user")?.content.trim();
      if (first) session.title = first.split("\n").find(Boolean)?.replace(/^>\s*/, "").slice(0, 50) || "新对话";
    }
    const pending = this.sessionTimers.get(session.id);
    if (pending) { window.clearTimeout(pending.timer); this.sessionTimers.delete(session.id); }
    if (immediate) await this.sessions.save(session);
    else {
      const id = session.id;
      const timer = window.setTimeout(() => {
        this.sessionTimers.delete(id);
        void this.sessions.save(session).catch(e => this.reportError(e));
      }, 450);
      this.sessionTimers.set(session.id, { timer, session });
    }
  }
  async flushSessions(): Promise<void> {
    for (const { timer, session } of this.sessionTimers.values()) {
      window.clearTimeout(timer);
      await this.sessions.save(session);
    }
    this.sessionTimers.clear();
    await this.sessions.flush();
  }
  async deleteSession(id: string): Promise<void> {
    const views = this.chatViews().filter(view => view.sessionId === id);
    for (const view of views) view.stop();
    await Promise.all(views.map(view => view.waitForCompletion()));
    const pending = this.sessionTimers.get(id);
    if (pending) { window.clearTimeout(pending.timer); this.sessionTimers.delete(id); }
    await this.sessions.delete(id);
    if (this.lastSessionId === id) this.lastSessionId = null;
    await this.saveSettings();
    if (views.length) {
      const latest = this.sessions.list()[0];
      const replacement = latest ? await this.sessions.get(latest.id) : await this.createSession();
      for (const view of views) await view.replaceDeletedSession(id, replacement);
    }
  }
  private chatViews(): ChatView[] {
    const views: ChatView[] = [];
    this.app.workspace.iterateAllLeaves(leaf => { if (leaf.view instanceof ChatView) views.push(leaf.view); });
    return views;
  }
  async openSession(id: string, preferred?: ChatView): Promise<void> {
    const already = this.chatViews().find(v => v.sessionId === id);
    if (already) { await this.app.workspace.revealLeaf(already.leaf); return; }
    const view = preferred ?? this.chatViews()[0];
    if (view) {
      await view.openSession(await this.sessions.get(id));
      await this.app.workspace.revealLeaf(view.leaf);
    } else await this.openLeaf(await this.sessions.get(id));
  }
  async startConversation(preferred?: ChatView): Promise<void> {
    const session = await this.createSession();
    await this.openSession(session.id, preferred);
  }
  async openNewChatView(): Promise<void> {
    const session = await this.createSession();
    if (Platform.isMobile && this.chatViews().length) await this.openSession(session.id, this.chatViews()[0]);
    else await this.openLeaf(session);
  }
  private async openLeaf(session: ChatSession): Promise<WorkspaceLeaf | null> {
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) { new Notice("无法打开侧栏面板"); return null; }
    await leaf.setViewState({ type: VIEW_TYPE_COBRAIN_CHAT, state: { sessionId: session.id }, active: true });
    if (leaf.view instanceof ChatView) await leaf.view.openSession(session);
    await this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
  async revealOrOpenChatView(): Promise<void> {
    const views = this.chatViews();
    const view = views.find(v => v.sessionId === this.lastSessionId) ?? views[0];
    if (view) await this.app.workspace.revealLeaf(view.leaf);
    else await this.openLeaf(await this.initialSession());
  }
  async activateChatView(): Promise<ChatView | null> {
    await this.revealOrOpenChatView();
    return this.chatViews().find(v => v.sessionId === this.lastSessionId) ?? this.chatViews()[0] ?? null;
  }
  private async quoteSelection(editor: Editor, ctx: MarkdownFileInfo): Promise<void> {
    const text = editor.getSelection();
    if (!text.trim() || !ctx.file) return;
    this.lastDocumentPath = ctx.file.path;
    const heading = findHeadingAbove(editor.getValue().split("\n"), editor.getCursor("from").line) ?? undefined;
    const reference: MaterialReference = {
      id: `selection:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      path: ctx.file.path, kind: "selection", origin: "unknown", text, heading,
    };
    const view = await this.activateChatView();
    view?.quoteIntoInput(buildQuote(text, this.app.metadataCache.fileToLinktext(ctx.file, "", true), heading ?? null), reference);
  }
  private async updateMaterialPaths(oldPath: string, path: string): Promise<void> {
    for (const info of this.sessions.list()) {
      const session = await this.sessions.get(info.id);
      let changed = false;
      for (const material of session.materials) {
        if (material.path === oldPath || material.path.startsWith(`${oldPath}/`)) {
          material.path = path + material.path.slice(oldPath.length);
          if (material.kind === "document") material.id = `document:${material.path}`;
          changed = true;
        }
      }
      session.sources = session.sources.map(source => source === oldPath || source.startsWith(`${oldPath}/`) ? path + source.slice(oldPath.length) : source);
      if (changed) await this.persistSession(session);
    }
    for (const view of this.chatViews()) view.refreshSessionHeader();
  }

  chatConfigProblem(): string | null {
    const s = this.settings;
    return !s.llmBaseUrl || !s.llmKey || !s.llmModel ? "请先在设置中配置文本模型的地址、密钥和模型名称。" : null;
  }
  embedConfigProblem(): string | null {
    const s = this.settings;
    return !s.embedBaseUrl || !s.embedKey || !s.embedModel ? "请先在可选资料检索设置中配置嵌入端点。" : null;
  }
  openPluginSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    if (!setting) { new Notice("请在设置 → 第三方插件 → Cobrain 中配置"); return; }
    setting.open(); setting.openTabById(this.manifest.id);
  }
  async whenIndexReady(): Promise<void> {
    if (!this.settings.indexEnabled) return;
    if (!this.indexReady) this.indexReady = this.loadIndex().catch(e => { this.indexReady = null; throw e; });
    await this.indexReady;
  }
  private async loadIndex(): Promise<void> {
    await new Promise<void>(resolve => this.app.workspace.onLayoutReady(resolve));
    if (this.disposed) return;
    const model = await this.indexStore.load({
      legacyDataIndex: this.legacyDataIndex,
      onMigratedLegacyDataIndex: async () => { this.legacyDataIndex = undefined; await this.saveSettings(); },
    });
    if (model && model !== this.settings.embedModel) {
      this.store.deserialize(null);
      if (!Platform.isMobile) await this.indexStore.clearAll();
      new Notice("嵌入模型与索引不一致，已停用旧索引。请在桌面端重建允许范围的索引。");
    }
    for (const path of this.store.allPaths()) {
      if (!shouldIndexPath(path, this.settings) || !(this.app.vault.getAbstractFileByPath(path) instanceof TFile)) this.store.removeFile(path);
    }
    this.indexLoaded = true;
  }
  async indexScopeChanged(): Promise<void> {
    await this.saveSettings();
    if (this.indexReady) {
      await this.indexReady;
      await this.enqueueIndexOperation(async () => {
        for (const path of this.store.allPaths()) {
          if (!shouldIndexPath(path, this.settings)) {
            this.store.removeFile(path);
            if (!Platform.isMobile) await this.indexStore.removeFile(path);
          }
        }
      });
    }
  }
  async resetIndexForEmbedModelChange(): Promise<void> {
    if (this.indexReady) await this.indexReady.catch(() => undefined);
    await this.enqueueIndexOperation(async () => { this.store.deserialize(null); await this.indexStore.clearAll(); });
    this.indexReady = null; this.indexLoaded = false;
  }
  async rebuildIndex(): Promise<void> {
    if (Platform.isMobile) { new Notice("请在桌面端重建索引；文档对话无需索引。 "); return; }
    if (!this.settings.indexEnabled || !parseFolders(this.settings.indexIncludeFolders).length) {
      new Notice("先在高级设置中启用可选索引，并明确填写允许索引的目录。"); return;
    }
    const problem = this.embedConfigProblem();
    if (problem) { new Notice(problem); return; }
    await this.whenIndexReady();
    await this.enqueueIndexOperation(() => this.indexer.reindexAll(this.indexStore, this.settings.embedModel, { force: true }));
  }
  async searchNotes(query: string, scope: RetrievalScope): Promise<QueryHit[]> {
    if (!this.settings.indexEnabled || !parseFolders(this.settings.indexIncludeFolders).length) {
      throw new Error("可选索引尚未启用。请先指定允许目录并在桌面端建立索引；也可以直接添加文档，无需检索。");
    }
    const problem = this.embedConfigProblem();
    if (problem) throw new Error(problem);
    const hits = await this.retriever.retrieve(query, 12, scope);
    return hits.filter(hit => this.app.vault.getAbstractFileByPath(hit.path) instanceof TFile);
  }
  openRetrievalTest(): void { new RetrievalModal(this.app, this).open(); }
  async showIndexStatus(): Promise<void> {
    if (this.settings.indexEnabled) await this.whenIndexReady();
    const status = this.indexer.getStatus();
    new IndexStatusModal(this.app, {
      ...status, indexedFiles: this.store.allPaths().length, chunks: this.store.entryCount(),
      embedModel: this.settings.embedModel || "未配置",
    }).open();
  }
  private scheduleReindex(file: TFile): void {
    if (!shouldIndexPath(file.path, this.settings) || this.embedConfigProblem()) return;
    this.clearModifyTimer(file.path);
    this.modifyTimers.set(file.path, window.setTimeout(() => {
      this.modifyTimers.delete(file.path);
      if (this.disposed || !shouldIndexPath(file.path, this.settings)) return;
      void this.whenIndexReady().then(() => this.enqueueIndexOperation(() => this.indexer.onModify(file, this.indexStore)))
        .catch(e => { this.indexer.recordFailure(file.path, e); this.reportError(e); });
    }, 2500));
  }
  private clearModifyTimer(path: string): void {
    const timer = this.modifyTimers.get(path);
    if (timer) window.clearTimeout(timer);
    this.modifyTimers.delete(path);
  }
  private enqueueIndexOperation<T>(op: () => Promise<T>): Promise<T> {
    const run = this.indexQueue.catch(() => undefined).then(op);
    this.indexQueue = run.then(() => undefined, () => undefined);
    return run;
  }
  reportError(e: unknown): void {
    console.error("Cobrain", e);
    new Notice(e instanceof Error ? e.message : String(e), 8000);
  }
  onunload(): void {
    this.disposed = true;
    this.saveSettingsDebounced.cancel();
    for (const timer of this.modifyTimers.values()) window.clearTimeout(timer);
    this.modifyTimers.clear();
    for (const view of this.chatViews()) view.stop();
    void this.flushSessions().catch(e => this.reportError(e));
    void this.saveSettings().catch(e => this.reportError(e));
  }
}

class IndexStatusModal extends Modal {
  constructor(
    app: App,
    private status: {
      indexedFiles: number;
      chunks: number;
      embedModel: string;
      running: boolean;
      lastChangedAt: number | null;
      lastFullReindexAt: number | null;
      failures: IndexFailure[];
    },
  ) { super(app); }

  onOpen() {
    const { contentEl } = this;
    const fmt = (ts: number | null) => ts ? new Date(ts).toLocaleString() : "本次启动后暂无记录";
    contentEl.createEl("h3", { text: "索引状态" });
    contentEl.createEl("p", {
      text: Platform.isMobile ? "本设备：移动端（只读检索，不写索引）" : "本设备：桌面端（索引写入方）",
    });
    contentEl.createEl("p", { text: `状态：${this.status.running ? "正在索引" : "空闲"}` });
    contentEl.createEl("p", { text: `嵌入模型：${this.status.embedModel}` });
    contentEl.createEl("p", { text: `已索引笔记：${this.status.indexedFiles} 篇` });
    contentEl.createEl("p", { text: `分片数量：${this.status.chunks} 个` });
    contentEl.createEl("p", { text: `最近更新：${fmt(this.status.lastChangedAt)}` });
    contentEl.createEl("p", { text: `最近全量重建：${fmt(this.status.lastFullReindexAt)}` });

    contentEl.createEl("h4", { text: "最近失败" });
    if (!this.status.failures.length) {
      contentEl.createEl("p", { text: "无" });
      return;
    }
    for (const f of this.status.failures.slice(0, 10)) {
      const row = contentEl.createDiv({ cls: "cobrain-index-failure" });
      row.createDiv({ text: `${new Date(f.at).toLocaleString()} · ${f.path}`, cls: "cobrain-index-failure-title" });
      row.createDiv({ text: f.message, cls: "cobrain-index-failure-message" });
    }
  }

  onClose() { this.contentEl.empty(); }
}
