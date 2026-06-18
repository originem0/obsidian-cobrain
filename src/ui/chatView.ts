import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, Modal, App } from "obsidian";
import type { ChatMsg } from "../llm/chatClient";
import type { QueryHit } from "../rag/vectorStore";
import { saveNote, saveImage } from "../noteWriter";
import type LearningTutorPlugin from "../main";

export const VIEW_TYPE_LT_CHAT = "lt-chat";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function extractMermaid(text: string): string | null {
  const m = text.match(/```mermaid[\s\S]*?```/);
  if (m) return m[0];
  if (/(graph\s+(TD|LR|RL|BT))|flowchart/i.test(text)) return "```mermaid\n" + text.trim() + "\n```";
  return null;
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

  constructor(leaf: WorkspaceLeaf, private plugin: LearningTutorPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_LT_CHAT; }
  getDisplayText(): string { return "创作副脑"; }
  getIcon(): string { return "brain"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.style.cssText = "display:flex; flex-direction:column; height:100%;";

    this.messagesEl = root.createDiv();
    this.messagesEl.style.cssText = "flex:1; overflow-y:auto; padding:8px;";
    const w = this.messagesEl.createDiv();
    w.style.cssText = "opacity:0.55; padding:8px; font-size:0.9em;";
    w.setText("跟它聊一个你正在想的东西——它会从你 vault 里翻出你写过的相关旧笔记摊到眼前，并回抛问题逼你自己想，而不是讲给你听。下方按钮：概念图 / 配图 / 存为笔记。");

    const bar = root.createDiv();
    bar.style.cssText =
      "display:flex; gap:6px; padding:4px 8px; flex-wrap:wrap; border-top:1px solid var(--background-modifier-border);";
    this.makeBtn(bar, "概念图", () => void this.doConceptMap());
    this.makeBtn(bar, "配图", () => this.doImage());
    this.makeBtn(bar, "存为笔记", () => void this.doSaveNote());

    const iw = root.createDiv();
    iw.style.cssText =
      "display:flex; gap:6px; padding:8px; border-top:1px solid var(--background-modifier-border);";
    this.inputEl = iw.createEl("textarea", {
      attr: { rows: "2", placeholder: "问副脑…（Enter 发送，Shift+Enter 换行）" },
    });
    this.inputEl.style.cssText = "flex:1; resize:none;";
    this.sendBtn = iw.createEl("button", { text: "发送" });
    this.sendBtn.onclick = () => void this.send();
    this.inputEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
  }

  private makeBtn(parent: HTMLElement, text: string, fn: () => void): void {
    const b = parent.createEl("button", { text });
    b.style.fontSize = "0.85em";
    b.onclick = fn;
  }

  private addBubble(role: "user" | "assistant", text: string, sources?: string[]): HTMLElement {
    const b = this.messagesEl.createDiv();
    b.style.cssText = `margin:8px 0; padding:8px 10px; border-radius:8px; background:var(${
      role === "user" ? "--background-secondary" : "--background-primary-alt"
    });`;
    const who = b.createEl("div", { text: role === "user" ? "你" : "副脑" });
    who.style.cssText = "font-size:0.72em; opacity:0.55; margin-bottom:4px;";
    const body = b.createDiv();
    if (role === "assistant") void MarkdownRenderer.render(this.app, text, body, "", this);
    else body.setText(text);
    if (sources?.length) {
      const s = b.createEl("div", { text: "来源：" + sources.map(p => p.split("/").pop()).join("、") });
      s.style.cssText = "font-size:0.72em; opacity:0.5; margin-top:6px;";
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return b;
  }

  // 把检索命中的旧笔记显式列出来、可点开——让 vault 主动「撞」你，而不是悄悄喂给模型（第二大脑「联想」）
  private addRelatedBlock(hits: QueryHit[]): void {
    if (!hits.length) return;
    const seen = new Set<string>();
    const uniq = hits.filter(h => {
      if (seen.has(h.path)) return false;
      seen.add(h.path);
      return true;
    });
    const wrap = this.messagesEl.createDiv();
    wrap.style.cssText =
      "margin:8px 0; padding:6px 10px; border-left:2px solid var(--interactive-accent); background:var(--background-secondary); border-radius:4px;";
    const head = wrap.createEl("div", { text: "你写过的（点开撞一撞）" });
    head.style.cssText = "font-size:0.72em; opacity:0.55; margin-bottom:4px;";
    uniq.slice(0, 5).forEach(h => {
      const item = wrap.createDiv();
      item.style.cssText = "margin:3px 0; cursor:pointer;";
      const title = (h.path.split("/").pop() ?? h.path).replace(/\.md$/, "") + (h.heading ? " › " + h.heading : "");
      const t = item.createEl("div", { text: title });
      t.style.cssText = "font-size:0.85em; color:var(--text-accent);";
      const s = item.createEl("div", { text: h.text.slice(0, 80) + (h.text.length > 80 ? "…" : "") });
      s.style.cssText = "font-size:0.78em; opacity:0.5;";
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

  private async send(): Promise<void> {
    if (this.busy) return;
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.busy = true;
    this.inputEl.disabled = true;
    this.sendBtn.disabled = true;
    this.inputEl.value = "";
    this.addBubble("user", text);
    const thinking = this.addBubble("assistant", "思考中…");
    try {
      const { reply, sources, related } = await this.plugin.tutor.ask(this.history, text);
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
      this.busy = false;
      this.inputEl.disabled = false;
      this.sendBtn.disabled = false;
      this.inputEl.focus();
    }
  }

  private async doConceptMap(): Promise<void> {
    const t = this.currentTopic();
    if (!t) {
      new Notice("先聊点什么，再画概念图");
      return;
    }
    const bubble = this.addBubble("assistant", "画概念图中…");
    try {
      const raw = await this.plugin.tutor.conceptMap(t);
      this.lastMermaid = extractMermaid(raw);
      bubble.remove();
      this.addBubble("assistant", this.lastMermaid ?? "（未能生成有效的概念图）\n\n" + raw);
    } catch (e) {
      bubble.remove();
      this.addBubble("assistant", "概念图失败：" + errMsg(e));
    }
  }

  // 配图两步：选概念 → LLM 把概念扩写成详细视觉提示词 → 用户编辑确认 → 出图。
  // 根因（提示词太简陋 + currentTopic 常是整句话）在扩写 + 可编辑这两步被收敛。
  private doImage(): void {
    new PromptModal(this.app, "给哪个概念配图？", this.currentTopic(), async concept => {
      if (!concept) return;
      const notice = new Notice("扩写配图提示词中…", 0);
      let scene: string;
      try {
        scene = await this.plugin.tutor.imagePrompt(concept);
      } catch (e) {
        notice.hide();
        new Notice("提示词扩写失败：" + errMsg(e));
        return;
      }
      notice.hide();
      const style = this.plugin.settings.imageStyle;
      const fullPrompt = [scene.trim(), style ? `风格：${style}` : "", "画面中不要出现任何文字。"]
        .filter(Boolean)
        .join("\n\n");
      new TextAreaModal(this.app, "确认 / 编辑配图提示词", fullPrompt, async finalPrompt => {
        if (!finalPrompt) return;
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
        }
      }).open();
    }).open();
  }

  private async doSaveNote(): Promise<void> {
    if (!this.history.length) {
      new Notice("还没有对话可保存");
      return;
    }
    const notice = new Notice("整理成笔记中…", 0);
    try {
      const { title, body } = await this.plugin.tutor.summarizeNote(this.history);
      const conversation = this.plugin.settings.appendConversation
        ? this.history.map(m => `**${m.role === "user" ? "你" : "副脑"}**：${m.content}`).join("\n\n")
        : null;
      const path = await saveNote(this.app, this.plugin.settings, {
        title,
        body,
        sources: [...this.sources],
        mermaid: this.lastMermaid,
        imageEmbed: this.lastImageEmbed,
        conversation,
      });
      notice.hide();
      new Notice("已保存：" + path);
    } catch (e) {
      notice.hide();
      new Notice("保存失败：" + errMsg(e));
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
