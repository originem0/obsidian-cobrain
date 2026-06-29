import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, Modal, App, TFile, Menu, normalizePath } from "obsidian";
import type { ChatMsg } from "../llm/chatClient";
import type { QueryHit } from "../rag/vectorStore";
import { saveNote, saveImage } from "../noteWriter";
import { extractMermaid } from "../util/mermaid";
import { fnv1a } from "../util/hash";
import type CobrainPlugin from "../main";
import type { SavedNoteState } from "../main";

export const VIEW_TYPE_COBRAIN_CHAT = "cobrain-chat";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const CHAT_CONTEXT_MSG_LIMIT = 20;

export function chatStateSignature(
  history: ChatMsg[],
  sources: string[],
  mermaid: string | null,
  imageEmbed: string | null,
): string {
  return fnv1a(JSON.stringify({
    history,
    sources: [...sources].sort(),
    mermaid,
    imageEmbed,
  }));
}

export function chatHistoryForModel(history: ChatMsg[]): ChatMsg[] {
  return history.slice(-CHAT_CONTEXT_MSG_LIMIT);
}

export function chatContextLimitText(historyLength: number): string | null {
  if (historyLength <= CHAT_CONTEXT_MSG_LIMIT) return null;
  return `更早的 ${historyLength - CHAT_CONTEXT_MSG_LIMIT} 条消息已保存在草稿里，但本轮不会发给模型。`;
}

// 带秒数计时的等待气泡：创建即开始计时，stop() 清计时器并移除气泡。
// 把「思考中」从不可观测的等待变成可观测的等待——用户知道副脑在跑、跑了多久。
function thinkingBubble(parent: HTMLElement, label: string): { el: HTMLElement; stop: () => void } {
  const el = parent.createDiv({ cls: "cobrain-bubble cobrain-bubble-ai" });
  el.createDiv({ cls: "cobrain-who", text: "副脑" });
  const body = el.createDiv();
  const labelSpan = body.createSpan({ text: label });
  const secSpan = body.createSpan({ text: " 0s", cls: "cobrain-timer" });
  secSpan.setCssStyles({ opacity: "0.6", fontSize: "0.9em" });
  const start = Date.now();
  const timer = window.setInterval(() => {
    secSpan.setText(" " + Math.floor((Date.now() - start) / 1000) + "s");
  }, 1000);
  parent.scrollTop = parent.scrollHeight;
  return {
    el,
    stop: () => { window.clearInterval(timer); el.remove(); },
  };
}

// 带秒数计时的 Notice：用于构思配图主题/扩写提示词/整理笔记等不在气泡里展示的等待。
function timedNotice(label: string): { notice: Notice; stop: () => void } {
  const start = Date.now();
  const notice = new Notice(`${label} 0s`, 0);
  const timer = window.setInterval(() => {
    notice.setMessage(`${label} ${Math.floor((Date.now() - start) / 1000)}s`);
  }, 1000);
  return { notice, stop: () => { window.clearInterval(timer); notice.hide(); } };
}

// 把回调式 Modal 包成 Promise，便于在配图/存笔记里线性 await。关闭未提交 → resolve 空值。
function askPrompt(app: App, title: string, initial: string): Promise<string | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    const m = new PromptModal(app, title, initial, v => finish(v || null));
    const close = m.onClose.bind(m);
    m.onClose = () => { close(); finish(null); };
    m.open();
  });
}
function askTextArea(app: App, title: string, initial: string): Promise<string | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: string | null) => { if (!done) { done = true; resolve(v); } };
    const m = new TextAreaModal(app, title, initial, v => finish(v || null));
    const close = m.onClose.bind(m);
    m.onClose = () => { close(); finish(null); };
    m.open();
  });
}
function askSaveOptions(
  app: App,
  title: string,
  defaults: { append: boolean; hasImage: boolean },
): Promise<{ append: boolean; image: boolean } | null> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: { append: boolean; image: boolean } | null) => { if (!done) { done = true; resolve(v); } };
    const m = new SaveOptionsModal(app, title, defaults, finish);
    const close = m.onClose.bind(m);
    m.onClose = () => { close(); finish(null); }; // 关闭未点保存 = 取消
    m.open();
  });
}

function askConfirm(app: App, title: string, message: string): Promise<boolean> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: boolean) => { if (!done) { done = true; resolve(v); } };
    const m = new ConfirmModal(app, title, message, finish);
    const close = m.onClose.bind(m);
    m.onClose = () => { close(); finish(false); };
    m.open();
  });
}

function isUnderFolder(path: string, folder: string): boolean {
  const p = normalizePath(path);
  const f = normalizePath(folder).replace(/\/+$/, "");
  return !!f && p.startsWith(f + "/");
}

export class ChatView extends ItemView {
  private history: ChatMsg[] = [];
  private sources = new Set<string>();
  private lastMermaid: string | null = null;
  private lastImageEmbed: string | null = null;
  private lastSavedNote: SavedNoteState | null = null;
  private messagesEl!: HTMLElement;
  private welcomeEl!: HTMLElement;
  private contextLimitEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private actionButtons: HTMLButtonElement[] = [];
  private saveNoteBtn!: HTMLButtonElement;
  private busy = false; // 一次只跑一轮 ask，避免连发导致 history 交错
  private pendingSourceContexts: string[] = []; // 引用带来的源笔记小节，只喂给紧接着的那一问
  private instanceId: number; // 实例 ID（1/2/3）

  constructor(leaf: WorkspaceLeaf, private plugin: CobrainPlugin, instanceId: number = 1) {
    super(leaf);
    this.instanceId = instanceId;
  }

  getViewType(): string { return `${VIEW_TYPE_COBRAIN_CHAT}-${this.instanceId}`; }
  getDisplayText(): string { return `创作副脑 #${this.instanceId}`; }
  getIcon(): string { return "brain"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cobrain-root");

    this.messagesEl = root.createDiv({ cls: "cobrain-messages" });
    this.renderWelcome();
    this.contextLimitEl = this.messagesEl.createDiv({ cls: "cobrain-context-limit" });

    const draft = this.plugin.getChatDraft(this.instanceId);
    if (draft) {
      this.history = [...draft.history];
      this.sources = new Set(draft.sources);
      this.lastMermaid = draft.lastMermaid;
      this.lastImageEmbed = draft.lastImageEmbed;
      this.lastSavedNote = draft.lastSavedNote;
      this.messagesEl.createDiv({ cls: "cobrain-restored", text: "已恢复上次未关闭的对话草稿。" });
      for (const msg of this.history) {
        if (msg.role === "user" || msg.role === "assistant") this.addBubble(msg.role, msg.content);
      }
    }

    const bar = root.createDiv({ cls: "cobrain-bar" });
    this.makeBtn(bar, "概念图", () => void this.doConceptMap());
    this.makeBtn(bar, "推敲", () => void this.doCritique());
    this.makeBtn(bar, "配图", () => void this.doImage());
    this.saveNoteBtn = this.makeBtn(bar, "存为笔记", () => void this.doSaveNote());
    this.makeBtn(bar, "清空", () => void this.doClearDraft());

    const iw = root.createDiv({ cls: "cobrain-inputrow" });
    this.inputEl = iw.createEl("textarea", {
      cls: "cobrain-input",
      attr: { rows: "1", placeholder: "问副脑…（Enter 发送，Shift+Enter 换行）" },
    });
    this.sendBtn = iw.createEl("button", { text: "发送" });
    this.sendBtn.onclick = () => void this.send();
    this.inputEl.addEventListener("input", () => this.autoGrow());
    this.inputEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
    this.autoGrow();
    this.updateContextLimitNotice();
    this.updateActionButtons();
  }

  // 输入框随内容长高；上限与滚动由 CSS（.cobrain-input 的 max-height/overflow）封顶。
  private autoGrow(): void {
    this.inputEl.setCssStyles({ height: "auto" });
    this.inputEl.setCssStyles({ height: this.inputEl.scrollHeight + "px" });
  }

  private makeBtn(parent: HTMLElement, text: string, fn: () => void): HTMLButtonElement {
    const b = parent.createEl("button", { text });
    b.onclick = fn;
    this.actionButtons.push(b);
    return b;
  }

  private renderWelcome(): void {
    this.welcomeEl = this.messagesEl.createDiv({
      cls: "cobrain-welcome",
      text: this.plugin.chatWelcomeText(),
    });
    void this.plugin.whenIndexReady().then(
      () => this.welcomeEl.setText(this.plugin.chatWelcomeText()),
      () => undefined,
    );
  }

  private persistDraft(): void {
    this.plugin.saveChatDraft(this.instanceId, {
      history: this.history,
      sources: [...this.sources],
      lastMermaid: this.lastMermaid,
      lastImageEmbed: this.lastImageEmbed,
      lastSavedNote: this.lastSavedNote,
    });
  }

  private updateActionButtons(): void {
    const hasHistory = this.history.length > 0;
    for (const b of this.actionButtons) b.disabled = this.busy || !hasHistory;
    if (this.saveNoteBtn) {
      this.saveNoteBtn.disabled = this.busy || !hasHistory;
      this.saveNoteBtn.setText("存为笔记");
    }
  }

  private updateContextLimitNotice(): void {
    if (!this.contextLimitEl) return;
    const text = chatContextLimitText(this.history.length);
    if (text) {
      this.contextLimitEl.setText(text);
      this.contextLimitEl.style.display = "";
    } else {
      this.contextLimitEl.setText("");
      this.contextLimitEl.style.display = "none";
    }
  }

  private appendHistory(...msgs: ChatMsg[]): void {
    this.history.push(...msgs);
    this.updateContextLimitNotice();
    this.updateActionButtons();
    this.persistDraft();
  }

  private resetConversationUi(): void {
    this.messagesEl.empty();
    this.renderWelcome();
    this.contextLimitEl = this.messagesEl.createDiv({ cls: "cobrain-context-limit" });
    this.updateContextLimitNotice();
    this.updateActionButtons();
  }

  private stateSignature(
    history: ChatMsg[] = this.history,
    sources: string[] = [...this.sources],
    mermaid: string | null = this.lastMermaid,
    imageEmbed: string | null = this.lastImageEmbed,
  ): string {
    return chatStateSignature(history, sources, mermaid, imageEmbed);
  }

  private addBubble(role: "user" | "assistant", text: string, sources?: string[]): HTMLElement {
    const b = this.messagesEl.createDiv({ cls: `cobrain-bubble cobrain-bubble-${role === "user" ? "user" : "ai"}` });
    b.createDiv({ cls: "cobrain-who", text: role === "user" ? "你" : "副脑" });
    const body = b.createDiv();

    if (role === "assistant") {
      void MarkdownRenderer.render(this.app, text, body, "", this);

      // 检测 Mermaid 代码块 → 点击图表切换显示代码
      const mermaidMatch = text.match(/```mermaid\n([\s\S]*?)```/);
      if (mermaidMatch) {
        const code = mermaidMatch[1].trim();
        // 等待渲染完成后添加点击切换逻辑
        window.setTimeout(() => {
          // 找到渲染容器：尝试多种可能的选择器
          const container = body.querySelector("pre.language-mermaid") || body.querySelector(".block-language-mermaid") || body.querySelector("[class*='mermaid']");
          if (!container || !(container instanceof HTMLElement)) return;

          let showingCode = false;
          const rendered = container.cloneNode(true) as HTMLElement; // 保存渲染视图

          container.addClass("cobrain-mermaid-toggle");
          container.setAttribute("title", "点击查看代码");
          container.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            if (showingCode) {
              // 切回图表
              container.empty();
              container.appendChild(rendered.cloneNode(true));
              container.setAttribute("title", "点击查看代码");
              showingCode = false;
            } else {
              // 切换成代码
              container.empty();
              const pre = container.createEl("pre", { cls: "cobrain-mermaid-code" });
              pre.createEl("code", { text: code });
              container.setAttribute("title", "点击返回图表");
              showingCode = true;
            }
          };
        }, 150);
      }

      // 检测图片嵌入 ![[...]] → 缩略图 + 单击查看大图 + 右键菜单
      const imageMatch = text.match(/!\[\[([^\]]+)\]\]/);
      if (imageMatch) {
        const imagePath = imageMatch[1];
        window.setTimeout(() => {
          // 找到渲染出的图片元素
          const imgEl = body.querySelector("img[src*='" + imagePath.split('/').pop()?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "']");
          if (!imgEl || !(imgEl instanceof HTMLImageElement)) return;

          // 缩略图样式
          imgEl.addClass("cobrain-image-thumb");
          imgEl.setAttribute("title", "单击查看大图");

          // 单击查看大图
          imgEl.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            const file = this.app.vault.getAbstractFileByPath(imagePath);
            if (file instanceof TFile) {
              // 使用 Obsidian 内置的图片查看器
              this.app.workspace.getLeaf(false).openFile(file);
            }
          };

          // 右键菜单
          imgEl.addEventListener("contextmenu", (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();

            menu.addItem(item => {
              item.setTitle("单独保存配图")
                .setIcon("download")
                .onClick(async () => {
                  const file = this.app.vault.getAbstractFileByPath(imagePath);
                  if (file instanceof TFile) {
                    try {
                      const content = await this.app.vault.readBinary(file);
                      const newPath = await saveImage(this.app, this.plugin.settings, content);
                      new Notice(`配图已另存为：${newPath}`);
                    } catch (err) {
                      new Notice("保存失败：" + (err instanceof Error ? err.message : String(err)));
                    }
                  }
                });
            });

            menu.addItem(item => {
              item.setTitle("删除配图")
                .setIcon("trash")
                .onClick(async () => {
                  const file = this.app.vault.getAbstractFileByPath(imagePath);
                  if (file instanceof TFile) {
                    const folder = this.plugin.settings.attachmentFolder || "cobrain-note/附件";
                    if (!isUnderFolder(file.path, folder)) {
                      new Notice("只能删除附件目录内的 Cobrain 配图");
                      return;
                    }
                    const confirmed = await askConfirm(this.app, "删除配图", `确定删除 ${file.path}？`);
                    if (!confirmed) return;
                    try {
                      await this.app.vault.delete(file);
                      new Notice("配图已删除");
                      // 移除图片元素
                      imgEl.remove();
                    } catch (err) {
                      new Notice("删除失败：" + (err instanceof Error ? err.message : String(err)));
                    }
                  }
                });
            });

            menu.showAtMouseEvent(e);
          });
        }, 150);
      }
    } else {
      body.setText(text);
    }

    if (sources?.length) {
      b.createDiv({ cls: "cobrain-srcline", text: "来源：" + sources.map(p => p.split("/").pop()).join("、") });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return b;
  }

  // 把检索命中的旧笔记显式列出来、可点开，让第二大脑的联想发生在用户眼前。
  private addRelatedBlock(hits: QueryHit[]): void {
    if (!hits.length) return;
    const seen = new Set<string>();
    const uniq = hits.filter(h => {
      if (seen.has(h.path)) return false;
      seen.add(h.path);
      return true;
    });
    const wrap = this.messagesEl.createDiv({ cls: "cobrain-related" });
    wrap.createDiv({ cls: "cobrain-related-head", text: "相关旧笔记" });
    uniq.slice(0, 8).forEach(h => {
      const item = wrap.createDiv({ cls: "cobrain-related-item" });
      const title = (h.path.split("/").pop() ?? h.path).replace(/\.md$/, "") + (h.heading ? " › " + h.heading : "");
      item.createDiv({ cls: "cobrain-related-title", text: title });
      item.createDiv({ cls: "cobrain-related-snippet", text: h.text.slice(0, 80) + (h.text.length > 80 ? "…" : "") });
      item.onclick = () => this.app.workspace.openLinkText(h.path, "", false);
    });
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private currentTopic(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user") return this.history[i].content;
    }
    return "";
  }

  // 占用面板：busy 期间禁用输入/发送，并让 send 与三个按钮（及彼此）互斥，避免并发请求把对话/产物交错。
  private acquire(): boolean {
    if (this.busy) { new Notice("正在处理上一个请求，请稍候…"); return false; }
    this.busy = true;
    this.inputEl.disabled = true;
    this.sendBtn.disabled = true;
    this.updateActionButtons();
    return true;
  }
  private release(): void {
    this.busy = false;
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
    this.updateActionButtons();
  }

  // 把"引用"(来源链接 + 原文)预填进输入框；来源上下文暂存，喂给紧接着的那一问。
  quoteIntoInput(text: string, sourceContext?: string): void {
    if (sourceContext) this.pendingSourceContexts.push(sourceContext);
    this.inputEl.value = text + this.inputEl.value;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
    this.autoGrow();
    this.inputEl.scrollTop = 0; // 引用在顶部，确保可见
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const configProblem = this.plugin.chatConfigProblem();
    if (configProblem) {
      new Notice(configProblem);
      return;
    }
    if (!this.acquire()) return;
    const priorHistory = chatHistoryForModel(this.history);
    const sourceContext = this.pendingSourceContexts.length
      ? this.pendingSourceContexts.join("\n\n---\n\n")
      : undefined; // 消费一次：仅这一问带来源上下文
    this.pendingSourceContexts = [];
    this.inputEl.value = "";
    this.autoGrow();
    this.addBubble("user", text);
    this.appendHistory({ role: "user", content: text });
    const thinking = thinkingBubble(this.messagesEl, "思考中…");
    try {
      const { reply, sources, related } = await this.plugin.tutor.ask(priorHistory, text, sourceContext);
      thinking.stop();
      // 先把你自己写过的相关旧笔记摊到眼前（第二大脑「联想」），再看导师的回应
      this.addRelatedBlock(related);
      this.addBubble("assistant", reply);
      sources.forEach(s => this.sources.add(s));
      this.appendHistory({ role: "assistant", content: reply });
    } catch (e) {
      thinking.stop();
      this.addBubble("assistant", "出错了：" + errMsg(e));
      this.persistDraft();
    } finally {
      this.release();
      this.inputEl.focus();
    }
  }

  private async doConceptMap(): Promise<void> {
    const t = this.currentTopic();
    if (!t) {
      new Notice("先聊点什么，再画概念图");
      return;
    }
    if (!this.acquire()) return;
    const bubble = thinkingBubble(this.messagesEl, "画概念图中…");
    try {
      const raw = await this.plugin.tutor.conceptMap(t);
      this.lastMermaid = extractMermaid(raw);
      bubble.stop();
      this.addBubble("assistant", this.lastMermaid ?? "（未能生成有效的概念图）\n\n" + raw);
      this.persistDraft();
    } catch (e) {
      this.lastMermaid = null; // 失败不保留上一个话题的旧图，避免存笔记时把陈旧图串进去
      bubble.stop();
      this.addBubble("assistant", "概念图失败：" + errMsg(e));
    } finally {
      this.release();
    }
  }

  private async doCritique(): Promise<void> {
    if (!this.history.length) {
      new Notice("还没有对话可推敲");
      return;
    }
    if (!this.acquire()) return;
    const bubble = thinkingBubble(this.messagesEl, "推敲中…");
    try {
      const reply = await this.plugin.tutor.critique(this.history);
      bubble.stop();
      this.addBubble("assistant", reply);
      this.appendHistory({ role: "assistant", content: reply });
    } catch (e) {
      bubble.stop();
      this.addBubble("assistant", "推敲失败：" + errMsg(e));
    } finally {
      this.release();
    }
  }

  // 配图：先从对话提炼「值得画的概念 + 隐喻」作为预填（默认是你最后一句话，常是提问、画了没意义），
  // 你可改概念 → LLM 扩写成详细视觉提示词 → 你编辑确认 → 出图。
  private async doImage(): Promise<void> {
    let seed = this.currentTopic();
    if (this.history.length) {
      if (!this.acquire()) return;
      const t = timedNotice("构思配图主题中…");
      try {
        seed = await this.plugin.tutor.imageConcept(this.history);
      } catch {
        // 提炼失败：回退到最近发言，不打断配图
      } finally {
        t.stop();
        this.release();
      }
    }
    if (!seed) { new Notice("先聊点什么，再配图"); return; }
    const concept = await askPrompt(this.app, "给哪个概念配图？", seed);
    if (concept) await this.runImageFromConcept(concept);
  }

  // 概念 → 扩写视觉提示词 → 编辑确认 → 出图 → 嵌入。doImage 与「存为笔记」的可选配图共用。
  // 成功返回 ![[path]] 并存入 lastImageEmbed；任意环节取消/失败返回 null。
  private async runImageFromConcept(concept: string): Promise<string | null> {
    if (!this.acquire()) return null;
    let scene: string;
    const t = timedNotice("扩写配图提示词中…");
    try {
      scene = await this.plugin.tutor.imagePrompt(concept);
    } catch (e) {
      new Notice("提示词扩写失败：" + errMsg(e));
      return null;
    } finally {
      t.stop();
      this.release(); // 扩写完即释放：用户编辑提示词期间不该锁住对话面板
    }
    const style = this.plugin.settings.imageStyle;
    const fullPrompt = [scene.trim(), style ? `风格：${style}` : "", "画面中不要出现任何文字。"]
      .filter(Boolean)
      .join("\n\n");
    const finalPrompt = await askTextArea(this.app, "确认 / 编辑配图提示词", fullPrompt);
    if (!finalPrompt) return null;
    if (!this.acquire()) return null;
    const bubble = thinkingBubble(this.messagesEl, `为「${concept}」配图中…（图像生成较慢，约 1 分钟）`);
    try {
      const buf = await this.plugin.image.generate(finalPrompt);
      const path = await saveImage(this.app, this.plugin.settings, buf);
      this.lastImageEmbed = `![[${path}]]`;
      bubble.stop();
      this.addBubble("assistant", `「${concept}」配图：\n\n${this.lastImageEmbed}`);
      this.persistDraft();
      return this.lastImageEmbed;
    } catch (e) {
      bubble.stop();
      this.addBubble("assistant", "配图失败：" + errMsg(e));
      return null;
    } finally {
      this.release();
    }
  }

  private async doSaveNote(): Promise<void> {
    if (!this.history.length) {
      new Notice("还没有对话可保存");
      return;
    }
    const currentSignature = this.stateSignature();
    if (this.lastSavedNote?.stateSignature === currentSignature) {
      new Notice(`这段对话和当前产物已保存过：${this.lastSavedNote.path}`);
      return;
    }
    if (this.lastSavedNote) new Notice("对话或产物已变化，将保存新版本");

    // 先冻结本次保存要用的材料。弹窗期间用户继续聊天，也不会悄悄混进这篇笔记。
    const historySnapshot = this.history.map(m => ({ ...m }));
    const sourcesSnapshot = [...this.sources].sort();
    const mermaidSnapshot = this.lastMermaid;
    let imageSnapshot = this.lastImageEmbed;

    if (!this.acquire()) return;
    let title = "", body = "";
    const t = timedNotice("整理成笔记中…");
    try {
      ({ title, body } = await this.plugin.tutor.summarizeNote(historySnapshot));
    } catch (e) {
      new Notice("整理失败：" + errMsg(e));
      t.stop();
      this.release();
      return;
    }
    t.stop();
    this.release(); // 下面要弹选项框、可能还要长时出图，期间不锁面板

    // 保存选项：附提问（默认随全局设置）+ 配图（默认关，即使本轮已配过图也要问）。取消则中止。
    const opts = await askSaveOptions(this.app, title, {
      append: this.plugin.settings.appendConversation,
      hasImage: false, // 始终显示配图复选框，不自动带入
    });
    if (!opts) return; // 取消，不落盘
    if (opts.image && !imageSnapshot) {
      imageSnapshot = await this.runImageFromConcept(title); // 自行管理 acquire/release
    }

    // 落盘
    if (!this.acquire()) return;
    try {
      // 只附用户的提问（原始问题），不含 AI 回答
      const conversation = opts.append
        ? historySnapshot.filter(m => m.role === "user").map(m => `**你**：${m.content}`).join("\n\n")
        : null;
      const path = await saveNote(this.app, this.plugin.settings, {
        title,
        body,
        sources: sourcesSnapshot,
        mermaid: mermaidSnapshot,
        imageEmbed: opts.image ? imageSnapshot : null, // 只有勾选才加配图
        conversation,
      });
      new Notice("已保存：" + path);
      // 只消费本次快照用掉的产物。保存弹窗期间若用户继续聊天或重新生成产物，不把新状态误清掉。
      if (this.lastMermaid === mermaidSnapshot) this.lastMermaid = null;
      if (this.lastImageEmbed === imageSnapshot) this.lastImageEmbed = null;
      for (const s of sourcesSnapshot) this.sources.delete(s);
      this.lastSavedNote = {
        stateSignature: this.stateSignature(historySnapshot, [], null, null),
        path,
        savedAt: Date.now(),
      };
      this.persistDraft();
    } catch (e) {
      new Notice("保存失败：" + errMsg(e));
    } finally {
      this.release();
    }
  }

  private async doClearDraft(): Promise<void> {
    if (!this.history.length) {
      new Notice("当前没有对话草稿");
      return;
    }
    const confirmed = await askConfirm(this.app, "清空当前对话", "会删除这个面板的消息和草稿，不会删除已经保存的笔记。");
    if (!confirmed) return;
    this.history = [];
    this.sources.clear();
    this.lastMermaid = null;
    this.lastImageEmbed = null;
    this.lastSavedNote = null;
    this.pendingSourceContexts = [];
    this.inputEl.value = "";
    this.autoGrow();
    this.plugin.clearChatDraft(this.instanceId);
    this.resetConversationUi();
    new Notice("当前对话已清空");
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
    // 释放实例 ID，允许再次使用这个槽位
    this.plugin.releaseViewId(this.instanceId);
  }
}

class PromptModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private initial: string,
    private onSubmit: (v: string) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl("h3", { text: this.titleText });
    const input = this.contentEl.createEl("input", { type: "text", value: this.initial });
    input.setCssStyles({ width: "100%" });
    input.focus();
    input.select();
    const submit = () => {
      this.onSubmit(input.value.trim());
      this.close();
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") submit();
    });
    const btn = this.contentEl.createEl("button", { text: "确定" });
    btn.setCssStyles({ marginTop: "8px" });
    btn.onclick = submit;
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

// 多行可编辑弹窗：用于出图前确认 / 编辑配图提示词
class TextAreaModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private initial: string,
    private onSubmit: (v: string) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl("h3", { text: this.titleText });
    const ta = this.contentEl.createEl("textarea");
    ta.value = this.initial;
    ta.setCssStyles({ width: "100%", height: "160px", resize: "vertical" });
    ta.focus();
    const btn = this.contentEl.createEl("button", { text: "生成" });
    btn.setCssStyles({ marginTop: "8px" });
    btn.onclick = () => {
      this.onSubmit(ta.value.trim());
      this.close();
    };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

class ConfirmModal extends Modal {
  constructor(
    app: App,
    private titleText: string,
    private message: string,
    private onPick: (v: boolean) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl("h3", { text: this.titleText });
    this.contentEl.createEl("p", { text: this.message });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "12px" });
    const cancel = row.createEl("button", { text: "取消" });
    const ok = row.createEl("button", { text: "删除" });
    ok.classList.add("mod-warning");
    cancel.onclick = () => { this.onPick(false); this.close(); };
    ok.onclick = () => { this.onPick(true); this.close(); };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

// 存为笔记的选项框：附提问原文（默认随全局设置） + 配图（默认关）。
// 按钮先回调再 close，避免与 onClose 的兜底重复 resolve。
class SaveOptionsModal extends Modal {
  constructor(
    app: App,
    private noteTitle: string,
    private defaults: { append: boolean; hasImage: boolean },
    private onPick: (v: { append: boolean; image: boolean } | null) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl("h3", { text: `存为笔记：「${this.noteTitle}」` });

    let append = this.defaults.append;
    let image = false;

    const mkCheck = (label: string, initial: boolean, onChange: (v: boolean) => void): void => {
      const row = this.contentEl.createDiv();
      row.setCssStyles({ display: "flex", alignItems: "center", gap: "8px", margin: "8px 0" });
      const cb = row.createEl("input", { type: "checkbox" });
      cb.checked = initial;
      cb.onchange = () => onChange(cb.checked);
      const lab = row.createEl("label", { text: label });
      lab.setCssStyles({ cursor: "pointer" });
      lab.onclick = () => { cb.checked = !cb.checked; onChange(cb.checked); };
    };

    mkCheck("附上我的提问原文", append, v => (append = v));
    mkCheck("为这篇配一张隐喻图（基于标题）", image, v => (image = v));

    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "12px" });
    const cancel = row.createEl("button", { text: "取消" });
    const save = row.createEl("button", { text: "保存" });
    save.classList.add("mod-cta");
    cancel.onclick = () => { this.onPick(null); this.close(); };
    save.onclick = () => { this.onPick({ append, image }); this.close(); };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
