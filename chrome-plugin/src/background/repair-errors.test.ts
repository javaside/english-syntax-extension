import { describe, expect, it } from "vitest";
import { groupRepairErrors } from "./repair-errors";
import type { SentenceInput } from "../shared/protocol";
import { tokenize } from "../language/segmenter";
import type { ValidationError } from "../language/analysis-validator";

const sentence = (id: string): SentenceInput => ({
  sentenceId: id,
  text: "The service works well.",
  tokens: tokenize("The service works well."),
});

const error = (path: string, message: string): ValidationError => ({ path, message });

describe("groupRepairErrors", () => {
  it("多句 repair 的错误各自归属到 sentenceId,不再共享 sentences[0]", () => {
    const groups = groupRepairErrors(
      [
        {
          sentence: sentence("a"),
          errors: [error("sentences[0].components[1].translation", "m-a")],
        },
        {
          sentence: sentence("b"),
          errors: [error("sentences[0].components[3].translation", "m-b")],
        },
      ],
      { sentences: [{ sentenceId: "a" }, { sentenceId: "b" }] },
    );
    expect(groups).toEqual([
      {
        sentenceId: "a",
        rawOccurrence: 0,
        kind: "invalid",
        errors: [{ path: "components[1].translation", message: "m-a" }],
      },
      {
        sentenceId: "b",
        rawOccurrence: 0,
        kind: "invalid",
        errors: [{ path: "components[3].translation", message: "m-b" }],
      },
    ]);
  });

  it("缺失句与重复句各有明确 kind", () => {
    const missing = groupRepairErrors([{ sentence: sentence("a"), errors: [] }], { sentences: [] });
    expect(missing[0]).toMatchObject({ sentenceId: "a", kind: "missing" });

    const duplicate = groupRepairErrors(
      [
        {
          sentence: sentence("a"),
          errors: [error("sentences[1].sentenceId", "is duplicated")],
        },
      ],
      { sentences: [{ sentenceId: "a" }, { sentenceId: "a" }] },
    );
    expect(duplicate).toEqual([
      {
        sentenceId: "a",
        rawOccurrence: 1,
        kind: "duplicate",
        errors: [{ path: "", message: "remove this duplicate instance" }],
      },
    ]);
  });

  it("重复实例与首实例非法并存时,两边各出一组、互不吞并", () => {
    const groups = groupRepairErrors(
      [
        {
          sentence: sentence("a"),
          errors: [
            error("sentences[1].sentenceId", "is duplicated"),
            error("sentences[0].components[1].translation", "m-a"),
          ],
        },
      ],
      { sentences: [{ sentenceId: "a" }, { sentenceId: "a" }, { sentenceId: "a" }] },
    );
    expect(groups).toEqual([
      {
        sentenceId: "a",
        rawOccurrence: 0,
        kind: "invalid",
        errors: [{ path: "components[1].translation", message: "m-a" }],
      },
      {
        sentenceId: "a",
        rawOccurrence: 1,
        kind: "duplicate",
        errors: [{ path: "", message: "remove this duplicate instance" }],
      },
      {
        sentenceId: "a",
        rawOccurrence: 2,
        kind: "duplicate",
        errors: [{ path: "", message: "remove this duplicate instance" }],
      },
    ]);
  });

  it("句对象级错误去掉 sentences 前缀后保留句级根路径", () => {
    const groups = groupRepairErrors(
      [{ sentence: sentence("a"), errors: [error("sentences[0].sentenceId", "must be a safe string")] }],
      { sentences: [{ sentenceId: "a" }] },
    );
    expect(groups).toEqual([
      {
        sentenceId: "a",
        rawOccurrence: 0,
        kind: "invalid",
        errors: [{ path: "sentenceId", message: "must be a safe string" }],
      },
    ]);
  });
});
