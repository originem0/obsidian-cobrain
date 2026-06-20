import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, Modal, App } from "obsidian";
import type { ChatMsg } from "../llm/chatClient";
import type { QueryHit } from "../rag/vectorStore";
import { saveNote, saveImage } from "../noteWriter";
import { extractMermaid } from "../util/mermaid";
import type CobrainPlugin from "../main";

export const VIEW_TYPE_COBRAIN_CHAT = "cobrain-chat";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

export class ChatView extends ItemView {
  private history: ChatMsg[] = [];
  private sources = new Set<string>();
  private lastMermaid: string | null = null;
  private lastImageEmbed: string | null = null;
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private busy = false; // 一次只跑一轮 ask，避免连发导致 history 交错
  private pendingSourceContext: string | null = null; // 引用带来的源笔记小节，只喂给紧接着的那一问

  constructor(leaf: WorkspaceLeaf, private plugin: CobrainPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_COBRAIN_CHAT; }
  getDisplayText(): string { return "创作副脑"; }
  getIcon(): string { return "brain"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("cobrain-root");

    this.messagesEl = root.createDiv({ cls: "cobrain-messages" });
    this.messagesEl.createDiv({
      cls: "cobrain-welcome",
      text: "聊你正在想的——我会翻出你写过的相关旧笔记摊到眼前，并回抛问题逼你自己想。下方：概念图 / 配图 / 存为笔记。",
    });

    const bar = root.createDiv({ cls: "cobrain-bar" });
    this.makeBtn(bar, "概念图", () => void this.doConceptMap());
    this.makeBtn(bar, "配图", () => void this.doImage());
    this.makeBtn(bar, "存为笔记", () => void this.doSaveNote());

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
  }

  // 输入框随内容长高；上限与滚动由 CSS（.cobrain-input 的 max-height/overflow）封顶。
  private autoGrow(): void {
    this.inputEl.setCssStyles({ height: "auto" });
    this.inputEl.setCssStyles({ height: this.inputEl.scrollHeight + "px" });
  }

  private makeBtn(parent: HTMLElement, text: string, fn: () => void): void {
    const b = parent.createEl("button", { text });
    b.onclick = fn;
  }

  private addBubble(role: "user" | "assistant", text: string, sources?: string[]): HTMLElement {
    const b = this.messagesEl.createDiv({ cls: `cobrain-bubble cobrain-bubble-${role === "user" ? "user" : "ai"}` });
    b.createDiv({ cls: "cobrain-who", text: role === "user" ? "你" : "副脑" });
    const body = b.createDiv();
    if (role === "assistant") void MarkdownRenderer.render(this.app, text, body, "", this);
    else body.setText(text);
    if (sources?.length) {
      b.createDiv({ cls: "cobrain-srcline", text: "来源：" + sources.map(p => p.split("/").pop()).join("、") });
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return b;
  }

  // 把检索命中的旧笔记显式列出来、可点开——让 vault 主动「撞」你（第二大脑「联想」）
  private addRelatedBlock(hits: QueryHit[]): void {
    if (!hits.length) return;
    const seen = new Set<string>();
    const uniq = hits.filter(h => {
      if (seen.has(h.path)) return false;
      seen.add(h.path);
      return true;
    });
    const wrap = this.messagesEl.createDiv({ cls: "cobrain-related" });
    wrap.createDiv({ cls: "cobrain-related-head", text: "你写过的（点开撞一撞）" });
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
    return true;
  }
  private release(): void {
    this.busy = false;
    this.inputEl.disabled = false;
    this.sendBtn.disabled = false;
  }

  // 把"引用"(来源链接 + 原文)预填进输入框；来源上下文暂存，喂给紧接着的那一问。
  quoteIntoInput(text: string, sourceContext?: string): void {
    this.pendingSourceContext = sourceContext ?? null;
    this.inputEl.value = text + this.inputEl.value;
    this.inputEl.focus();
    this.inputEl.setSelectionRange(text.length, text.length);
    this.autoGrow();
    this.inputEl.scrollTop = 0; // 引用在顶部，确保可见
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    if (!this.acquire()) return;
    const sourceContext = this.pendingSourceContext; // 消费一次：仅这一问带来源上下文
    this.pendingSourceContext = null;
    this.inputEl.value = "";
    this.autoGrow();
    this.addBubble("user", text);
    const thinking = this.addBubble("assistant", "思考中…");
    try {
      const { reply, sources, related } = await this.plugin.tutor.ask(this.history, text, sourceContext ?? undefined);
      thinking.remove();
      // 先把你自己写过的相关旧笔记摊到眼前（第二大脑「联想」），再看导师的回应
      this.addRelatedBlock(related);
      this.addBubble("assistant", reply);
      sources.forEach(s => this.sources.add(s));
      this.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
      if (this.history.length > 20) this.history = this.history.slice(-20);
    } catch (e) {
      thinking.remove();
      this.addBubble("assistant", "出错了：" + errMsg(e));
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
    const bubble = this.addBubble("assistant", "画概念图中…");
    try {
      const raw = await this.plugin.tutor.conceptMap(t);
      this.lastMermaid = extractMermaid(raw);
      bubble.remove();
      this.addBubble("assistant", this.lastMermaid ?? "（未能生成有效的概念图）\n\n" + raw);
    } catch (e) {
      this.lastMermaid = null; // 失败不保留上一个话题的旧图，避免存笔记时把陈旧图串进去
      bubble.remove();
      this.addBubble("assistant", "概念图失败：" + errMsg(e));
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
      const notice = new Notice("构思配图主题中…", 0);
      try {
        seed = await this.plugin.tutor.imageConcept(this.history);
      } catch {
        // 提炼失败：回退到最近发言，不打断配图
      } finally {
        notice.hide();
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
    const notice = new Notice("扩写配图提示词中…", 0);
    try {
      scene = await this.plugin.tutor.imagePrompt(concept);
    } catch (e) {
      new Notice("提示词扩写失败：" + errMsg(e));
      return null;
    } finally {
      notice.hide();
      this.release(); // 扩写完即释放：用户编辑提示词期间不该锁住对话面板
    }
    const style = this.plugin.settings.imageStyle;
    const fullPrompt = [scene.trim(), style ? `风格：${style}` : "", "画面中不要出现任何文字。"]
      .filter(Boolean)
      .join("\n\n");
    const finalPrompt = await askTextArea(this.app, "确认 / 编辑配图提示词", fullPrompt);
    if (!finalPrompt) return null;
    if (!this.acquire()) return null;
    const bubble = this.addBubble("assistant", `为「${concept}」配图中…（图像生成较慢，约 1 分钟，请稍候）`);
    try {
      const buf = await this.plugin.image.generate(finalPrompt);
      const path = await saveImage(this.app, this.plugin.settings, buf);
      this.lastImageEmbed = `![[${path}]]`;
      bubble.remove();
      this.addBubble("assistant", `「${concept}」配图：\n\n${this.lastImageEmbed}`);
      return this.lastImageEmbed;
    } catch (e) {
      bubble.remove();
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
    if (!this.acquire()) return;
    let title = "", body = "";
    const notice = new Notice("整理成笔记中…", 0);
    try {
      ({ title, body } = await this.plugin.tutor.summarizeNote(this.history));
    } catch (e) {
      new Notice("整理失败：" + errMsg(e));
      notice.hide();
      this.release();
      return;
    }
    notice.hide();
    this.release(); // 下面要弹选项框、可能还要长时出图，期间不锁面板

    // 保存选项：附提问（默认随全局设置）+ 配图（默认关；本轮已配过图则只提示、不再问）。取消则中止。
    const opts = await askSaveOptions(this.app, title, {
      append: this.plugin.settings.appendConversation,
      hasImage: !!this.lastImageEmbed,
    });
    if (!opts) return; // 取消，不落盘
    if (opts.image && !this.lastImageEmbed) await this.runImageFromConcept(title); // 自行管理 acquire/release

    // 落盘
    if (!this.acquire()) return;
    try {
      // 只附用户的提问（原始问题），不含 AI 回答
      const conversation = opts.append
        ? this.history.filter(m => m.role === "user").map(m => `**你**：${m.content}`).join("\n\n")
        : null;
      const path = await saveNote(this.app, this.plugin.settings, {
        title,
        body,
        sources: [...this.sources],
        mermaid: this.lastMermaid,
        imageEmbed: this.lastImageEmbed,
        conversation,
      });
      new Notice("已保存：" + path);
      // 每篇笔记消费掉本轮累积的产物与来源，避免渗进下一篇（旧概念图/配图/来源串台）
      this.lastMermaid = null;
      this.lastImageEmbed = null;
      this.sources.clear();
    } catch (e) {
      new Notice("保存失败：" + errMsg(e));
    } finally {
      this.release();
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
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

// 存为笔记的选项框：附提问原文（默认随全局设置） + 配图（默认关；本轮已配过图则改为提示、不再问）。
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
    if (this.defaults.hasImage) {
      // 本轮已点过「配图」：图会随笔记保存，不再重复询问
      const info = this.contentEl.createEl("p", { text: "✓ 已配图，将一并保存" });
      info.setCssStyles({ margin: "8px 0", color: "var(--text-muted)", fontSize: "0.9em" });
    } else {
      mkCheck("为这篇配一张隐喻图（基于标题）", image, v => (image = v));
    }

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
