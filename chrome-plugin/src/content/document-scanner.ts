import { explicitCandidateText, inventoryReadableUnits } from "./page-inventory";

export interface CandidateBlock {
  id: string;
  element: Element;
  text: string;
}

const blockIds = new WeakMap<Element, string>();
let nextBlockId = 1;

function getBlockId(element: Element): string {
  const existing = blockIds.get(element);
  if (existing !== undefined) return existing;
  const id = `block-${nextBlockId++}`;
  blockIds.set(element, id);
  return id;
}

/**
 * 自动扫描 = 页面语义清单(`page-inventory.ts`)的 automatic 投影。
 *
 * 候选发现、分类型门槛(标题/`dt`/`th`/`caption` 有英文实词即可;`p/li/dd/td/
 * figcaption` 不吃统一 20 字符门;松散 `div/section/span` 保留门)、principal root、
 * 最小安全语义单元去重(`li>p`、`td>p`、`figcaption>p` 只进一个;`table/tr/figure`
 * 永不整体)都由 inventory 统一定义,这里只做投影——两条路径永远不会口径分叉。
 */
export function scanDocument(root: ParentNode): CandidateBlock[] {
  return inventoryReadableUnits(root)
    .filter(({ automatic }) => automatic)
    .map(({ element, text }) => ({ id: getBlockId(element), element, text }));
}

/**
 * 只服务用户显式手势(选中文本 / 快捷键悬停 / 右键此区域),所以不套用自动扫描
 * 那几道取舍:不要求落在得分最高的正文容器里(多 article 页面、SPA 换页后缓存失效
 * 都会误伤),也不设最短长度。指哪解析哪,歧义已由用户的鼠标消解;英文占比仍适用
 * (非英文内容照旧拒绝),密码框、代码、编辑区、隐藏内容和危险交互容器也仍然拒绝。
 */
export function nearestSafeBlock(target: EventTarget | null): CandidateBlock | null {
  const start =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (start === null) return null;
  if (
    start.matches("input[type='password'],textarea,[contenteditable]") ||
    start.closest("[contenteditable]") !== null
  ) {
    return null;
  }

  for (let current: Element | null = start; current !== null; current = current.parentElement) {
    const text = explicitCandidateText(current);
    if (text !== null) return { id: getBlockId(current), element: current, text };
  }
  return null;
}
