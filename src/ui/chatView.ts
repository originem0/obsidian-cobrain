import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, Modal, App } from "obsidian";
import type { ChatMsg } from "../llm/chatClient";
import type { QueryHit } from "../rag/vectorStore";
import { saveNote, saveImage } from "../noteWriter";
import { extractMermaid } from "../util/mermaid";
import type CobrainPlugin from "../main";

export const VIEW_TYPE_COBRAIN_CHAT = "cobrain-chat";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
    this.makeBtn(bar, "配图", () => this.doImage());
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
    this.inputEl.style.height = "auto";
    this.inputEl.style.height = this.inputEl.scrollHeight + "px";
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
    uniq.slice(0, 5).forEach(h => {
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

  // 配图两步：选概念 → LLM 把概念扩写成详细视觉提示词 → 用户编辑确认 → 出图。
  // 根因（提示词太简陋 + currentTopic 常是整句话）在扩写 + 可编辑这两步被收敛。
  private doImage(): void {
    new PromptModal(this.app, "给哪个概念配图？", this.currentTopic(), async concept => {
      if (!concept) return;
      if (!this.acquire()) return;
      const notice = new Notice("扩写配图提示词中…", 0);
      let scene: string;
      try {
        scene = await this.plugin.tutor.imagePrompt(concept);
      } catch (e) {
        new Notice("提示词扩写失败：" + errMsg(e));
        return;
      } finally {
        notice.hide();
        this.release(); // 扩写完即释放：用户编辑提示词期间不该锁住对话面板
      }
      const style = this.plugin.settings.imageStyle;
      const fullPrompt = [scene.trim(), style ? `风格：${style}` : "", "画面中不要出现任何文字。"]
        .filter(Boolean)
        .join("\n\n");
      new TextAreaModal(this.app, "确认 / 编辑配图提示词", fullPrompt, async finalPrompt => {
        if (!finalPrompt) return;
        if (!this.acquire()) return;
        const bubble = this.addBubble("assistant", `为「${concept}」配图中…（图像生成较慢，约 1 分钟，请稍候）`);
        try {
          const buf = await this.plugin.image.generate(finalPrompt);
          const path = await saveImage(this.app, this.plugin.settings, buf);
          this.lastImageEmbed = `![[${path}]]`;
          bubble.remove();
          this.addBubble("assistant", `「${concept}」配图：\n\n${this.lastImageEmbed}`);
        } catch (e) {
          bubble.remove();
          this.addBubble("assistant", "配图失败：" + errMsg(e));
        } finally {
          this.release();
        }
      }).open();
    }).open();
  }

  private async doSaveNote(): Promise<void> {
    if (!this.history.length) {
      new Notice("还没有对话可保存");
      return;
    }
    if (!this.acquire()) return;
    const notice = new Notice("整理成笔记中…", 0);
    try {
      const { title, body } = await this.plugin.tutor.summarizeNote(this.history);
      // 只附用户的提问（原始问题），不含 AI 回答
      const conversation = this.plugin.settings.appendConversation
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
      notice.hide();
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
    input.style.width = "100%";
    input.focus();
    input.select();
    const submit = () => {
      this.close();
      this.onSubmit(input.value.trim());
    };
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") submit();
    });
    const btn = this.contentEl.createEl("button", { text: "确定" });
    btn.style.marginTop = "8px";
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
    ta.style.cssText = "width:100%; height:160px; resize:vertical;";
    ta.focus();
    const btn = this.contentEl.createEl("button", { text: "生成" });
    btn.style.marginTop = "8px";
    btn.onclick = () => {
      this.close();
      this.onSubmit(ta.value.trim());
    };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
