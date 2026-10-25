// Browser-only host adapter. The production view, session store and Tutor are bundled unchanged.
function create(parent: HTMLElement, tag: string, options: any = {}): HTMLElement {
  if (typeof options === "string") options = { cls: options };
  const el = document.createElement(tag);
  if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(" ") : options.cls;
  if (options.text !== undefined) el.textContent = options.text;
  for (const [key, value] of Object.entries(options.attr ?? {})) el.setAttribute(key, String(value));
  for (const key of ["type", "value", "href"]) if (options[key] !== undefined) (el as any)[key] = options[key];
  parent.appendChild(el); return el;
}
Object.assign(HTMLElement.prototype, {
  empty() { (this as HTMLElement).replaceChildren(); },
  createEl(tag: string, options: any) { return create(this, tag, options); },
  createDiv(options: any) { return create(this, "div", options); },
  createSpan(options: any) { return create(this, "span", options); },
  addClass(...names: string[]) { this.classList.add(...names); },
  removeClass(...names: string[]) { this.classList.remove(...names); },
  setText(text: string) { this.textContent = text; },
  setCssStyles(styles: any) { Object.assign(this.style, styles); },
});
export class Component {
  children: Component[] = [];
  cleanup: (() => void)[] = [];
  register(cb: () => void) { this.cleanup.push(cb); }
  addChild<T extends Component>(child: T): T { this.children.push(child); return child; }
  removeChild<T extends Component>(child: T): T { this.children = this.children.filter(c => c !== child); child.unload(); return child; }
  unload() { for (const cb of this.cleanup) cb(); for (const child of this.children) child.unload(); this.children = []; }
}
export class ItemView extends Component {
  app: any; contentEl: HTMLElement;
  constructor(public leaf: any) { super(); this.app = leaf.app; this.contentEl = leaf.contentEl; }
  async setState() {}
}
export class TFile {
  extension = "md"; basename: string; parent: { path: string };
  constructor(public path: string) { this.basename = path.split("/").pop()!.replace(/\.md$/, ""); this.parent = { path: path.split("/").slice(0, -1).join("/") }; }
}
export class TFolder {}
export class WorkspaceLeaf {}
export class App {}
export class PluginSettingTab {}
export class Setting {}
export class DropdownComponent {}
export class Plugin {}
export const Platform = { isMobile: true };
export const setIcon = (el: HTMLElement, icon: string) => {
  const paths: Record<string, string> = { history: "◷", plus: "+", "more-horizontal": "···" };
  el.textContent = paths[icon] ?? "·";
};
export const normalizePath = (path: string) => path.replace(/\\/g, "/");
export const requestUrl = () => { throw new Error("Unexpected network request"); };
export class Notice {
  static messages: string[] = [];
  constructor(text: string) { Notice.messages.push(text); }
}
export const MarkdownRenderer = { async render(_app: any, text: string, el: HTMLElement) { el.textContent = text; el.style.whiteSpace = "pre-wrap"; } };
export class Modal {
  contentEl: any; containerEl: HTMLElement;
  constructor(public app: any) {
    this.containerEl = document.createElement("div"); this.containerEl.className = "modal-container";
    this.contentEl = create(this.containerEl, "div", { cls: "modal", attr: { role: "dialog" } });
  }
  open() { document.body.appendChild(this.containerEl); (this as any).onOpen?.(); }
  close() { this.onClose(); this.containerEl.remove(); }
  onClose() {}
}
export class FuzzySuggestModal<T> extends Modal {
  placeholder = "";
  setPlaceholder(text: string) { this.placeholder = text; }
  onOpen() {
    const field = create(this.contentEl, "input", { attr: { "aria-label": this.placeholder, placeholder: this.placeholder } }) as HTMLInputElement;
    const list = create(this.contentEl, "div");
    const draw = () => {
      list.replaceChildren();
      for (const item of (this as any).getItems().filter((item: T) => (this as any).getItemText(item).includes(field.value))) {
        const button = create(list, "button", { cls: "suggestion-item", text: (this as any).getItemText(item) });
        button.onclick = () => { this.close(); (this as any).onChooseItem(item); };
      }
    };
    field.oninput = draw; draw();
  }
}
export class Menu {
  items: any[] = [];
  addSeparator() {}
  addItem(build: (item: any) => void) {
    const item: any = { title: "", disabled: false, setTitle(t: string) { this.title = t; return this; }, setIcon() { return this; }, setDisabled(value: boolean) { this.disabled = value; return this; }, onClick(fn: any) { this.action = fn; return this; } };
    build(item); this.items.push(item); return this;
  }
  showAtMouseEvent() {
    const menu = create(document.body, "div", { cls: "menu", attr: { role: "menu" } });
    for (const item of this.items) {
      const button = create(menu, "button", { text: item.title, attr: { role: "menuitem" } }) as HTMLButtonElement;
      button.disabled = item.disabled;
      button.onclick = () => { menu.remove(); item.action(); };
    }
  }
}
