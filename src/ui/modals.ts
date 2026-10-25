import { App, Modal, Platform } from "obsidian";

export function openModal<T>(make: (finish: (v: T) => void) => Modal, onCancel: T): Promise<T> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: T) => { if (!done) { done = true; resolve(v); } };
    const modal = make(finish);
    const close = modal.onClose.bind(modal);
    modal.onClose = () => { close(); finish(onCancel); };
    modal.open();
  });
}
function input(parent: HTMLElement, label: string, value: string): HTMLInputElement {
  const el = parent.createEl("input", { type: "text", value });
  el.setAttribute("aria-label", label);
  el.setAttribute("autocomplete", "off");
  el.addClass("cobrain-modal-input");
  return el;
}
function buttons(parent: HTMLElement, cancel: () => void, submit: () => void, label: string, destructive = false): void {
  const row = parent.createDiv({ cls: "cobrain-modal-actions" });
  row.createEl("button", { text: "取消" }).onclick = cancel;
  row.createEl("button", { text: label, cls: destructive ? "mod-warning" : "mod-cta" }).onclick = submit;
}
export function askPrompt(app: App, title: string, initial: string): Promise<string | null> {
  return openModal<string | null>(finish => new class extends Modal {
    onOpen(): void {
      this.contentEl.createEl("h3", { text: title });
      const field = input(this.contentEl, title, initial);
      const submit = () => { finish(field.value.trim() || null); this.close(); };
      field.onkeydown = e => { if (e.key === "Enter" && !e.isComposing && e.keyCode !== 229) submit(); };
      buttons(this.contentEl, () => this.close(), submit, "保存");
      if (!Platform.isMobile) { field.focus(); field.select(); }
    }
    onClose(): void { this.contentEl.empty(); }
  }(app), null);
}
export function askConfirm(app: App, title: string, message: string, okText = "确定"): Promise<boolean> {
  return openModal<boolean>(finish => new class extends Modal {
    onOpen(): void {
      this.contentEl.createEl("h3", { text: title });
      this.contentEl.createEl("p", { text: message });
      buttons(this.contentEl, () => this.close(), () => { finish(true); this.close(); }, okText, true);
    }
    onClose(): void { this.contentEl.empty(); }
  }(app), false);
}
export interface SaveOptions { title: string; body: string; append: boolean; }
export function askSaveOptions(app: App, title: string, body: string, appendDefault: boolean): Promise<SaveOptions | null> {
  return openModal<SaveOptions | null>(finish => new class extends Modal {
    onOpen(): void {
      this.contentEl.addClass("cobrain-save-modal");
      this.contentEl.createEl("h3", { text: "整理为笔记" });
      this.contentEl.createEl("p", { text: "确认内容与观点归属后保存。完整会话可在更多菜单中单独导出。", cls: "cobrain-muted" });
      const titleField = input(this.contentEl, "笔记标题", title);
      const bodyField = this.contentEl.createEl("textarea", { cls: "cobrain-note-preview" });
      bodyField.setAttribute("aria-label", "笔记正文，可编辑");
      bodyField.value = body;
      const label = this.contentEl.createEl("label", { cls: "cobrain-check-row" });
      const check = label.createEl("input", { type: "checkbox" });
      check.checked = appendDefault;
      label.createSpan({ text: "附上我的提问原文" });
      buttons(this.contentEl, () => this.close(), () => {
        if (!bodyField.value.trim()) { bodyField.focus(); return; }
        finish({ title: titleField.value.trim() || title, body: bodyField.value, append: check.checked });
        this.close();
      }, "保存笔记");
    }
    onClose(): void { this.contentEl.empty(); }
  }(app), null);
}
