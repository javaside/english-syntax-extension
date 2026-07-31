// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from "vitest";
import { BlockActivityMarker } from "./block-activity-marker";

function paragraph(attributes: Record<string, string> = {}): HTMLElement {
  const element = document.createElement("p");
  element.textContent = "Readers understand complex sentences.";
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

describe("BlockActivityMarker", () => {
  beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
  });

  it("marks an element and restores it exactly on clear", () => {
    const element = paragraph({ class: "article-copy", style: "color: purple" });
    const marker = new BlockActivityMarker();

    marker.mark(element);
    expect(element.className).not.toBe("article-copy");
    expect(element.className).toContain("article-copy");
    expect(document.head.querySelector("style")).not.toBeNull();

    marker.clear();
    expect(element.className).toBe("article-copy");
    expect(element.getAttribute("style")).toBe("color: purple");
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("leaves no empty class attribute when the element never had one", () => {
    const element = paragraph();
    const marker = new BlockActivityMarker();

    marker.mark(element);
    marker.clear();

    expect(element.hasAttribute("class")).toBe(false);
  });

  it("is idempotent for the same target", () => {
    const element = paragraph();
    const marker = new BlockActivityMarker();

    marker.mark(element);
    const applied = element.className;
    marker.mark(element);

    expect(element.className).toBe(applied);
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
  });

  it("releases the previous target when the marker moves", () => {
    const first = paragraph();
    const second = paragraph();
    const marker = new BlockActivityMarker();

    marker.mark(first);
    marker.mark(second);

    expect(first.hasAttribute("class")).toBe(false);
    expect(second.className).not.toBe("");
    expect(document.head.querySelectorAll("style")).toHaveLength(1);
  });

  it("picks a fresh suffix when the page already uses the candidate class", () => {
    const squatter = document.createElement("div");
    squatter.className = `${BlockActivityMarker.activeClass}-1`;
    document.body.append(squatter);
    const element = paragraph();
    let attempts = 0;
    const marker = new BlockActivityMarker(() => {
      attempts += 1;
      return String(attempts);
    });

    marker.mark(element);

    expect(element.className).toBe(`${BlockActivityMarker.activeClass}-2`);
  });

  it("ignores a detached element", () => {
    const detached = document.createElement("p");
    const marker = new BlockActivityMarker();

    marker.mark(detached);

    expect(detached.hasAttribute("class")).toBe(false);
    expect(document.head.querySelector("style")).toBeNull();
  });

  it("clear is safe when nothing was marked", () => {
    expect(() => new BlockActivityMarker().clear()).not.toThrow();
  });

  it("clear survives the target being ripped out by the page", () => {
    const element = paragraph();
    const marker = new BlockActivityMarker();
    marker.mark(element);

    element.remove();

    expect(() => marker.clear()).not.toThrow();
    expect(document.head.querySelector("style")).toBeNull();
  });
});
