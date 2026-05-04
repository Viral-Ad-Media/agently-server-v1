"use strict";

const PROVIDER = "openai";
const DEFAULT_REALTIME_MODEL = "gpt-realtime";

function preflightEnabled() {
  return String(process.env.AI_PROVIDER_PREFLIGHT_ENABLED || "true")
    .trim()
    .toLowerCase() !== "false";
}

function realtimeModel() {
  return String(process.env.OPENAI_REALTIME_MODEL || DEFAULT_REALTIME_MODEL).trim();
}

function unavailableError(reason, message) {
  return {
    success: false,
    error: {
      code: "AI_PROVIDER_UNAVAILABLE",
      provider: PROVIDER,
      reason: reason || "unknown",
      message:
        message ||
        "The AI voice provider is currently unavailable. Please try again later.",
    },
  };
}

function classifyOpenAIError(raw) {
  const text = String(raw || "").toLowerCase();
  if (/insufficient[_\s-]?quota|quota|billing|exceeded your current quota/.test(text)) {
    return {
      reason: "insufficient_quota",
      message:
        "The AI voice provider is currently unavailable because quota or billing is exhausted.",
    };
  }
  if (/invalid[_\s-]?api[_\s-]?key|incorrect api key|unauthorized|401/.test(text)) {
    return {
      reason: "invalid_api_key",
      message:
        "The AI voice provider is currently unavailable because the API key is invalid.",
    };
  }
  if (/model[_\s-]?not[_\s-]?found|model .* not found|does not exist|404/.test(text)) {
    return {
      reason: "model_not_found",
      message:
        "The AI voice provider is currently unavailable because the configured realtime model was not found.",
    };
  }
  if (/rate[_\s-]?limit|too many requests|429/.test(text)) {
    return {
      reason: "rate_limit_exceeded",
      message:
        "The AI voice provider is temporarily rate limited. Please try again later.",
    };
  }
  if (/billing[_\s-]?not[_\s-]?active|payment required|billing inactive/.test(text)) {
    return {
      reason: "billing_not_active",
      message:
        "The AI voice provider is currently unavailable because billing is not active.",
    };
  }
  return {
    reason: "provider_check_failed",
    message:
      "The AI voice provider is currently unavailable. Please try again later.",
  };
}

async function checkOpenAIRealtimeProvider() {
  if (!preflightEnabled()) {
    return { success: true, skipped: true, provider: PROVIDER, reason: "disabled" };
  }

  console.log("[ai-provider] preflight started");

  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    const result = unavailableError(
      "missing_api_key",
      "The AI voice provider is currently unavailable because the API key is not configured.",
    );
    console.warn("[ai-provider] preflight failed reason=missing_api_key");
    return result;
  }

  const model = realtimeModel();
  if (!model) {
    const result = unavailableError(
      "missing_model",
      "The AI voice provider is currently unavailable because no realtime model is configured.",
    );
    console.warn("[ai-provider] preflight failed reason=missing_model");
    return result;
  }

  const timeoutMs = Math.max(
    2500,
    Number(process.env.AI_PROVIDER_PREFLIGHT_TIMEOUT_MS || 7000),
  );
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/sessions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Beta": "realtime=v1",
      },
      body: JSON.stringify({
        model,
        voice: process.env.OPENAI_REALTIME_VOICE || "alloy",
      }),
    });

    const body = await response.text();
    if (!response.ok) {
      const classified = classifyOpenAIError(body || response.statusText || response.status);
      console.warn(`[ai-provider] preflight failed reason=${classified.reason}`);
      return unavailableError(classified.reason, classified.message);
    }

    console.log("[ai-provider] preflight ok");
    return { success: true, provider: PROVIDER, model };
  } catch (err) {
    const reason = err?.name === "AbortError" ? "provider_timeout" : classifyOpenAIError(err?.message || err).reason;
    const message =
      reason === "provider_timeout"
        ? "The AI voice provider health check timed out. Please try again later."
        : classifyOpenAIError(err?.message || err).message;
    console.warn(`[ai-provider] preflight failed reason=${reason}`);
    return unavailableError(reason, message);
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  checkOpenAIRealtimeProvider,
  classifyOpenAIError,
  preflightEnabled,
  realtimeModel,
};
