"use strict";

const AWS_API_URL = "https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com";
const RETIRED_API_HOST = "agently-server-v1.vercel.app";

// A laptop can initiate a real call too. Never send its provider callbacks to
// the retired backend, regardless of NODE_ENV. Keep other configured hosts.
function getBackendBaseUrl(env = process.env) {
  const base = String(env.API_URL || "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const url = new URL(base);
  if (url.hostname.toLowerCase() === RETIRED_API_HOST) return AWS_API_URL;
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("API_URL must be an HTTP(S) backend URL without credentials");
  }
  return base;
}

module.exports = { getBackendBaseUrl, AWS_API_URL };
