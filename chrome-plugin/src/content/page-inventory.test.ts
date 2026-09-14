// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { inventoryReadableUnits, type ReadableUnit } from "./page-inventory";
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
      inventoryReadableUnits(document).map((unit) => [unit.element.id || unit.text.slice(0, 30), unit]),
    );
  }

  it("整块由邮箱与转换残留构成时按 reference-metadata 排除", () => {
    const units = inventoryOf(
      "<main><p id=\"emails\">show]Rachel.Gray@glasgow.ac.uk ]Daniel.Williams@glasgow.ac.uk ]a.papadopoulos.1@research.gla.ac.uk</p></main>",
    );
    expect(units.get("emails")?.automatic).toBe(false);
    expect(units.get("emails")?.exclusionReason).toBe("reference-metadata");
  });

  it("正文里出现的邮箱不触发排除(反向保留)", () => {
    const units = inventoryOf(
      "<main><p id=\"contact\">Contact us at author@example.org for details.</p></main>",
    );
    expect(units.get("contact")?.automatic).toBe(true);
    expect(units.get("contact")?.exclusionReason).toBeUndefined();
  });

  it("单邮箱作者行同样排除", () => {
    const units = inventoryOf("<main><p id=\"one\">author@example.org</p></main>");
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
