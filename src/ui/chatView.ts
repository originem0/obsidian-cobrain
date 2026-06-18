import { ItemView, WorkspaceLeaf, MarkdownRenderer } from "obsidian";
import type { ChatMsg } from "../llm/chatClient";
import type LearningTutorPlugin from "../main";

export const VIEW_TYPE_LT_CHAT = "lt-chat";

export class ChatView extends ItemView {
  private history: ChatMsg[] = [];
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

    const welcome = this.messagesEl.createDiv();
    welcome.style.cssText = "opacity:0.55; padding:8px; font-size:0.9em;";
    welcome.setText("跟导师聊一个你想搞懂的概念——它会检索你的 vault、按你的水平讲，并把新知识接到你已有的笔记上。");

    const inputWrap = root.createDiv();
    inputWrap.style.cssText =
      "display:flex; gap:6px; padding:8px; border-top:1px solid var(--background-modifier-border);";
    this.inputEl = inputWrap.createEl("textarea", {
      attr: { rows: "2", placeholder: "问导师…（Enter 发送，Shift+Enter 换行）" },
    });
    this.inputEl.style.cssText = "flex:1; resize:none;";
    const sendBtn = inputWrap.createEl("button", { text: "发送" });

    sendBtn.onclick = () => void this.send();
    this.inputEl.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
  }

  private addBubble(role: "user" | "assistant", text: string, sources?: string[]): HTMLElement {
    const b = this.messagesEl.createDiv();
    b.style.cssText = `margin:8px 0; padding:8px 10px; border-radius:8px; background:var(${
      role === "user" ? "--background-secondary" : "--background-primary-alt"
    });`;
    const who = b.createEl("div", { text: role === "user" ? "你" : "导师" });
    who.style.cssText = "font-size:0.72em; opacity:0.55; margin-bottom:4px;";
    const body = b.createDiv();
    if (role === "assistant") {
      void MarkdownRenderer.render(this.app, text, body, "", this);
    } else {
      body.setText(text);
    }
    if (sources?.length) {
      const s = b.createEl("div", {
        text: "来源：" + sources.map(p => p.split("/").pop()).join("、"),
      });
      s.style.cssText = "font-size:0.72em; opacity:0.5; margin-top:6px;";
    }
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    return b;
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
      this.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
      if (this.history.length > 20) this.history = this.history.slice(-20);
    } catch (e) {
      thinking.remove();
      this.addBubble("assistant", "出错了：" + (e instanceof Error ? e.message : String(e)));
    }
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }
}
