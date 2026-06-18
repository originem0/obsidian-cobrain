import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, Modal, App } from "obsidian";
import type { ChatMsg } from "../llm/chatClient";
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

  constructor(leaf: WorkspaceLeaf, private plugin: LearningTutorPlugin) {
    super(leaf);
  }

  getViewType(): string { return VIEW_TYPE_LT_CHAT; }
  getDisplayText(): string { return "学习导师"; }
  getIcon(): string { return "graduation-cap"; }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.style.cssText = "display:flex; flex-direction:column; height:100%;";

    this.messagesEl = root.createDiv();
    this.messagesEl.style.cssText = "flex:1; overflow-y:auto; padding:8px;";
    const w = this.messagesEl.createDiv();
    w.style.cssText = "opacity:0.55; padding:8px; font-size:0.9em;";
    w.setText("跟导师聊一个想搞懂的概念——它会检索你的 vault、按你的水平讲。下方按钮：把当前话题画成概念图 / 给概念配图 / 把对话存成结构化笔记。");

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
      attr: { rows: "2", placeholder: "问导师…（Enter 发送，Shift+Enter 换行）" },
    });
    this.inputEl.style.cssText = "flex:1; resize:none;";
    const send = iw.createEl("button", { text: "发送" });
    send.onclick = () => void this.send();
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
    const who = b.createEl("div", { text: role === "user" ? "你" : "导师" });
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

  private currentTopic(): string {
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === "user") return this.history[i].content;
    }
    return "";
  }

  private async send(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    this.addBubble("user", text);
    const thinking = this.addBubble("assistant", "思考中…");
    try {
      const { reply, sources } = await this.plugin.tutor.ask(this.history, text);
      thinking.remove();
      this.addBubble("assistant", reply, sources);
      sources.forEach(s => this.sources.add(s));
      this.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
      if (this.history.length > 20) this.history = this.history.slice(-20);
    } catch (e) {
      thinking.remove();
      this.addBubble("assistant", "出错了：" + errMsg(e));
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

  private doImage(): void {
    new PromptModal(this.app, "给哪个概念配图？", this.currentTopic(), async concept => {
      if (!concept) return;
      const bubble = this.addBubble("assistant", `为「${concept}」配图中…（图像生成较慢，约 1 分钟，请稍候）`);
      try {
        const prompt = `为「${concept}」这一概念创作一张帮助理解记忆的插画：用具象、生动、略带夸张的视觉隐喻表现其核心含义；画面简洁、有冲击力；不要出现文字。`;
        const buf = await this.plugin.image.generate(prompt);
        const path = await saveImage(this.app, this.plugin.settings, buf);
        this.lastImageEmbed = `![[${path}]]`;
        bubble.remove();
        this.addBubble("assistant", `「${concept}」配图：\n\n${this.lastImageEmbed}`);
      } catch (e) {
        bubble.remove();
        this.addBubble("assistant", "配图失败：" + errMsg(e));
      }
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
      const path = await saveNote(this.app, this.plugin.settings, {
        title,
        body,
        sources: [...this.sources],
        mermaid: this.lastMermaid,
        imageEmbed: this.lastImageEmbed,
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
