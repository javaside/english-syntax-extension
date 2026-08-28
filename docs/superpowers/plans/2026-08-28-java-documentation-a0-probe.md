# Java Documentation A0 Platform Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decide with reproducible evidence whether IntelliJ IDEA 2025.1 supported APIs can wrap the actual native Java Documentation target/result, preserve its behavior, and append a fixed Chinese update in hover, Quick Documentation, and the Documentation Tool Window.

**Architecture:** A0 is a fail-fast feasibility gate, not a partial feature implementation. It first proves that a third-party provider can obtain and delegate the actual native target and transform native synchronous, asynchronous, and updating results without internal APIs; only a GO result permits a disabled fixed-Chinese wrapper skeleton. Any core failure jumps immediately to the STOP closeout and removes probe registration from releasable code.

**Tech Stack:** Kotlin 2.1.20, Java 21, IntelliJ Platform Gradle Plugin 2.18.1, IntelliJ IDEA Community/Ultimate 2025.1, Java bundled plugin, Documentation Target API, Kotlin Coroutines Flow, IntelliJ Platform Java test fixtures, Plugin Verifier.

**Spec:** `docs/superpowers/specs/2026-08-28-java-documentation-translation-design.md`

## Global Constraints

- A0 must not add model calls, text extraction, prompts, profiles, credentials, SQLite, scheduler changes, translation cache, or user settings.
- Target IntelliJ IDEA Community and Ultimate 2025.1+, Java 21, plugin ID `dev.codetui.english-syntax-idea`.
- Forbidden in production: reflection; `com.intellij.*.ide.impl.*`; `com.intellij.lang.documentation.psi.*`; `PsiElementDocumentationTarget`; internal EP fields; `QuickDocUtil.updateQuickDoc*`; Swing/JCEF component traversal or injection.
- Calling the public-but-obsolete legacy Java `DocumentationProvider` is allowed only as a characterization branch inside `NativeJavaDocumentationAdapter.kt`; it cannot substitute for proving that the actual native target/result can be delegated and transformed.
- An opaque platform `DocumentationResult` that cannot be mapped with supported API is a core STOP. Creating a plugin-owned async result does not prove that native async results are wrappable.
- Reconstructing presentation/navigation/hint from PSI does not count as delegating the native target. If the actual target cannot be obtained through supported API, mark STOP.
- Use channels, deferred probes, event IDs, and logs for async assertions; no fixed sleeps.
- Core failure jumps to Task 3 (STOP closeout). Tasks 4–8 are GO-only and must not run after STOP.
- A source-specific external Javadoc failure may be `GO WITH SOURCE DEGRADATION` only after native target delegation, three UI entries, metadata fidelity, and cancellation all pass.
- The fixed probe is disabled unless `ENGLISH_SYNTAX_A0_JAVA_DOC=true`; ordinary installs must retain native Java Documentation.
- Commit subjects use Chinese.

## Branching Control Flow

```text
Task 1: establish dependencies and API guards
  → Task 2: core decorator feasibility gate
      ├─ core gate fails → Task 3 STOP closeout → END
      └─ core gate passes → Tasks 4–8 GO path
```

A failure record never needs unobserved values. Any matrix item not run after a gate failure is written as `NOT RUN — stopped at core gate <number>`.

## Planned File Structure

### Always created during A0

- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaDocumentationPluginConfigurationTest.kt` — Java dependency and EP contract.
- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaDocumentationInternalApiGuardTest.kt` — forbidden API source guard.
- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/DocumentationApiFeasibilityTest.kt` — supported API characterization.
- `docs/superpowers/specs/2026-08-28-java-documentation-a0-decision.md` — evidence and verdict; created only with observed values.

### Created only after the core gate passes

- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/A0ProbeGate.kt` — environment gate and event logger.
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/NativeJavaDocumentationAdapter.kt` — supported native target/result adapter; only file allowed to mention obsolete provider APIs.
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetProvider.kt` — Java-only provider.
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTarget.kt` — wrapper target that delegates the actual native target.
- `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/A0DocumentationComposer.kt` — supported result transformation and fixed update.
- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaDocumentationPlatformTestCase.kt` — shared Java fixture.
- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/NativeJavaDocumentationAdapterTest.kt` — native target/result tests.
- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetProviderTest.kt` — provider routing tests.
- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetTest.kt` — delegation/pointer tests.
- `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/A0DocumentationComposerTest.kt` — pure composition tests.
- `intellij-plugin/src/test/testData/javaDocumentationProbe/ProbeSubject.java` — documented/undocumented and overload fixture.

---

### Task 1: Establish Java dependencies, test fixtures, and forbidden-API guards

**Files:**
- Modify: `intellij-plugin/build.gradle.kts`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaDocumentationPluginConfigurationTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaDocumentationInternalApiGuardTest.kt`

**Interfaces:**
- Produces: Java plugin compile/test classpath.
- Produces: XML registration candidate `com.intellij.platform.backend.documentation.psiTargetProvider`.
- Produces: source guard `assertJavaDocumentationApiBoundary()` used after every GO-path task.

- [ ] **Step 1: Write the configuration test before modifying Gradle/XML**

```kotlin
class JavaDocumentationPluginConfigurationTest {
  @Test
  fun `Java dependency and provider registration stay synchronized`() {
    val build = Path("build.gradle.kts").readText()
    val xml = Path("src/main/resources/META-INF/plugin.xml").readText()

    assertTrue(build.contains("bundledPlugin(\"com.intellij.java\")"))
    assertTrue(xml.contains("<depends>com.intellij.java</depends>"))
    assertEquals(1, Regex("platform\\.backend\\.documentation\\.psiTargetProvider")
      .findAll(xml).count())
  }
}
```

- [ ] **Step 2: Run the test and verify RED**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaDocumentationPluginConfigurationTest'
```

Expected: FAIL because Java dependency and provider registration are absent.

- [ ] **Step 3: Add the exact primary dependency candidate**

Add to `dependencies { intellijPlatform { ... } }`:

```kotlin
bundledPlugin("com.intellij.java")
testFramework(org.jetbrains.intellij.platform.gradle.TestFrameworkType.Plugin.Java)
```

Add to `plugin.xml` after Markdown:

```xml
<depends>com.intellij.java</depends>
```

Register a temporary feasibility provider class only after Task 2 supplies it. During Task 1, make the configuration test expect a marker XML comment instead of a nonexistent class:

```xml
<!-- A0_JAVA_DOCUMENTATION_PROVIDER_GATE -->
```

The test counts the marker in Task 1; Task 4 replaces it with the real EP and updates the assertion. This keeps Task 1 compilable.

- [ ] **Step 4: Verify the dependency candidate compiles**

```bash
./gradlew :intellij-plugin:compileKotlin \
  :intellij-plugin:compileTestKotlin \
  :intellij-plugin:verifyPluginProjectConfiguration
```

Expected: PASS. If `com.intellij.java` is rejected, save the complete output, change only `plugin.xml` to the documented module alias `com.intellij.modules.java`, update the test expectation, and rerun once. Gradle remains `bundledPlugin("com.intellij.java")`. Record the proven XML ID; do not try further IDs.

If the single alias retry also fails, the A0 dependency foundation is unprovable: save both complete outputs, leave `build.gradle.kts` and `plugin.xml` in their pre-A0 state, delete `JavaDocumentationPluginConfigurationTest.kt`, and jump to Task 3. In the STOP decision write `Stopped at: dependency establishment failure (classification: N/A — no supported Java dependency declaration)`, and include both saved outputs plus the exact Gradle/IDE builds as evidence. Do not attempt any further dependency IDs or proceed to Task 2.

- [ ] **Step 5: Write the forbidden API guard**

```kotlin
private val forbidden = listOf(
  ".ide.impl.",
  "com.intellij.lang.documentation.psi.",
  "PsiElementDocumentationTarget",
  "QuickDocUtil.updateQuickDoc",
  "getActiveDocComponent",
  "java.lang.reflect",
  "kotlin.reflect",
  "Class.forName",
  "getDeclaredField",
  "getDeclaredMethod",
  "setAccessible",
  "trySetAccessible",
  "JBCef",
  "javax.swing",
)
```

Scan only production files in `.../java/documentation`. Assert every token is absent. Also assert `DocumentationProvider` and `com.intellij.codeInsight.documentation.DocumentationManager` occur in at most one production file named `NativeJavaDocumentationAdapter.kt`.

- [ ] **Step 6: Run the two tests**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaDocumentationPluginConfigurationTest' \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaDocumentationInternalApiGuardTest'
```

Expected: PASS.

- [ ] **Step 7: Commit the dependency baseline**

```bash
git add intellij-plugin/build.gradle.kts \
  intellij-plugin/src/main/resources/META-INF/plugin.xml \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation
git commit -m "test: 建立 Java 文档平台探针基线"
```

---

### Task 2: Execute the core native-target and native-result feasibility gate

**Files:**
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/DocumentationApiFeasibilityTest.kt`
- Create locally: `.superpowers/acceptance/java-documentation-api-signatures.txt` (ignored, never commit)
- Create on failure or completion: `docs/superpowers/specs/2026-08-28-java-documentation-a0-decision.md`

**Interfaces:**
- Produces one observed classification:
  - `SUPPORTED_NATIVE_DECORATION`
  - `UNSUPPORTED_NO_NATIVE_TARGET_ACCESS`
  - `UNSUPPORTED_OPAQUE_NATIVE_RESULT`
  - `UNSUPPORTED_METADATA_LOSS`
- GO requires only `SUPPORTED_NATIVE_DECORATION`.

- [ ] **Step 1: Write compile-time assertions for allowed SPI surfaces**

The test references only these public/OverrideOnly APIs:

```kotlin
private fun publicSpiSurface(
  provider: PsiDocumentationTargetProvider,
  target: DocumentationTarget,
  result: DocumentationResult,
  content: DocumentationContent,
): List<Any> = listOf(provider, target, result, content)
```

Add assertions, using Java reflection only in test code, that public methods available to a provider include no parameter or callback representing “next provider”, “existing target”, or “native result”, and that `DocumentationResult` exposes no public `map`, `flatMap`, `fold`, content getter, or visitor.

Test-only reflection is allowed because it characterizes API; the production guard scans only `src/main`.

- [ ] **Step 2: Run the API surface test**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.DocumentationApiFeasibilityTest'
```

Expected characterization on 251: test passes while recording the exact public method lists. Passing does not mean GO; it proves the absence/presence facts used in Step 4.

- [ ] **Step 3: Record exact 251 signatures from the resolved IDE**

Use `javap` against Gradle's resolved IDEA 2025.1 installation, recording these classes to the ignored evidence file:

```text
com.intellij.platform.backend.documentation.DocumentationTargetProvider
com.intellij.platform.backend.documentation.PsiDocumentationTargetProvider
com.intellij.platform.backend.documentation.DocumentationTarget
com.intellij.platform.backend.documentation.DocumentationResult
com.intellij.platform.backend.documentation.DocumentationResult$Documentation
com.intellij.platform.backend.documentation.DocumentationContent
```

Record class-level `ApiStatus`, method signatures, and sealed permitted subclasses. Also record that `com.intellij.lang.documentation.psi` is Internal and `PsiElementDocumentationTarget` is VisibleForTesting. Do not add an internal import to prove this.

- [ ] **Step 4: Apply the core gate algorithm**

Answer all four questions from observed signatures and a minimal registered test provider:

1. Does the supported provider callback receive the actual native Java target or a `next` callback?  
2. Is there a supported factory/service that returns the actual native Java target, not an internal/default reconstruction?  
3. Can a third party inspect/map an arbitrary native synchronous or `asyncDocumentation` result without casting to sealed internal implementations?  
4. Can presentation, navigation, hint, anchor, images, external URL, definition details, and native updates be forwarded from that actual target/result?

Classification rules are mechanical:

- Question 1 and 2 both NO → `UNSUPPORTED_NO_NATIVE_TARGET_ACCESS` → STOP.
- Question 3 NO → `UNSUPPORTED_OPAQUE_NATIVE_RESULT` → STOP.
- Question 4 NO for required behavior → `UNSUPPORTED_METADATA_LOSS` → STOP.
- Only all required answers YES → `SUPPORTED_NATIVE_DECORATION` → continue to Task 4.

Calling legacy `generateDoc()` and constructing a new plugin-owned target does not change a NO answer: it reconstructs HTML rather than wraps the actual native target/result.

- [ ] **Step 5: Run Plugin Verifier against the minimal dependency state**

```bash
./gradlew :intellij-plugin:buildPlugin :intellij-plugin:verifyPlugin
```

Record the report path and exit code. A verifier incompatibility is core gate 9 and therefore STOP.

- [ ] **Step 6: Branch immediately**

- If classification is not `SUPPORTED_NATIVE_DECORATION`, execute Task 3 and then end this plan.
- If supported, write the observed public native-target acquisition and result-mapping signatures into the decision evidence, then execute Task 4.

Do not create provider/composer production files before this branch.

---

### Task 3: STOP closeout path

**Files:**
- Create: `docs/superpowers/specs/2026-08-28-java-documentation-a0-decision.md`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml` to remove the A0 marker/registration.
- Modify: `intellij-plugin/build.gradle.kts` only if Java dependencies are unnecessary after STOP.
- Retain: characterization tests that compile without provider registration.

**Interfaces:**
- Consumes: failed classification, exact command output, signature evidence, verifier report.
- Produces: verdict `STOP` and a clean, buildable repository with no active fixed-Chinese provider.

- [ ] **Step 1: Write the STOP decision using observed values only**

Required fields:

```markdown
# Java Documentation A0 Probe Decision

**Date:** 2026-08-28
**Tested platform:** IntelliJ IDEA 2025.1 / build observed in resolved product
**Verdict:** STOP
**Stopped at:** core gate number and classification, or "dependency establishment failure (classification: N/A)"
```

For unrun matrices write `NOT RUN — stopped at core gate N`. Include command, exit code, report/evidence path, exact missing API capability, and why legacy synchronous HTML reconstruction does not satisfy the approved spec.

- [ ] **Step 2: Remove releasable probe activation and synchronize the configuration test**

Remove the XML marker or provider registration. Delete any GO-only production files if they were accidentally created. Keep Java dependencies only if characterization tests require them; otherwise revert them too.

In the same step, update `JavaDocumentationPluginConfigurationTest.kt` to assert the STOP end state so the verification set can pass:

```kotlin
@Test
fun `Java dependency and provider registration stay synchronized`() {
  val build = Path("build.gradle.kts").readText()
  val xml = Path("src/main/resources/META-INF/plugin.xml").readText()

  val javaDependencyKept = build.contains("bundledPlugin(\"com.intellij.java\")")
  val xmlDependencyKept = xml.contains("<depends>com.intellij.java</depends>") ||
    xml.contains("<depends>com.intellij.modules.java</depends>")
  assertEquals(javaDependencyKept, xmlDependencyKept)
  assertEquals(0, Regex("platform\\.backend\\.documentation\\.psiTargetProvider").findAll(xml).count())
  assertFalse(xml.contains("A0_JAVA_DOCUMENTATION_PROVIDER_GATE"))
}
```

If the dependency establishment failed before Task 1 Step 4 succeeded, this test file was already deleted in Task 1; skip this edit.

- [ ] **Step 3: Run the STOP-safe verification set**

```bash
./gradlew :intellij-plugin:test \
  :intellij-plugin:buildPlugin \
  :intellij-plugin:verifyPluginProjectConfiguration
(cd chrome-plugin && npm test && npm run docs:drift)
git diff --check
```

Expected: all commands pass after cleanup. The earlier failing/negative verifier or capability observation remains evidence; it is not rerun as a required-success command.

- [ ] **Step 4: Commit the STOP decision and characterization evidence**

```bash
git add docs/superpowers/specs/2026-08-28-java-documentation-a0-decision.md \
  intellij-plugin/build.gradle.kts \
  intellij-plugin/src/main/resources/META-INF/plugin.xml \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation
git commit -m "docs: 记录 Java 文档探针不可行结论"
```

Stage only paths that actually changed. After this commit, stop. Return to brainstorming for方案 B; do not execute Tasks 4–8 or write A1.

---

### Task 4: Build the disabled wrapper skeleton only after a GO core result

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/A0ProbeGate.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/NativeJavaDocumentationAdapter.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetProvider.kt`
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTarget.kt`
- Modify: `intellij-plugin/src/main/resources/META-INF/plugin.xml`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaDocumentationPlatformTestCase.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/NativeJavaDocumentationAdapterTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetProviderTest.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetTest.kt`
- Create: `intellij-plugin/src/test/testData/javaDocumentationProbe/ProbeSubject.java`

**Interfaces:**
- Consumes: the exact supported native-target acquisition and arbitrary-result mapping API proven by Task 2; copy those observed signatures verbatim into these interfaces before coding.
- Produces: `fun interface ProbeEnabled { fun get(): Boolean }`.
- Produces: `fun interface FixedTranslationProbe { fun updates(targetId: String): Flow<String> }`.
- Produces: `NativeDocumentationDelegate(target: DocumentationTarget)` where `target` is the actual native target.
- Produces: provider constructors:

```kotlin
constructor() : this(
  ProbeEnabled { A0ProbeGate.enabled },
  NativeJavaDocumentationAdapter(),
  FixedTranslationProbe { targetId -> A0ProbeEvents.fixedUpdate(targetId) },
)

internal constructor(
  enabled: ProbeEnabled,
  adapter: NativeJavaDocumentationAdapter,
  fixedProbe: FixedTranslationProbe,
)
```

- Produces target factory:

```kotlin
JavaTranslationDocumentationTarget.create(
  nativeDelegate: NativeDocumentationDelegate,
  ownerPointer: SmartPsiElementPointer<PsiDocCommentOwner>,
  originalPointer: SmartPsiElementPointer<PsiElement>?,
  stableOwnerId: String,
  fixedProbe: FixedTranslationProbe,
): JavaTranslationDocumentationTarget
```

- [ ] **Step 1: Add a complete Java fixture**

Include documented class/method/field, two overloads, and an explicitly undocumented method:

```java
package probe;

/** Native class docs with {@link java.util.List}. */
public class ProbeSubject {
  /** Native field docs. */ public String value;
  /** @param fallback fallback text @return current value */
  public String value(String fallback) { return value; }
  /** Overload docs. */ public String value(int fallback) { return value; }
  public void undocumented() {}
}
```

- [ ] **Step 2: Write provider tests before implementation**

Exact cases:

```text
disabled gate → null
non-Java PSI → null
documented class/method/field → wrapper around actual native delegate
undocumented method → preserve native provider behavior; do not synthesize docs
competing test provider → native/other target remains represented according to Task 2 proven API
```

- [ ] **Step 3: Run provider tests and verify RED**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaTranslationDocumentationTargetProviderTest'
```

Expected: FAIL because GO-only classes do not exist.

- [ ] **Step 4: Implement the gate and event probe**

`A0ProbeGate.enabled` reads only `ENGLISH_SYNTAX_A0_JAVA_DOC == "true"`. `A0ProbeEvents` emits sanitized records:

```text
target-created targetId=<uuid>
collector-started targetId=<uuid>
emit targetId=<uuid> phase=native|fixed
collector-cancelled targetId=<uuid>
```

No PSI text, paths, credentials, or document HTML enter logs.

- [ ] **Step 5: Implement the provider/adapter using only Task 2 proven signatures**

The provider returns no wrapper when disabled. When enabled, it obtains the actual native delegate through the supported API proven in Task 2 and passes that delegate unchanged to the wrapper. Do not substitute legacy `generateDoc()` if the proven interface expected a native `DocumentationTarget`/`DocumentationResult`.

- [ ] **Step 6: Write and implement exact delegation tests**

For the actual native delegate, assert wrapper results equal delegate results for:

```text
computePresentation()
navigatable
computeDocumentationHint()
createPointer() reconstruction identity
anchor/images/externalUrl/definitionDetails/native updates through the proven result mapper
```

If any field cannot be delegated with the Task 2 API, reclassify as STOP and jump to Task 3; do not reconstruct from PSI.

- [ ] **Step 7: Implement smart-pointer reconstruction**

The pointer stores only the delegate's supported pointer, smart PSI pointers, stable owner ID, and fixed probe. Dereference restores all, verifies the owner ID, obtains the dereferenced actual native delegate, and creates a fresh wrapper. Deletion or signature mismatch returns `null`.

- [ ] **Step 8: Replace the XML marker with the real EP and update its test**

```xml
<platform.backend.documentation.psiTargetProvider
    implementation="dev.codetui.englishsyntax.java.documentation.JavaTranslationDocumentationTargetProvider"/>
```

Update `JavaDocumentationPluginConfigurationTest` to assert exactly one real EP and no marker.

- [ ] **Step 9: Run focused tests and guard**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.NativeJavaDocumentationAdapterTest' \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaTranslationDocumentationTargetProviderTest' \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaTranslationDocumentationTargetTest' \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaDocumentationInternalApiGuardTest'
```

Expected: PASS.

- [ ] **Step 10: Commit the GO skeleton**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation \
  intellij-plugin/src/test/testData/javaDocumentationProbe/ProbeSubject.java \
  intellij-plugin/src/main/resources/META-INF/plugin.xml
git commit -m "feat: 建立 Java 原生文档包装探针"
```

---

### Task 5: Transform native results and verify deterministic cancellation

**Files:**
- Create: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/A0DocumentationComposer.kt`
- Modify: `intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTarget.kt`
- Create: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/A0DocumentationComposerTest.kt`
- Modify: `intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetTest.kt`

**Interfaces:**
- Consumes: the exact arbitrary-native-result mapper proven in Task 2.
- Produces: `A0DocumentationComposer.compose(nativeResult, targetId, fixedProbe): DocumentationResult`.
- Produces pure helper `appendProbeSection(nativeHtml, escapedText): String`.

- [ ] **Step 1: Write the pure HTML composition tests**

Assert byte-for-byte native HTML inclusion, exactly one namespaced probe section, escaping of `& < > " '`, and replacement rather than duplicate append.

- [ ] **Step 2: Write a channel-handshaked Flow harness**

Use:

```kotlin
data class FlowProbe(
  val collectorStarted: CompletableDeferred<Unit>,
  val collectorCancelled: CompletableDeferred<Unit>,
  val updates: Channel<String>,
)
```

The Flow completes `collectorStarted` on collection, receives from `updates`, and completes `collectorCancelled` in `finally`. Tests await these deferred values before sending/cancelling. Do not use `MutableSharedFlow.tryEmit` or sleeps.

- [ ] **Step 3: Verify RED**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.A0DocumentationComposerTest'
```

Expected: FAIL because composer does not exist.

- [ ] **Step 4: Implement mapping for all native result forms proven by Task 2**

Required tests use actual mapped forms:

```text
native synchronous documentation
native asyncDocumentation result
native documentation with updates Flow
native async result whose final documentation has updates
```

Each update emits the latest complete native content plus current fixed section while retaining all public metadata. Do not cast sealed implementations. If Task 2's supported mapper cannot execute one form in code, jump to STOP Task 3.

- [ ] **Step 5: Test cancellation and stale target IDs**

Test sequence:

1. await old collector start;
2. cancel old collector;
3. await old collector cancelled;
4. start new target collector and await start;
5. send an old update tagged with old target ID;
6. assert new collector records no old emission;
7. send new target update and assert exactly one emission.

- [ ] **Step 6: Run composer, target, and source guard tests**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.A0DocumentationComposerTest' \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaTranslationDocumentationTargetTest' \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaDocumentationInternalApiGuardTest'
```

Expected: PASS.

- [ ] **Step 7: Commit result transformation behavior**

```bash
git add intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/A0DocumentationComposer.kt \
  intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTarget.kt \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/A0DocumentationComposerTest.kt \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation/JavaTranslationDocumentationTargetTest.kt
git commit -m "feat: 验证 Java 文档结果组合与取消"
```

---

### Task 6: Configure exact IC/IU runs and execute the three-entry acceptance matrix

**Files:**
- Modify: `intellij-plugin/build.gradle.kts`
- Create locally: `.superpowers/acceptance/java-documentation-a0-probe.md` (ignored, never commit)
- Create locally: `.superpowers/acceptance/java-documentation-a0-events.log` (ignored, never commit)

**Interfaces:**
- Produces Gradle tasks `runIde2025_1` and `runIdeUltimate2025_1`.
- Consumes sanitized `A0ProbeEvents` target/collector/emission IDs.

- [ ] **Step 1: Add exact IU run and verifier configuration**

```kotlin
pluginVerification {
  ides {
    select {
      types = setOf(
        org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity,
        org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaUltimate,
      )
      sinceBuild = "251"
    }
  }
}

intellijPlatformTesting {
  runIde.register("runIde2025_1") {
    type = org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity
    version = "2025.1"
  }
  runIde.register("runIdeUltimate2025_1") {
    type = org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaUltimate
    version = "2025.1"
  }
}
```

Run `./gradlew :intellij-plugin:tasks --all` and assert both run tasks exist before acceptance.

- [ ] **Step 2: Prepare the exact acceptance project**

Create an ignored sandbox project containing the same `ProbeSubject.java` fixture and one dependency with attached sources. Configure one external Javadoc URL through IDEA settings. Record project path and dependency coordinates in the local acceptance file.

- [ ] **Step 3: Run IC**

```bash
ENGLISH_SYNTAX_A0_JAVA_DOC=true ./gradlew :intellij-plugin:runIde2025_1
```

For class, method, field, JDK member, attached dependency, and external Javadoc:

1. hover until popup appears;
2. invoke Quick Documentation through the IDE action/keymap;
3. pin/open Documentation Tool Window;
4. verify native content appears before fixed probe;
5. verify native links/navigation/images/details still work;
6. move A→B rapidly and check event log target IDs;
7. close popup/tool window and verify matching `collector-cancelled`;
8. edit/delete target and confirm old ID never emits into new target;
9. inspect IDE log for plugin exceptions and UI freeze reports.

PASS requires matching create/start/native/fixed/cancel event IDs and no stale emission. Screenshot alone is insufficient.

- [ ] **Step 4: Run IU with the same operations**

```bash
ENGLISH_SYNTAX_A0_JAVA_DOC=true ./gradlew :intellij-plugin:runIdeUltimate2025_1
```

Use the same project and matrix. Record exact IC/IU builds from Help → About and artifact/log paths. For terminal reporting, name image paths and describe them; do not embed Markdown image syntax.

- [ ] **Step 5: Test restart, upgrade, disable, and unload behavior**

For both IDEs:

1. launch without env var and confirm no target-created events and native docs unchanged;
2. install previous 1.2.0 ZIP, then install A0 build and record whether restart is required;
3. disable/uninstall A0 build and confirm native docs return with no active collectors;
4. attempt dynamic unload and record platform result;
5. restart and confirm no stale target IDs.

- [ ] **Step 6: Classify sources and gates**

- Core target/result/entry/cancellation failure → jump to STOP Task 3.
- Only a named external source unavailable through supported API → record `GO WITH SOURCE DEGRADATION` and continue.
- All required rows pass → GO.

- [ ] **Step 7: Commit only Gradle configuration**

Never commit `.superpowers/acceptance/`.

```bash
git add intellij-plugin/build.gradle.kts
git commit -m "test: 增加 Java 文档双版本验收环境"
```

---

### Task 7: Run real Plugin Verifier and repository gates

**Files:**
- Modify only if evidence requires: `intellij-plugin/build.gradle.kts`
- Create on GO path: `docs/superpowers/specs/2026-08-28-java-documentation-a0-decision.md`

**Interfaces:**
- Produces: IC/IU verifier report paths and final pre-documentation verdict.

- [ ] **Step 1: Run real Plugin Verifier**

```bash
./gradlew :intellij-plugin:buildPlugin :intellij-plugin:verifyPlugin
```

GO requires no internal API, missing dependency, invalid descriptor, or compatibility errors. A prohibited obsolete bridge is STOP, not a suppression candidate.

- [ ] **Step 2: Run the IntelliJ gate**

```bash
(cd intellij-plugin && npm ci && npm test) \
  && ./gradlew :intellij-plugin:test \
    :intellij-plugin:buildPlugin \
    :intellij-plugin:verifyPluginProjectConfiguration
```

Expected: PASS.

- [ ] **Step 3: Run architecture guards**

```bash
cd chrome-plugin && npm test && npm run docs:drift
```

Expected: tests identify exactly which architecture docs require updates.

- [ ] **Step 4: Run final source guard**

```bash
./gradlew :intellij-plugin:test \
  --tests 'dev.codetui.englishsyntax.java.documentation.JavaDocumentationInternalApiGuardTest'
git diff --check
git status --short
```

Expected: guard PASS and only intentional paths modified.

- [ ] **Step 5: Branch on verifier result**

Verifier/core failure → Task 3 STOP closeout. Successful verifier → Task 8.

---

### Task 8: Finalize GO decision and synchronize only proven architecture

**Files:**
- Create: `docs/superpowers/specs/2026-08-28-java-documentation-a0-decision.md`
- Modify: `docs/architecture/modules.md`
- Modify: `docs/architecture/rendering.md`
- Modify: `docs/architecture/build-test-release.md`
- Modify: `docs/architecture/invariants.md`
- Modify: `docs/architecture/overview.md`
- Modify: `CHANGELOG.md` only if the disabled skeleton remains releasable.

**Interfaces:**
- Produces verdict `GO` or `GO WITH SOURCE DEGRADATION`.
- Consumes exact API signatures, automated tests, IC/IU events, verifier reports, and lifecycle evidence.

- [ ] **Step 1: Write the decision with no placeholders**

Include exact date, IC/IU build numbers, Gradle dependency, XML dependency, EP, verifier report paths, artifact/log paths, and one verdict. Map all nine spec §6.2 gates to `PASS` or `NOT TRIGGERED` with evidence. No unobserved field or template marker is allowed.

- [ ] **Step 2: Document actual native delegation/result mapping**

Record the exact supported APIs used to obtain the native target, delegate presentation/navigation/hint/pointer, map synchronous/async/updating results, preserve metadata, and receive UI cancellation. Explicitly list any source degradation.

- [ ] **Step 3: Synchronize proven architecture**

- `modules.md`: every retained source file and sole obsolete adapter boundary.
- `rendering.md`: full-content replacement and observed cancellation behavior.
- `build-test-release.md`: Java dependency, IC/IU matrix, verifier, restart/unload behavior.
- `invariants.md`: supported API boundary, native fidelity, target-ID cancellation isolation.
- `overview.md`: provider → native delegate → wrapper → updates path.
- `CHANGELOG.md`: only the disabled A0 skeleton/restart impact, never claim formal Java translation exists.

Do not document A1 models, prompts, cache, settings, or extraction as implemented.

- [ ] **Step 4: Run the full GO verification**

```bash
(cd intellij-plugin && npm ci && npm test) \
  && ./gradlew :intellij-plugin:test \
    :intellij-plugin:buildPlugin \
    :intellij-plugin:verifyPluginProjectConfiguration \
    :intellij-plugin:verifyPlugin \
  && (cd chrome-plugin && npm test && npm run docs:drift) \
  && git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Request code review**

Invoke `requesting-code-review`. Reviewer checks spec §§4, 6, 7, 12, 16, 17; confirms no internal API and no A1 implementation; verifies evidence supports the verdict.

- [ ] **Step 6: Commit exact retained files**

Stage only files shown by `git status --short` that belong to the A0 Files lists; never `git add intellij-plugin` wholesale.

```bash
git add docs/superpowers/specs/2026-08-28-java-documentation-a0-decision.md \
  docs/architecture/modules.md \
  docs/architecture/rendering.md \
  docs/architecture/build-test-release.md \
  docs/architecture/invariants.md \
  docs/architecture/overview.md
git add intellij-plugin/build.gradle.kts \
  intellij-plugin/src/main/resources/META-INF/plugin.xml \
  intellij-plugin/src/main/kotlin/dev/codetui/englishsyntax/java/documentation \
  intellij-plugin/src/test/kotlin/dev/codetui/englishsyntax/java/documentation \
  intellij-plugin/src/test/testData/javaDocumentationProbe/ProbeSubject.java
git commit -m "docs: 记录 Java 文档平台探针结论"
```

Add `CHANGELOG.md` only if changed.

- [ ] **Step 7: Enforce the A1 handoff**

Ask the user to review the decision. Only GO-class approval permits a new `writing-plans` invocation for A1. STOP returns to brainstorming for方案 B.
