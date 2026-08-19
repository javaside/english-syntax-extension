export function normalizeBaseUrl(baseUrl: string): string {
  const trimmedBaseUrl = baseUrl.trim();
  if (trimmedBaseUrl.includes("?") || trimmedBaseUrl.includes("#")) {
    throw new Error("Model base URL must not contain query strings or fragments");
  }

  let url: URL;
  try {
    url = new URL(trimmedBaseUrl);
  } catch {
    throw new Error("Model base URL must be a valid URL");
  }

  if (url.username || url.password) {
    throw new Error("Model base URL must not contain credentials");
  }

  const isLocalHttp =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("Model base URL must use HTTPS unless it is localhost");
  }

  return url.toString().replace(/\/$/, "");
}

export function chatCompletionsUrl(baseUrl: string): string {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`;
}

export function hostPermissionPattern(baseUrl: string): string {
  return `${new URL(normalizeBaseUrl(baseUrl)).origin}/*`;
}

/**
 * 本地(loopback)端点与云端 API 的合批取舍相反,调用方据此选批次大小:
 * 本地模型串行处理请求,合并成一条大请求才快;云端并发好且耗时几乎只由输出
 * token 决定,拆小批并行才快。判定失败时返回 false——退回云端策略,因为远端
 * 才是默认场景。
 */
export function isLoopbackBaseUrl(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}
