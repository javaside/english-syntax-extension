plugins {
  base
  alias(libs.plugins.intellij.platform) apply false
  alias(libs.plugins.kotlin.jvm) apply false
  alias(libs.plugins.kotlin.serialization) apply false
}

tasks.register("intellijCheck") {
  dependsOn(":intellij-plugin:test", ":intellij-plugin:buildPlugin", ":intellij-plugin:verifyPlugin")
}
