plugins {
  alias(libs.plugins.kotlin.jvm)
  alias(libs.plugins.kotlin.serialization)
  id("org.jetbrains.intellij.platform")
  id("java-test-fixtures")
}

group = "dev.codetui"
version = "0.1.0-SNAPSHOT"

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
}

tasks {
  withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile>().configureEach {
    compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
  }
  test {
    useJUnitPlatform()
  }
}
