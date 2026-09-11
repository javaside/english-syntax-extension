import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { Window } from "happy-dom";

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
const readFixture = (name: (typeof fixtures)[number], extension: "html" | "json") =>
  readFileSync(
    new URL(
      `../../tests/fixtures/${extension === "html" ? "pages" : "page-inventory"}/${name}.${extension}`,
      import.meta.url,
    ),
    "utf8",
  );
const parsePage = (html: string) => {
  const window = new Window();
  window.document.write(html);
  return window.document;
};

const normalizedFixtureText = (element: Element) => {
  const copy = element.cloneNode(true) as Element;
  for (const auxiliary of copy.querySelectorAll("annotation, [aria-hidden='true']")) {
    auxiliary.remove();
  }
  for (const math of copy.querySelectorAll("math")) {
    math.replaceWith(math.getAttribute("alttext") ?? math.textContent ?? "");
  }
  return copy.textContent?.replace(/\s+/gu, " ").trim() ?? "";
};

describe("Task 5 page inventory denominator", () => {
  it("leaves the production inventory module absent for Task 6 RED", () => {
    expect(() => readFileSync(new URL("./page-inventory.ts", import.meta.url), "utf8")).toThrow(
      /ENOENT/u,
    );
  });

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
    expect(
      expected.units.map(({ id }) => ({
        id,
        text: normalizedFixtureText(page.querySelector(`[data-audit-id="${id}"]`) ?? page.body),
      })),
    ).toEqual(expected.units.map(({ id, text }) => ({ id, text })));
    expect(expected.units.every(({ kind }) => unitKinds.includes(kind))).toBe(true);
    expect(
      expected.units.every(({ automatic, reason }) =>
        automatic ? reason === null : reason !== null,
      ),
    ).toBe(true);
  });
});
