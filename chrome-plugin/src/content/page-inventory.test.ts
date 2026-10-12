// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import {
  explainElement,
  explicitCandidateText,
  inventoryReadableUnits,
  type ReadableUnit,
} from "./page-inventory";
import { scanDocument } from "./document-scanner";
import { normalizedReadableText } from "./readable-dom-text";

const unitKinds = [
  "heading",
  "paragraph",
  "list-item",
  "definition-term",
  "definition-body",
  "table-caption",
  "table-header",
  "table-cell",
  "figure-caption",
  "callout",
  "footnote",
  "reference-title",
  "loose-block",
] as const;

const requiredExclusionReasons = [
  "outside-principal-content",
  "excluded-region",
  "unsafe-interactive",
  "hidden",
  "non-english",
  "no-readable-words",
  "loose-block-too-short",
  "display-math",
  "math-auxiliary",
  "conversion-placeholder",
  "reference-metadata",
  "unsupported-reference-layout",
  "covered-by-child",
  "unsafe-partial-replacement",
] as const;

type ExpectedUnit = {
  id: string;
  kind: (typeof unitKinds)[number];
  text: string;
  automatic: boolean;
  reason: (typeof requiredExclusionReasons)[number] | null;
};

type InventoryContract = {
  sourceUrl: string;
  capturedAt: string;
  units: ExpectedUnit[];
};

const fixtures = ["spring-ai-coverage", "arxiv-paper-coverage"] as const;
const fixturePath = (name: string, extension: "html" | "json") =>
  resolve(
    import.meta.dirname,
    `../../tests/fixtures/${extension === "html" ? "pages" : "page-inventory"}/${name}.${extension}`,
  );
const readFixture = (name: (typeof fixtures)[number], extension: "html" | "json") =>
  readFileSync(fixturePath(name, extension), "utf8");
// happy-dom 的 Document 与 TS lib.dom 的 Document 类型不互通;fixture 页需要独立的
// window 实例(避免 document.body 复用污染),断言统一走 DOM lib 类型。
const parsePage = (html: string): Document => {
  const window = new Window();
  window.document.write(html);
  return window.document as unknown as Document;
};

describe("Task 5 page inventory denominator", () => {
  it("covers every required exclusion reason across the frozen contracts", () => {
    const reasons = fixtures.flatMap((fixtureName) =>
      (JSON.parse(readFixture(fixtureName, "json")) as InventoryContract).units.map(
        ({ reason }) => reason,
      ),
    );

    expect(new Set(reasons.filter((reason) => reason !== null))).toEqual(
      new Set(requiredExclusionReasons),
    );
  });
});

describe.each(fixtures)("%s page inventory contract", (fixtureName) => {
  const contract = () => JSON.parse(readFixture(fixtureName, "json")) as InventoryContract;
  const document = () => parsePage(readFixture(fixtureName, "html"));

  const auditElement = (page: Document, id: string): Element =>
    page.querySelector(`[data-audit-id="${id}"]`)!;

  const inventoryProjection = (page: Document) =>
    inventoryReadableUnits(page).map(({ id, kind, text, automatic, exclusionReason }) => ({
      id,
      kind,
      text,
      automatic,
      reason: exclusionReason ?? null,
    }));

  it("classifies every audit id exactly once without dangling contract entries", () => {
    const page = document();
    const expected = contract();
    const domIds = Array.from(page.querySelectorAll("[data-audit-id]")).map(
      (element) => element.attributes.getNamedItem("data-audit-id")?.value ?? "",
    );
    const contractIds = expected.units.map(({ id }) => id);

    expect(expected.capturedAt).toBe("2026-09-08");
    expect(expected.sourceUrl).toMatch(/^https:\/\//u);
    expect(new Set(domIds).size).toBe(domIds.length);
    expect(new Set(contractIds).size).toBe(contractIds.length);
    expect(contractIds).toEqual(domIds);
    // 生产归一化提取文本——不再是 Task 5 的测试内 helper(义务 a:行为断言替换)。
    expect(
      expected.units.map(({ id }) => ({
        id,
        text: normalizedReadableText(auditElement(page, id)),
      })),
    ).toEqual(expected.units.map(({ id, text }) => ({ id, text })));
    expect(expected.units.every(({ kind }) => unitKinds.includes(kind))).toBe(true);
    expect(
      expected.units.every(({ automatic, reason }) =>
        automatic ? reason === null : reason !== null,
      ),
    ).toBe(true);
    // 义务 c:contract unit 必须是恰好五个键,杜绝悄悄加字段的口子。
    expect(expected.units.map((unit) => Object.keys(unit))).toEqual(
      expected.units.map(() => ["id", "kind", "text", "automatic", "reason"]),
    );
  });

  it("matches the frozen contract exactly with the production inventory", () => {
    const expected = contract().units;

    expect(inventoryProjection(document())).toEqual(expected);
  });

  it("types production units with exactly the frozen ReadableUnit keys", () => {
    const units = inventoryReadableUnits(document());

    expect(units.length).toBeGreaterThan(0);
    // exclusionReason 是可选键:automatic 单元不携带它,排除单元恰好携带它。
    expect(units.map((unit) => Object.keys(unit))).toEqual(
      units.map((unit) =>
        unit.automatic
          ? ["id", "element", "kind", "text", "automatic"]
          : ["id", "element", "kind", "text", "automatic", "exclusionReason"],
      ),
    );
    expect(units.every(({ element }) => element instanceof Element)).toBe(true);
    expect(
      units.every((unit) =>
        unit.automatic ? unit.exclusionReason === undefined : unit.exclusionReason !== undefined,
      ),
    ).toBe(true);
  });

  it("projects exactly the automatic units through the automatic scanner", () => {
    const page = document();
    const expectedAutomatic = contract()
      .units.filter(({ automatic }) => automatic)
      .map(({ id }) => id);
    const discovered = scanDocument(page).map(
      ({ element }) => element.attributes.getNamedItem("data-audit-id")?.value,
    );

    expect(discovered).toEqual(expectedAutomatic);
  });
});

describe("作者邮箱元数据排除(D3)", () => {
  function inventoryOf(markup: string): Map<string, ReadableUnit> {
    document.body.innerHTML = markup;
    return new Map(
      inventoryReadableUnits(document).map((unit) => [
        unit.element.id || unit.text.slice(0, 30),
        unit,
      ]),
    );
  }

  it("整块由邮箱与转换残留构成时按 reference-metadata 排除", () => {
    const units = inventoryOf(
      '<main><p id="emails">show]Rachel.Gray@glasgow.ac.uk ]Daniel.Williams@glasgow.ac.uk ]a.papadopoulos.1@research.gla.ac.uk</p></main>',
    );
    expect(units.get("emails")?.automatic).toBe(false);
    expect(units.get("emails")?.exclusionReason).toBe("reference-metadata");
  });

  it("正文里出现的邮箱不触发排除(反向保留)", () => {
    const units = inventoryOf(
      '<main><p id="contact">Contact us at author@example.org for details.</p></main>',
    );
    expect(units.get("contact")?.automatic).toBe(true);
    expect(units.get("contact")?.exclusionReason).toBeUndefined();
  });

  it("单邮箱作者行同样排除", () => {
    const units = inventoryOf('<main><p id="one">author@example.org</p></main>');
    expect(units.get("one")?.exclusionReason).toBe("reference-metadata");
  });
});

/** 义务 b:covered-by-child 的方向语义——父被子吸收,而不是子被父吸收。 */
describe("covered-by-child 方向语义", () => {
  function inventoryOf(markup: string): Map<string, ReadableUnit> {
    document.body.innerHTML = markup;
    return new Map(inventoryReadableUnits(document).map((unit) => [unit.element.id, unit]));
  }

  it("把内联 math 标记为被其段落父吸收,而不是把段落吸收进 math", () => {
    const units = inventoryOf(
      `<main><p id="host">Sentence with inline <math id="math" data-audit-id="math" alttext="H0"><mi>H</mi><mn>0</mn></math> value.</p></main>`,
    );

    expect(units.get("host")?.automatic).toBe(true);
    expect(units.get("host")?.exclusionReason).toBeUndefined();
    // 方向:子(math)记 covered-by-child——它的文本已被父段落的单元覆盖。
    expect(units.get("math")?.automatic).toBe(false);
    expect(units.get("math")?.exclusionReason).toBe("covered-by-child");
  });

  it("把文本完全由子单元组成的父容器记为 covered-by-child", () => {
    const units = inventoryOf(
      `<main><ul id="list" data-audit-id="list"><li id="item">Combine galaxy catalogues with observations.</li></ul></main>`,
    );

    expect(units.get("list")?.exclusionReason).toBe("covered-by-child");
    expect(units.get("item")?.automatic).toBe(true);
  });

  it("父带不可安全分离的直接文本时记 unsafe-partial-replacement", () => {
    const units = inventoryOf(
      `<main><div id="parent" data-audit-id="parent">Direct prose stays here.<p id="child">A safe nested paragraph is readable.</p></div></main>`,
    );

    expect(units.get("parent")?.exclusionReason).toBe("unsafe-partial-replacement");
    expect(units.get("child")?.automatic).toBe(true);
  });
});

/**
 * header 条件排除:Mintlify 一类站点把页面引导段落(h1 + 描述)渲染在 `<header>`
 * 里。header 只有在站点横幅位置(不被 article/main/section/[role=main] 包住)时才
 * 是导航噪声;正文容器内的 header 是页面自己的标题区,必须照常进清单。
 */
describe("header 条件排除(站点横幅 vs 内容标题区)", () => {
  function inventoryOf(markup: string): Map<string, ReadableUnit> {
    document.body.innerHTML = markup;
    return new Map(inventoryReadableUnits(document).map((unit) => [unit.element.id, unit]));
  }

  it("main 内 header 的标题与引导段落进自动清单(Mintlify 页头)", () => {
    const units = inventoryOf(
      `<main><header id="page-header"><h1 id="title">30 Days of HyperFrames</h1><p id="lead">The official lessons, collected in one place as the series is published.</p></header><p id="body">Regular paragraph outside the header keeps scanning as before.</p></main>`,
    );

    for (const id of ["title", "lead", "body"]) {
      expect(units.get(id)?.automatic, id).toBe(true);
      expect(units.get(id)?.exclusionReason, id).toBeUndefined();
    }
    expect(units.get("lead")?.kind).toBe("paragraph");
  });

  it("body 直属的 header 仍按站点横幅排除", () => {
    const units = inventoryOf(
      `<header id="banner"><p id="banner-text">arXiv paper tools and site navigation live up here permanently.</p></header>`,
    );

    expect(units.get("banner-text")?.automatic).toBe(false);
    expect(units.get("banner-text")?.exclusionReason).toBe("excluded-region");
  });

  it("header 内的导航与交互控件仍按各自理由排除", () => {
    const units = inventoryOf(
      `<main><header id="page-header"><nav id="nav"><p id="nav-text">On this page links for quick navigation between sections only.</p></nav><p id="actions">Edit this page <button id="edit" type="button">Edit</button> with the toolbar.</p></header></main>`,
    );

    expect(units.get("nav-text")?.exclusionReason).toBe("excluded-region");
    expect(units.get("actions")?.exclusionReason).toBe("unsafe-interactive");
  });

  it("显式手势对内容标题区里的段落放行,对站点横幅照旧拒绝", () => {
    document.body.innerHTML =
      `<main><header id="page-header"><p id="lead">The official lessons, collected in one place as the series is published.</p></header></main>` +
      `<header id="banner"><p id="banner-text">arXiv paper tools and site navigation live up here permanently.</p></header>`;

    expect(explicitCandidateText(document.getElementById("lead")!)).not.toBeNull();
    expect(explicitCandidateText(document.getElementById("banner-text")!)).toBeNull();
  });
});

/**
 * X Articles 的正文容器是 Draft.js 编辑器的只读渲染,根节点带 contenteditable="false"。
 * 隐藏/危险判据此前按属性存在匹配,"false" 的只读展示区被整体判成不可见内容——
 * 表现为整篇文章正文进不了清单,而同页的推文与评论正常。
 */
describe("contenteditable=false 只读展示区不触发隐藏排除", () => {
  function inventoryOf(markup: string): Map<string, ReadableUnit> {
    document.body.innerHTML = markup;
    return new Map(inventoryReadableUnits(document).map((unit) => [unit.element.id, unit]));
  }

  it("只读容器里的段落进自动清单", () => {
    const units = inventoryOf(
      `<main><div contenteditable="false"><div id="para">Draft editor paragraphs stay perfectly readable content.</div></div></main>`,
    );

    expect(units.get("para")?.automatic).toBe(true);
    expect(units.get("para")?.exclusionReason).toBeUndefined();
  });

  it("可编辑状态(true/空串/plaintext-only)照旧排除", () => {
    const units = inventoryOf(
      `<main>
         <div contenteditable="true"><p id="ed-true">Editable true content paragraph here.</p></div>
         <div contenteditable=""><p id="ed-empty">Editable empty content paragraph here.</p></div>
         <div contenteditable="plaintext-only"><p id="ed-plain">Editable plain content paragraph.</p></div>
       </main>`,
    );

    for (const id of ["ed-true", "ed-empty", "ed-plain"]) {
      expect(units.get(id)?.automatic, id).toBe(false);
      expect(units.get(id)?.exclusionReason, id).toBe("hidden");
    }
  });

  it("只读后代不把宿主块判成危险后代,可读后代照旧", () => {
    const units = inventoryOf(
      `<main>
         <div id="readonly-host">Host text <span contenteditable="false">read only words</span> more words.</div>
         <div id="editable-host">Host text <span contenteditable="true">edit me</span> more words.</div>
       </main>`,
    );

    expect(units.get("readonly-host")?.automatic).toBe(true);
    expect(units.get("editable-host")?.exclusionReason).toBe("unsafe-interactive");
  });
});

describe("explainElement 只读诊断出口", () => {
  // 集合包含式一致性（刻意不是「首个失败门唯一决定 reason」）：classifyExclusion
  // (page-inventory.ts:430-472) 的优先级链 + covered-by-child 的方向①（内联单元被
  // 自动父吸收）都依赖整页两遍算法，单元素函数无法逐门复刻优先级。断言改为两条：
  // ① automatic 单元无任何失败门；② 非自动单元的失败门集合 ⊇ 产出其 reason 所需的门。
  // 这就是防「诊断逻辑漂移」的核心断言：诊断说的原因必须与生产判定一致。
  const SCIENTIFIC_REASONS = [
    "conversion-placeholder",
    "math-auxiliary",
    "reference-metadata",
    "display-math",
    "unsupported-reference-layout",
  ];
  const requiredGateByReason: Record<string, string> = {
    "outside-principal-content": "inside-principal-root",
    "excluded-region": "excluded-region",
    "unsafe-interactive": "unsafe-descendant",
    "no-readable-words": "readable-words",
    "non-english": "english-dominant",
    "loose-block-too-short": "min-auto-text-length",
    "covered-by-child": "covered-by-child",
    "unsafe-partial-replacement": "has-separable-direct-text",
  };

  it("对两份冻结 fixture 的每个 unit，失败门集合覆盖其 exclusionReason 所需的门", () => {
    for (const fixtureName of fixtures) {
      const page = parsePage(readFixture(fixtureName, "html"));
      const contract = JSON.parse(readFixture(fixtureName, "json")) as InventoryContract;
      const units = new Map(
        inventoryReadableUnits(page).map((unit) => [
          unit.element.getAttribute("data-audit-id") ?? unit.id,
          unit,
        ]),
      );
      for (const { id, reason } of contract.units) {
        const unit = units.get(id);
        if (unit === undefined || reason === null) continue;
        const failed = new Set(
          explainElement(unit.element)
            .filter(({ ok }) => !ok)
            .map(({ gate }) => gate),
        );
        if (unit.automatic) {
          expect([...failed], `${fixtureName}:${id} 自动单元不应有失败门`).toEqual([]);
          continue;
        }
        if (SCIENTIFIC_REASONS.includes(reason)) {
          expect(failed, `${fixtureName}:${id} reason=${reason}`).toContain("scientific-exclusion");
          continue;
        }
        if (reason === "hidden") {
          expect(
            failed.has("hidden-ancestor") || failed.has("layout-visible"),
            `${fixtureName}:${id} hidden 应有 hidden-ancestor 或 layout-visible 失败`,
          ).toBe(true);
          continue;
        }
        if (reason === "covered-by-child") {
          // 两方向：方向②自身有可分析子（covered-by-child 门失败）；方向①被某个自动
          // 祖先吸收（整页判定，这里用 inventory 结果验证，explainElement 单元素复算不了）。
          const absorbed = [...units.values()].some(
            (other) =>
              other.automatic &&
              other.element !== unit.element &&
              other.element.contains(unit.element),
          );
          expect(
            failed.has("covered-by-child") || absorbed,
            `${fixtureName}:${id} covered-by-child 两方向均不满足`,
          ).toBe(true);
          continue;
        }
        const required = requiredGateByReason[reason];
        expect(
          required,
          `${fixtureName}:${id} 未知的 reason=${reason}——映射表缺条目`,
        ).toBeDefined();
        expect(failed, `${fixtureName}:${id} reason=${reason} 缺门 ${required}`).toContain(
          required,
        );
      }
    }
  });

  it("english-dominant 门带回词级占比（isEnglishDominant 是词级判定，不是字符级）", () => {
    // 3/6 英文词 = 0.5 < 0.6（englishLetterRatio 的词级占比，page-inventory.ts:163-167）。
    document.body.innerHTML = '<main><p id="mixed">你好 hello 世界 test again 更多</p></main>';
    const gates = explainElement(document.getElementById("mixed")!);
    const gate = gates.find(({ gate }) => gate === "english-dominant")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBe(0.5);
  });

  it("min-auto-text-length 门的条件与 classifyExclusion 同款（非 BLOCK/CALLOUT 且 <20）", () => {
    document.body.innerHTML = '<main><div id="tiny">Short text</div></main>';
    const gates = explainElement(document.getElementById("tiny")!);
    const gate = gates.find(({ gate }) => gate === "min-auto-text-length")!;
    expect(gate.ok).toBe(false);
    expect(gate.value).toBe(10);
    // BLOCK_SELECTOR 命中的元素不受短块门限制（classifyExclusion:464-470 同款）。
    document.body.innerHTML = '<main><figcaption id="cap">Tiny.</figcaption></main>';
    const caption = explainElement(document.getElementById("cap")!);
    expect(caption.find(({ gate }) => gate === "min-auto-text-length")!.ok).toBe(true);
  });
});
