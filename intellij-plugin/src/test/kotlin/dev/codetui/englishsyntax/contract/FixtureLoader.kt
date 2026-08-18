package dev.codetui.englishsyntax.contract

import java.nio.file.Files
import java.nio.file.Path

object FixtureLoader {
  private val repositoryRoot: Path = locateRepositoryRoot()

  fun text(name: String): String = Files.readString(repositoryRoot.resolve("shared-fixtures").resolve(name))

  private fun locateRepositoryRoot(): Path {
    val start = Path.of(System.getProperty("user.dir")).toAbsolutePath().normalize()
    return generateSequence(start) { it.parent }
      .firstOrNull { Files.isRegularFile(it.resolve("shared-fixtures/contracts.json")) }
      ?: error("Could not locate repository root from $start")
  }
}
