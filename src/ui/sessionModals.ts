import { App, FuzzySuggestModal, Modal, TFile } from "obsidian";
import type CobrainPlugin from "../main";
import type { ChatSession, MaterialReference, MaterialOrigin, SessionInfo } from "../chat/session";

export class SessionPicker extends FuzzySuggestModal<SessionInfo> {
  constructor(app: App, private plugin: CobrainPlugin, private choose: (id: string) => void) {
    super(app); this.setPlaceholder("搜索历史会话…");
  }
  getItems(): SessionInfo[] { return this.plugin.sessions.list(); }
  getItemText(item: SessionInfo): string { return `${item.title} · ${new Date(item.updatedAt).toLocaleDateString()}`; }
  onChooseItem(item: SessionInfo): void { this.choose(item.id); }
}
export class NotePicker extends FuzzySuggestModal<TFile> {
  constructor(app: App, private choose: (file: TFile) => void) { super(app); this.setPlaceholder("选择要加入讨论的文档…"); }
  getItems(): TFile[] { return this.app.vault.getMarkdownFiles(); }
  getItemText(file: TFile): string { return file.path.replace(/\.md$/i, ""); }
  onChooseItem(file: TFile): void { this.choose(file); }
}
export class MaterialModal extends Modal {
  constructor(app: App, private plugin: CobrainPlugin, private session: ChatSession, private changed: () => void) { super(app); }
  onOpen(): void { this.paint(); }
  private change(): void { this.changed(); this.paint(); }
  private add(reference: MaterialReference): void {
    if (!this.session.materials.some(m => m.id === reference.id)) this.session.materials.push(reference);
    this.change();
  }
  private paint(): void {
    const el = this.contentEl;
    el.empty(); el.addClass("cobrain-material-modal");
    el.createEl("h3", { text: "本会话的讨论范围" });
    el.createEl("p", { text: "只读取下面明确附加的材料。切换笔记不会自动改变范围；文档读取最新内容，选文保留原文快照。移除材料只影响后续读取，已发生的聊天记录仍然保留。", cls: "cobrain-muted" });
    const actions = el.createDiv({ cls: "cobrain-modal-actions cobrain-material-actions" });
    actions.createEl("button", { text: "添加文档" }).onclick = () => new NotePicker(this.app, file => this.add(this.plugin.documentReference(file))).open();
    const current = this.plugin.currentDocument();
    const replace = actions.createEl("button", { text: "改为当前文档" });
    replace.disabled = !current;
    if (current) replace.title = current.path;
    replace.onclick = () => {
      const file = this.plugin.currentDocument();
      if (file) { this.session.materials = [this.plugin.documentReference(file)]; this.change(); }
    };
    if (!this.session.materials.length) el.createEl("p", { text: "尚未附加文档。当前会话只使用聊天内容。", cls: "cobrain-muted" });
    for (const material of this.session.materials) {
      const row = el.createDiv({ cls: "cobrain-material-row" });
      const text = row.createDiv({ cls: "cobrain-material-description" });
      const link = text.createEl("a", { text: material.path.replace(/\.md$/i, ""), href: "#" });
      link.onclick = e => { e.preventDefault(); void this.app.workspace.openLinkText(material.path, ""); };
      text.createDiv({ text: material.kind === "selection" ? `选文快照${material.heading ? ` · ${material.heading}` : ""}` : "整篇文档", cls: "cobrain-muted" });
      if (material.kind === "selection") text.createDiv({ text: material.text?.slice(0, 120) ?? "", cls: "cobrain-selection-preview" });
      const controls = row.createDiv({ cls: "cobrain-material-controls" });
      const origin = controls.createEl("select");
      origin.setAttribute("aria-label", `${material.path} 的观点归属`);
      for (const [value, label] of [["unknown", "归属未确认"], ["self", "我的笔记"], ["external", "外部材料"], ["generated", "AI 整理"]]) {
        origin.createEl("option", { value, text: label });
      }
      origin.value = material.origin;
      origin.onchange = () => { material.origin = origin.value as MaterialOrigin; this.changed(); };
      const remove = controls.createEl("button", { text: "移除" });
      remove.setAttribute("aria-label", `从本会话移除 ${material.path}`);
      remove.onclick = () => { this.session.materials = this.session.materials.filter(m => m.id !== material.id); this.change(); };
    }
    const done = el.createDiv({ cls: "cobrain-modal-actions" });
    done.createEl("button", { text: "完成", cls: "mod-cta" }).onclick = () => this.close();
  }
  onClose(): void { this.contentEl.empty(); }
}
