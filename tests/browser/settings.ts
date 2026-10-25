import { CobrainSettingTab, DEFAULT_SETTINGS } from "../../src/settings";

const w = window as any;
let modal: HTMLElement;
let tab: CobrainSettingTab;

w.openSettingsTest = (constrained = false) => {
  modal?.remove();
  modal = document.body.createDiv({ cls: "cobrain-settings-test-host" });
  modal.createDiv({ cls: "settings-test-title", text: "Cobrain 设置" });
  const frame = modal.createDiv({ cls: "vertical-tab-content-container" });
  const plugin: any = { settings: { ...DEFAULT_SETTINGS }, saveSettings: async () => undefined, saveSettingsDebounced: () => undefined };
  tab = new CobrainSettingTab({} as any, plugin);
  frame.appendChild(tab.containerEl);
  // Include a host that clips content: the plugin must own its scroll region.
  modal.classList.toggle("constrained-settings", constrained);
  tab.display();
  tab.containerEl.querySelectorAll("details").forEach(el => { el.open = true; });
};
w.settingsLayout = () => {
  const scroller = tab.containerEl;
  const controls = [...scroller.querySelectorAll<HTMLElement>("textarea, button, input, select")];
  const view = scroller.getBoundingClientRect();
  const wheelMoved = scroller.scrollTop > 0;
  scroller.scrollTop = scroller.scrollHeight;
  const last = [...scroller.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
  const bottom = last.getBoundingClientRect();
  const topAfter = scroller.scrollTop;
  const overflowY = getComputedStyle(scroller).overflowY;
  const prompts = [...scroller.querySelectorAll<HTMLTextAreaElement>("textarea")].slice(-3);
  return {
    width: innerWidth, height: innerHeight, overflowY, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
    scrollTop: topAfter, wheelMoved, canScroll: /auto|scroll/.test(overflowY) && topAfter > 0,
    lastControlVisible: bottom.top >= view.top && bottom.bottom <= view.bottom,
    controlsFit: controls.every(el => { const r = el.getBoundingClientRect(); return r.left >= view.left && r.right <= view.right; }),
    promptWidths: prompts.map(el => el.getBoundingClientRect().width),
    openPanels: scroller.querySelectorAll("details[open]").length,
  };
};
w.settingsScrollTarget = () => {
  tab.containerEl.scrollTop = 0;
  const view = tab.containerEl.getBoundingClientRect();
  return { x: view.right - 8, y: view.top + 80 };
};
w.closeSettingsTest = () => modal.remove();
