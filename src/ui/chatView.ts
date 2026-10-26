import { Component, ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, Menu, Platform, setIcon } from "obsidian";
import type { ViewStateResult } from "obsidian";
import type CobrainPlugin from "../main";
import type { ChatSession, MaterialReference } from "../chat/session";
import { conversationMarkdown } from "../chat/session";
import { readMaterials } from "../chat/materials";
import type { ContextOpts } from "../tutor/tutor";
import { fnv1a } from "../util/hash";
import { extractMermaid } from "../util/mermaid";
import { makeCancellable, CancelledError } from "../util/cancellable";
import { saveNote, saveConversation } from "../noteWriter";
import { askConfirm, askPrompt, askSaveOptions } from "./modals";
import { SessionPicker, MaterialModal } from "./sessionModals";
import { RetrievalModal } from "./retrievalModal";

export const VIEW_TYPE_COBRAIN_CHAT = "cobrain-chat";
export function shouldSendOnEnter(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing" | "keyCode">, mobile: boolean, composing = false): boolean {
  return event.key === "Enter" && !event.isComposing && !composing && event.keyCode !== 229
    && !event.shiftKey && (!mobile || event.ctrlKey || event.metaKey);
}
export function nearBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 72;
}
export function sessionSignature(session: ChatSession): string {
  return fnv1a(JSON.stringify({ history: session.history, materials: session.materials, mermaid: session.lastMermaid }));
}

export class ChatView extends ItemView {
  private session: ChatSession | null = null;
  private messagesEl!: HTMLElement;
  private olderBtn!: HTMLButtonElement;
  private titleEl!: HTMLElement;
  private materialBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private bottomBtn!: HTMLButtonElement;
  private composing = false;
  private sending = false;
  private switchTicket = 0;
  private busy = false;
  private closed = false;
  private generation = 0;
  private renderedFrom = 0;
  private following = true;
  private currentAbort: AbortController | null = null;
  private currentCancel: (() => void) | null = null;
  private currentTask: Promise<void> | null = null;
  private renderers = new Map<HTMLElement, Component>();

  constructor(leaf: WorkspaceLeaf, private plugin: CobrainPlugin, private viewType = VIEW_TYPE_COBRAIN_CHAT) { super(leaf); }
  get sessionId(): string | null { return this.session?.id ?? null; }
  getViewType(): string { return this.viewType; }
  getDisplayText(): string { return this.session?.title ?? "副脑"; }
  getIcon(): string { return "brain"; }
  getState(): Record<string, unknown> { return { sessionId: this.sessionId }; }
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const id = state && typeof state === "object" && "sessionId" in state ? state.sessionId : null;
    const session = typeof id === "string" && this.plugin.sessions.has(id)
      ? await this.plugin.sessions.get(id) : await this.plugin.initialSession(this.viewType);
    await this.openSession(session);
    await super.setState(state, result);
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    const root = this.contentEl;
    root.empty(); root.addClass("cobrain-root");
    const header = root.createDiv({ cls: "cobrain-header" });
    this.titleEl = header.createDiv({ cls: "cobrain-title", text: "副脑" });
    const history = this.iconButton(header, "history", "历史会话");
    history.onclick = () => new SessionPicker(this.app, this.plugin, id => this.ui(() => this.plugin.openSession(id, this))).open();
    const fresh = this.iconButton(header, "plus", "新建对话");
    fresh.onclick = () => this.ui(() => this.plugin.startConversation(this));
    const more = this.iconButton(header, "more-horizontal", "更多操作");
    more.onclick = event => this.showMenu(event);
    const scope = root.createDiv({ cls: "cobrain-scope" });
    this.materialBtn = scope.createEl("button", { cls: "cobrain-scope-button", text: "选择讨论文档" });
    this.materialBtn.onclick = () => this.editMaterials();
    const area = root.createDiv({ cls: "cobrain-reading-area" });
    this.messagesEl = area.createDiv({ cls: "cobrain-messages", attr: { role: "log", "aria-label": "对话记录" } });
    this.messagesEl.onscroll = () => {
      this.following = nearBottom(this.messagesEl);
      this.bottomBtn.hidden = this.following;
    };
    this.bottomBtn = area.createEl("button", { text: "回到最新", cls: "cobrain-jump-bottom" });
    this.bottomBtn.hidden = true;
    this.bottomBtn.onclick = () => this.scrollToBottom();
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => { if (this.following && !this.closed) this.scrollToBottom(); });
      observer.observe(this.messagesEl);
      this.register(() => observer.disconnect());
    }
    this.statusEl = root.createDiv({ cls: "cobrain-status", attr: { "aria-live": "polite" } });
    this.statusEl.hidden = true;
    const composer = root.createDiv({ cls: "cobrain-composer" });
    this.inputEl = composer.createEl("textarea", { cls: "cobrain-input", attr: {
      rows: "1", placeholder: "围绕这些材料继续聊…", "aria-label": "发给副脑的消息", name: "cobrain-message", autocomplete: "off",
    } });
    this.sendBtn = composer.createEl("button", { text: "发送", cls: "cobrain-send mod-cta" });
    this.sendBtn.onclick = () => this.busy ? this.stop() : this.ui(() => this.send());
    this.inputEl.oninput = () => {
      this.autoGrow();
      if (this.session) { this.session.composer = this.inputEl.value; this.ui(() => this.plugin.persistSession(this.session!, false)); }
    };
    this.inputEl.addEventListener("compositionstart", () => { this.composing = true; });
    this.inputEl.addEventListener("compositionend", () => { this.composing = false; });
    this.inputEl.onkeydown = event => {
      if (shouldSendOnEnter(event, Platform.isMobile, this.composing)) {
        event.preventDefault(); if (!this.busy) this.ui(() => this.send());
      }
    };
  }
  private iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "cobrain-icon-button" });
    button.setAttribute("aria-label", label); button.title = label; setIcon(button, icon);
    if (!button.querySelector("svg") && !button.textContent) button.textContent = icon === "plus" ? "+" : icon === "history" ? "历史" : "⋯";
    return button;
  }
  private ui(action: () => Promise<unknown>): void { void action().catch(e => this.plugin.reportError(e)); }
  async openSession(session: ChatSession): Promise<void> {
    if (this.session?.id === session.id || this.closed) return;
    const ticket = ++this.switchTicket;
    this.stop();
    if (this.currentTask) await this.currentTask;
    if (this.session) await this.plugin.persistSession(this.session);
    if (ticket !== this.switchTicket || this.closed) return;
    this.generation++;
    this.session = session;
    this.inputEl.value = session.composer;
    this.setStatus(""); this.autoGrow(); this.refreshSessionHeader();
    await this.renderHistory();
    if (ticket !== this.switchTicket || this.closed) return;
    await this.plugin.rememberSession(session.id);
    this.app.workspace.requestSaveLayout();
    this.scrollToBottom();
  }
  refreshSessionHeader(): void {
    if (!this.session || !this.titleEl) return;
    this.titleEl.setText(this.session.title); this.titleEl.title = this.session.title;
    const materials = this.session.materials;
    const first = materials[0];
    const name = first?.path.split("/").pop()?.replace(/\.md$/i, "");
    const label = !first ? "未附加文档 · 仅聊天内容"
      : `${first.kind === "selection" ? "选文" : "文档"} · ${name}${materials.length > 1 ? ` 等 ${materials.length} 项` : ""}`;
    this.materialBtn.setText(label);
    this.materialBtn.title = `${materials.map(m => m.path).join("\n") || "添加文档，无需索引"}\n点击管理本会话范围`;
    this.materialBtn.setAttribute("aria-label", `管理讨论范围，${label}`);
  }
  async refreshStoredSession(): Promise<void> {
    if (this.closed || !this.session) return;
    this.refreshSessionHeader();
    if (this.busy || this.sending) return;
    const top = this.messagesEl.scrollTop, following = this.following;
    this.inputEl.value = this.session.composer; this.autoGrow();
    await this.renderHistory();
    if (following) this.scrollToBottom(); else this.messagesEl.scrollTop = top;
  }
  private editMaterials(): void {
    if (!this.session || this.busy || this.sending) return;
    new MaterialModal(this.app, this.plugin, this.session, () => {
      this.refreshSessionHeader(); this.ui(() => this.plugin.persistSession(this.session!));
    }).open();
  }
  quoteIntoInput(text: string, reference: MaterialReference): void {
    if (!this.session) return;
    // 明确选文后以选区替换同篇全文引用，避免用户只想讨论一句话却把整篇当默认材料。
    this.session.materials = this.session.materials.filter(m => !(m.path === reference.path && m.kind === "document"));
    this.session.materials.push(reference);
    this.inputEl.value = text + this.inputEl.value;
    this.session.composer = this.inputEl.value;
    this.refreshSessionHeader(); this.autoGrow(); this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
    this.ui(() => this.plugin.persistSession(this.session!));
  }
  private showMenu(event: MouseEvent): void {
    const session = this.session;
    if (!session) return;
    const menu = new Menu();
    const add = (title: string, icon: string, action: () => Promise<unknown>, disabled = false) => {
      menu.addItem(item => item.setTitle(title).setIcon(icon).setDisabled(disabled).onClick(() => this.ui(action)));
    };
    add("整理为笔记", "file-plus", () => this.saveAsNote(), this.busy || !session.history.length);
    add("导出完整会话", "download", () => this.exportConversation(), !session.history.length);
    menu.addSeparator();
    menu.addItem(item => item.setTitle("手动查找其它资料").setIcon("search").setDisabled(this.busy).onClick(() => {
      new RetrievalModal(this.app, this.plugin, references => {
        for (const ref of references) if (!session.materials.some(m => m.id === ref.id)) session.materials.push(ref);
        this.refreshSessionHeader(); this.ui(() => this.plugin.persistSession(session));
      }).open();
    }));
    add("推敲观点", "scan-search", () => this.startResponse("critique"), this.busy || !session.history.length);
    add("生成概念图", "network", () => this.startResponse("concept"), this.busy || !session.history.length);
    menu.addSeparator();
    add("重命名会话", "pencil", async () => {
      const title = await askPrompt(this.app, "会话名称", session.title);
      if (title) { session.title = title; this.refreshSessionHeader(); await this.plugin.persistSession(session); }
    });
    if (!Platform.isMobile) add("新开对话面板", "panel-right-open", () => this.plugin.openNewChatView());
    menu.addItem(item => item.setTitle("设置").setIcon("settings").onClick(() => this.plugin.openPluginSettings()));
    menu.addSeparator();
    add("删除当前会话", "trash", async () => {
      if (!await askConfirm(this.app, "删除这段会话", "会删除这段会话的完整记录，已导出的笔记会保留。", "删除会话")) return;
      this.stop(); if (this.currentTask) await this.currentTask;
      await this.plugin.deleteSession(session.id);
    });
    menu.showAtMouseEvent(event);
  }
  private autoGrow(): void {
    this.inputEl.addClass("cobrain-input-measuring");
    const height = this.inputEl.scrollHeight + 2;
    this.inputEl.removeClass("cobrain-input-measuring");
    this.inputEl.setCssProps({ "--cobrain-input-height": `${height}px` });
  }
  private setStatus(text: string): void {
    if (this.closed) return;
    this.statusEl.setText(text); this.statusEl.title = text; this.statusEl.hidden = !text;
  }
  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.closed) return;
    this.sendBtn.setText(busy ? "停止" : "发送");
    this.sendBtn.setAttribute("aria-label", busy ? "停止当前回答" : "发送消息");
    this.materialBtn.disabled = busy;
    // 保留输入能力，手机键盘不会因禁用输入框反复收起，也可以在等待时起草下一问。
  }
  private scrollToBottom(): void {
    this.following = true;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    this.bottomBtn.hidden = true;
  }
  private clearMessages(): void {
    for (const component of this.renderers.values()) this.removeChild(component);
    this.renderers.clear(); this.messagesEl.empty();
  }
  private async renderAssistant(body: HTMLElement, text: string): Promise<void> {
    const previous = this.renderers.get(body);
    if (previous) this.removeChild(previous);
    const component = new Component(); this.addChild(component); this.renderers.set(body, component);
    body.empty(); await MarkdownRenderer.render(this.app, text, body, "", component);
  }
  private async bubble(role: "user" | "assistant", text: string, index?: number): Promise<HTMLElement> {
    const el = this.messagesEl.createDiv({ cls: `cobrain-bubble cobrain-bubble-${role}` });
    if (index !== undefined) el.dataset.historyIndex = String(index);
    const who = el.createDiv({ cls: "cobrain-who" });
    who.createSpan({ text: role === "user" ? "我" : "副脑" });
    const copy = who.createEl("button", { cls: "cobrain-copy", text: "复制" });
    copy.setAttribute("aria-label", `复制这条${role === "user" ? "提问" : "回答"}`);
    copy.onclick = () => this.ui(async () => { await navigator.clipboard.writeText(text); new Notice("已复制"); });
    const body = el.createDiv({ cls: "cobrain-body" });
    if (role === "assistant") await this.renderAssistant(body, text); else body.setText(text);
    return el;
  }
  private async renderHistory(): Promise<void> {
    if (!this.session) return;
    const gen = this.generation;
    this.clearMessages();
    this.olderBtn = this.messagesEl.createEl("button", { cls: "cobrain-load-older" });
    this.renderedFrom = Math.max(0, this.session.history.length - 60);
    this.updateOlderButton();
    this.olderBtn.onclick = () => this.ui(() => this.loadOlder());
    if (!this.session.history.length) {
      const empty = this.messagesEl.createDiv({ cls: "cobrain-empty" });
      empty.createDiv({ text: "从正在读的这一篇开始", cls: "cobrain-empty-title" });
      empty.createEl("p", { text: this.session.materials.length ? "文档已附加。可以解释一个概念，追问一段论证，或沿着一个问题往下想。" : "添加一篇文档，或直接开始对话。" });
      if (this.plugin.chatConfigProblem()) empty.createEl("button", { text: "配置文本模型" }).onclick = () => this.plugin.openPluginSettings();
    }
    for (let i = this.renderedFrom; i < this.session.history.length; i++) {
      if (gen !== this.generation || this.closed) return;
      const message = this.session.history[i];
      await this.bubble(message.role as "user" | "assistant", message.content, i);
    }
    if (this.session.history[this.session.history.length - 1]?.role === "user") this.retryLine("上次提问尚未完成，可以继续回答。");
  }
  private updateOlderButton(): void {
    this.olderBtn.hidden = this.renderedFrom === 0;
    this.olderBtn.setText(`显示更早的记录（还有 ${this.renderedFrom} 条）`);
  }
  private async loadOlder(): Promise<void> {
    if (!this.session || !this.renderedFrom) return;
    this.olderBtn.disabled = true;
    const gen = this.generation, before = this.messagesEl.scrollHeight, top = this.messagesEl.scrollTop;
    const from = Math.max(0, this.renderedFrom - 40);
    const anchor = this.olderBtn.nextSibling;
    for (let i = from; i < this.renderedFrom; i++) {
      const message = this.session.history[i];
      const el = await this.bubble(message.role as "user" | "assistant", message.content, i);
      if (gen !== this.generation) return;
      this.messagesEl.insertBefore(el, anchor);
    }
    this.renderedFrom = from; this.updateOlderButton(); this.olderBtn.disabled = false;
    this.messagesEl.scrollTop = top + this.messagesEl.scrollHeight - before;
  }
  private trimRendered(): void {
    const elements = this.messagesEl.querySelectorAll<HTMLElement>("[data-history-index]");
    if (elements.length <= 100 || !this.following) return;
    for (const el of Array.from(elements).slice(0, elements.length - 60)) {
      const body = el.querySelector<HTMLElement>(".cobrain-body");
      const renderer = body ? this.renderers.get(body) : null;
      if (renderer) { this.removeChild(renderer); this.renderers.delete(body!); }
      this.renderedFrom = Math.max(this.renderedFrom, Number(el.dataset.historyIndex) + 1); el.remove();
    }
    this.updateOlderButton();
  }
  private async send(): Promise<void> {
    if (!this.session || this.busy || this.sending) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    const problem = this.plugin.chatConfigProblem();
    if (problem) { new Notice(problem); return; }
    const release = this.plugin.acquireSessionRequest(this.session.id);
    if (!release) { new Notice("这段会话正在另一个面板中回答，请稍后继续。"); return; }
    this.sending = true;
    try {
      this.messagesEl.querySelectorAll(".cobrain-empty, .cobrain-retry").forEach(el => el.remove());
      this.session.history.push({ role: "user", content: text });
      this.session.composer = ""; this.inputEl.value = ""; this.autoGrow();
      await this.bubble("user", text, this.session.history.length - 1);
      this.scrollToBottom();
      await this.startResponse("ask", release);
    } finally { this.sending = false; release(); }
  }
  private async startResponse(kind: "ask" | "critique" | "concept", ownedRelease?: () => void): Promise<void> {
    if (!this.session || this.busy) return;
    const problem = this.plugin.chatConfigProblem();
    if (problem) { new Notice(problem); return; }
    const release = ownedRelease ?? this.plugin.acquireSessionRequest(this.session.id);
    if (!release) { new Notice("这段会话正在另一个面板中回答，请稍后继续。"); return; }
    const task = this.respond(kind);
    this.currentTask = task;
    try { await task; } finally { release(); if (this.currentTask === task) this.currentTask = null; }
  }
  private async respond(kind: "ask" | "critique" | "concept"): Promise<void> {
    const session = this.session!;
    const gen = this.generation;
    const abort = new AbortController(); this.currentAbort = abort; this.setBusy(true);
    this.messagesEl.querySelectorAll(".cobrain-retry").forEach(el => el.remove());
    const snapshot = session.history.map(m => ({ ...m }));
    const references = session.materials.map(m => ({ ...m }));
    const active = () => !this.closed && gen === this.generation && this.session?.id === session.id;
    let streamed = "", settled = false, committed = false;
    const el = this.messagesEl.createDiv({ cls: "cobrain-bubble cobrain-bubble-assistant" });
    const who = el.createDiv({ cls: "cobrain-who", text: "副脑" });
    const body = el.createDiv({ cls: "cobrain-body cobrain-stream", text: "思考中…" });
    const copy = who.createEl("button", { text: "复制", cls: "cobrain-copy" });
    copy.setAttribute("aria-label", "复制这条回答");
    copy.onclick = () => this.ui(async () => { await navigator.clipboard.writeText(streamed); new Notice("已复制"); });
    if (this.following) this.scrollToBottom();
    const finish = async (text: string) => {
      if (!active()) return;
      body.removeClass("cobrain-stream");
      await this.renderAssistant(body, text);
      if (this.following) this.scrollToBottom();
    };
    try {
      await this.plugin.persistSession(session);
      this.refreshSessionHeader();
      const work = async () => {
        const documents = await readMaterials(this.app, references);
        if (abort.signal.aborted) throw new CancelledError();
        const opts: ContextOpts = {
          documents, summary: session.contextSummary, signal: abort.signal,
          onDelta: delta => {
            if (settled || !active()) return;
            streamed += delta; body.setText(streamed);
            if (this.following) this.scrollToBottom();
          },
          onSummary: summary => {
            if (settled || abort.signal.aborted || !active()) return;
            session.contextSummary = summary;
          },
          onStatus: text => { if (!settled && active() && !streamed) body.setText(text); },
          onPrepared: info => {
            if (settled || !active()) return;
            const parts = [
              ...(info.excerpted.length ? [`${info.excerpted.length} 篇长文使用文内节选`] : []),
              ...(info.summarizedCount ? [`较早 ${info.summarizedCount} 条已整理，完整记录保留`] : []),
            ];
            this.setStatus(parts.join(" · "));
          },
        };
        if (kind === "ask") {
          const latest = snapshot[snapshot.length - 1];
          const result = await this.plugin.tutor.ask(snapshot.slice(0, -1), latest.content, opts);
          return { text: result.reply, sources: result.sources };
        }
        const text = kind === "critique" ? await this.plugin.tutor.critique(snapshot, opts) : await this.plugin.tutor.conceptMap(snapshot, opts);
        return { text, sources: references.map(r => r.path) };
      };
      const cancellable = makeCancellable(work()); this.currentCancel = cancellable.cancel;
      const result = await cancellable.result;
      settled = true; streamed = result.text;
      session.history.push({ role: "assistant", content: result.text });
      committed = true;
      for (const path of result.sources) if (!session.sources.includes(path)) session.sources.push(path);
      if (kind === "concept") session.lastMermaid = extractMermaid(result.text);
      el.dataset.historyIndex = String(session.history.length - 1);
      await this.plugin.persistSession(session);
      await finish(result.text);
    } catch (error) {
      settled = true;
      if (streamed.trim() && !committed) {
        session.history.push({ role: "assistant", content: streamed });
        for (const reference of references) if (!session.sources.includes(reference.path)) session.sources.push(reference.path);
        el.dataset.historyIndex = String(session.history.length - 1);
        await finish(streamed);
      } else if (committed && streamed.trim()) await finish(streamed);
      else el.remove();
      await this.plugin.persistSession(session).catch(e => this.plugin.reportError(e));
      if (active()) {
        const stopped = abort.signal.aborted || error instanceof CancelledError;
        const message = stopped ? "已停止，已有内容已保存。" : error instanceof Error ? error.message : String(error);
        if (kind === "ask" && !streamed.trim()) this.retryLine(message);
        else this.setStatus(message);
      }
    } finally {
      this.currentAbort = null; this.currentCancel = null; this.setBusy(false);
      this.trimRendered();
      // 回答结束不主动聚焦输入框，不抢移动端键盘，也不打断往回阅读。
    }
  }
  private retryLine(message: string): void {
    const row = this.messagesEl.createDiv({ cls: "cobrain-retry", attr: { role: "status" } });
    row.createSpan({ text: message });
    row.createEl("button", { text: "继续回答" }).onclick = () => this.ui(() => this.startResponse("ask"));
  }
  stop(): void { this.currentAbort?.abort(); this.currentCancel?.(); }
  async waitForCompletion(): Promise<void> { if (this.currentTask) await this.currentTask; }
  async replaceDeletedSession(id: string, replacement: ChatSession): Promise<void> {
    if (this.session?.id !== id) return;
    this.session = null;
    await this.openSession(replacement);
  }
  private async saveAsNote(): Promise<void> {
    if (!this.session || !this.session.history.length || this.busy) return;
    const current = this.session;
    const snapshot = JSON.parse(JSON.stringify(current)) as ChatSession;
    const signature = sessionSignature(snapshot);
    if (current.lastSavedNote?.stateSignature === signature) {
      await this.app.workspace.openLinkText(current.lastSavedNote.path, ""); return;
    }
    const abort = new AbortController(); this.currentAbort = abort; this.setBusy(true); this.setStatus("正在整理为笔记…");
    const work = async () => {
      const documents = await readMaterials(this.app, snapshot.materials);
      if (abort.signal.aborted) throw new CancelledError();
      return this.plugin.tutor.summarizeNote(snapshot.history, {
        documents, summary: snapshot.contextSummary, signal: abort.signal,
        onSummary: summary => { if (!abort.signal.aborted) current.contextSummary = summary; },
      });
    };
    const cancellable = makeCancellable(work()); this.currentCancel = cancellable.cancel;
    const task = cancellable.result.then(() => undefined, () => undefined); this.currentTask = task;
    let note: { title: string; body: string };
    try { note = await cancellable.result; }
    catch (e) { if (!abort.signal.aborted && !(e instanceof CancelledError)) this.plugin.reportError(e); return; }
    finally {
      if (this.currentTask === task) this.currentTask = null;
      if (this.currentAbort === abort) { this.currentAbort = null; this.currentCancel = null; this.setBusy(false); this.setStatus(""); }
    }
    if (abort.signal.aborted || this.closed) return;
    // 只把请求计入在途任务；编辑预览弹窗不占住会话切换或关闭。保存始终使用冻结快照。
    const options = await askSaveOptions(this.app, note.title, note.body, this.plugin.settings.appendConversation);
    if (!options) return;
    const path = await saveNote(this.app, this.plugin.settings, {
      title: options.title, body: options.body,
      sources: [...new Set([...snapshot.sources, ...snapshot.materials.map(m => m.path)])],
      mermaid: snapshot.lastMermaid,
      conversation: options.append ? snapshot.history.filter(m => m.role === "user").map(m => `**我**\n\n${m.content}`).join("\n\n") : null,
    });
    if (this.plugin.sessions.has(current.id)) {
      current.lastSavedNote = { stateSignature: signature, path, savedAt: Date.now() };
      await this.plugin.persistSession(current);
    }
    new Notice(`已保存笔记：${path}`);
  }
  private async exportConversation(): Promise<void> {
    if (!this.session) return;
    const snapshot = JSON.parse(JSON.stringify(this.session)) as ChatSession;
    const path = await saveConversation(this.app, this.plugin.settings, snapshot.title, conversationMarkdown(snapshot));
    new Notice(`完整会话已导出：${path}`);
  }
  async onClose(): Promise<void> {
    this.closed = true; this.stop();
    if (this.currentTask) await this.currentTask;
    if (this.session) await this.plugin.persistSession(this.session);
    this.generation++; this.clearMessages(); this.contentEl.empty();
  }
}
