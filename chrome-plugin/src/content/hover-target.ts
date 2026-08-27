/**
 * 「鼠标现在指着哪个元素」的解析器。
 *
 * 不能查裸 `:hover`:**quirks 模式**(页面没有 doctype)下 Chrome 按
 * [hover/active quirk](https://quirks.spec.whatwg.org/#the-active-and-hover-quirk)
 * 只让链接匹配,`querySelectorAll(":hover")` 于是**整页恒为空集**——`compatMode=BackCompat`
 * 的页面按快捷键只能得到「未找到可解析的段落」,而不是某个段落被拒。
 *
 * 而该 quirk 只在「复合选择器里除伪类之外别无他物」时生效,把 `:hover` 塞进 `:is()`
 * 就落进子选择器语境、不再适用。实测同一 quirks 页面同一位置:`:hover` → 空,
 * `:is(:hover)` → `html > body > main > p#safe`;标准模式下二者恒等,所以一律用后者,
 * 不必先探文档模式。`:is()` 自 Chrome 88 起可用,本扩展要求 120。
 *
 * `elementFromPoint` 只作最后兜底:引擎压根没建立 hover 状态时(如指针已移出窗口),
 * 最后见到的指针位置是唯一线索。它不足以替代 `:is(:hover)`——快捷键常常是**冷启动**,
 * 内容脚本正是被这一按注入的,此后指针不动就永远等不到第一个 pointer 事件。
 * 反过来监听也必须在装载时就挂(而不是等建会话):用户早在按键之前就把鼠标放好了。
 */
/** 悬停链选择器。导出是为了让测试钉住 `:is()` 这层包装,它是 quirks 页面唯一的指望。 */
export const HOVER_CHAIN_SELECTOR = ":is(:hover)";

export function installHoverTracker(doc: Document): () => Element | null {
  let point: { readonly x: number; readonly y: number } | undefined;
  const remember = (event: Event): void => {
    const { clientX, clientY } = event as MouseEvent;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    point = { x: clientX, y: clientY };
  };
  // 捕获阶段:页面自己在冒泡途中 stopPropagation 也挡不住我们。passive:纯记坐标,
  // 别让这个监听有阻塞滚动的资格。
  const options = { capture: true, passive: true } as const;
  // pointermove 覆盖鼠标 / 触控笔;个别页面(以及一些自动化驱动)只派发 mouse 事件。
  doc.addEventListener("pointermove", remember, options);
  doc.addEventListener("mousemove", remember, options);
  return () => resolveHoverTarget(doc, point);
}

/** 解析逻辑单独暴露,便于直接钉住两条分支。 */
export function resolveHoverTarget(
  doc: Document,
  point: { readonly x: number; readonly y: number } | undefined,
): Element | null {
  // `:is()` 不能省:裸 `:hover` 在 quirks 页面恒为空集(见文件头)。
  const chain = doc.querySelectorAll(HOVER_CHAIN_SELECTOR);
  const hovered = chain.length > 0 ? chain[chain.length - 1] : undefined;
  if (hovered !== undefined) return hovered;
  if (point === undefined) return null;
  // 视口坐标:页面滚动不会让它失效,不需要跟着换算。
  return doc.elementFromPoint(point.x, point.y);
}
