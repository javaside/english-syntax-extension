package dev.codetui.englishsyntax.tts

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

private class FakeProcess : ManagedProcess {
  var destroyed = false
  override fun destroy() {
    destroyed = true
  }

  override fun await(): Int = 0
}

private class FakeExecutor(
  private val availableCommands: Set<String> = setOf("say", "spd-say"),
  private val voiceLines: List<String> = emptyList(),
) : CommandExecutor {
  val started = mutableListOf<Pair<String, List<String>>>()
  val processes = mutableListOf<FakeProcess>()

  override fun start(command: String, args: List<String>): ManagedProcess {
    started += command to args
    return FakeProcess().also { processes += it }
  }

  override fun available(command: String): Boolean = command in availableCommands

  override fun readLines(command: String, args: List<String>): List<String> = voiceLines
}

class SpeechSpeakerTest {
  @Test
  fun `second speak destroys the first process and starts with the new text`() {
    val executor = FakeExecutor(voiceLines = listOf("Samantha            en_US    # Hello"))
    val speaker = ProcessSpeechSpeaker(executor, osName = "Mac OS X")
    speaker.speak("first sentence")
    speaker.speak("second sentence")
    assertEquals(true, executor.processes[0].destroyed)
    assertEquals("say", executor.started[1].first)
    assertEquals(true, "second sentence" in executor.started[1].second)
  }

  @Test
  fun `stop and shutdown destroy the current process`() {
    val executor = FakeExecutor(voiceLines = listOf("Samantha            en_US"))
    val speaker = ProcessSpeechSpeaker(executor, osName = "Mac OS X")
    speaker.speak("hello")
    speaker.stop()
    assertEquals(true, executor.processes[0].destroyed)
    speaker.speak("again")
    speaker.shutdown()
    assertEquals(true, executor.processes[1].destroyed)
  }

  @Test
  fun `macos speak passes the picked voice`() {
    val executor = FakeExecutor(
      voiceLines = listOf(
        "Albert              en_US    # old",
        "Samantha            en_US    # default",
      ),
    )
    val speaker = ProcessSpeechSpeaker(executor, osName = "Mac OS X")
    speaker.speak("hi")
    assertEquals(listOf("-v", "Samantha", "--", "hi"), executor.started[0].second)
  }

  @Test
  fun `missing platform command throws speech unavailable`() {
    val executor = FakeExecutor(availableCommands = emptySet())
    val speaker = ProcessSpeechSpeaker(executor, osName = "Mac OS X")
    assertThrows(SpeechUnavailableException::class.java) { speaker.speak("hi") }
    val linux = ProcessSpeechSpeaker(executor, osName = "Linux")
    assertThrows(SpeechUnavailableException::class.java) { linux.speak("hi") }
  }

  @Test
  fun `windows speak escapes single quotes and calls powershell`() {
    val executor = FakeExecutor(availableCommands = setOf("powershell"))
    val speaker = ProcessSpeechSpeaker(executor, osName = "Windows 11")
    speaker.speak("it's fine")
    val (command, args) = executor.started[0]
    assertEquals("powershell", command)
    assertEquals(true, "-NoProfile" in args)
    val script = args.last()
    assertEquals(true, script.contains("it''s fine"))
    assertEquals(true, script.contains("System.Speech"))
  }

  @Test
  fun `linux falls back from spd-say to espeak`() {
    val executor = FakeExecutor(availableCommands = setOf("espeak"))
    val speaker = ProcessSpeechSpeaker(executor, osName = "Linux")
    speaker.speak("hello")
    assertEquals("espeak", executor.started[0].first)
    assertEquals(listOf("hello"), executor.started[0].second)
  }
}

class PickMacVoiceTest {
  @Test
  fun `prefers premium over novelty and unknown over novelty`() {
    val lines = listOf(
      "Bad News           en_US    # novelty",
      "Mystery Voice      en_US    # unknown",
      "Samantha           en_US    # default",
    )
    assertEquals("Samantha", pickMacVoice(lines))
    assertEquals("Mystery Voice", pickMacVoice(listOf(lines[1])))
    // 只剩 novelty 时才轮到它(垫底仍优于无声)。
    assertEquals("Bad News", pickMacVoice(listOf(lines[0])))
  }

  @Test
  fun `returns null for empty list or no en_us voices`() {
    assertEquals(null, pickMacVoice(emptyList()))
    assertEquals(null, pickMacVoice(listOf("Tingting           zh_CN    # Chinese")))
  }
}
