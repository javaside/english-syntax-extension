package dev.codetui.englishsyntax.model

/**
 * 把被截断的 JSON 补成能解析的文本:在最后一个完整值处截断，补齐未闭合的括号。
 *
 * 与 Chrome 侧 `chrome-plugin/src/background/lenient-json.ts` 逐字对齐——两端返回的
 * **文本**必须完全相同，向量见 `shared-fixtures/truncated-json-salvage.json`
 * (`LenientJsonTest` 与 `lenient-json.test.ts` 各跑一遍同一批)。
 *
 * 为什么要救:模型少吐收尾括号是常态(本机 qwen3.5:9b-mlx 每次都少最后一个 `}`,
 * 云端模型触到 max_tokens 也会断在半句上)。此前这类输出让整条请求直接判死
 * (INVALID_MODEL_OUTPUT)，同一批句子全军覆没——而其中前几句往往是完整的。救回来的
 * 对象若缺字段，由上层逐句校验判无效并进修复轮，那也远好过整块判死。
 */
internal fun repairTruncatedJson(text: String): String? {
  val source = stripFences(text)
  // 只认以容器开头的正文:模型该给的是对象,而「绝不从散文里抠 JSON」是既有不变量
  // (kotlinx 的 parseToJsonElement 会把裸词当字符串收下,这道门也让两端判据一致)。
  if (!source.startsWith("{") && !source.startsWith("[")) return null
  if (canParse(source)) return source
  val cut = lastCompleteValue(source) ?: return null
  val candidate = source.substring(0, cut.index) + cut.closers
  return if (canParse(candidate)) candidate else null
}

/** 未闭合的容器:对象容器里冒号之后、下一个逗号之前读到的字符串是值，不是键。 */
private class OpenContainer(val closer: Char, var awaitingValue: Boolean)

/** 截断位置(不含)与该处仍未闭合的容器的收尾括号(由内向外)。 */
private class Cut(val index: Int, val closers: String)

private val WHITESPACE = setOf(' ', '\t', '\n', '\r')
private val OPENING_FENCE = Regex("^```[A-Za-z]*[\\t ]*\\r?\\n")
private val TRAILING_FENCE = Regex("\\r?\\n?```$")

private fun canParse(candidate: String): Boolean {
  if (candidate.isEmpty()) return false
  return try {
    streamJson.parseToJsonElement(candidate)
    true
  } catch (_: Exception) {
    false
  }
}

/**
 * 摘掉 Markdown 围栏。收尾那道围栏正是最先被截掉的东西，所以开头那道要单独摘，
 * 不能只认成对出现的围栏(那是 stripSingleJsonFence 的活)。
 */
private fun stripFences(text: String): String =
  text.trim().replace(OPENING_FENCE, "").replace(TRAILING_FENCE, "").trim()

/**
 * 按 JSON 词法扫一遍，记住「最后一个已闭合的值」的结束位置与当时未闭合的容器。
 * 截断点只落在值边界上:半截字符串、被截断的数字、只有键没有值的成员都不会留下。
 */
private fun lastCompleteValue(source: String): Cut? {
  val stack = ArrayDeque<OpenContainer>()
  var cut: Cut? = null
  var inString = false
  var escaped = false
  var inScalar = false
  var started = false

  fun complete(endExclusive: Int) {
    stack.lastOrNull()?.awaitingValue = false
    cut = Cut(endExclusive, stack.reversed().map { it.closer }.joinToString(""))
  }

  var index = 0
  while (index < source.length) {
    val character = source[index]

    if (inString) {
      when {
        escaped -> escaped = false
        character == '\\' -> escaped = true
        character == '"' -> {
          inString = false
          val container = stack.lastOrNull()
          // 对象里的字符串可能是键,只有冒号之后那个才是值。
          if (container == null || container.closer == ']' || container.awaitingValue) {
            complete(index + 1)
          }
        }
      }
      index += 1
      continue
    }

    // 裸标量(数字/true/false/null)在分隔符之前就结束了。
    if (inScalar && (character in WHITESPACE || character == ',' || character == '}' || character == ']')) {
      inScalar = false
      complete(index)
    }

    if (!started) {
      // 正文之前的客套话不参与词法(免得把散文里的词当标量或字符串)。注意候选仍从 0 切,
      // 所以正文前有散文时整段解析不了——「绝不从散文里抠 JSON」是既有不变量,不在此处放宽。
      if (character != '{' && character != '[') {
        index += 1
        continue
      }
      started = true
    }

    when (character) {
      '"' -> inString = true
      '{' -> stack.addLast(OpenContainer('}', false))
      '[' -> stack.addLast(OpenContainer(']', false))
      '}', ']' -> {
        // 括号对不上:后面的文本不可信，就此收手。
        if (stack.removeLastOrNull() == null) return cut
        complete(index + 1)
      }
      ':' -> stack.lastOrNull()?.awaitingValue = true
      ',' -> stack.lastOrNull()?.awaitingValue = false
      else -> if (character !in WHITESPACE) inScalar = true
    }
    index += 1
  }
  // 结尾的裸标量可能只吐了一半(「12」其实是「123」),不认它，退回上一个完整值。
  return cut
}
