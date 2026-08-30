plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
  id("org.jetbrains.intellij.platform")
  id("java-test-fixtures")
}

group = "dev.codetui"
version = "1.3.1"

kotlin { jvmToolchain(21) }

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
  testImplementation(kotlin("test"))
  testImplementation("junit:junit:4.13.2")
}

intellijPlatform {
  pluginConfiguration {
    ideaVersion {
      sinceBuild = "251"
    }
  }
  pluginVerification {
    ides {
      select {
        types = setOf(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity)
        sinceBuild = "251"
      }
    }
  }
  // 独立 IDE 实例集成测试（假 JCEF 探针用例已覆盖主链路，这里跑完整 IDE 环境）。
  intellijPlatformTesting {
    runIde.register("runIde2025_1") {
      type = org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.IntellijIdeaCommunity
      version = "2025.1"
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
  // 聚合门禁：测试 + 构建 + 插件校验（供 npm run test:all 与 CI 调用）。
  register("intellijCheck") {
    group = "verification"
    description = "Runs tests, builds the plugin, and verifies plugin configuration."
    dependsOn("test", "buildPlugin", "verifyPluginProjectConfiguration")
  }
}
