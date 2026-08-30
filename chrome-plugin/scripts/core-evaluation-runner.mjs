const PROVIDER_ERROR_LIMIT = 320;
const VALIDATION_REJECTION_STATUSES = new Set([400, 422]);

/**
 * 请求、日志和 artifact 使用同一份规范化 base URL。credentials/query/fragment 会造成
 * 请求语义、日志与 artifact 分叉，非 HTTP(S) URL 也不是可用的模型端点，因此直接拒绝。
 */
export function parseRunnerBaseUrl(value) {
  let parsed;
  try {
    parsed = new globalThis.URL(value);
  } catch {
    throw new Error("Runner base URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Runner base URL must use http or https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Runner base URL must not contain username, password, query, or fragment");
  }
  const normalizedBaseUrl = parsed.toString().replace(/\/$/u, "");
  return { requestBaseUrl: normalizedBaseUrl, safeBaseUrl: normalizedBaseUrl };
}

export function predictionList(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.sentences)) return document.sentences;
  if (Array.isArray(document?.predictions)) return document.predictions;
  if (Array.isArray(document?.analyses)) return document.analyses;
  throw new Error(
    "Prediction JSON must be an array or contain sentences/predictions/analyses array",
  );
}

export function sanitizeProviderError(error, apiKey) {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.replaceAll(apiKey, "<masked>");
  message = message
    .replace(/Bearer\s+[^\s,;"']+/giu, "Bearer <masked>")
    .replace(/Authorization\s*[:=]\s*(?:Bearer\s+)?[^\s,;"']+/giu, "Authorization: <masked>");
  return message.slice(0, PROVIDER_ERROR_LIMIT);
}

function rejectedField(status, text, body) {
  if (!VALIDATION_REJECTION_STATUSES.has(status)) return undefined;
  if (Object.hasOwn(body, "reasoning_effort") && /reasoning[_ ]?effort/iu.test(text)) {
    return "reasoning_effort";
  }
  if (
    Object.hasOwn(body, "response_format") &&
    /response[_ ]?format|json[_ ]?object/iu.test(text)
  ) {
    return "response_format";
  }
  return undefined;
}

export async function requestChatCompletion(options, fetchImplementation = globalThis.fetch) {
  const body = { ...options.body };
  while (true) {
    const response = await fetchImplementation(options.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: globalThis.AbortSignal.timeout(options.timeoutMs),
    });
    const text = await response.text();
    if (response.ok) return JSON.parse(text);

    const field = rejectedField(response.status, text, body);
    if (field) {
      delete body[field];
      continue;
    }

    const summary = sanitizeProviderError(text, options.apiKey);
    throw new Error(`HTTP ${response.status}: ${summary}`);
  }
}
