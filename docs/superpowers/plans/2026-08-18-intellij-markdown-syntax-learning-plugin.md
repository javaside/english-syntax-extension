# IntelliJ IDEA Markdown 英语句法学习插件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在当前仓库新增 Kotlin 原生 IntelliJ IDEA 2025.1+ 插件，在官方 Markdown 预览中按可见区域就地渲染与 Chrome 扩展兼容的英语句法卡片和成分详解。

**Architecture:** `intellij-plugin/` 是独立 Gradle 子项目，使用自定义 `MarkdownHtmlPanelProvider` 持有 JCEF 面板；JCEF JavaScript 只负责 Markdown DOM 扫描、可见性观察和可逆渲染，Kotlin 负责配置、PasswordSafe、分句分词、模型请求、校验、缓存、调度和会话状态。TypeScript 与 Kotlin 不共享运行时代码，通过 `shared-fixtures/` 的枚举、版本、Prompt 首行、分词、缓存键和交换文件测试向量保持兼容。

**Tech Stack:** Kotlin 2.x、Java 21、IntelliJ Platform 2025.1、IntelliJ Platform Gradle Plugin 2.x、JetBrains Markdown 插件、JCEF、Kotlin coroutines、JDK `HttpClient`、kotlinx.serialization、SQLite JDBC、JUnit 5、Vitest/happy-dom、Plugin Verifier。

**设计依据:** `docs/superpowers/specs/2026-08-18-intellij-markdown-syntax-learning-plugin-design.md`

## Global Constraints

- 目标平台是 IntelliJ IDEA Community / Ultimate 2025.1 及以上；`since-build` 使用 251。
- JetBrains 官方 Markdown 插件是必需依赖：Gradle `bundledPlugin("org.intellij.plugins.markdown")`，`plugin.xml` 使用 `<depends>org.intellij.plugins.markdown</depends>`。
- Kotlin 必须使用 2.x；目标 IDE 2025.1 自带 Kotlin stdlib 2.1.10 和 coroutines 1.8.0-intellij-13，不打包自有 stdlib/coroutines。
- Java toolchain 和 Kotlin JVM target 均为 21。
- JCEF 不支持时禁用 Preview Provider 并显示提示；不实现 Swing/JavaFX 回退。
- API Key 和敏感请求头只进 PasswordSafe 和 Kotlin HTTP 层，不得进入 JCEF、日志、通知、缓存交换文件。
- 首版只支持 Markdown 预览、核心解析、流式预览、点击详解、暂停/继续、停止恢复、失败重试、多 Profile 和缓存互导。
- 首版不做源码编辑器 Inlay、自动启动、选中/右键局部解析、详解预载、纠错重分析或其他 JetBrains IDE 正式兼容。
- 核心缓存键、详解缓存键、角色枚举、错误码、Prompt 首行、Schema 版本和交换文件格式必须与 Chrome 端一致。
- Chrome 现有 lint 基线仍是恰好 1 个错误，不修复也不新增。
- 所有新功能按 TDD 实施；每个任务完成后执行指定测试并用中文主题提交，提交尾注追加 `Co-Authored-By: CodeTui <noreply@codetui.dev>`。

---

## 文件结构

### 根仓库新增/修改

| 文件 | 职责 |
| --- | --- |
| `settings.gradle.kts` | 根 Gradle 工程，只包含 `intellij-plugin` |
| `build.gradle.kts` | 根聚合任务 `intellijCheck` / `allCheck` |
| `gradle.properties` | Java/Kotlin/Gradle 公共构建参数 |
| `gradle/libs.versions.toml` | Kotlin、IntelliJ Platform Gradle Plugin、serialization、SQLite、JUnit 版本目录 |
| `shared-fixtures/contracts.json` | 角色、标签、错误码、版本和常量的跨端唯一 fixture |
| `shared-fixtures/cache-key-vectors.json` | 核心/详解缓存键固定向量 |
| `shared-fixtures/cache-transfer-v1.json` | 双向导入导出样本 |
| `shared-fixtures/segmenter-vectors.json` | 分句分词固定向量 |
| `src/shared/cross-platform-contract.test.ts` | TypeScript 侧读取共享 fixture 防漂移 |
| `src/background/analysis-cache.test.ts` | 增加共享缓存键向量断言 |
| `src/options/cache-transfer.test.ts` | 增加共享交换文件断言 |
| `package.json` | 增加 bridge 测试和聚合门禁脚本 |
| `vitest.config.ts` | 纳入 `intellij-plugin/src/main/resources/web/**/*.test.ts` |
| `tsconfig.json` | 纳入 JCEF web TypeScript 测试源 |
| `eslint.config.js` | 忽略 Gradle 构建产物，不放宽 Web bridge 规则 |
| `.gitignore` | 忽略 `.gradle/`、`**/build/`、IDE sandbox |
| `docs/architecture/README.md` | 总览增加 IntelliJ 子项目入口 |
| `docs/architecture/modules.md` | 增加 IntelliJ 模块地图和 shared fixtures |
| `docs/architecture/overview.md` | 增加 IDEA/JCEF/Kotlin 运行时链路 |
| `docs/architecture/model-pipeline.md` | 记录跨端模型契约和差异 |
| `docs/architecture/rendering.md` | 增加 Markdown Preview 渲染链路 |
| `docs/architecture/build-test-release.md` | 增加 Gradle、Plugin Verifier 和发布门禁 |
| `docs/architecture/invariants.md` | 增加 bridge 密钥隔离、预览代次和 Provider API 不变量 |
| `AGENTS.md` | 增加 IntelliJ 子项目门禁和关键约定 |

### IntelliJ 子项目

| 文件/目录 | 职责 |
| --- | --- |
| `intellij-plugin/build.gradle.kts` | 插件构建、依赖、测试、Verifier、ZIP |
| `intellij-plugin/src/main/resources/META-INF/plugin.xml` | Plugin ID、Markdown 依赖、Provider、Service、Configurable、Action |
| `intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties` | UI 文案 |
| `intellij-plugin/src/main/kotlin/.../domain/Domain.kt` | Token、核心/详解、错误和版本常量 |
| `intellij-plugin/src/main/kotlin/.../language/Segmenter.kt` | 分句、分词、重建和句子 ID |
| `intellij-plugin/src/main/kotlin/.../language/AnalysisValidator.kt` | 核心/详解最终校验 |
| `intellij-plugin/src/main/kotlin/.../contract/SharedFixtures.kt` | 测试读取根目录 fixture |
| `intellij-plugin/src/main/kotlin/.../settings/ProfileState.kt` | 非敏感 Profile 状态 |
| `intellij-plugin/src/main/kotlin/.../settings/ProfileRepository.kt` | PersistentStateComponent 与能力位更新 |
| `intellij-plugin/src/main/kotlin/.../settings/CredentialStore.kt` | PasswordSafe 端口和实现 |
| `intellij-plugin/src/main/kotlin/.../settings/EnglishSyntaxConfigurable.kt` | Kotlin UI DSL 2 设置页 |
| `intellij-plugin/src/main/kotlin/.../model/BaseUrl.kt` | URL 归一化和 Chat Completions 地址 |
| `intellij-plugin/src/main/kotlin/.../model/Prompts.kt` | Prompt、紧凑序列化、JSON Schema |
| `intellij-plugin/src/main/kotlin/.../model/SseDecoder.kt` | SSE 帧解码 |
| `intellij-plugin/src/main/kotlin/.../model/CoreStreamParser.kt` | 流式核心成分解析 |
| `intellij-plugin/src/main/kotlin/.../model/DetailStreamParser.kt` | 流式详解结构解析 |
| `intellij-plugin/src/main/kotlin/.../model/OpenAiCompatibleClient.kt` | JDK HttpClient、错误映射、三种降级、超时和探测 |
| `intellij-plugin/src/main/kotlin/.../scheduler/RequestScheduler.kt` | 五档 IDEA 优先级、并发、去重、重试、取消 |
| `intellij-plugin/src/main/kotlin/.../cache/CacheKeys.kt` | 与 TS 一致的 SHA-256 键 |
| `intellij-plugin/src/main/kotlin/.../cache/AnalysisCache.kt` | SQLite core/detail、LRU、统计、清空 |
| `intellij-plugin/src/main/kotlin/.../cache/CacheTransfer.kt` | 交换格式导入导出 |
| `intellij-plugin/src/main/kotlin/.../analysis/AnalysisService.kt` | 缓存→分块→请求→校验→修复→写缓存 |
| `intellij-plugin/src/main/kotlin/.../bridge/BridgeProtocol.kt` | JS/Kotlin 封闭消息协议和白名单校验 |
| `intellij-plugin/src/main/kotlin/.../markdown/EnglishSyntaxPreviewProvider.kt` | `MarkdownHtmlPanelProvider` |
| `intellij-plugin/src/main/kotlin/.../markdown/EnglishSyntaxPreviewPanel.kt` | JCEF 面板、资源注入、bridge、代次 |
| `intellij-plugin/src/main/kotlin/.../session/PreviewSessionManager.kt` | 项目级会话、状态机、批处理、滚动请求 |
| `intellij-plugin/src/main/kotlin/.../actions/*.kt` | 开始、暂停/继续、停止 Action |
| `intellij-plugin/src/main/resources/web/preview.ts` | DOM 扫描、IntersectionObserver、bridge 调用 |
| `intellij-plugin/src/main/resources/web/render.ts` | 三层卡片、详解、恢复和代次守卫 |
| `intellij-plugin/src/main/resources/web/preview.css` | Shadow DOM/作用域样式 |
| `intellij-plugin/src/test/kotlin/...` | Kotlin 单元与轻量平台测试 |
| `intellij-plugin/src/testFixtures/kotlin/.../FakeOpenAiServer.kt` | Kotlin 假 OpenAI 服务器与请求探针 |

---

### Task 1: 建立 Gradle IntelliJ 插件骨架

**Files:**
- Create: `settings.gradle.kts`
- Create: `build.gradle.kts`
- Create: `gradle.properties`
- Create: `gradle/libs.versions.toml`
- Create: `intellij-plugin/build.gradle.kts`
- Create: `intellij-plugin/src/main/resources/META-INF/plugin.xml`
- Create: `intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/PluginIdentity.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/PluginIdentityTest.kt`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `PluginIdentity.ID = "dev.codetui.english-syntax-idea"`, `PluginIdentity.DISPLAY_NAME = "English Syntax Learning"`.
- Produces: Gradle tasks `:intellij-plugin:test`, `:intellij-plugin:buildPlugin`, `:intellij-plugin:verifyPlugin`.

- [ ] **Step 1: 写骨架测试**

创建 `PluginIdentityTest.kt`：

```kotlin
package dev.codetui.englishsyntax

import kotlin.test.Test
import kotlin.test.assertEquals

class PluginIdentityTest {
  @Test
  fun `plugin identity stays stable`() {
    assertEquals("dev.codetui.english-syntax-idea", PluginIdentity.ID)
    assertEquals("English Syntax Learning", PluginIdentity.DISPLAY_NAME)
  }
}
```

- [ ] **Step 2: 创建 Gradle 配置并确认测试先失败**

`settings.gradle.kts`：

```kotlin
pluginManagement {
  repositories {
    gradlePluginPortal()
    mavenCentral()
  }
}

dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
  repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
  }
}

rootProject.name = "english-syntax-extension"
include(":intellij-plugin")
```

`gradle/libs.versions.toml`：

```toml
[versions]
kotlin = "2.1.10"
intellijPlatform = "2.18.1"
serialization = "1.7.3"
sqlite = "3.49.1.0"
junit = "5.12.2"

[plugins]
kotlin-jvm = { id = "org.jetbrains.kotlin.jvm", version.ref = "kotlin" }
kotlin-serialization = { id = "org.jetbrains.kotlin.plugin.serialization", version.ref = "kotlin" }
intellij-platform = { id = "org.jetbrains.intellij.platform", version.ref = "intellijPlatform" }

[libraries]
kotlinx-serialization-json = { module = "org.jetbrains.kotlinx:kotlinx-serialization-json", version.ref = "serialization" }
sqlite-jdbc = { module = "org.xerial:sqlite-jdbc", version.ref = "sqlite" }
junit-bom = { module = "org.junit:junit-bom", version.ref = "junit" }
junit-jupiter = { module = "org.junit.jupiter:junit-jupiter" }
```

`gradle.properties`：

```properties
org.gradle.jvmargs=-Xmx2g -Dfile.encoding=UTF-8
org.gradle.configuration-cache=true
org.gradle.caching=true
kotlin.code.style=official
kotlin.stdlib.default.dependency=false
```

`build.gradle.kts`：

```kotlin
plugins {
  base
  alias(libs.plugins.intellij.platform) apply false
  alias(libs.plugins.kotlin.jvm) apply false
  alias(libs.plugins.kotlin.serialization) apply false
}

tasks.register("intellijCheck") {
  dependsOn(":intellij-plugin:test", ":intellij-plugin:buildPlugin", ":intellij-plugin:verifyPlugin")
}
```

`intellij-plugin/build.gradle.kts`：

```kotlin
plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
  alias(libs.plugins.intellij.platform)
}

group = "dev.codetui"
version = "0.1.0-SNAPSHOT"

kotlin { jvmToolchain(21) }

repositories {
  mavenCentral()
  intellijPlatform { defaultRepositories() }
}

dependencies {
  intellijPlatform {
    intellijIdeaCommunity("2025.1")
    bundledPlugin("org.intellij.plugins.markdown")
    testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Platform)
    pluginVerifier()
  }
  implementation(libs.kotlinx.serialization.json) {
    exclude(group = "org.jetbrains.kotlin", module = "kotlin-stdlib")
    exclude(group = "org.jetbrains.kotlinx", module = "kotlinx-coroutines-core")
  }
  implementation(libs.sqlite.jdbc)
  testImplementation(platform(libs.junit.bom))
  testImplementation(libs.junit.jupiter)
}

intellijPlatform {
  pluginConfiguration {
    ideaVersion {
      sinceBuild = "251"
    }
  }
  pluginVerification {
    ides {
      ide(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity, "2025.1")
    }
  }
}

tasks {
  withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
  }
  test {
    useJUnitPlatform()
  }
}
```

运行：`./gradlew :intellij-plugin:test --tests '*PluginIdentityTest'`

Expected: FAIL，`PluginIdentity` 尚不存在。

- [ ] **Step 3: 创建最小插件身份和 plugin.xml**

`PluginIdentity.kt`：

```kotlin
package dev.codetui.englishsyntax

object PluginIdentity {
  const val ID = "dev.codetui.english-syntax-idea"
  const val DISPLAY_NAME = "English Syntax Learning"
}
```

`plugin.xml`：

```xml
<idea-plugin>
  <id>dev.codetui.english-syntax-idea</id>
  <name>English Syntax Learning</name>
  <vendor email="noreply@codetui.dev">CodeTui</vendor>
  <description><![CDATA[
    Learn English syntax directly in IntelliJ IDEA Markdown previews.
  ]]></description>
  <depends>com.intellij.modules.platform</depends>
  <depends>org.intellij.plugins.markdown</depends>
</idea-plugin>
```

`EnglishSyntaxBundle.properties`：

```properties
plugin.name=English Syntax Learning
```

在 `.gitignore` 追加：

```gitignore
.gradle/
**/build/
intellij-plugin/.intellijPlatform/
intellij-plugin/.sandbox/
```

- [ ] **Step 4: 验证骨架**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*PluginIdentityTest'
./gradlew :intellij-plugin:verifyPluginProjectConfiguration
./gradlew :intellij-plugin:buildPlugin
```

Expected: 测试 PASS；配置验证 PASS；ZIP 出现在 `intellij-plugin/build/distributions/`。

- [ ] **Step 5: 提交**

```bash
git add settings.gradle.kts build.gradle.kts gradle.properties gradle intellij-plugin .gitignore
git commit -m "$(cat <<'EOF'
feat: 建立 IntelliJ 插件工程骨架

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 2: 建立跨端契约 fixture 与 TypeScript 守护

**Files:**
- Create: `shared-fixtures/contracts.json`
- Create: `shared-fixtures/cache-key-vectors.json`
- Create: `shared-fixtures/segmenter-vectors.json`
- Create: `src/shared/cross-platform-contract.test.ts`
- Modify: `src/background/analysis-cache.test.ts`
- Modify: `src/language/segmenter.test.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces: `contracts.json` 字段 `messageVersion`, `coreSchemaVersion`, `corePromptVersion`, `detailPromptVersion`, `maxSentencesPerRequest`, `cloudSentencesPerRequest`, `roles`, `errorCodes`, `promptFirstLines`.
- Produces: 所有 Kotlin 任务使用的根目录共享测试数据。

- [ ] **Step 1: 写失败的 TypeScript 契约测试**

创建 `src/shared/cross-platform-contract.test.ts`：

```ts
import contracts from "../../shared-fixtures/contracts.json";
import { CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT } from "../background/analysis-service";
import { CORE_OUTPUT_SHAPE, PROMPT_FIRST_LINES } from "../background/prompts";
import { ERROR_CODES } from "./errors";
import { GRAMMAR_LABELS, GrammarRole } from "./grammar";
import { MAX_SENTENCES_PER_REQUEST } from "./protocol";
import {
  CORE_PROMPT_VERSION,
  CORE_SCHEMA_VERSION,
  DETAIL_PROMPT_VERSION,
  MESSAGE_VERSION,
} from "./versions";

it("keeps the shared IntelliJ contract synchronized", () => {
  expect(contracts).toMatchObject({
    messageVersion: MESSAGE_VERSION,
    coreSchemaVersion: CORE_SCHEMA_VERSION,
    corePromptVersion: CORE_PROMPT_VERSION,
    detailPromptVersion: DETAIL_PROMPT_VERSION,
    maxSentencesPerRequest: MAX_SENTENCES_PER_REQUEST,
    cloudSentencesPerRequest: CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT,
    roles: Object.values(GrammarRole).map((role) => ({ role, label: GRAMMAR_LABELS[role] })),
    errorCodes: ERROR_CODES,
    promptFirstLines: PROMPT_FIRST_LINES,
  });
  expect(CORE_OUTPUT_SHAPE).toContain("Output minified JSON on a single line");
});
```

- [ ] **Step 2: 跑测试确认失败**

运行：`npx vitest run src/shared/cross-platform-contract.test.ts`

Expected: FAIL，fixture 和两个显式 contract 导出尚不存在。

- [ ] **Step 3: 暴露只读契约常量并创建 fixture**

在 `analysis-service.ts` 把云端常量改为：

```ts
export const CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT = 2;
const CLOUD_SENTENCES_PER_REQUEST = CLOUD_SENTENCES_PER_REQUEST_FOR_CONTRACT;
```

在 `prompts.ts` 增加：

```ts
export const PROMPT_FIRST_LINES = {
  core: "Analyze the numbered English sentences below into core grammatical components.",
  coreRepair:
    "Repair only the structure of the invalid core-analysis JSON so it satisfies every validation error.",
  detail: "Explain only the selected grammatical component in the single sentence below.",
  detailRepair: "Repair only the structure of the invalid detail-analysis JSON.",
  probeSystem: "Return only the requested JSON object.",
} as const;
```

并让 `buildCorePrompt`、`buildRepairPrompt`、`buildDetailPrompt` 使用这些常量，不改实际文本。

创建 `contracts.json`：

```json
{
  "messageVersion": 1,
  "coreSchemaVersion": 1,
  "corePromptVersion": 2,
  "detailPromptVersion": 3,
  "maxSentencesPerRequest": 6,
  "cloudSentencesPerRequest": 2,
  "roles": [
    { "role": "SUBJECT", "label": "主语" },
    { "role": "PREDICATE", "label": "谓语" },
    { "role": "OBJECT", "label": "宾语" },
    { "role": "PREDICATIVE", "label": "表语" },
    { "role": "ATTRIBUTE", "label": "定语" },
    { "role": "ADVERBIAL", "label": "状语" },
    { "role": "COMPLEMENT", "label": "补语" },
    { "role": "APPOSITIVE", "label": "同位语" },
    { "role": "SUBJECT_CLAUSE", "label": "主语从句" },
    { "role": "OBJECT_CLAUSE", "label": "宾语从句" },
    { "role": "PREDICATIVE_CLAUSE", "label": "表语从句" },
    { "role": "ATTRIBUTIVE_CLAUSE", "label": "定语从句" },
    { "role": "ADVERBIAL_CLAUSE", "label": "状语从句" },
    { "role": "INDEPENDENT_ELEMENT", "label": "独立成分" },
    { "role": "COORDINATE_CLAUSE", "label": "并列分句" },
    { "role": "CONJUNCTION", "label": "并列连词" }
  ],
  "errorCodes": [
    "CONFIG_MISSING",
    "HOST_PERMISSION_DENIED",
    "AUTH_FAILED",
    "MODEL_NOT_FOUND",
    "RATE_LIMITED",
    "NETWORK_ERROR",
    "REQUEST_TIMEOUT",
    "INVALID_MODEL_OUTPUT",
    "UNSUPPORTED_PAGE",
    "UNSAFE_CONTENT_BLOCK",
    "SENTENCE_TOO_LONG",
    "REQUEST_CANCELLED",
    "NO_CACHE"
  ],
  "promptFirstLines": {
    "core": "Analyze the numbered English sentences below into core grammatical components.",
    "coreRepair": "Repair only the structure of the invalid core-analysis JSON so it satisfies every validation error.",
    "detail": "Explain only the selected grammatical component in the single sentence below.",
    "detailRepair": "Repair only the structure of the invalid detail-analysis JSON.",
    "probeSystem": "Return only the requested JSON object."
  }
}
```

- [ ] **Step 4: 生成缓存键和分词向量**

创建 `cache-key-vectors.json`，先写两个输入并通过一次性 Node 脚本调用现有 `createCoreCacheKey` 得到精确 expected 值；文件最终结构必须是：

```json
[
  {
    "name": "core-normalized-sentence",
    "input": { "normalizedSentence": "The service validates every response.", "schemaVersion": 1 },
    "expected": "49a9b9835761131d20496f0867eb10e2f38772fc51d5204ad148f78464bcc937"
  },
  {
    "name": "detail-focus",
    "input": {
      "normalizedSentence": "The service validates every response.",
      "schemaVersion": 1,
      "focus": { "startToken": 2, "endToken": 4 }
    },
    "expected": "e5876a844e369797d94e99f5ad82c8a79eb16c42841f8b7fea85d0377ffe32b2"
  }
]
```

这里的尖括号只描述生成步骤，提交前文件中必须替换成实际 digest，计划执行者不得保留占位文本。

创建 `segmenter-vectors.json`：

```json
[
  {
    "name": "abbreviation-and-apostrophe",
    "block": "Dr. Smith doesn't guess. The parser works.",
    "sentences": [
      {
        "text": "Dr. Smith doesn't guess.",
        "tokens": ["Dr", ".", "Smith", "doesn't", "guess", "."],
        "punctuation": [false, true, false, false, false, true]
      },
      {
        "text": "The parser works.",
        "tokens": ["The", "parser", "works", "."],
        "punctuation": [false, false, false, true]
      }
    ]
  },
  {
    "name": "unicode-dash",
    "block": "Well-designed tools reduce context-switching.",
    "sentences": [
      {
        "text": "Well-designed tools reduce context-switching.",
        "tokens": ["Well-designed", "tools", "reduce", "context-switching", "."],
        "punctuation": [false, false, false, false, true]
      }
    ]
  }
]
```

在现有 `analysis-cache.test.ts` 和 `segmenter.test.ts` 读取对应 JSON 并逐向量断言。

- [ ] **Step 5: 验证 TypeScript 契约**

运行：

```bash
npx vitest run src/shared/cross-platform-contract.test.ts src/background/analysis-cache.test.ts src/language/segmenter.test.ts
npm test
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add shared-fixtures src/shared/cross-platform-contract.test.ts src/background/analysis-service.ts src/background/prompts.ts src/background/analysis-cache.test.ts src/language/segmenter.test.ts tsconfig.json
git commit -m "$(cat <<'EOF'
test: 建立 Chrome 与 IDEA 的共享契约

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 3: 实现 Kotlin 领域模型与共享契约测试

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain/Domain.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/contract/SharedContractTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/contract/FixtureLoader.kt`

**Interfaces:**
- Produces: `enum class GrammarRole`, `GRAMMAR_LABELS`, `enum class ErrorCode`.
- Produces: `Token`, `TokenRange`, `SentenceInput`, `CoreComponent`, `CoreAnalysis`, `DetailStructure`, `DetailAnalysis`, `ValidationError`.
- Produces: `ContractVersions` 与 Task 2 fixture 完全一致。

- [ ] **Step 1: 写失败测试**

`FixtureLoader.kt`：

```kotlin
package dev.codetui.englishsyntax.contract

import java.nio.file.Files
import java.nio.file.Path

object FixtureLoader {
  private val repositoryRoot: Path = Path.of(System.getProperty("user.dir")).parent

  fun text(name: String): String = Files.readString(repositoryRoot.resolve("shared-fixtures").resolve(name))
}
```

`SharedContractTest.kt`：

```kotlin
package dev.codetui.englishsyntax.contract

import dev.codetui.englishsyntax.domain.ContractVersions
import dev.codetui.englishsyntax.domain.ErrorCode
import dev.codetui.englishsyntax.domain.GRAMMAR_LABELS
import dev.codetui.englishsyntax.domain.GrammarRole
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class SharedContractTest {
  private val root = Json.parseToJsonElement(FixtureLoader.text("contracts.json")).jsonObject

  @Test
  fun `versions and constants match Chrome`() {
    assertEquals(ContractVersions.MESSAGE, root.getValue("messageVersion").jsonPrimitive.content.toInt())
    assertEquals(ContractVersions.CORE_SCHEMA, root.getValue("coreSchemaVersion").jsonPrimitive.content.toInt())
    assertEquals(6, root.getValue("maxSentencesPerRequest").jsonPrimitive.content.toInt())
    assertEquals(2, root.getValue("cloudSentencesPerRequest").jsonPrimitive.content.toInt())
  }

  @Test
  fun `roles labels and errors match Chrome`() {
    val roles = root.getValue("roles").jsonArray.map {
      val item = it.jsonObject
      item.getValue("role").jsonPrimitive.content to item.getValue("label").jsonPrimitive.content
    }
    assertEquals(GrammarRole.entries.map { it.name to GRAMMAR_LABELS.getValue(it) }, roles)
    assertEquals(ErrorCode.entries.map { it.name }, root.getValue("errorCodes").jsonArray.map { it.jsonPrimitive.content })
  }
}
```

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*SharedContractTest'`

Expected: FAIL，领域类型不存在。

- [ ] **Step 3: 实现领域模型**

`Domain.kt`：

```kotlin
package dev.codetui.englishsyntax.domain

import kotlinx.serialization.Serializable

object ContractVersions {
  const val MESSAGE = 1
  const val CORE_SCHEMA = 1
  const val CORE_PROMPT = 2
  const val DETAIL_PROMPT = 3
  const val MAX_SENTENCES_PER_REQUEST = 6
  const val CLOUD_SENTENCES_PER_REQUEST = 2
}

@Serializable
enum class GrammarRole {
  SUBJECT,
  PREDICATE,
  OBJECT,
  PREDICATIVE,
  ATTRIBUTE,
  ADVERBIAL,
  COMPLEMENT,
  APPOSITIVE,
  SUBJECT_CLAUSE,
  OBJECT_CLAUSE,
  PREDICATIVE_CLAUSE,
  ATTRIBUTIVE_CLAUSE,
  ADVERBIAL_CLAUSE,
  INDEPENDENT_ELEMENT,
  COORDINATE_CLAUSE,
  CONJUNCTION,
}

val GRAMMAR_LABELS: Map<GrammarRole, String> = mapOf(
  GrammarRole.SUBJECT to "主语",
  GrammarRole.PREDICATE to "谓语",
  GrammarRole.OBJECT to "宾语",
  GrammarRole.PREDICATIVE to "表语",
  GrammarRole.ATTRIBUTE to "定语",
  GrammarRole.ADVERBIAL to "状语",
  GrammarRole.COMPLEMENT to "补语",
  GrammarRole.APPOSITIVE to "同位语",
  GrammarRole.SUBJECT_CLAUSE to "主语从句",
  GrammarRole.OBJECT_CLAUSE to "宾语从句",
  GrammarRole.PREDICATIVE_CLAUSE to "表语从句",
  GrammarRole.ATTRIBUTIVE_CLAUSE to "定语从句",
  GrammarRole.ADVERBIAL_CLAUSE to "状语从句",
  GrammarRole.INDEPENDENT_ELEMENT to "独立成分",
  GrammarRole.COORDINATE_CLAUSE to "并列分句",
  GrammarRole.CONJUNCTION to "并列连词",
)

@Serializable
enum class ErrorCode {
  CONFIG_MISSING,
  HOST_PERMISSION_DENIED,
  AUTH_FAILED,
  MODEL_NOT_FOUND,
  RATE_LIMITED,
  NETWORK_ERROR,
  REQUEST_TIMEOUT,
  INVALID_MODEL_OUTPUT,
  UNSUPPORTED_PAGE,
  UNSAFE_CONTENT_BLOCK,
  SENTENCE_TOO_LONG,
  REQUEST_CANCELLED,
  NO_CACHE,
}

@Serializable
data class Token(
  val id: Int,
  val text: String,
  val start: Int,
  val end: Int,
  val leadingWhitespace: String,
  val punctuation: Boolean,
)

@Serializable
data class TokenRange(val startToken: Int, val endToken: Int)

@Serializable
data class SentenceInput(val sentenceId: String, val text: String, val tokens: List<Token>)

@Serializable
data class CoreComponent(
  val startToken: Int,
  val endToken: Int,
  val role: GrammarRole,
  val translation: String,
)

@Serializable
data class CoreAnalysis(
  val schemaVersion: Int = ContractVersions.CORE_SCHEMA,
  val sentenceId: String,
  val components: List<CoreComponent>,
  val modelProfileId: String,
)

@Serializable
data class DetailStructure(
  val startToken: Int,
  val endToken: Int,
  val role: String,
  val explanation: String,
  val translation: String? = null,
)

@Serializable
data class DetailAnalysis(
  val sentenceId: String,
  val focus: TokenRange,
  val structures: List<DetailStructure>,
  val grammarPoints: List<String>,
  val explanation: String,
  val modelProfileId: String,
)

@Serializable
data class ValidationError(val path: String, val message: String)

data class ExtensionFailure(
  val code: ErrorCode,
  override val message: String,
  val retryable: Boolean,
  val details: Map<String, String> = emptyMap(),
) : RuntimeException(message)
```

- [ ] **Step 4: 验证并提交**

运行：`./gradlew :intellij-plugin:test --tests '*SharedContractTest'`

Expected: PASS。

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/domain intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/contract
git commit -m "$(cat <<'EOF'
feat: 新增 IDEA 句法领域契约

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 4: 实现 Kotlin 分句、分词和稳定句子 ID

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/Segmenter.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/SegmenterTest.kt`

**Interfaces:**
- Consumes: `Token`, `SentenceInput` from Task 3.
- Produces: `SegmentedSentence`, `segmentBlock(text)`, `tokenize(sentence)`, `rebuildTokens(tokens)`, `createSentenceId(...)`.

- [ ] **Step 1: 写共享向量测试**

```kotlin
package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.contract.FixtureLoader
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class SegmenterTest {
  @Test
  fun `matches shared segmenter vectors`() {
    val vectors = Json.parseToJsonElement(FixtureLoader.text("segmenter-vectors.json")).jsonArray
    for (vector in vectors) {
      val item = vector.jsonObject
      val actual = segmentBlock(item.getValue("block").jsonPrimitive.content)
      val expected = item.getValue("sentences").jsonArray
      assertEquals(expected.map { it.jsonObject.getValue("text").jsonPrimitive.content }, actual.map { it.text })
      expected.zip(actual).forEach { (expectedSentence, sentence) ->
        val expectedObject = expectedSentence.jsonObject
        val tokens = tokenize(sentence.text)
        assertEquals(expectedObject.getValue("tokens").jsonArray.map { it.jsonPrimitive.content }, tokens.map { it.text })
        assertEquals(expectedObject.getValue("punctuation").jsonArray.map { it.jsonPrimitive.content.toBoolean() }, tokens.map { it.punctuation })
        assertEquals(sentence.text, rebuildTokens(tokens))
      }
    }
  }

  @Test
  fun `sentence id is stable and scoped to preview instance`() {
    val first = createSentenceId("preview-1", "block-1", 0, "The parser works.")
    assertEquals(first, createSentenceId("preview-1", "block-1", 0, "The parser works."))
    check(first != createSentenceId("preview-2", "block-1", 0, "The parser works."))
    assertEquals(24, first.length)
  }
}
```

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*SegmenterTest'`

Expected: FAIL，函数不存在。

- [ ] **Step 3: 实现与 TypeScript 兼容的算法**

`Segmenter.kt` 的实现要求：

```kotlin
package dev.codetui.englishsyntax.language

import dev.codetui.englishsyntax.domain.Token
import java.security.MessageDigest
import java.text.BreakIterator
import java.util.Locale

private val abbreviations = listOf("Mr.", "Mrs.", "Ms.", "Dr.", "Prof.", "Sr.", "Jr.", "e.g.", "i.e.", "U.S.")
private val tokenPattern = Regex("[\\p{L}\\p{N}]+(?:['’-][\\p{L}\\p{N}]+)*|[^\\s]")
private val wordStart = Regex("^[\\p{L}\\p{N}]")

data class SegmentedSentence(val text: String, val start: Int, val end: Int)

fun segmentBlock(text: String): List<SegmentedSentence> {
  val iterator = BreakIterator.getSentenceInstance(Locale.ENGLISH)
  iterator.setText(text)
  val raw = buildList {
    var start = iterator.first()
    var end = iterator.next()
    while (end != BreakIterator.DONE) {
      add(start to end)
      start = end
      end = iterator.next()
    }
  }
  val merged = mutableListOf<Pair<Int, Int>>()
  for ((start, end) in raw) {
    val previous = merged.lastOrNull()
    if (previous != null && abbreviations.any { text.substring(previous.first, previous.second).trimEnd().endsWith(it) }) {
      merged[merged.lastIndex] = previous.first to end
    } else {
      merged += start to end
    }
  }
  return merged.mapNotNull { (rawStart, rawEnd) ->
    val source = text.substring(rawStart, rawEnd)
    val leading = source.length - source.trimStart().length
    val value = source.trim()
    if (value.isEmpty()) null else SegmentedSentence(value, rawStart + leading, rawStart + leading + value.length)
  }
}

fun tokenize(sentence: String): List<Token> {
  var previousEnd = 0
  return tokenPattern.findAll(sentence).mapIndexed { index, match ->
    val start = match.range.first
    val end = match.range.last + 1
    Token(
      id = index,
      text = match.value,
      start = start,
      end = end,
      leadingWhitespace = sentence.substring(previousEnd, start),
      punctuation = !wordStart.containsMatchIn(match.value),
    ).also { previousEnd = end }
  }.toList()
}

fun rebuildTokens(tokens: List<Token>): String = tokens.joinToString("") { it.leadingWhitespace + it.text }

fun createSentenceId(sessionId: String, blockId: String, order: Int, normalizedText: String): String {
  val source = "$sessionId\u0000$blockId\u0000$order\u0000$normalizedText"
  return MessageDigest.getInstance("SHA-256")
    .digest(source.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }
    .take(24)
}
```

若 `BreakIterator` 与 `Intl.Segmenter` 在共享向量上有差异，只能在本函数增加确定性后处理使共享向量一致，不得修改 fixture 去迁就 Kotlin。

- [ ] **Step 4: 验证并提交**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*SegmenterTest'
npm test -- --run src/language/segmenter.test.ts
```

Expected: 两端 PASS。

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/Segmenter.kt intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/SegmenterTest.kt
git commit -m "$(cat <<'EOF'
feat: 实现 IDEA 英文分句与分词

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

### Task 5: 实现核心和详解输出校验

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/AnalysisValidatorTest.kt`

**Interfaces:**
- Consumes: `SentenceInput`, `CoreAnalysis`, `DetailAnalysis` from Task 3 and `tokenize` from Task 4。
- Produces: `validateCoreBatch(raw: JsonElement, requests: List<SentenceInput>, profileId: String): ValidationResult<List<CoreAnalysis>>`。
- Produces: `validateDetail(raw: JsonElement, request: SentenceInput, focus: TokenRange, profileId: String): ValidationResult<DetailAnalysis>`。

- [ ] **Step 1: 写失败测试**

`AnalysisValidatorTest.kt` 必须覆盖以下实际样本：

```kotlin
@Test
fun `accepts complete non punctuation coverage`() {
  val sentence = sentence("The service validates every response.")
  val raw = Json.parseToJsonElement(
    """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"该服务"},{"startToken":2,"endToken":2,"role":"PREDICATE","translation":"校验"},{"startToken":3,"endToken":4,"role":"OBJECT","translation":"每个响应"}]}]}""",
  )
  val result = validateCoreBatch(raw, listOf(sentence), "profile-1")
  assertTrue(result.ok)
}

@Test
fun `rejects missing token and overlap`() {
  val sentence = sentence("The service validates every response.")
  val raw = Json.parseToJsonElement(
    """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":2,"role":"SUBJECT","translation":"该服务校验"},{"startToken":2,"endToken":4,"role":"OBJECT","translation":"响应"}]}]}""",
  )
  val result = validateCoreBatch(raw, listOf(sentence), "profile-1")
  assertFalse(result.ok)
  assertTrue(result.errors.any { it.message.contains("overlap", ignoreCase = true) || it.message.contains("covered") })
}

@Test
fun `rejects unsafe output and punctuation only component`() {
  val sentence = sentence("The service works.")
  val raw = Json.parseToJsonElement(
    """{"sentences":[{"sentenceId":"s1","components":[{"startToken":0,"endToken":1,"role":"SUBJECT","translation":"<script>alert(1)</script>"},{"startToken":2,"endToken":2,"role":"PREDICATE","translation":"工作"},{"startToken":3,"endToken":3,"role":"OBJECT","translation":"。"}]}]}""",
  )
  assertFalse(validateCoreBatch(raw, listOf(sentence), "profile-1").ok)
}

@Test
fun `detail must preserve requested focus`() {
  val sentence = sentence("The service validates every response.")
  val raw = Json.parseToJsonElement(
    """{"sentenceId":"s1","focus":{"startToken":0,"endToken":1},"structures":[],"grammarPoints":[],"explanation":"主语短语"}""",
  )
  assertFalse(validateDetail(raw, sentence, TokenRange(2, 2), "profile-1").ok)
}
```

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest'`

Expected: FAIL，校验函数不存在。

- [ ] **Step 3: 实现最小安全校验**

实现必须遵循 TypeScript 的判定顺序：先检查 envelope/字段白名单，再解析范围、角色、文本，最后检查顺序、不重叠、覆盖率和长度。危险文本正则为：

```kotlin
private val unsafeText = Regex("<script|<iframe|javascript:|\\u0000", RegexOption.IGNORE_CASE)
```

实现时固定这些规则：

- 核心角色只接受 `GrammarRole.entries`；
- 区间必须是闭区间，start/end 非负，start <= end，且首尾 Token 存在；
- 成分排序按 `startToken`，任何 `startToken <= previousEnd` 都失败；
- 每个非标点 Token 覆盖恰好一次；标点可不覆盖但不可被覆盖多次；
- 纯标点成分先由 `dropPunctuationOnlyComponents` 复制 raw envelope 后移除，再进入核心校验；
- 核心译文非空，长度不超过 `maxOf(500, englishLength * 8)`；
- 详解 role/explanation/grammarPoints/translation 只允许安全文本；
- 详解 focus 必须逐字段等于请求 focus；
- 详解结构范围不得越出 Token；
- `modelProfileId` 只由 Kotlin 传入，不能信任模型 JSON。

- [ ] **Step 4: 验证边界样本**

追加测试：未知角色、缺句、重复 sentenceId、额外字段、空翻译、超长翻译、详解缺 focus、详解危险 explanation、超过 12 个 grammar points。

运行：`./gradlew :intellij-plugin:test --tests '*AnalysisValidatorTest'`

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/language/AnalysisValidator.kt intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/language/AnalysisValidatorTest.kt
git commit -m "$(cat <<'EOF'
feat: 增加 IDEA 模型输出校验

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 6: 实现 Profile、PasswordSafe 和配置设置

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/settings/ProfileState.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/settings/ProfileRepository.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/settings/CredentialStore.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/settings/EnglishSyntaxConfigurable.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/settings/ProfileRepositoryTest.kt`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml`

**Interfaces:**
- Produces: `data class ModelProfile(id, name, baseUrl, model, headerNames, timeoutMs, jsonSchemaSupport, streamSupport, reasoningControl)`；明文凭据不在该类型中。
- Produces: `CredentialStore.get(profileId, field): String?`, `put(profileId, field, value)`, `delete(profileId, field)`。
- Produces: `ProfileRepository.list()`, `save(profile)`, `delete(id)`, `active()`, `setActive(id)`, `updateCapability(id, capability)`。

- [ ] **Step 1: 写配置校验失败测试**

创建五个独立测试：

1. `normalizes HTTPS base URL and rejects forbidden headers`：保存 `https://api.example.com/v1/` 后断言读回 `https://api.example.com/v1`；逐一传入 `Authorization`、`Host`、`Content-Length`、`Origin`、`X-Syntax-Request-Id` 并断言 `IllegalArgumentException`。
2. `timeout is limited to 5000 through 120000 milliseconds`：断言 5,000 和 120,000 可保存，4,999 和 120,001 被拒绝。
3. `api key is never serialized into persistent state`：向 FakeCredentialStore 写 `secret-profile-key`，保存 Profile 后把 PersistentState 编码成 XML/字符串，断言不含该 key；再由 repository 读取凭据并断言能得到原值。
4. `deleting profile deletes credentials`：保存 API Key 和一个敏感自定义头，删除 Profile，断言 FakeCredentialStore 对两个 field 都收到 delete。
5. `capabilities persist only negative state`：分别记录 schema/stream/reasoning 不支持并读回；尝试写 supported 时只允许 schema 的连接探测结果，stream/reasoning 不创建肯定态字段。

另加参数化断言：HTTPS 远端合法，HTTP 只允许 localhost/127.0.0.1；空名称、空模型和错误超时被拒绝。

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*ProfileRepositoryTest'`

Expected: FAIL，配置类不存在。

- [ ] **Step 3: 实现 PersistentStateComponent 和凭据隔离**

`ProfileState.kt` 使用 `SimplePersistentStateComponent` + `BaseState`，保存 Profile 列表、当前 Profile ID、缓存上限、流式开关和能力否定位。每个 Profile 只保存：

```kotlin
data class StoredProfile(
  val id: String,
  val name: String,
  val baseUrl: String,
  val model: String,
  val headers: Map<String, String>,
  val timeoutMs: Int,
  val jsonSchemaSupport: String,
  val streamSupport: String?,
  val reasoningControl: String?,
)
```

`CredentialStore.kt`：

```kotlin
interface CredentialStore {
  suspend fun get(profileId: String, field: String): String?
  suspend fun put(profileId: String, field: String, value: String)
  suspend fun delete(profileId: String, field: String)
}

class PasswordSafeCredentialStore : CredentialStore {
  private fun attributes(profileId: String, field: String): CredentialAttributes =
    CredentialAttributes(generateServiceName("English Syntax Learning", "$profileId:$field"))

  override suspend fun get(profileId: String, field: String): String? = withContext(Dispatchers.IO) {
    PasswordSafe.instance.getPassword(attributes(profileId, field))
  }

  override suspend fun put(profileId: String, field: String, value: String) = withContext(Dispatchers.IO) {
    PasswordSafe.instance.setPassword(attributes(profileId, field), value)
  }

  override suspend fun delete(profileId: String, field: String) = withContext(Dispatchers.IO) {
    PasswordSafe.instance.setPassword(attributes(profileId, field), null)
  }
}
```

ProfileRepository 使用应用级 service 构造器注入 `CoroutineScope`，但 API Key 读取只在模型请求前通过 `CredentialStore` 取得，不能放入 `ModelProfile` 状态对象。

- [ ] **Step 4: 实现 Settings UI DSL 2**

配置页必须提供：Profile 列表、名称/Base URL/模型/自定义头/超时编辑、API Key 输入、测试连接按钮、启用 Profile、缓存上限、流式开关、缓存导入导出入口。UI 文案全部从 `EnglishSyntaxBundle` 读取，不写散落的硬编码用户文案。

在 `plugin.xml` 注册：

```xml
<extensions defaultExtensionNs="com.intellij">
  <applicationService serviceImplementation="dev.codetui.englishsyntax.settings.ProfileRepository"/>
  <applicationConfigurable parentId="tools" instance="dev.codetui.englishsyntax.settings.EnglishSyntaxConfigurable"/>
</extensions>
```

- [ ] **Step 5: 验证敏感信息和设置页**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*ProfileRepositoryTest'
./gradlew :intellij-plugin:buildPlugin
```

人工检查：解压插件和沙箱设置 XML，不出现 API Key；设置页可打开，PasswordSafe 操作不在 EDT 执行。

- [ ] **Step 6: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/settings intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/settings intellij-plugin/src/main/resources/META-INF/plugin.xml
 git commit -m "$(cat <<'EOF'
feat: 增加 IDEA 模型配置与安全凭据存储

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 7: 实现 Prompt、Schema、URL 和 SSE/流式解析

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/BaseUrl.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/Prompts.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/SseDecoder.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/CoreStreamParser.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/DetailStreamParser.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/BaseUrlTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/PromptsTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/SseDecoderTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/StreamParserTest.kt`

**Interfaces:**
- Produces: `normalizeBaseUrl`, `chatCompletionsUrl`, `isLoopbackBaseUrl`。
- Produces: `buildCorePrompt`, `buildRepairPrompt`, `buildDetailPrompt`, `serializeSentence`, `serialize`。
- Produces: `SseDecoder.push(chunk): List<String>`，`SSE_DONE`。
- Produces: `CoreStreamParser.push(delta): List<StreamedComponent>`、`DetailStreamParser.push(delta): List<JsonObject>`。

- [ ] **Step 1: 先移植固定 Prompt 测试**

测试直接读取 `contracts.json` 的 prompt 首行，并断言以下内容：

```kotlin
@Test
fun `core prompt starts with shared line and compact sentence payload`() {
  val prompt = buildCorePrompt(listOf(sentence("The service works.")))
  assertTrue(prompt.startsWith("Analyze the numbered English sentences below into core grammatical components."))
  assertTrue(prompt.contains("{\"sentenceId\":\"s1\""))
  assertFalse(prompt.contains("\n  \"sentenceId\""))
}
```

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*PromptsTest' --tests '*SseDecoderTest'`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 URL 和 Prompt**

URL 规则与 Chrome 相同：远端强制 HTTPS；HTTP 仅允许 localhost/127.0.0.1；去掉末尾 `/`；追加 `/v1/chat/completions`，不重复追加。

Prompt 规则：

- 使用 `kotlinx.serialization.json.Json { encodeDefaults = false; prettyPrint = false }`；
- 句子只序列化 `sentenceId`, `text`, `tokens[{id,text,punctuation?}]`；
- 核心结果、focus、校验错误和待修复 JSON 紧凑序列化；
- 首行文本与 `contracts.json` 完全一致；
- 输出形状、16 角色、覆盖率、从句和 `MINIFIED_OUTPUT` 规则与 TS 相同。

- [ ] **Step 4: 实现 SSE 解码器**

`SseDecoder` 必须处理：CRLF、LF、注释行、跨 chunk 半行、多个 data 行、空行事件边界和 `[DONE]`。只读取 `data:` 字段；空事件不返回；不把任意 SSE 文本直接送给 JSON parser。

- [ ] **Step 5: 实现流式 parser**

Core parser 只在 JSON 字符级状态机发现完整 `component` 对象时输出；Detail parser 只在 `structures` 数组内发现完整对象时输出。两者必须忽略 Markdown 围栏和开头散文，不能用简单括号深度替代 key-aware 解析。

- [ ] **Step 6: 验证**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*BaseUrlTest' --tests '*PromptsTest' --tests '*SseDecoderTest' --tests '*StreamParserTest'
npm test -- --run src/background/prompts.test.ts src/background/sse.test.ts src/background/core-stream-parser.test.ts src/background/detail-stream-parser.test.ts
```

Expected: Kotlin 与 TypeScript 全绿。

- [ ] **Step 7: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model
git commit -m "$(cat <<'EOF'
feat: 增加 IDEA Prompt 与流式解析

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

### Task 8: 实现 OpenAI-compatible HTTP 客户端与能力降级

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/OpenAiCompatibleClient.kt`
- Create: `intellij-plugin/src/testFixtures/kotlin/dev/codetui/englishsyntax/testsupport/FakeOpenAiServer.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/OpenAiCompatibleClientTest.kt`
- Modify: `intellij-plugin/build.gradle.kts`

**Interfaces:**
- Consumes: Profile/CredentialStore from Task 6；Prompt schema and stream parsers from Task 7。
- Produces: `completeJson`, `completeCoreStreaming`, `completeDetailStreaming`, `probeJsonCapability`。
- Produces: `CapabilityWriter.markJsonSchemaUnsupported`, `markStreamUnsupported`, `markReasoningUnsupported`。

- [ ] **Step 1: 配置 test fixtures 并写假服务器**

在 `intellij-plugin/build.gradle.kts` 增加 `java-test-fixtures` 插件和 `testFixturesImplementation`。`FakeOpenAiServer` 使用 JDK `HttpServer`，必须支持：

```kotlin
data class RecordedRequest(
  val path: String,
  val headers: Map<String, List<String>>,
  val body: JsonObject,
)

class FakeOpenAiServer : AutoCloseable {
  val baseUrl: String
  val requests: List<RecordedRequest>
  fun enqueueJson(content: String, status: Int = 200, headers: Map<String, String> = emptyMap())
  fun enqueueSse(deltas: List<String>, includeDone: Boolean = true)
  fun clearRequests()
}
```

服务器对 `/v1/chat/completions` 按队列返回；JSON 完成响应使用 `choices[0].message.content`；SSE 使用 `choices[0].delta.content`；所有请求记录必须保存 `stream`、`reasoning_effort` 和 `response_format` 以便探针断言。

- [ ] **Step 2: 写失败的 HTTP/降级测试**

写 11 个可独立运行的测试，每个都用 `FakeOpenAiServer.requests` 断言请求数量和字段：

1. 缓冲请求：enqueue 合法 JSON，调用 `completeJson`，断言 Authorization、schema、`reasoning_effort:none`、`stream:false`。
2. 401：enqueue 401，断言 `ExtensionFailure(AUTH_FAILED, retryable=false)`。
3. 429：enqueue 429 + `Retry-After: 2`，断言 `RATE_LIMITED` 且 `retryAfterMs=2000`。
4. 400 Model Not Exist：断言 `MODEL_NOT_FOUND`。
5. schema 降级：先 enqueue 400 response_format，再成功；断言两请求，第二个无 response_format，CapabilityWriter 被调用一次。
6. reasoning 降级：先 enqueue 422 reasoning_effort，再成功；断言第二请求无该字段，writer 一次。
7. stream 降级：先 enqueue 400 stream，再 enqueue buffered 成功；断言第二请求 `stream:false`。
8. 空 stream：返回只有 `[DONE]`，再 buffered 成功；断言降级一次、总请求两次。
9. 静默超时：测试 server 用可控闸门逐片写入，片间小于 timeout、最后静默大于 timeout；断言前两片延长生命，最后得到 `REQUEST_TIMEOUT`。
10. 调用方取消：server 保持 body 打开，取消 coroutine，断言 `REQUEST_CANCELLED` 且 server 观察连接关闭。
11. 密钥脱敏：provider 500 body 回显唯一 API Key，断言异常 message/details 不含原值而含 `[redacted]`。

除静默超时的可控虚拟/短超时测试外，不使用固定等待；降级行为一律以请求探针和 writer 调用次数判定。

- [ ] **Step 3: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*OpenAiCompatibleClientTest'`

Expected: FAIL，客户端不存在。

- [ ] **Step 4: 实现缓冲请求和错误映射**

使用 JDK `HttpClient.newBuilder().connectTimeout(...).build()`；每次请求创建 `HttpRequest`，只允许配置层提供的 URL。请求头：`Content-Type`, `Authorization: Bearer`, 非敏感/敏感自定义头合并后的最终值。

错误映射固定为：

- 401/403 → `AUTH_FAILED`, retryable false；
- 404 或 400 body 匹配 `model...not exist/not found` → `MODEL_NOT_FOUND`；
- 429 → `RATE_LIMITED`, retryable true，解析秒数或 HTTP 日期；
- 超时 → `REQUEST_TIMEOUT`, retryable true；
- 调用方取消 → `REQUEST_CANCELLED`, retryable false；
- 其余 → `NETWORK_ERROR`, 仅 5xx retryable。

所有 provider body 在进入异常前调用：

```kotlin
fun redactSecrets(text: String, secrets: Collection<String>): String =
  secrets.filter { it.isNotEmpty() }.fold(text) { value, secret -> value.replace(secret, "[redacted]") }
```

- [ ] **Step 5: 实现三种能力降级和流式静默超时**

流式读取使用 `BodyHandlers.ofInputStream()`，循环读取字节后喂给 `SseDecoder`。每个非空字节块都更新 `lastActivityNanos`；独立 watchdog coroutine 只在静默超过 `timeoutMs` 时取消请求。读取循环同时 `select` 调用方 Job 取消，不能依赖 InputStream 自动响应取消。

降级顺序：

1. schema 拒绝 → 写 `jsonSchemaSupport=unsupported`，保留 stream/reasoning 重试；
2. stream 拒绝或无内容分片 → 写 `streamSupport=unsupported`，走缓冲路径；
3. reasoning 拒绝 → 写 `reasoningControl=unsupported`，去字段重试；
4. 每种能力一次调用最多降级一次，禁止无限循环。

- [ ] **Step 6: 验证**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*OpenAiCompatibleClientTest'
./gradlew :intellij-plugin:test
```

Expected: 全部 PASS；假服务器请求计数与降级次数精确一致。

- [ ] **Step 7: 提交**

```bash
git add intellij-plugin/build.gradle.kts intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/model/OpenAiCompatibleClient.kt intellij-plugin/src/testFixtures intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/model/OpenAiCompatibleClientTest.kt
git commit -m "$(cat <<'EOF'
feat: 实现 IDEA OpenAI 兼容客户端

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 9: 实现 IDEA 请求调度器

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/scheduler/RequestScheduler.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/scheduler/RequestSchedulerTest.kt`

**Interfaces:**
- Produces: `enum class SchedulerPriority { USER_RETRY, DETAIL_CLICK, ACTIVE_VISIBLE_CORE, OTHER_VISIBLE_CORE, ACTIVE_PREFETCH_CORE }`。
- Produces: `ScheduledRequest<T>`, `suspend schedule(request, run): T`, `cancelDocument(documentId)`, `pauseDocument(documentId)`, `resumeDocument(documentId)`。

- [ ] **Step 1: 写失败测试**

覆盖 10 个独立场景：

1. 先 pause scheduler，按逆序入队五档优先级，resume 后用 execution log 断言固定顺序。
2. 同优先级普通、repair、普通三项入队，断言 repair 先出；另放更高优先级普通项，断言它仍早于低优先级 repair。
3. concurrency=2，两个 run block 在 deferred gate，第三个不得开始；放行一个后第三个开始，证明一请求一槽。
4. concurrency=4/background=3，四个背景项入队只启动三个，再入队交互项立即占第四槽。
5. 相同 documentId/cacheKey 两次 schedule，断言 runner 一次且两个 await 得同值；不同 document 不去重。
6. sentenceCount=7 立即失败 `SENTENCE_TOO_LONG`，runner 未调用。
7. runner 前两次抛 retryable、第三次成功；推进 TestCoroutineScheduler，断言三次调用和 500/1000ms 延迟。
8. RATE_LIMITED 带 `retryAfterMs=2300`，断言只推进 2300ms 后重试。
9. 一个 active 和一个 queued 属于同 document，调用 cancel 后两者都得到 `REQUEST_CANCELLED`；其他 document 继续。
10. pauseDocument 只挡该 document 新工作，另一个 document 正常运行；resumeDocument 后被挡项开始。

测试用 `StandardTestDispatcher` 和 `TestCoroutineScheduler`，不得 `Thread.sleep`。

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*RequestSchedulerTest'`

Expected: FAIL。

- [ ] **Step 3: 实现调度器**

默认：`concurrency=4`，`backgroundConcurrency=3`，`maxSentencesPerRequest=6`，`maxRetries=2`。排序键：priority rank → `jumpQueue=true` → sequence。去重键：`documentId + NUL + cacheKey`。

`ACTIVE_PREFETCH_CORE` 是背景类；其余四类为交互/可见类。已经运行的任务不抢占。每个 queue item 持有自己的 `CompletableDeferred` 与 `Job`，取消 document 时排队项以 `REQUEST_CANCELLED` 完成异常，在飞 Job 取消。

- [ ] **Step 4: 验证并提交**

运行：`./gradlew :intellij-plugin:test --tests '*RequestSchedulerTest'`

Expected: PASS。

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/scheduler intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/scheduler
git commit -m "$(cat <<'EOF'
feat: 增加 IDEA 模型请求调度器

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 10: 实现 SQLite 缓存、键与跨端交换

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/cache/CacheKeys.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/cache/AnalysisCache.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/cache/CacheTransfer.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/cache/CacheKeysTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/cache/AnalysisCacheTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/cache/CacheTransferTest.kt`
- Create: `shared-fixtures/cache-transfer-v1.json`
- Modify: `src/options/cache-transfer.test.ts`

**Interfaces:**
- Produces: `createCoreCacheKey(normalizedSentence, schemaVersion, focus?)`。
- Produces: `AnalysisCache.getCore/putCore/getDetail/putDetail/stats/clear/export/import`。
- Produces: `CacheExportFile(format, formatVersion, schemaVersion, exportedAt, core, detail)`。

- [ ] **Step 1: 写缓存键共享向量测试**

Kotlin 测试读取 `cache-key-vectors.json`，逐条调用 `createCoreCacheKey` 并与 expected 完全相等。算法必须精确编码 JSON 数组：

```text
core: ["core", normalizedSentence, schemaVersion, null]
detail: ["core", normalizedSentence, schemaVersion, [startToken, endToken]]
```

使用 UTF-8 + SHA-256 + 小写十六进制。

- [ ] **Step 2: 写 SQLite/LRU/交换失败测试**

覆盖：put/get 更新 `lastAccessedAt`；同毫秒写入时间单调；跨 core/detail 按 LRU 淘汰；已有键导入跳过；非法文件整体拒绝；schema mismatch 拒绝；清空后统计为零；导出不含 profile 凭据。

共享 `cache-transfer-v1.json` 使用一个合法 core 和一个合法 detail 条目，键必须由 Task 2 固定向量构造，value 必须能同时通过 TS/Kotlin 校验。

- [ ] **Step 3: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*Cache*Test'`

Expected: FAIL。

- [ ] **Step 4: 实现 SQLite schema 和事务**

数据库路径放在 `PathManager.getSystemPath()/english-syntax-learning/cache-v1.sqlite`。测试构造器允许传临时路径。建表：

```sql
CREATE TABLE IF NOT EXISTS analysis_cache (
  store TEXT NOT NULL CHECK(store IN ('core','detail')),
  cache_key TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_accessed_at INTEGER NOT NULL,
  estimated_bytes INTEGER NOT NULL,
  PRIMARY KEY(store, cache_key)
);
CREATE INDEX IF NOT EXISTS analysis_cache_lru ON analysis_cache(last_accessed_at);
```

所有 DB 操作在 `Dispatchers.IO`。`put` 后在同一互斥区执行跨 store LRU；导入先完整解析/校验，再单事务写入，最后统一 LRU。

- [ ] **Step 5: 双端验证交换 fixture**

TypeScript `cache-transfer.test.ts` 读取共享文件，验证可导入；Kotlin 导入后导出，规范化 `exportedAt` 后与共享 value/key 相等。

运行：

```bash
./gradlew :intellij-plugin:test --tests '*Cache*Test'
npx vitest run src/options/cache-transfer.test.ts src/background/analysis-cache.test.ts
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/cache intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/cache shared-fixtures/cache-transfer-v1.json src/options/cache-transfer.test.ts
git commit -m "$(cat <<'EOF'
feat: 增加 IDEA 分析缓存与跨端交换

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 11: 实现缓存分析服务

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis/AnalysisService.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/analysis/AnalysisServiceTest.kt`

**Interfaces:**
- Consumes: Client Task 8、Scheduler Task 9、Cache Task 10、Validator Task 5。
- Produces: `analyzeCore`, `lookupCore`, `analyzeDetail`, `lookupDetail`, `cancelDocument`。
- Produces: `CoreBatchOutcome(result, failures, cacheHit)` 和流式 sink 接口。

- [ ] **Step 1: 写核心链路失败测试**

测试覆盖：全缓存命中不调 client；远端 5 个缺失句切成 2/2/1 三请求；loopback 6 句只发一请求；一块失败不连坐；只修非法句；修复仍失败变 `INVALID_MODEL_OUTPUT`；纯标点成分本地删除后不修复；流式暂定成分不写缓存；详解缓存键与点击路径一致。

Fake client 暴露 `requests` 和可脚本化 raw 响应；断言用调用计数而不是时间。

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*AnalysisServiceTest'`

Expected: FAIL。

- [ ] **Step 3: 实现核心分析**

流程：

1. 对每句算 key 并读取缓存；
2. 缓存命中也重新校验，并将 `modelProfileId` 改成当前 Profile；
3. 未命中按 base URL 分块；
4. 每块通过 scheduler 发请求；
5. 流式时用 `ProvisionalComponents` 只接受角色合法、范围合法、有序不重叠项；
6. 完整 raw 先删除纯标点 component，再逐句校验；
7. 只把失败句和其错误送修复；
8. 合法句立刻写缓存；
9. 汇总结果和逐句失败。

- [ ] **Step 4: 实现详解分析**

详解只处理单 focus；优先级 `DETAIL_CLICK`；流式 `ProvisionalStructures` 校验范围/非空文本/危险文本；最终失败修复一次；合法后写 Task 10 的 detail key。

- [ ] **Step 5: 验证并提交**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*AnalysisServiceTest'
./gradlew :intellij-plugin:test
```

Expected: PASS。

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/analysis intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/analysis
git commit -m "$(cat <<'EOF'
feat: 实现 IDEA 缓存分析服务

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 12: 建立 JCEF Bridge 协议和 Web 测试工具链

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocol.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge/BridgeProtocolTest.kt`
- Create: `intellij-plugin/src/main/resources/web/bridge.ts`
- Create: `intellij-plugin/src/main/resources/web/bridge.test.ts`
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Modify: `tsconfig.json`

**Interfaces:**
- Produces JS→Kotlin：`PREVIEW_READY`, `VISIBLE_BLOCKS`, `DETAIL_REQUEST`, `RETRY_SENTENCE`。
- Produces Kotlin→JS：`SESSION_STATE`, `CORE_STREAM`, `CORE_RESULT`, `CORE_ERROR`, `DETAIL_STREAM`, `DETAIL_RESULT`, `RESTORE_ALL`。
- 每条消息包含 `version=1`, `previewId`, `generation`；句子消息再含 `sentenceId`。

- [ ] **Step 1: 定义共享 bridge fixture 并写失败测试**

Kotlin 和 TS 都测试：合法最小消息通过；未知 type、额外键、错误版本、空 previewId、负 generation、非连续 Token、超过 6 句、包含 `apiKey`/`headers`/`baseUrl` 字段的消息拒绝。

`VISIBLE_BLOCKS` 最大 50 块，每块文本最大 20,000 字符；`DETAIL_REQUEST` focus 必须非负闭区间。

- [ ] **Step 2: 配置 Vitest 包含 Web 模块**

`vitest.config.ts` include 增加：

```ts
"intellij-plugin/src/main/resources/web/**/*.test.ts"
```

`tsconfig.json` include 增加 Web 目录。`package.json` 增加：

```json
"test:idea-web": "vitest run intellij-plugin/src/main/resources/web"
```

- [ ] **Step 3: 跑测试确认失败**

运行：

```bash
npm run test:idea-web
./gradlew :intellij-plugin:test --tests '*BridgeProtocolTest'
```

Expected: FAIL。

- [ ] **Step 4: 实现严格协议**

Kotlin 使用 `JsonObject.keys == allowedKeys`，不能只检查必需字段。解析后构造封闭 sealed interface；不得把未知 JSON 透传到会话层。

TypeScript 使用每 type 的 `hasOnlyKeys` 和逐字段守卫。JS bridge 对 Kotlin 回调也重复校验 generation；旧 generation 直接丢弃。

- [ ] **Step 5: 验证并提交**

运行：

```bash
npm run test:idea-web
./gradlew :intellij-plugin:test --tests '*BridgeProtocolTest'
```

Expected: PASS。

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/bridge intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/bridge intellij-plugin/src/main/resources/web/bridge.ts intellij-plugin/src/main/resources/web/bridge.test.ts package.json vitest.config.ts tsconfig.json
git commit -m "$(cat <<'EOF'
feat: 建立 IDEA 预览 Bridge 协议

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

### Task 13: 实现 Markdown DOM 扫描和可逆句法卡片

**Files:**
- Create: `intellij-plugin/src/main/resources/web/preview.ts`
- Create: `intellij-plugin/src/main/resources/web/render.ts`
- Create: `intellij-plugin/src/main/resources/web/preview.css`
- Create: `intellij-plugin/src/main/resources/web/preview.test.ts`
- Create: `intellij-plugin/src/main/resources/web/render.test.ts`

**Interfaces:**
- Consumes: bridge Task 12。
- Produces: `scanMarkdownBlocks(root): PreviewBlock[]`, `observeBlocks`, `renderCoreStream`, `renderCoreResult`, `renderCoreError`, `renderDetail*`, `restoreAll`。

- [ ] **Step 1: 写 DOM 扫描失败测试**

happy-dom fixture 至少包含：标题、普通段落、列表项、blockquote、pre/code、table、`.math`、`.mermaid`、脚注、按钮、嵌套块和插件自己的 `[data-english-syntax-card]`。

断言：只返回安全叶子正文；英文占比不足或短于 20 字符跳过；代码/表格/数学/图表/脚注/交互区跳过；同一节点不重复注册。

- [ ] **Step 2: 写可逆渲染失败测试**

覆盖：

- 完整结果前原文可见；
- 流式首个安全成分到达后可显示 preview card；
- 最终结果覆盖 preview；
- 错误恢复原文并显示重试按钮；
- `restoreAll` 删除全部插件节点和 data 属性；
- 模型文本 `<img onerror=...>` 只作为文本；
- 旧 generation 消息不改 DOM；
- 未覆盖标点按原序附着；
- 点击成分发 `DETAIL_REQUEST`；
- 同时只展开一个详解面板。

- [ ] **Step 3: 跑测试确认失败**

运行：`npm run test:idea-web`

Expected: FAIL。

- [ ] **Step 4: 实现扫描和 IntersectionObserver**

候选选择器固定为 `h1,h2,h3,h4,h5,h6,p,li,blockquote`，但 blockquote 只返回其安全叶子。排除选择器包括：

```ts
const EXCLUDED = "pre,code,table,.math,.katex,.mermaid,.footnotes,[role='doc-endnotes'],button,input,textarea,select,iframe,[contenteditable], [data-english-syntax-card]";
```

英文占比按字母词统计，>= 60%；自动最短 20 字符。`IntersectionObserver` rootMargin 使用 `100% 0px 100% 0px`；fallback 用 requestAnimationFrame 节流 scroll/resize。

- [ ] **Step 5: 实现卡片和详解**

原节点使用 `data-english-syntax-hidden`，CSS `display:none!important`；卡片插在其后。卡片 host 使用 open Shadow DOM，内部创建 role/english/translation 三行按钮，所有字符串走 `textContent`。

原节点原本的属性不修改，除插件专用 data 属性；恢复时精确删除该属性和插件 sibling。Markdown 重新 patch 删除节点时，MutationObserver 清理孤儿记录。

- [ ] **Step 6: 验证并提交**

运行：

```bash
npm run test:idea-web
npm test
```

Expected: PASS。

```bash
git add intellij-plugin/src/main/resources/web/preview.ts intellij-plugin/src/main/resources/web/render.ts intellij-plugin/src/main/resources/web/preview.css intellij-plugin/src/main/resources/web/preview.test.ts intellij-plugin/src/main/resources/web/render.test.ts
git commit -m "$(cat <<'EOF'
feat: 实现 IDEA Markdown 句法卡片渲染

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 14: 实现自定义 Markdown Preview Provider 和 JCEF 面板

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewProvider.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanel.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewProviderTest.kt`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml`

**Interfaces:**
- Produces: `EnglishSyntaxPreviewProvider : MarkdownHtmlPanelProvider`。
- Produces: `EnglishSyntaxPreviewPanel : MarkdownHtmlPanelEx`，暴露 `previewId`, `generation`, `send(message)`。
- Consumes: Task 12 bridge 和 Task 13 bundled web 资源。

- [ ] **Step 1: 写 Provider 失败测试**

使用 `BasePlatformTestCase` 测试四个实际场景：

1. `provider info is stable`：实例化 Provider，断言 name 为 `English Syntax Chromium Preview`，className 为实现类全名。
2. `provider is unavailable when JCEF support probe is false`：注入 `{ false }` support probe，断言 `AvailabilityInfo.UNAVAILABLE` 且 `createHtmlPanel` 不被调用。
3. `provider creates project and virtual file aware panel`：用 fixture `.md` 文件调用 `createHtmlPanel(project, file)`，断言 panel 保存相同 project/file。
4. `disposing panel closes bridge queries and coroutine scope`：创建 panel，发送一条 bridge 消息，调用 `Disposer.dispose(panel)`，断言 query handler 不再接收、scope Job 已取消、发送入口抛出已释放错误。

为可测性，Provider 构造器接受 `jcefSupported: () -> Boolean = JBCefApp::isSupported` 和 panel factory；每个测试的 act/assert 必须写在实际测试方法中，不保留空方法。

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*EnglishSyntaxPreviewProviderTest'`

Expected: FAIL。

- [ ] **Step 3: 实现 Provider**

准确覆盖 Markdown API：

```kotlin
class EnglishSyntaxPreviewProvider : MarkdownHtmlPanelProvider() {
  override fun createHtmlPanel(): MarkdownHtmlPanel = EnglishSyntaxPreviewPanel(null, null)
  override fun createHtmlPanel(project: Project, virtualFile: VirtualFile): MarkdownHtmlPanel =
    EnglishSyntaxPreviewPanel(project, virtualFile)
  override fun isAvailable(): AvailabilityInfo =
    if (JBCefApp.isSupported()) AvailabilityInfo.AVAILABLE else AvailabilityInfo.UNAVAILABLE
  override fun getProviderInfo() = ProviderInfo("English Syntax Chromium Preview", javaClass.name)
}
```

`plugin.xml` 注册准确扩展点：

```xml
<extensions defaultExtensionNs="org.intellij.markdown">
  <html.panel.provider implementation="dev.codetui.englishsyntax.markdown.EnglishSyntaxPreviewProvider"/>
</extensions>
```

如果 Plugin Verifier 指出 XML 简写不识别，使用完整 `<extension point="org.intellij.markdown.html.panel.provider" implementation="..."/>`，不得猜测其他名字。

- [ ] **Step 4: 实现 Panel**

Panel 可参考官方 `MarkdownJCEFHtmlPanel`，但只复制完成需求所需的最小职责：

- 使用 `PreviewStaticServer` 提供 index/web 资源，CSP 只放行本插件脚本样式；
- 使用 `MarkdownUpdateHandler.Debounced` 和 Incremental DOM 更新官方生成 HTML；
- 每次 `setHtml` 完成 patch 后 `generation += 1` 并调用 JS `initialize(previewId,generation)`；
- 使用绑定当前 browser 的 `JBCefJSQuery` 收 JS JSON；handler 先调用 Task 12 严格解析；
- Kotlin→JS 使用 JSON 参数调用一个固定全局入口，禁止拼接模型文本进可执行 JS；
- 保留 Markdown scroll listener、`scrollToMarkdownSrcOffset` 和 `reloadWithOffset`；
- 外部链接按官方策略交给 IDE/浏览器，不允许导航替换预览页；
- `dispose` 取消 scope、移除 handler、dispose query/browser/static provider。

不得继承或反射访问官方 `MarkdownJCEFHtmlPanel` 私有字段；适配代码集中在本文件。

- [ ] **Step 5: 验证 Plugin API**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*EnglishSyntaxPreviewProviderTest'
./gradlew :intellij-plugin:verifyPluginProjectConfiguration
./gradlew :intellij-plugin:buildPlugin
```

Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/markdown intellij-plugin/src/main/resources/META-INF/plugin.xml
git commit -m "$(cat <<'EOF'
feat: 接管 IDEA Markdown JCEF 预览

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 15: 实现预览会话状态机和端到端接线

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSessionManager.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session/PreviewSession.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session/PreviewSessionTest.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanel.kt`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml`

**Interfaces:**
- Produces: `SessionState STOPPED/RUNNING/PAUSED`, `SentencePhase DISCOVERED/CACHE_CHECK/QUEUED/REQUESTING/VALIDATING/READY/FAILED/STALE`。
- Produces: `start(previewId)`, `pause`, `resume`, `stop`, `onBridgeMessage`, `onGenerationChanged`, `disposePreview`。
- Consumes: ProfileRepository, AnalysisService, Panel send callback。

- [ ] **Step 1: 写会话失败测试**

测试使用 FakePanel/FakeAnalysisService，覆盖：

- start 后请求 JS 扫描；
- visible blocks 分句、分词并最多 6 句/120ms 合批；
- 活动 preview 使用 `ACTIVE_VISIBLE_CORE`，非活动 preview 用 `OTHER_VISIBLE_CORE`；
- 屏外附近预取用 `ACTIVE_PREFETCH_CORE`；
- pause 不派发新请求，resume 重放；
- stop 取消 document 并发送 RESTORE_ALL；
- generation 变化取消旧请求、200ms 防抖后重扫；
- 旧 generation core/detail 回调被拒绝；
- 相同文本新 generation 从缓存恢复；
- 关闭 preview 释放会话；
- 无 Profile 时只查缓存，未命中保持原文并发送 NO_CACHE 状态；
- AUTH_FAILED 暂停 Profile 新请求但缓存仍返回。

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*PreviewSessionTest'`

Expected: FAIL。

- [ ] **Step 3: 实现项目级 SessionManager**

注册为 project service，构造器 `PreviewSessionManager(project: Project, scope: CoroutineScope)`。每个 preview 有 child Job；关闭项目自动取消。

`PreviewSession` 保存 block/句记录、generation、pending batch、状态计数和当前打开 detail。所有分析结果回调先比较 previewId/generation/operationVersion。

- [ ] **Step 4: 接线桥接和流式结果**

`VISIBLE_BLOCKS` → 分句分词 → 缓存/模型；流式 sink → `CORE_STREAM`；最终 → `CORE_RESULT`；错误 → `CORE_ERROR`；点击 → detail；停止 → `RESTORE_ALL`。任何消息都不含 Profile 或凭据。

- [ ] **Step 5: 验证并提交**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*PreviewSessionTest'
./gradlew :intellij-plugin:test
npm run test:idea-web
```

Expected: PASS。

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/session intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/session intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/markdown/EnglishSyntaxPreviewPanel.kt intellij-plugin/src/main/resources/META-INF/plugin.xml
git commit -m "$(cat <<'EOF'
feat: 接通 IDEA Markdown 句法会话

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 16: 实现开始、暂停、继续、停止 Action 和状态 UI

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/StartSyntaxLearningAction.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/TogglePauseSyntaxLearningAction.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/StopSyntaxLearningAction.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions/PreviewActionSupport.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/actions/ActionStateTest.kt`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml`
- Modify: `intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties`

**Interfaces:**
- Consumes: PreviewSessionManager Task 15。
- Produces: 三个 Action，准确启用条件和状态文案。

- [ ] **Step 1: 写 Action 状态失败测试**

测试：非 Markdown/无预览/JCEF 不支持时 Start disabled；stopped 时 Start enabled；running 时 Pause/Stop enabled；paused 时 Toggle 文案“继续”；无 Profile 时 Start 仍可用但提示纯缓存；当前 panel 不是本 Provider 时给出切换 Preview Provider 提示。

- [ ] **Step 2: 跑测试确认失败**

运行：`./gradlew :intellij-plugin:test --tests '*ActionStateTest'`

Expected: FAIL。

- [ ] **Step 3: 实现 Action**

Action 只能通过当前 `FileEditorManager` 定位 `EnglishSyntaxPreviewPanel`，不得全局扫描 Swing 组件。JCEF 不支持时 notification 包含切换 JetBrains Runtime 的操作说明。

在 `plugin.xml` 注册 action group，并加入 Markdown Preview Toolbar；若 2025.1 没有稳定公开的预览工具栏 group，先注册 Tools 菜单和 Search Everywhere Action，面板内部再提供自己的 `ActionToolbar`。禁止依赖硬编码 Swing child index。

- [ ] **Step 4: 实现进度状态**

Panel 顶部 ActionToolbar 显示 `句法学习：ready/discovered`；暂停显示“已暂停”；完成显示失败数和缓存命中数。状态更新由 Kotlin Session 推送，不从 DOM 反推。

- [ ] **Step 5: 验证并提交**

运行：

```bash
./gradlew :intellij-plugin:test --tests '*ActionStateTest'
./gradlew :intellij-plugin:buildPlugin
```

Expected: PASS。

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/actions intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/actions intellij-plugin/src/main/resources/META-INF/plugin.xml intellij-plugin/src/main/resources/messages/EnglishSyntaxBundle.properties
git commit -m "$(cat <<'EOF'
feat: 增加 IDEA 句法学习操作与状态栏

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 17: 增加 IDE 集成测试和假模型全链路

**Files:**
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/integration/MarkdownSyntaxIntegrationTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/integration/SecretIsolationTest.kt`
- Modify: `intellij-plugin/build.gradle.kts`

**Interfaces:**
- Consumes: 完整插件链路。
- Produces: `testIde` 集成任务和稳定探针。

- [ ] **Step 1: 写平台集成测试**

使用 `BasePlatformTestCase` 创建临时 `.md` 文件，选择本 Provider，验证 Provider 实例、setHtml/generation、Action 状态和 dispose。JCEF UI 本身在 headless 测试不可依赖像素，使用 Panel 注入的 test probe：接收发送消息记录、generation、disposed 标志。

- [ ] **Step 2: 写假模型链路测试**

连接 Task 8 `FakeOpenAiServer` 和真实 AnalysisService/Session：

- start + visible block 发 1 次 core 请求；
- cache hit 第二次 generation 不发请求；
- stream 分片先推 CORE_STREAM，最终推 CORE_RESULT；
- detail click 发 1 次 detail 请求；
- schema/reasoning/stream 降级请求数准确；
- Markdown generation 变化取消旧请求；
- stop 发 RESTORE_ALL 且取消在飞；
- 部分成功保留成功句。

- [ ] **Step 3: 写密钥隔离测试**

生成唯一 key `secret-integration-9f3d`，遍历：panel outbound messages、session logs capture、cache export、notifications、异常 message。断言均不包含 key；Fake server Authorization 可以包含，这是唯一允许位置。

- [ ] **Step 4: 配置和运行 testIde**

在 Gradle 注册 `intellijPlatformTesting.testIde { register("testIde2025_1") { type = IntelliJPlatformType.IntellijIdeaCommunity; version = "2025.1" } }`。运行：

```bash
./gradlew :intellij-plugin:test
./gradlew :intellij-plugin:testIde2025_1
```

Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/integration intellij-plugin/build.gradle.kts
git commit -m "$(cat <<'EOF'
test: 覆盖 IDEA Markdown 句法插件全链路

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 18: 同步架构文档、门禁和发布配置

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/architecture/README.md`
- Modify: `docs/architecture/modules.md`
- Modify: `docs/architecture/overview.md`
- Modify: `docs/architecture/model-pipeline.md`
- Modify: `docs/architecture/rendering.md`
- Modify: `docs/architecture/build-test-release.md`
- Modify: `docs/architecture/invariants.md`
- Modify: `src/shared/architecture-docs.test.ts`
- Modify: `scripts/check-docs-drift.mjs`
- Modify: `scripts/check-docs-drift.test.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `intellij-plugin/README.md` only if the user-facing installation instructions cannot fit clearly in root `README.md`; otherwise do not create it。

**Interfaces:**
- Produces: 根命令 `npm run test:contracts`, `npm run test:all`, Gradle `intellijCheck`。
- Produces: CI Chrome / IntelliJ / contracts 三 Job。

- [ ] **Step 1: 先扩展文档守护测试**

`architecture-docs.test.ts` 增加：所有 `intellij-plugin/src/main/kotlin/**/*.kt` 和 web 实现文件必须出现在 `modules.md`；contracts 的角色/错误/常量必须出现在架构文档；`modules.md` 允许测试文件省略但实现文件不允许。

`check-docs-drift.mjs` 映射：domain/bridge → protocol/overview；model/analysis/cache/scheduler → model-pipeline；markdown/session/web/actions → rendering/overview；Gradle/plugin.xml/test → build-test-release；新坑 → invariants。

- [ ] **Step 2: 跑测试确认失败**

运行：

```bash
npm test -- --run src/shared/architecture-docs.test.ts scripts/check-docs-drift.test.mjs
```

Expected: FAIL，文档未覆盖。

- [ ] **Step 3: 更新文档和 AGENTS**

必须写清：两运行时架构；Provider/JCEF 生命周期；Bridge 字段白名单；generation 双闸；PasswordSafe；SQLite 缓存；模型共同契约与 IDEA 优先级差异；门禁命令；Plugin Verifier；发布 ZIP；JCEF 不可用行为。

`AGENTS.md` 增加 IntelliJ 门禁：

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build \
  && npm run test:idea-web \
  && ./gradlew :intellij-plugin:test :intellij-plugin:buildPlugin :intellij-plugin:verifyPlugin
```

并记录三个硬不变量：密钥不进 JCEF；generation 在 Kotlin/JS 双端校验；Markdown 内部 API 只留在 `markdown/`。

- [ ] **Step 4: 增加聚合命令与 CI**

`package.json`：

```json
"test:contracts": "vitest run src/shared/cross-platform-contract.test.ts src/background/analysis-cache.test.ts src/options/cache-transfer.test.ts src/language/segmenter.test.ts",
"test:all": "npm test && npm run test:idea-web && ./gradlew intellijCheck"
```

CI 分三 Job：现有 Chrome；Gradle test/build/verify；跨端 fixtures。Gradle 使用 Java 21 和缓存，不上传 PasswordSafe/沙箱。

- [ ] **Step 5: 验证并提交**

运行：

```bash
npm test
npm run docs:drift
./gradlew :intellij-plugin:verifyPluginProjectConfiguration
```

Expected: PASS；docs drift 不报告本次 IntelliJ 代码缺文档。

```bash
git add AGENTS.md README.md docs/architecture src/shared/architecture-docs.test.ts scripts/check-docs-drift.mjs scripts/check-docs-drift.test.mjs package.json .github/workflows/ci.yml
git commit -m "$(cat <<'EOF'
docs: 纳入 IDEA 插件架构与门禁

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

---

### Task 19: 完整验证、真机验收和发布产物

**Files:**
- Modify only files required by failures found during verification。
- Do not commit `.superpowers/acceptance/`, sandbox, secrets, test reports or ZIP unless release policy explicitly requires it。

**Interfaces:**
- Produces: 可安装 IntelliJ 插件 ZIP 和完整验证证据。

- [ ] **Step 1: 跑 Chrome 门禁**

```bash
npm test && npx playwright test && npm run lint && npm run format:check && npm run build
```

Expected: 单测/E2E/build/format PASS；lint 恰好 1 个已知错误且 0 warning。

- [ ] **Step 2: 跑 IDEA 门禁**

```bash
npm run test:idea-web
./gradlew :intellij-plugin:test
./gradlew :intellij-plugin:buildPlugin
./gradlew :intellij-plugin:verifyPlugin
```

Expected: 全部 PASS；ZIP 在 `intellij-plugin/build/distributions/`；Verifier 对 IDEA 2025.1 无兼容错误。

- [ ] **Step 3: 跑跨端和文档门禁**

```bash
npm run test:contracts
npm run docs:drift
```

Expected: PASS/无遗漏。

- [ ] **Step 4: IDEA 真机验收**

运行 `./gradlew :intellij-plugin:runIde`，在沙箱 IDEA：

1. 配置本地假模型或环境变量提供的真实 OpenAI-compatible endpoint；日志只显示 `key <masked>`；
2. 打开包含标题、段落、列表、引用、代码块、表格和数学公式的 Markdown；
3. 选择 `English Syntax Chromium Preview`；
4. 点击开始，确认只解析可见及附近英文块；
5. 卡片就地替换，代码/表格/公式不变；
6. 点击成分显示详解；
7. 暂停后滚动不新增请求，继续后恢复；
8. 编辑 Markdown，确认会话继续、缓存句无需模型请求、旧响应不污染新 DOM；
9. 停止后完整恢复；
10. 修改 JetBrains Runtime 或用测试注入模拟 JCEF 不支持，确认不发请求并显示提示。

是否调用模型必须看 Fake server 请求记录，不用墙钟猜测。

- [ ] **Step 5: 检查密钥和产物**

搜索构建产物、日志、缓存导出、测试报告中用于验收的唯一假 key；除假服务器请求探针外不得出现。检查 `git status --short` 不包含 `.gradle`、build、sandbox、数据库和视觉伴侣文件。

- [ ] **Step 6: 修复验证发现的问题并重跑对应门禁**

任何失败都保持当前任务未完成；按根因修复，不放宽契约、校验或文档守护。全部命令重新通过后才能提交。

- [ ] **Step 7: 最终提交**

若验证产生代码/文档修复：

```bash
git add -u intellij-plugin src docs AGENTS.md README.md package.json .github
git commit -m "$(cat <<'EOF'
fix: 完成 IDEA 插件发布前验证

Co-Authored-By: CodeTui <noreply@codetui.dev>
EOF
)"
```

若工作区无改动，不创建空提交。

---

## 计划执行顺序与检查点

- Task 1–4：工程骨架和跨端领域基础。检查点：Kotlin 测试能独立运行，共享分词/键向量双端一致。
- Task 5–11：模型、校验、配置、调度和缓存。检查点：不接 JCEF 也能通过假服务器跑完整 core/detail 链路。
- Task 12–16：Bridge、DOM、Provider、会话和 Action。检查点：JCEF 只传领域输入/输出，密钥隔离，停止可逆恢复。
- Task 17–19：集成、文档、CI 和发布验证。检查点：Plugin Verifier、假模型探针和全仓门禁全绿。

## Self-Review 结果

- 规格中的首版功能均映射到任务：Provider/JCEF（14）、可见扫描/卡片/详解（13/15）、配置/PasswordSafe（6）、模型/流式/降级（7/8/11）、调度（9）、缓存互导（10）、Action/状态（16）、刷新/generation（15）、测试/发布（17–19）。
- 明确排除项未进入实现任务：源码 Inlay、自动启动、右键/选中、详解预载、纠错重分析、Swing 回退、其他 IDE 兼容承诺。
- 关键类型在首次生产任务中定义，后续接口命名保持一致。
- 计划无未决占位、空测试体、省略实现或未完成续写标记；Task 2 的缓存 digest 已写成实际值。

