"use strict";

const { createClient } = require("@supabase/supabase-js");

let _client = null;

/**
 * Returns a singleton Supabase client using the service key.
 * Throws a clear error if the required env vars are missing
 * rather than silently returning a broken client.
 */
function getSupabase() {
  if (_client) return _client;

  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_KEY || "").trim();

  if (!url) throw new Error("SUPABASE_URL is not set. Check your .env file.");
  if (!key)
    throw new Error("SUPABASE_SERVICE_KEY is not set. Check your .env file.");

  _client = createClient(url, key, {
    auth: { persistSession: false },
  });

  return _client;
}

module.exports = { getSupabase };
