// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionStatus } from "../shared/protocol";
import { SyntaxProgressPill } from "./progress-pill";

function status(partial: Partial<SessionStatus>): SessionStatus {
  return { state: "stopped", discovered: 0, queued: 0, ready: 0, failed: 0, ...partial };
}

describe("SyntaxProgressPill", () => {
  let pill: SyntaxProgressPill;

  beforeEach(() => {
    vi.useFakeTimers();
    pill = new SyntaxProgressPill();
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const host of document.documentElement.querySelectorAll("[data-syntax-progress-pill]")) {
      host.remove();
    }
  });

  const pillText = (pill: SyntaxProgressPill): string =>
    pill.host.shadowRoot!.querySelector(".pill")!.textContent.replace(/\s+/gu, " ").trim();

  const label = (): string =>
    pill.host
      .shadowRoot!.querySelector(".pill span:last-child")!
      .textContent.replace(/\s+/gu, " ")
      .trim();

  const spinnerVisible = (): boolean => {
    const spinner = pill.host.shadowRoot!.querySelector<HTMLElement>(".spinner")!;
    return spinner.style.display !== "none";
  };

  it("appears with live counts while the session is running", () => {
    const pill = new SyntaxProgressPill();

    pill.update(status({ state: "running", discovered: 5, queued: 3, ready: 2 }));

    expect(pill.host.isConnected).toBe(true);
    expect(pillText(pill)).toContain("句法解析中 2/5");
  });

  it("shows the paused state", () => {
    const pill = new SyntaxProgressPill();

    pill.update(status({ state: "paused", discovered: 5, queued: 3, ready: 2 }));

    expect(pillText(pill)).toContain("已暂停");
  });

  it("announces completion with failures and fades away", () => {
    const pill = new SyntaxProgressPill();

    pill.update(status({ state: "running", discovered: 5, ready: 4, failed: 1 }));

    expect(pillText(pill)).toContain("完成");
    expect(pillText(pill)).toContain("1 句失败");
    vi.advanceTimersByTime(2600);
    expect(pill.host.isConnected).toBe(false);
  });

  it("cancels a pending fade when new sentences arrive", () => {
    const pill = new SyntaxProgressPill();

    pill.update(status({ state: "running", discovered: 2, ready: 2 }));
    vi.advanceTimersByTime(1000);
    pill.update(status({ state: "running", discovered: 4, queued: 2, ready: 2 }));
    vi.advanceTimersByTime(2600);

    expect(pill.host.isConnected).toBe(true);
    expect(pillText(pill)).toContain("2/4");
  });

  it("stays purely presentational: pointer events pass through", () => {
    const pill = new SyntaxProgressPill();

    pill.update(status({ state: "running", discovered: 5, queued: 5 }));

    const styles = pill.host.shadowRoot!.querySelector("style")!.textContent;
    expect(styles).toMatch(/:host\s*\{[^}]*pointer-events:\s*none/u);
    expect(styles).toMatch(/\.pill\s*\{[^}]*pointer-events:\s*none/u);
  });

  it("disappears immediately when the session stops", () => {
    const pill = new SyntaxProgressPill();

    pill.update(status({ state: "running", discovered: 5, queued: 5 }));
    pill.update(status({ state: "stopped" }));

    expect(pill.host.isConnected).toBe(false);
  });

  it("shows detail prefetch progress after the core phase completes", () => {
    pill.update(
      status({
        state: "running",
        discovered: 2,
        ready: 2,
        detailTotal: 6,
        detailReady: 3,
        detailFailed: 1,
      }),
    );
    expect(label()).toBe("详解预载中 4/6");
    expect(spinnerVisible()).toBe(true);
  });

  it("mentions failed details in the completion text", () => {
    pill.update(
      status({
        state: "running",
        discovered: 2,
        ready: 2,
        detailTotal: 6,
        detailReady: 4,
        detailFailed: 2,
      }),
    );
    expect(label()).toBe("✓ 解析完成（2 个详解失败）");
  });

  it("keeps the plain completion text when prefetch is off", () => {
    pill.update(status({ state: "running", discovered: 2, ready: 2 }));
    expect(label()).toBe("✓ 解析完成");
  });

  it("notice 短暂展示提示文本后淡出", () => {
    pill.notice("未找到可解析的段落，请将鼠标悬停在正文段落上");

    expect(pill.host.isConnected).toBe(true);
    expect(label()).toBe("未找到可解析的段落，请将鼠标悬停在正文段落上");
    expect(spinnerVisible()).toBe(false);
    vi.advanceTimersByTime(2600);
    expect(pill.host.isConnected).toBe(false);
  });

  it("纯缓存会话说「查询缓存」而不是「句法解析」", () => {
    const pill = new SyntaxProgressPill(document);

    pill.update({
      state: "running",
      discovered: 6,
      queued: 3,
      ready: 1,
      failed: 0,
      skipped: 2,
      cacheOnly: true,
    });

    expect(pill.host.shadowRoot!.textContent).toContain("查询缓存中");
    expect(pill.host.shadowRoot!.textContent).not.toContain("句法解析");
  });

  // 漏掉 skipped 时，纯缓存模式下计数会一直停在 0——看起来像卡死了。
  it("进度计数把 skipped 算作已完成", () => {
    const pill = new SyntaxProgressPill(document);

    pill.update({
      state: "running",
      discovered: 6,
      queued: 1,
      ready: 1,
      failed: 1,
      skipped: 3,
      cacheOnly: true,
    });

    expect(pill.host.shadowRoot!.textContent).toContain("5/6");
  });

  it("纯缓存会话完成时报命中数，不说「解析完成」", () => {
    const pill = new SyntaxProgressPill(document);

    pill.update({
      state: "running",
      discovered: 4,
      queued: 0,
      ready: 1,
      failed: 0,
      skipped: 3,
      cacheOnly: true,
    });

    const text = pill.host.shadowRoot!.textContent ?? "";
    expect(text).toContain("缓存命中 1/4");
    expect(text).not.toContain("解析完成");
  });

  /**
   * 扫描登记完全部句子(相位 discovered)、视口回调还没把可见块推去派发时，
   * queued 与 inFlight 都是 0。这是会话真正的 t=0,以前会闪一下「✓ 解析完成」
   * 再退回「解析中」,还顺手起了淡出定时器——一句都没解析就先说完成。
   */
  it("句子刚发现、还没派发时不许说完成", () => {
    pill.update(status({ state: "running", discovered: 12, queued: 0, inFlight: 0 }));

    expect(label()).toBe("句法解析中 0/12");
    expect(spinnerVisible()).toBe(true);
    vi.advanceTimersByTime(2600);
    expect(pill.host.isConnected).toBe(true);
  });

  it("落地一句后回到既有的完成口径:屏外未触发的不阻塞", () => {
    pill.update(status({ state: "running", discovered: 12, queued: 0, ready: 1, inFlight: 0 }));

    expect(label()).toBe("✓ 解析完成");
  });
});
