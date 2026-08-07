import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./errors";
import { GRAMMAR_LABELS, GrammarRole } from "./grammar";
import { MAX_SENTENCES_PER_REQUEST } from "./protocol";
import { CORE_SCHEMA_VERSION, MESSAGE_VERSION } from "./versions";

/**
 * 架构文档(docs/architecture/)必须跟着代码走。人不会记得改文档,所以这里把
 * 「最容易漂移、且能机器判定」的部分钉住:枚举与清单要求全覆盖,关键常量要求
 * 数值一致,新增源文件要求在模块地图里露面。
 *
 * 这不是要求文档逐字复述代码——散文部分照旧靠人。它只保证:**改了这些东西却
 * 忘了同步文档,门禁会红**,而不是等到半年后有人照着过时的文档做决定。
 *
 * 断言失败时的正确反应是去改文档,不是来放宽这里的规则。
 */

const root = resolve(import.meta.dirname, "../..");
const docsDir = join(root, "docs", "architecture");
const srcDir = join(root, "src");

const docFileNames = readdirSync(docsDir).filter((name) => name.endsWith(".md"));
const docs = new Map(
  docFileNames.map((name) => [name, readFileSync(join(docsDir, name), "utf8")] as const),
);
/** 全部架构文档拼在一起:多数断言只关心「有没有写到」,不关心写在哪一份里。 */
const allDocs = [...docs.values()].join("\n");

function sourceOf(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), "utf8");
}

/** 源码里模块私有常量的字面量值。为测试而导出它们并不值得,读文本足够。 */
function literalNumber(source: string, name: string): number {
  const match = source.match(new RegExp(`${name}[^=\\n]*=\\s*(\\d[\\d_]*)`, "u"));
  expect(match, `源码里找不到常量 ${name},本测试的正则需要跟着改`).not.toBeNull();
  return Number(match![1]!.replaceAll("_", ""));
}

/**
 * 每一处「提到 `name` 后紧跟一个数字」的地方都必须等于 `expected`——只查首处的话,
 * 命中哪份文档要看目录遍历顺序,同一个常量写在三处、只对了一处也会蒙混过关。
 *
 * 窗口收窄到同一行内的 24 个非数字字符:避免蹭到邻近段落里无关的数字。因此
 * 「只提名字、不写数值」的引用(如模块地图的索引表)不参与校验,也不算漏。
 */
function expectDocumentedNumber(name: string, expected: number): void {
  const matches = [...allDocs.matchAll(new RegExp(`${name}[^\\n\\d]{0,24}(\\d[\\d,_]*)`, "gu"))];
  expect(matches.length, `架构文档里没有写明 ${name} 的取值`).toBeGreaterThan(0);
  for (const match of matches) {
    expect(
      Number(match[1]!.replaceAll(/[,_]/gu, "")),
      `${name} 在代码里是 ${expected},文档里却写着「${match[0]}」`,
    ).toBe(expected);
  }
}

function implementationFiles(): string[] {
  return readdirSync(srcDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((directory) =>
      readdirSync(join(srcDir, directory.name))
        .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
        .map((name) => `${directory.name}/${name}`),
    );
}

describe("架构文档与代码同步", () => {
  it("每一份文档都非空,且首行是标题", () => {
    expect(docFileNames.length).toBeGreaterThanOrEqual(7);
    for (const [name, text] of docs) {
      expect(text.trim().length, name).toBeGreaterThan(0);
      expect(text.startsWith("# "), `${name} 应以一级标题开头`).toBe(true);
    }
  });

  it("文档之间的相对链接都指向真实存在的文档", () => {
    for (const [name, text] of docs) {
      for (const match of text.matchAll(/\]\((\.\/)?([\w-]+\.md)(#[^)]*)?\)/gu)) {
        expect(docFileNames, `${name} 链接到了不存在的 ${match[2]!}`).toContain(match[2]!);
      }
    }
  });

  it("src 下每个实现文件都在模块地图里出现", () => {
    const modules = docs.get("modules.md")!;
    for (const relativePath of implementationFiles()) {
      const fileName = relativePath.split("/").at(-1)!;
      expect(modules, `modules.md 缺少 ${relativePath}——新增模块要补进模块地图`).toContain(
        fileName,
      );
    }
  });

  it("每一条 RequestMessage / ResponseMessage 都在协议参考里出现", () => {
    const protocolSource = sourceOf("shared/protocol.ts");
    const protocolDoc = docs.get("protocol.md")!;
    const messageTypes = new Set(
      [...protocolSource.matchAll(/type:\s*"([A-Z_]+)"/gu)].map((match) => match[1]!),
    );
    expect(messageTypes.size).toBeGreaterThan(20);
    for (const messageType of messageTypes) {
      expect(protocolDoc, `protocol.md 缺少消息类型 ${messageType}`).toContain(messageType);
    }
  });

  it("每个语法角色连同中文标签都在协议参考里出现", () => {
    const protocolDoc = docs.get("protocol.md")!;
    const roles = Object.values(GrammarRole);
    // 「16 个语法角色」「16 值封闭枚举」这类说法散在多份文档里,逐个核对。
    const claims = [...allDocs.matchAll(/(\d+)\s*(?:个语法角色|值封闭枚举)/gu)];
    expect(claims.length, "架构文档里没有写明语法角色的数量").toBeGreaterThan(0);
    for (const claim of claims) {
      expect(Number(claim[1]!), `文档写着「${claim[0]}」,实际有 ${roles.length} 个`).toBe(
        roles.length,
      );
    }
    for (const role of roles) {
      expect(protocolDoc, `protocol.md 缺少语法角色 ${role}`).toContain(role);
      expect(protocolDoc, `protocol.md 缺少 ${role} 的中文标签`).toContain(GRAMMAR_LABELS[role]);
    }
  });

  it("每一个错误码都在协议参考里出现", () => {
    const protocolDoc = docs.get("protocol.md")!;
    for (const code of ERROR_CODES) {
      expect(protocolDoc, `protocol.md 缺少错误码 ${code}`).toContain(code);
    }
  });

  it("每一档调度优先级都在模型链路文档里出现", () => {
    const schedulerSource = sourceOf("background/request-scheduler.ts");
    const pipeline = docs.get("model-pipeline.md")!;
    const priorities = [
      ...schedulerSource.matchAll(/"(user-retry|detail-click|visible-core|prefetch-\w+)":\s*\d/gu),
    ].map((match) => match[1]!);
    expect(priorities.length).toBe(5);
    for (const priority of priorities) {
      expect(pipeline, `model-pipeline.md 缺少优先级 ${priority}`).toContain(priority);
    }
  });

  it("每一个 storage 键都在协议参考的存储清单里出现", () => {
    const configSource = sourceOf("background/config-repository.ts");
    const protocolDoc = docs.get("protocol.md")!;
    const keys = [...configSource.matchAll(/_KEY = "([\w.]+)"/gu)].map((match) => match[1]!);
    expect(keys.length).toBeGreaterThanOrEqual(5);
    for (const key of keys) {
      expect(protocolDoc, `protocol.md 的存储清单缺少 ${key}`).toContain(key);
    }
  });

  it("关键常量的取值与文档一致", () => {
    expectDocumentedNumber("MESSAGE_VERSION", MESSAGE_VERSION);
    expectDocumentedNumber("CORE_SCHEMA_VERSION", CORE_SCHEMA_VERSION);
    expectDocumentedNumber("MAX_SENTENCES_PER_REQUEST", MAX_SENTENCES_PER_REQUEST);
    expectDocumentedNumber(
      "MODEL_REQUEST_CONCURRENCY",
      literalNumber(sourceOf("background/service-worker.ts"), "MODEL_REQUEST_CONCURRENCY"),
    );
    expectDocumentedNumber(
      "CLOUD_SENTENCES_PER_REQUEST",
      literalNumber(sourceOf("background/analysis-service.ts"), "CLOUD_SENTENCES_PER_REQUEST"),
    );
  });

  it("三个能力降级位都在模型链路文档的降级矩阵里出现", () => {
    const pipeline = docs.get("model-pipeline.md")!;
    for (const capability of ["jsonSchemaSupport", "streamSupport", "reasoningControl"]) {
      expect(pipeline, `model-pipeline.md 缺少能力位 ${capability}`).toContain(capability);
    }
  });

  it("每一个句子相位都在总览的相位机里出现", () => {
    const controllerSource = sourceOf("content/session-controller.ts");
    const overview = docs.get("overview.md")!;
    const declaration = controllerSource.match(/export type SentencePhase =([\s\S]*?);/u);
    expect(declaration, "session-controller.ts 里找不到 SentencePhase 声明").not.toBeNull();
    const phases = [...declaration![1]!.matchAll(/"([\w-]+)"/gu)].map((match) => match[1]!);
    expect(phases.length).toBeGreaterThanOrEqual(8);
    for (const phase of phases) {
      expect(overview, `overview.md 的相位机缺少 ${phase}`).toContain(phase);
    }
  });
});
