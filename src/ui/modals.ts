import { App, Modal } from "obsidian";

// 把回调式 Modal 包成 Promise：done 守卫避免重复 resolve；覆写 onClose 兜底「关闭未提交=取消」。
// 五处 askX 共用，消除原先复制五遍的样板。
export function openModal<T>(make: (finish: (v: T) => void) => Modal, onCancel: T): Promise<T> {
  return new Promise(resolve => {
    let done = false;
    const finish = (v: T) => { if (!done) { done = true; resolve(v); } };
    const m = make(finish);
    const close = m.onClose.bind(m);
    m.onClose = () => { close(); finish(onCancel); };
    m.open();
  });
}

export function askPrompt(app: App, title: string, initial: string): Promise<string | null> {
  return openModal<string | null>(finish => new PromptModal(app, title, initial, v => finish(v || null)), null);
}

export function askTextArea(app: App, title: string, initial: string): Promise<string | null> {
  return openModal<string | null>(finish => new TextAreaModal(app, title, initial, v => finish(v || null)), null);
}

export function askConfirm(app: App, title: string, message: string): Promise<boolean> {
  return openModal<boolean>(finish => new ConfirmModal(app, title, message, finish), false);
}

export function askSaveOptions(
  app: App,
  title: string,
  defaults: { append: boolean; hasImage: boolean },
): Promise<{ append: boolean; image: boolean } | null> {
  return openModal<{ append: boolean; image: boolean } | null>(
    finish => new SaveOptionsModal(app, title, defaults, finish),
    null,
  );
}

export function askDraftChoice(app: App, id: number): Promise<"restore" | "new" | null> {
  return openModal<"restore" | "new" | null>(finish => new DraftChoiceModal(app, id, finish), null);
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

// 打开已有草稿的槽位时询问：恢复 / 新建 / 取消。
class DraftChoiceModal extends Modal {
  constructor(
    app: App,
    private id: number,
    private onPick: (v: "restore" | "new" | null) => void,
  ) { super(app); }

  onOpen() {
    this.contentEl.createEl("h3", { text: `创作副脑 #${this.id} 有未结束草稿` });
    this.contentEl.createEl("p", { text: "恢复会继续上次对话。新建会清空这个槽位的草稿。" });
    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "12px", flexWrap: "wrap" });
    const cancel = row.createEl("button", { text: "取消" });
    const fresh = row.createEl("button", { text: "新建空对话" });
    const restore = row.createEl("button", { text: "恢复草稿" });
    restore.classList.add("mod-cta");
    cancel.onclick = () => { this.onPick(null); this.close(); };
    fresh.onclick = () => { this.onPick("new"); this.close(); };
    restore.onclick = () => { this.onPick("restore"); this.close(); };
  }

  onClose() { this.contentEl.empty(); }
}
