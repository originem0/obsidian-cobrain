import { App, Modal } from "obsidian";

// 把回调式 Modal 包成 Promise：done 守卫避免重复 resolve；覆写 onClose 兜底「关闭未提交=取消」。
// 多处 askX 共用，消除原先复制多遍的样板。
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

// okText：确认键文案跟随动作（删除/清空/确定…），别让「清空对话」的确认键写着「删除」。
export function askConfirm(app: App, title: string, message: string, okText = "确定"): Promise<boolean> {
  return openModal<boolean>(finish => new ConfirmModal(app, title, message, okText, finish), false);
}

export interface SaveOptions {
  title: string;
  append: boolean;
  image: boolean;
}

export function askSaveOptions(
  app: App,
  title: string,
  defaults: { append: boolean; hasImage: boolean },
): Promise<SaveOptions | null> {
  return openModal<SaveOptions | null>(
    finish => new SaveOptionsModal(app, title, defaults, finish),
    null,
  );
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
    private okText: string,
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
    const ok = row.createEl("button", { text: this.okText });
    ok.classList.add("mod-warning");
    cancel.onclick = () => { this.onPick(false); this.close(); };
    ok.onclick = () => { this.onPick(true); this.close(); };
  }
  onClose(): void {
    this.contentEl.empty();
  }
}

// 存为笔记的选项框：标题可编辑（LLM 起的标题不满意就地改，别让用户保存后再改文件名）
// + 附提问原文（默认随全局设置） + 配图（默认关）。按钮先回调再 close，避免与 onClose 的兜底重复 resolve。
class SaveOptionsModal extends Modal {
  constructor(
    app: App,
    private noteTitle: string,
    private defaults: { append: boolean; hasImage: boolean },
    private onPick: (v: SaveOptions | null) => void,
  ) {
    super(app);
  }
  onOpen(): void {
    this.contentEl.createEl("h3", { text: "存为笔记" });

    let append = this.defaults.append;
    let image = false;

    const titleInput = this.contentEl.createEl("input", { type: "text", value: this.noteTitle });
    titleInput.setCssStyles({ width: "100%", marginBottom: "4px" });
    titleInput.setAttribute("placeholder", "笔记标题");

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

    const submit = () => {
      // 标题被清空按取消编辑处理，回退 LLM 标题，不产出空文件名
      this.onPick({ title: titleInput.value.trim() || this.noteTitle, append, image });
      this.close();
    };
    titleInput.addEventListener("keydown", e => {
      if (e.key === "Enter") submit();
    });

    const row = this.contentEl.createDiv();
    row.setCssStyles({ display: "flex", gap: "8px", justifyContent: "flex-end", marginTop: "12px" });
    const cancel = row.createEl("button", { text: "取消" });
    const save = row.createEl("button", { text: "保存" });
    save.classList.add("mod-cta");
    cancel.onclick = () => { this.onPick(null); this.close(); };
    save.onclick = submit;
  }
  onClose(): void {
    this.contentEl.empty();
  }
}
