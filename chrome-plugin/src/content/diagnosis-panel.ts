import type { BlockDiagnosis, DiagnosisExplanation } from "../shared/protocol";
import type { ExtensionError } from "../shared/errors";
import { formatDiagnosisReport } from "./block-diagnosis";

const STYLES = `
  :host { all: initial; }
  .panel {
    all: initial;
    position: fixed; right: 16px; bottom: 64px; z-index: 2147483647;
    max-width: min(560px, calc(100vw - 32px)); max-height: 60vh; overflow: auto;
    font: 13px/1.6 system-ui, sans-serif; color: #111;
    background: #fff; border: 1px solid #d4d4d8; border-radius: 10px;
    padding: 12px 14px; box-shadow: 0 8px 24px rgba(0,0,0,.18);
  }
  /* 面板本身可交互——与 progress-pill 不同,这里刻意不写 pointer-events: none。 */
  .header { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  h4 { margin: 8px 0 4px; font-size: 12px; color: #52525b; }
  .privacy { font-size: 11px; color: #71717a; margin: 4px 0 8px; }
  .gate-table { border-collapse: collapse; font-size: 12px; }
  .gate-table td, .gate-table th { border: 1px solid #e4e4e7; padding: 1px 6px; }
  .model-pending { color: #71717a; }
  .model-error { color: #b91c1c; }
  .toolbar { display: flex; gap: 8px; margin-top: 8px; }
  button { all: initial; font: inherit; cursor: pointer; padding: 3px 10px;
    border: 1px solid #a1a1aa; border-radius: 6px; }
  button.primary { background: #18181b; color: #fff; }
  textarea { width: 100%; height: 120px; font: 11px/1.4 monospace; margin-top: 8px;
    box-sizing: border-box; }
`;

/**
 * 段落诊断面板:host + open shadow root(结构照 progress-pill)。本地证据立即渲染,
 * 模型解释段按 requestId 防过期地更新;report() 在点击复制时才组装完整 markdown。
 */
export class DiagnosisPanel {
  readonly host: HTMLElement;
  readonly #doc: Document;
  readonly #root: HTMLDivElement;
  #diagnosis?: BlockDiagnosis;
  #model?: DiagnosisExplanation;
  #modelError?: ExtensionError;
  #profile?: { model: string };
  #latestRequestId?: string;
  #modelSection: HTMLDivElement | undefined;

  constructor(doc: Document = document) {
    this.#doc = doc;
    this.host = doc.createElement("div");
    this.host.dataset.syntaxDiagnosisPanel = "";
    const shadow = this.host.attachShadow({ mode: "open" });
    const style = doc.createElement("style");
    style.textContent = STYLES;
    this.#root = doc.createElement("div");
    this.#root.className = "panel";
    shadow.append(style, this.#root);
  }

  /** 单例复用:再次 show 就地重渲染,并丢弃上一轮的模型状态。 */
  show(diagnosis: BlockDiagnosis): void {
    this.#diagnosis = diagnosis;
    this.#resetModelState();
    this.#render();
    if (!this.host.isConnected) this.#doc.documentElement.append(this.host);
  }

  /** 记录最新请求并回到等待态:同一面板上发起的新请求不能沿用旧解释。 */
  trackRequest(requestId: string): void {
    this.#latestRequestId = requestId;
    this.#resetModelState();
    this.#renderModelSection();
  }

  updateModel(result: {
    requestId: string;
    model?: DiagnosisExplanation;
    modelError?: ExtensionError;
    profile?: { model: string };
  }): void {
    // requestId 即 generation(spec D5/重要7):晚到的旧响应直接丢弃。
    if (result.requestId !== this.#latestRequestId) return;
    this.#model = result.model;
    this.#modelError = result.modelError;
    this.#profile = result.profile;
    this.#renderModelSection();
  }

  report(): string {
    if (this.#diagnosis === undefined) return "";
    return formatDiagnosisReport(this.#diagnosis, {
      ...(this.#model === undefined ? {} : { model: this.#model }),
      ...(this.#modelError === undefined ? {} : { modelError: this.#modelError }),
      ...(this.#profile === undefined ? {} : { profileModel: this.#profile.model }),
      generatedAt: new Date().toISOString(),
    });
  }

  close(): void {
    this.host.remove();
  }

  #resetModelState(): void {
    this.#model = undefined;
    this.#modelError = undefined;
    this.#profile = undefined;
  }

  #render(): void {
    const d = this.#diagnosis;
    if (d === undefined) return;
    const doc = this.#doc;
    const title = doc.createElement("strong");
    title.textContent = "这段为什么没被翻译";
    const close = doc.createElement("button");
    close.textContent = "关闭";
    close.addEventListener("click", () => this.close());
    const header = doc.createElement("div");
    header.className = "header";
    header.append(title, close);
    const privacy = doc.createElement("p");
    privacy.className = "privacy";
    privacy.textContent =
      "报告含页面 URL 与截断 HTML，粘贴到外部工具前请自查。模型解释会把判定证据（不含 URL 与 HTML）发送给你配置的模型服务。";
    const evidence = doc.createElement("div");
    evidence.append(this.#heading("本地判定证据"));
    const firstFailing = d.gates.find(({ ok }) => !ok);
    const summary = doc.createElement("p");
    summary.textContent = firstFailing
      ? `第一个失败门：${firstFailing.gate}${firstFailing.value === undefined ? "" : `（取值 ${firstFailing.value}）`}`
      : "所有扫描门均通过";
    evidence.append(summary);
    const table = doc.createElement("table");
    table.className = "gate-table";
    for (const { gate, ok, value } of d.gates) {
      const row = table.insertRow();
      row.insertCell().textContent = gate;
      row.insertCell().textContent = ok ? "✅" : "❌";
      row.insertCell().textContent = value === undefined ? "" : String(value);
    }
    evidence.append(table);
    const modelSection = doc.createElement("div");
    modelSection.className = "model-section";
    const toolbar = doc.createElement("div");
    toolbar.className = "toolbar";
    const copy = doc.createElement("button");
    copy.className = "primary copy";
    copy.textContent = "复制诊断报告";
    copy.addEventListener("click", () => void this.#copy(copy));
    toolbar.append(copy);
    this.#modelSection = modelSection;
    this.#renderModelSection();
    this.#root.replaceChildren(header, privacy, evidence, modelSection, toolbar);
  }

  #renderModelSection(): void {
    const section = this.#modelSection;
    if (section === undefined) return;
    section.replaceChildren(this.#heading("模型解释"));
    if (this.#model !== undefined) {
      const cause = this.#doc.createElement("p");
      cause.textContent = `likelyCause: ${this.#model.likelyCause}`;
      const body = this.#doc.createElement("p");
      body.textContent = this.#model.explanation;
      section.append(
        cause,
        body,
        ...this.#model.suggestions.map((item) => {
          const li = this.#doc.createElement("div");
          li.textContent = `- ${item}`;
          return li;
        }),
      );
      return;
    }
    const status = this.#doc.createElement("p");
    status.className = this.#modelError === undefined ? "model-pending" : "model-error";
    status.textContent =
      this.#modelError === undefined
        ? "模型解释生成中…"
        : `模型解释不可用：${this.#modelError.code}：${this.#modelError.message}（本地证据仍完整）`;
    section.append(status);
  }

  #heading(text: string): HTMLHeadingElement {
    const h = this.#doc.createElement("h4");
    h.textContent = text;
    return h;
  }

  async #copy(button: HTMLButtonElement): Promise<void> {
    const report = this.report();
    try {
      await navigator.clipboard.writeText(report);
      button.textContent = "已复制";
      return;
    } catch {
      // 非安全上下文 / 权限拒绝:展开已全选的只读 textarea 兜底(在 shadow root 内、
      // 非 button 内,因此可聚焦可选可手动复制)。重复点击时替换旧兜底,不叠罗汉。
      const area = this.#doc.createElement("textarea");
      area.readOnly = true;
      area.value = report;
      this.#root.querySelector("textarea")?.remove();
      this.#root.append(area);
      area.focus();
      area.select();
      button.textContent = "请按 ⌘C / Ctrl+C 复制";
    }
  }
}
