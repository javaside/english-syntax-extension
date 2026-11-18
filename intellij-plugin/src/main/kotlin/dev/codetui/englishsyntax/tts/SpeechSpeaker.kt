package dev.codetui.englishsyntax.tts

import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit

/**
 * 朗读进程的最小控制面（测试 seam：生产实现包 [Process]）。
 */
interface ManagedProcess {
  fun destroy()
  fun await(): Int
}

/**
 * 系统命令执行 seam：测试注入 fake,不真起进程。
 */
interface CommandExecutor {
  fun start(command: String, args: List<String>): ManagedProcess
  fun available(command: String): Boolean

  /** 读完命令的全部输出行（macOS `say -v ?` 的语音清单走这里,测试注入假列表）。 */
  fun readLines(command: String, args: List<String>): List<String>
}

/** 平台语音命令不存在/不可执行。message 面向用户（经 TTS_ERROR 显示）。 */
class SpeechUnavailableException(message: String) : RuntimeException(message)

/**
 * 进程式系统 TTS 执行器：macOS `say` / Windows `System.Speech` / Linux `spd-say`（回落 `espeak`）。
 * 参数数组直传 ProcessBuilder、不经 shell——文本无注入面。
 */
/** 朗读执行器 seam：会话与测试面向它,生产实现是 [ProcessSpeechSpeaker]。 */
interface SpeechSpeaker {
  fun speak(text: String)
  fun stop()
  fun shutdown()
}

class ProcessSpeechSpeaker(
  private val executor: CommandExecutor = ProcessCommandExecutor(),
  private val osName: String = System.getProperty("os.name"),
  private val voiceListReader: () -> List<String> = {
    executor.readLines("say", listOf("-v", "?"))
  },
) : SpeechSpeaker {
  private var current: ManagedProcess? = null
  private var macVoice: String? = null
  private var macVoiceResolved = false
  /** available 结果缓存:可用性在进程生命周期内基本不变,别让每次点击都 fork which。 */
  private val availableCache = mutableMapOf<String, Boolean>()

  /** 新朗读先销毁旧进程（会话内单声道、新朗读接管）。 */
  override fun speak(text: String) {
    synchronized(this) {
      val command = resolveCommand()
      val args = when {
        command == "say" -> listOf("-v", macVoice(), "--", text)
        command == "spd-say" -> listOf("--", text)
        command == "espeak" -> listOf(text)
        else -> listOf(
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak('${text.replace("'", "''")}')",
        )
      }
      current?.destroy()
      current = executor.start(command, args)
    }
  }

  override fun stop() {
    synchronized(this) {
      current?.destroy()
      current = null
    }
  }

  /** 全停（会话终止/换代）：与 [stop] 同义,语义上留给生命周期钩子。 */
  override fun shutdown() = stop()

  private fun resolveCommand(): String {
    val mac = osName.contains("Mac", ignoreCase = true)
    val windows = osName.contains("Windows", ignoreCase = true)
    return when {
      mac -> {
        checkAvailable("say", "macOS 的 say 命令不可用")
        "say"
      }
      windows -> {
        checkAvailable("powershell", "未找到 PowerShell（Windows 语音依赖 System.Speech）")
        "powershell"
      }
      else -> {
        if (isAvailable("spd-say")) "spd-say"
        else if (isAvailable("espeak")) "espeak"
        else throw SpeechUnavailableException("未安装系统语音命令：请安装 spd-say 或 espeak（如 sudo apt install speech-dispatcher espeak）")
      }
    }
  }

  private fun checkAvailable(command: String, message: String) {
    if (!isAvailable(command)) throw SpeechUnavailableException(message)
  }

  private fun isAvailable(command: String): Boolean =
    availableCache.getOrPut(command) { executor.available(command) }

  private fun macVoice(): String {
    if (!macVoiceResolved) {
      macVoice = runCatching { pickMacVoice(voiceListReader()) }.getOrNull()
      macVoiceResolved = true
    }
    return macVoice ?: ""
  }
}

/**
 * macOS `say -v ?` 清单挑选（Chrome 端 `chrome-plugin/src/content/speech.ts` 的同源名单,
 * 两端各自维护、注释互指）。行形如 `Samantha            en_US    # ...`：
 * 含独立的 `en_US` token 时,名字 = 其前所有 token 以单空格连接（覆盖 "Bad News" 这类
 * 带空格名）。档序：白名单现代语音 > 其他 en_US > novelty 黑名单垫底；无 en_US 返回
 * null（回落不指定 voice 的系统默认）。
 */
fun pickMacVoice(voiceLines: List<String>): String? {
  val premium = setOf(
    "samantha", "ava", "zoe", "serena", "allison", "susan", "daniel", "karen", "moira",
    "tessa", "fiona", "nicky", "deirdre", "eddy", "flo", "reed", "rocko", "sandy",
    "shelley", "grandma", "grandpa", "aria", "jenny", "guy", "michelle", "zira", "david",
  )
  val novelty = setOf(
    "albert", "fred", "junior", "kathy", "ralph", "princess", "zarvox", "trinoids",
    "whisper", "wobble", "bubbles", "bahh", "bells", "boing", "cellos", "organ", "jester",
    "superstar", "bad news", "good news", "hysterical", "deranged",
  )
  val candidates = voiceLines.mapNotNull { line ->
    val tokens = line.trim().split(Regex("\\s+"))
    val localeIndex = tokens.indexOfFirst { it == "en_US" }
    if (localeIndex <= 0) null else tokens.subList(0, localeIndex).joinToString(" ")
  }
  val english = candidates.filter { it.isNotBlank() }
  if (english.isEmpty()) return null
  val rank = { name: String ->
    when {
      name.lowercase() in premium -> 0
      name.lowercase() in novelty -> 2
      else -> 1
    }
  }
  return english.sortedBy { rank(it) }.first()
}

/** 生产实现：真实 ProcessBuilder。 */
class ProcessCommandExecutor : CommandExecutor {
  override fun start(command: String, args: List<String>): ManagedProcess {
    val process = ProcessBuilder(listOf(command) + args).start()
    return object : ManagedProcess {
      override fun destroy() = process.destroy()
      override fun await(): Int = process.waitFor()
    }
  }

  override fun available(command: String): Boolean =
    runCatching {
      val probe = if (System.getProperty("os.name").contains("Windows")) "where" else "which"
      // 有界等待:PATH 含挂载点/网络盘时 which 可能长挂,别把调用方锁死。
      ProcessBuilder(listOf(probe, command)).start().waitFor(2, TimeUnit.SECONDS)
    }.getOrDefault(false)

  override fun readLines(command: String, args: List<String>): List<String> =
    BufferedReader(InputStreamReader(ProcessBuilder(listOf(command) + args).start().inputStream)).use { reader ->
      reader.readLines()
    }
}
