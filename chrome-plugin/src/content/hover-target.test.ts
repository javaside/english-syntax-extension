// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { HOVER_CHAIN_SELECTOR, installHoverTracker, resolveHoverTarget } from "./hover-target";

/**
 * quirks 模式的实测症状:`document.querySelectorAll(":hover")` 恒为空集
 * (Chrome 的 hover/active quirk 只让链接匹配),于是快捷键整页都拿不到目标。
 * happy-dom 不实现这条 quirk,这里直接把两条来源都桩掉,钉的是取舍顺序;
 * 「必须用 `:is(:hover)` 查」由下面单独一条钉住选择器字面量。
 */
function stub(hoverChain: readonly Element[], atPoint: Element | null) {
  const doc = document;
  const chain = vi
    .spyOn(doc, "querySelectorAll")
    .mockReturnValue(hoverChain as unknown as ReturnType<Document["querySelectorAll"]>);
  const fromPoint = vi.spyOn(doc, "elementFromPoint").mockReturnValue(atPoint);
  return { doc, chain, fromPoint };
}

/**
 * 真机实测(Chromium,无 doctype 页面,鼠标停在 `#safe` 上):
 *   `:hover`      → 空集
 *   `:is(:hover)` → html > body > main > p#safe
 * quirk 只在「复合选择器里除伪类之外别无他物」时生效,`:is()` 让它落进子选择器语境。
 * 坐标兜底救不了这一条:快捷键冷启动时内容脚本才刚被注入,指针不动就永远等不到
 * 第一个 pointer 事件,`point` 恒为 undefined。
 */
describe("悬停链选择器", () => {
  it("查的是 :is(:hover) 而不是裸 :hover", () => {
    expect(HOVER_CHAIN_SELECTOR).toBe(":is(:hover)");
    const { doc, chain } = stub([], null);

    resolveHoverTarget(doc, undefined);

    expect(chain).toHaveBeenCalledWith(":is(:hover)");
  });
});

describe("resolveHoverTarget", () => {
  it("有 :hover 链时取最深那个,不查坐标", () => {
    const outer = document.createElement("div");
    const inner = document.createElement("p");
    const { doc, fromPoint } = stub([outer, inner], null);

    expect(resolveHoverTarget(doc, { x: 10, y: 20 })).toBe(inner);
    expect(fromPoint).not.toHaveBeenCalled();
  });

  it("悬停链为空(引擎没建立 hover 状态)时用最后的指针位置兜底", () => {
    const paragraph = document.createElement("p");
    const { doc, fromPoint } = stub([], paragraph);

    expect(resolveHoverTarget(doc, { x: 12, y: 34 })).toBe(paragraph);
    expect(fromPoint).toHaveBeenCalledWith(12, 34);
  });

  it("鼠标从未移动过就没有坐标可用,老老实实返回 null", () => {
    const { doc, fromPoint } = stub([], document.createElement("p"));

    expect(resolveHoverTarget(doc, undefined)).toBeNull();
    expect(fromPoint).not.toHaveBeenCalled();
  });
});

describe("installHoverTracker", () => {
  it("记住 pointermove 与 mousemove 的最新坐标", () => {
    const paragraph = document.createElement("p");
    const resolve = installHoverTracker(document);
    const { fromPoint } = stub([], paragraph);

    document.dispatchEvent(new MouseEvent("pointermove", { clientX: 5, clientY: 6 }));
    expect(resolve()).toBe(paragraph);
    expect(fromPoint).toHaveBeenLastCalledWith(5, 6);

    document.dispatchEvent(new MouseEvent("mousemove", { clientX: 70, clientY: 80 }));
    expect(resolve()).toBe(paragraph);
    expect(fromPoint).toHaveBeenLastCalledWith(70, 80);
  });

  it("挂在捕获阶段:页面在冒泡途中拦事件也照样记得住", () => {
    const paragraph = document.createElement("p");
    document.body.append(paragraph);
    paragraph.addEventListener("pointermove", (event) => event.stopPropagation());
    const resolve = installHoverTracker(document);
    const { fromPoint } = stub([], paragraph);

    paragraph.dispatchEvent(
      new MouseEvent("pointermove", { clientX: 44, clientY: 55, bubbles: true }),
    );

    expect(resolve()).toBe(paragraph);
    expect(fromPoint).toHaveBeenCalledWith(44, 55);
  });
});
