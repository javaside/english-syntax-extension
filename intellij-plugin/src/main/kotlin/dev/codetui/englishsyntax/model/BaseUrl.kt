package dev.codetui.englishsyntax.model

import java.net.URI

/**
 * 与 Chrome 端 `src/background/base-url.ts` 保持一致：远端强制 HTTPS，
 * HTTP 仅允许 localhost / 127.0.0.1；拒绝 query、fragment 和内嵌凭据。
 */
fun normalizeBaseUrl(baseUrl: String): String {
  val trimmed = baseUrl.trim()
  if (trimmed.contains('?') || trimmed.contains('#')) {
    throw IllegalArgumentException("Model base URL must not contain query strings or fragments")
  }
  val uri = try {
    URI(trimmed)
  } catch (exception: Exception) {
    throw IllegalArgumentException("Model base URL must be a valid URL", exception)
  }
  if (!uri.rawUserInfo.isNullOrEmpty()) {
    throw IllegalArgumentException("Model base URL must not contain credentials")
  }
  val scheme = uri.scheme?.lowercase()
  val host = uri.host?.lowercase()
  require(host != null) { "Model base URL must include a host" }
  val isLocalHttp = scheme == "http" && (host == "localhost" || host == "127.0.0.1")
  if (scheme != "https" && !isLocalHttp) {
    throw IllegalArgumentException("Model base URL must use HTTPS unless it is localhost")
  }
  // 与 JS `URL.toString()` 等价：scheme/host 小写、去掉显式默认端口。
  val port = if ((scheme == "https" && uri.port == 443) || (scheme == "http" && uri.port == 80)) -1 else uri.port
  val path = uri.path.ifEmpty { null }
  val normalized = URI(scheme, null, host, port, path, null, null)
  // 与 JS `url.toString().replace(/\/$/, "")` 相同：只去掉恰好一个尾斜杠。
  return normalized.toString().removeSuffix("/")
}

fun chatCompletionsUrl(baseUrl: String): String {
  val normalized = normalizeBaseUrl(baseUrl)
  return if (normalized.endsWith("/chat/completions")) normalized else "$normalized/chat/completions"
}

/**
 * 本地(loopback)端点与云端 API 的合批取舍相反；判定失败返回 false——退回云端策略。
 */
fun isLoopbackBaseUrl(baseUrl: String): Boolean {
  return try {
    val host = URI(baseUrl).host?.lowercase()
    host == "localhost" || host == "127.0.0.1"
  } catch (_: Exception) {
    false
  }
}
