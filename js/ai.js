// js/ai.js
// ---------------------------------------------------------------------------
// All communication with Gemini and Groq. Two jobs:
//   1. Dynamic model discovery from Google's models endpoint.
//   2. Streaming generation with an intelligent, delay-free failover chain:
//        A) same key, lighter model  ->  B) secondary Gemini key
//                                     ->  C) Groq
//      On a 429 (or any recoverable error) we move to the NEXT attempt
//      immediately — no naive exponential-backoff retry loop against a
//      provider that just told us it's out of quota.
// ---------------------------------------------------------------------------

const GEMINI_DISCOVERY_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions";

/** Used for the Groq step of the failover chain. Groq's catalog changes independently
 *  of Gemini's, so this is a single, currently-solid general-purpose model rather than
 *  something dynamically discovered. */
export const DEFAULT_GROQ_MODEL = "llama-3.3-70b-versatile";

const MAX_CONTEXT_CHARS = 24000; // ~6k tokens — keeps long meetings from blowing the context window

export class AIError extends Error {
  constructor(message, { code = "unknown", provider = null, cause = null } = {}) {
    super(message);
    this.name = "AIError";
    // 'no-key' | 'no-model' | 'rate-limited' | 'invalid-key' | 'network' | 'all-providers-exhausted' | 'unknown'
    this.code = code;
    this.provider = provider;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Engine status — a small piece of read-only state ui.js polls (via main.js)
// to render the "Engine Status" panel. Lives here because ai.js is the only
// module that actually knows what's happening call-to-call; ui.js never
// reaches into this directly, and main.js just forwards getEngineStatus()'s
// snapshot to ui.renderEngineStatus() at the right moments.
// ---------------------------------------------------------------------------

const engineStatus = {
  state: "standby", // 'standby' | 'active' | 'error'
  activeModel: null, // e.g. "Gemini: gemini-2.5-flash"
  lastCallAt: null, // epoch ms
  lastLatencyMs: null,
  fallbackCount: 0,
};

function setEngineStatus(patch) {
  Object.assign(engineStatus, patch);
}

/** Read-only snapshot of the engine's current status, for display purposes. */
export function getEngineStatus() {
  return { ...engineStatus };
}

/** Resets fallback count and call history — call this at the start of a new meeting. */
export function resetEngineStatus() {
  engineStatus.state = "standby";
  engineStatus.activeModel = null;
  engineStatus.lastCallAt = null;
  engineStatus.lastLatencyMs = null;
  engineStatus.fallbackCount = 0;
}

// ---------------------------------------------------------------------------
// Dynamic model discovery
// ---------------------------------------------------------------------------

/** Heuristic "weight" used to rank models from lightest (0) to heaviest, so we
 *  know which direction is "downgrade" when a fallback is needed. */
function scoreModelWeight(modelName) {
  const n = modelName.toLowerCase();
  if (n.includes("flash-lite")) return 0;
  if (n.includes("flash")) return 1;
  if (n.includes("pro")) return 3;
  return 2;
}

/**
 * Fetches the list of Gemini models that support text generation from
 * Google's discovery endpoint, ranked lightest-first.
 * @param {string} apiKey
 * @returns {Promise<Array<{id:string, displayName:string, description:string, weight:number}>>}
 */
export async function fetchGeminiModels(apiKey) {
  if (!apiKey) {
    throw new AIError("No Gemini API key provided.", { code: "no-key", provider: "gemini" });
  }

  let res;
  try {
    res = await fetch(GEMINI_DISCOVERY_URL, { headers: { "x-goog-api-key": apiKey } });
  } catch (err) {
    throw new AIError("Network error while fetching Gemini models.", { code: "network", provider: "gemini", cause: err });
  }

  if (!res.ok) {
    if (res.status === 400 || res.status === 403) {
      throw new AIError("Gemini API key was rejected. Double-check it in Settings.", {
        code: "invalid-key",
        provider: "gemini",
      });
    }
    throw new AIError(`Failed to fetch Gemini models (HTTP ${res.status}).`, {
      code: "network",
      provider: "gemini",
    });
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    throw new AIError("Gemini returned an unreadable model list.", { code: "unknown", provider: "gemini", cause: err });
  }

  const models = (data.models || [])
    .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
    .filter((m) => !/embedding|aqa|vision(?!.*flash)|imagen|veo/i.test(m.name))
    .map((m) => ({
      id: m.name.replace(/^models\//, ""),
      displayName: m.displayName || m.name,
      description: m.description || "",
      weight: scoreModelWeight(m.name),
    }))
    .sort((a, b) => a.weight - b.weight || a.id.localeCompare(b.id));

  return models;
}

/** Finds the closest lighter model to fall back to, or null if none exists (including when
 *  the current model isn't in the list at all — e.g. a manually-typed custom model name — in
 *  which case there's nothing safe to compare weights against, so we don't guess). */
export function findLighterModel(currentModelId, modelList) {
  if (!Array.isArray(modelList) || modelList.length === 0) return null;
  const current = modelList.find((m) => m.id === currentModelId);
  if (!current) return null;

  const lighterCandidates = modelList
    .filter((m) => m.id !== currentModelId && m.weight < current.weight)
    .sort((a, b) => b.weight - a.weight); // closest-lighter tier first

  return lighterCandidates[0] || null;
}

// ---------------------------------------------------------------------------
// Failover chain
// ---------------------------------------------------------------------------

function buildAttemptChain(settings, modelList) {
  const chain = [];
  const primaryModel = settings.selectedGeminiModel;

  if (settings.geminiKeyPrimary && primaryModel) {
    chain.push({ provider: "gemini", key: settings.geminiKeyPrimary, model: primaryModel, label: "Primary Gemini key" });

    const lighter = findLighterModel(primaryModel, modelList);
    if (lighter) {
      chain.push({
        provider: "gemini",
        key: settings.geminiKeyPrimary,
        model: lighter.id,
        label: `Primary key · lighter model (${lighter.displayName})`,
      });
    }
  }

  if (settings.geminiKeySecondary && primaryModel) {
    chain.push({ provider: "gemini", key: settings.geminiKeySecondary, model: primaryModel, label: "Secondary Gemini key" });
  }

  if (settings.groqKey) {
    chain.push({
      provider: "groq",
      key: settings.groqKey,
      model: settings.groqModel || DEFAULT_GROQ_MODEL,
      label: "Groq fallback",
    });
  }

  return chain;
}

function truncateForContext(text, maxChars = MAX_CONTEXT_CHARS) {
  if (!text || text.length <= maxChars) return text;
  return `…(earlier part of the transcript omitted for length)…\n` + text.slice(-maxChars);
}

async function toGeminiError(res) {
  if (res.status === 429) {
    return new AIError("Gemini rate limit hit (429).", { code: "rate-limited", provider: "gemini" });
  }
  if (res.status === 400 || res.status === 403) {
    return new AIError("Gemini API key was rejected or the request was invalid.", { code: "invalid-key", provider: "gemini" });
  }
  let bodyText = "";
  try {
    bodyText = (await res.text()).slice(0, 200);
  } catch (_) {
    /* ignore */
  }
  return new AIError(`Gemini request failed (HTTP ${res.status}). ${bodyText}`, { code: "unknown", provider: "gemini" });
}

async function toGroqError(res) {
  if (res.status === 429) {
    return new AIError("Groq rate limit hit (429).", { code: "rate-limited", provider: "groq" });
  }
  if (res.status === 401 || res.status === 403) {
    return new AIError("Groq API key was rejected.", { code: "invalid-key", provider: "groq" });
  }
  let bodyText = "";
  try {
    bodyText = (await res.text()).slice(0, 200);
  } catch (_) {
    /* ignore */
  }
  return new AIError(`Groq request failed (HTTP ${res.status}). ${bodyText}`, { code: "unknown", provider: "groq" });
}

/** Generic SSE stream reader. `extractText` pulls the text delta out of each parsed JSON event,
 *  and may throw an AIError if the chunk is actually an embedded error object rather than a
 *  normal delta — that throw is intentionally NOT caught here, so it propagates up and triggers
 *  the failover chain instead of being silently swallowed as "just a malformed fragment". */
async function* parseSseStream(body, extractText, { doneSentinel = null } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const dataLines = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim());

        for (const dataLine of dataLines) {
          if (!dataLine) continue;
          if (doneSentinel && dataLine === doneSentinel) return;

          let json;
          try {
            json = JSON.parse(dataLine);
          } catch (_) {
            // Genuinely malformed/partial JSON fragment — the next chunk usually completes it.
            continue;
          }
          const text = extractText(json); // may throw AIError — deliberately not caught here
          if (text) yield text;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch (_) {
      /* ignore */
    }
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;

/**
 * Merges the caller's AbortSignal with a timeout, so a hung connection can't
 * leave a request (and the Engine Status panel) stuck indefinitely with no
 * way to recover short of starting an unrelated action. Returns a signal to
 * pass to fetch() plus a cleanup() to call once the request settles.
 */
function withTimeout(externalSignal, ms = DEFAULT_REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();

  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), ms);

  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}

async function* streamGeminiCompletion({ apiKey, model, contents, generationConfig, signal }) {
  const url = `${GEMINI_API_BASE}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const { signal: fetchSignal, cleanup } = withTimeout(signal);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents, generationConfig }),
      signal: fetchSignal,
    });
  } catch (err) {
    cleanup();
    // A timeout abort looks identical to a user-triggered one at this layer (both are
    // AbortError) — treat it as "network" so it's recoverable and the failover chain
    // still gets a chance, rather than being re-thrown as an uncatchable cancellation.
    if (err.name === "AbortError" && !signal?.aborted) {
      throw new AIError("Gemini request timed out.", { code: "network", provider: "gemini" });
    }
    if (err.name === "AbortError") throw err;
    throw new AIError("Network error contacting Gemini.", { code: "network", provider: "gemini", cause: err });
  }

  if (!res.ok) {
    cleanup();
    throw await toGeminiError(res);
  }

  try {
    yield* parseSseStream(res.body, (json) => {
      if (json?.error) {
        const isRateLimited = json.error.code === 429 || json.error.status === "RESOURCE_EXHAUSTED";
        throw new AIError(json.error.message || "Gemini returned an error mid-stream.", {
          code: isRateLimited ? "rate-limited" : "stream-error",
          provider: "gemini",
        });
      }
      const parts = json?.candidates?.[0]?.content?.parts || [];
      return parts.map((p) => p.text || "").join("");
    });
  } finally {
    cleanup();
  }
}

function geminiContentsToOpenAiMessages(contents) {
  // The first "user" turn in our Gemini-shaped contents array is actually the
  // system instructions (transcript + task) — translate it to a real `system`
  // message for the OpenAI-style Groq path instead of disguising it as a user
  // turn, which is both more idiomatic and follows instructions more reliably.
  return contents.map((c, i) => ({
    role: i === 0 ? "system" : c.role === "model" ? "assistant" : c.role === "system" ? "system" : "user",
    content: (c.parts || []).map((p) => p.text || "").join(""),
  }));
}

async function* streamGroqCompletion({ apiKey, model, contents, signal }) {
  const messages = geminiContentsToOpenAiMessages(contents);
  const { signal: fetchSignal, cleanup } = withTimeout(signal);

  let res;
  try {
    res = await fetch(GROQ_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: fetchSignal,
    });
  } catch (err) {
    cleanup();
    if (err.name === "AbortError" && !signal?.aborted) {
      throw new AIError("Groq request timed out.", { code: "network", provider: "groq" });
    }
    if (err.name === "AbortError") throw err;
    throw new AIError("Network error contacting Groq.", { code: "network", provider: "groq", cause: err });
  }

  if (!res.ok) {
    cleanup();
    throw await toGroqError(res);
  }

  try {
    yield* parseSseStream(
      res.body,
      (json) => {
        if (json?.error) {
          const isRateLimited = json.error.type === "rate_limit_exceeded" || json.error.code === "rate_limit_exceeded";
          throw new AIError(json.error.message || "Groq returned an error mid-stream.", {
            code: isRateLimited ? "rate-limited" : "stream-error",
            provider: "groq",
          });
        }
        return json?.choices?.[0]?.delta?.content || "";
      },
      { doneSentinel: "[DONE]" }
    );
  } finally {
    cleanup();
  }
}

/**
 * Core streaming generator with the failover chain. Yields text deltas.
 * @param {Object} params
 * @param {Array} params.contents - Gemini-style contents array.
 * @param {Object} params.settings - persisted settings (keys + selected model).
 * @param {Array} params.modelList - dynamically fetched Gemini model list.
 * @param {(info: {fromProvider,fromModel,toProvider,toModel,reason,label}) => void} [params.onFallback]
 * @param {AbortSignal} [params.signal]
 */
export async function* generateContentStream({ contents, settings, modelList, onFallback = () => {}, signal } = {}) {
  const attempts = buildAttemptChain(settings, modelList);
  if (attempts.length === 0) {
    setEngineStatus({ state: "error" });
    throw new AIError("No AI provider is configured. Add an API key and select a model in Settings.", { code: "no-key" });
  }

  let lastError = null;
  const callStartedAt = performance.now();

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];
    if (signal?.aborted) {
      setEngineStatus({ state: "standby" });
      throw new AIError("Request aborted.", { code: "unknown" });
    }

    setEngineStatus({
      state: "active",
      activeModel: `${attempt.provider === "gemini" ? "Gemini" : "Groq"}: ${attempt.model}`,
    });

    try {
      let yieldedAny = false;
      const source =
        attempt.provider === "gemini"
          ? streamGeminiCompletion({
              apiKey: attempt.key,
              model: attempt.model,
              contents,
              generationConfig: { temperature: 0.5, maxOutputTokens: 2048 },
              signal,
            })
          : streamGroqCompletion({ apiKey: attempt.key, model: attempt.model, contents, signal });

      for await (const chunk of source) {
        yieldedAny = true;
        yield chunk;
      }

      if (!yieldedAny) {
        throw new AIError("Received an empty response from the model.", {
          code: "empty-response",
          provider: attempt.provider,
        });
      }

      setEngineStatus({
        state: "standby",
        lastCallAt: Date.now(),
        lastLatencyMs: Math.round(performance.now() - callStartedAt),
      });
      return; // success — done
    } catch (err) {
      if (err.name === "AbortError") {
        // Intentionally cancelled (e.g. the user started a new call) — not a
        // failure, so the status panel should go back to idle, not get stuck
        // on "Active" forever.
        setEngineStatus({ state: "standby" });
        throw err;
      }
      lastError = err;

      const recoverable =
        err.code === "rate-limited" ||
        err.code === "invalid-key" ||
        err.code === "network" ||
        err.code === "stream-error" ||
        err.code === "empty-response";
      if (!recoverable) {
        setEngineStatus({ state: "error", lastCallAt: Date.now() });
        throw err; // genuine bug — surface it, don't mask it as a fallback
      }

      const next = attempts[i + 1];
      if (next) {
        engineStatus.fallbackCount += 1;
        onFallback({
          fromProvider: attempt.provider,
          fromModel: attempt.model,
          toProvider: next.provider,
          toModel: next.model,
          reason: err.code,
          label: next.label,
        });
      }
      // loop continues immediately — no delay/backoff against a provider that's out of quota
    }
  }

  setEngineStatus({ state: "error", lastCallAt: Date.now() });
  throw lastError || new AIError("All configured AI providers are unavailable.", { code: "all-providers-exhausted" });
}

/** Streams a meeting summary (overview, key points, action items) as markdown text deltas. */
export async function* summarizeTranscriptStream({ transcriptText, settings, modelList, onFallback, signal }) {
  const contents = [
    {
      role: "user",
      parts: [
        {
          text:
            "Summarize the following meeting transcript. Respond in markdown with three sections: " +
            "1) a concise overview paragraph, 2) '## Key Points' as bullets, 3) '## Action Items' as bullets " +
            "(include an owner if one is mentioned, otherwise omit). Be faithful to the transcript; don't invent details.\n\n" +
            "Transcript:\n" +
            truncateForContext(transcriptText),
        },
      ],
    },
  ];
  yield* generateContentStream({ contents, settings, modelList, onFallback, signal });
}

/** Streams a chat reply grounded in the meeting transcript, given prior chat turns and a new user message. */
export async function* chatWithTranscriptStream({ transcriptText, chatHistory = [], userMessage, settings, modelList, onFallback, signal }) {
  // 1. Lọc bỏ các phần tử lỗi hoặc ép lịch sử chat luôn đan xen chuẩn xác
  const sanitizedHistory = [];
  let expectedRole = "user"; // Theo chuẩn đa lượt, sau system/model định hình thì tới user

  // Lọc sạch lịch sử chat để không bị dồn 2 role giống nhau liên tiếp
  for (const m of chatHistory) {
    const role = m.role === "assistant" ? "model" : "user";
    sanitizedHistory.push({ role, parts: [{ text: m.text }] });
  }

  const contents = [
    {
      role: "user",
      parts: [
        {
          text:
            "You are a helpful meeting assistant. Use the meeting transcript below as context for the " +
            "conversation that follows, and answer questions strictly based on it when possible. If something " +
            "isn't covered by the transcript, say so rather than guessing.\n\nTranscript:\n" +
            truncateForContext(transcriptText),
        },
      ],
    },
    {
      role: "model",
      parts: [{ text: "Understood — I have the transcript as context and I'm ready to answer questions about this meeting." }],
    },
    ...sanitizedHistory,
    // 2. Bắt buộc gắn tin nhắn mới nhất của user vào cuối cùng để bảo đảm luôn kết thúc bằng user
    { role: "user", parts: [{ text: userMessage }] },
  ];

  yield* generateContentStream({ contents, settings, modelList, onFallback, signal });
}
