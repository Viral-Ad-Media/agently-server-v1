'use strict';

/**
 * ============================================================
 * lib/billing-tracker.js
 * ============================================================
 * Per-number Twilio billing tracker for Agently SaaS.
 *
 * PURPOSE:
 *   This module runs a background job every 30 seconds.
 *   For every voice_agent row in the DB that has a Twilio
 *   phone number (twilio_phone_number + twilio_phone_sid),
 *   it fetches the cost of all calls on that number for the
 *   current billing period from Twilio's Calls API, sums them
 *   with the monthly rental cost, and writes the total back
 *   to voice_agents.twilio_billing_usd.
 *
 * WHY THIS MATTERS:
 *   The master Twilio account is shared across all orgs.
 *   fetchMonthlyBilling() only returns account-wide totals —
 *   it cannot break costs down by number or by org.
 *   This tracker isolates costs PER NUMBER so the app owner
 *   can later use twilio_billing_usd to calculate what to
 *   charge each tenant for their subscription.
 *
 * WHAT IS TRACKED:
 *   1. Monthly rental cost (set once at purchase, rare to change)
 *   2. Inbound call costs  (GET /Calls.json?To={number})
 *   3. Outbound call costs (GET /Calls.json?From={number})
 *
 * WHAT IS NEVER EXPOSED:
 *   These columns are backend-only. No route returns them.
 *   No frontend component reads them. They are internal cost
 *   data for the app owner's billing calculations ONLY.
 *
 * HOW IT IS STARTED:
 *   Called once from api/index.js on server boot:
 *     require('./lib/billing-tracker').start();
 *
 * VERCEL SERVERLESS NOTE:
 *   Vercel serverless functions are stateless and short-lived.
 *   setInterval will only run while a function invocation is
 *   active. For true background polling on Vercel, you would
 *   use a Vercel Cron Job (vercel.json "crons" config) that
 *   hits a dedicated /api/internal/billing-sync route.
 *   This file provides both:
 *     - start()    → setInterval for local dev / always-on servers
 *     - runOnce()  → called by the Vercel Cron route
 * ============================================================
 */

const { getSupabase } = require('./supabase');

// ── Twilio API helper (inline — does NOT import from lib/twilio
//   to avoid circular deps; uses the same Basic-Auth pattern) ─────────
const TWILIO_BASE = 'https://api.twilio.com/2010-04-01';

async function twilioGet(path, params = {}) {
  const sid   = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN  || '').trim();
  if (!sid || !token) throw new Error('Twilio credentials not set');

  const qs = new URLSearchParams(params).toString();
  const url = `${TWILIO_BASE}/Accounts/${sid}${path}${qs ? '?' + qs : ''}`;
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');

  const res = await fetch(url, { headers: { Authorization: auth } });
  if (res.status === 404) return null; // number may have been released
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio ${res.status} on ${path}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── Fetch the total call cost for a phone number in a date range ──────
// We query both To= and From= to get inbound + outbound costs.
// Twilio's Calls API can filter by specific number.
// Each call record has a `price` field (negative for Twilio's convention).
async function fetchCallCostForNumber(phoneNumber, startDate) {
  let totalCost = 0;
  const pageSize = '100';

  for (const direction of ['To', 'From']) {
    let nextPage = `/Calls.json`;
    let params = {
      [direction]: phoneNumber,
      StartTime: startDate,     // YYYY-MM-DD — calls on/after this date
      Status: 'completed',      // only count completed calls (have a price)
      PageSize: pageSize,
    };

    // Page through all results (Twilio paginates at PageSize)
    let iterations = 0;
    while (nextPage && iterations < 20) {
      iterations++;
      let data;
      try {
        // If nextPage already has the full path from next_page_uri, use it
        data = await twilioGet(nextPage, iterations === 1 ? params : {});
      } catch (err) {
        console.warn(`[billing-tracker] Calls API error (${direction}=${phoneNumber}):`, err.message);
        break;
      }
      if (!data) break;

      const calls = data.calls || [];
      for (const call of calls) {
        // Twilio returns price as a negative number (cost to you) or null for in-progress
        const price = parseFloat(call.price || '0');
        if (!isNaN(price)) {
          totalCost += Math.abs(price); // store as positive USD
        }
      }

      // Follow pagination
      nextPage = data.next_page_uri
        ? data.next_page_uri.replace(`/2010-04-01/Accounts/${(process.env.TWILIO_ACCOUNT_SID || '').trim()}`, '')
        : null;
    }
  }

  return totalCost;
}

// ── Fetch the monthly rental cost for a phone number SID ─────────────
// This is the fixed monthly fee Twilio charges for owning the number.
async function fetchNumberRentalCost(phoneSid) {
  try {
    const data = await twilioGet(`/IncomingPhoneNumbers/${phoneSid}.json`);
    if (!data) return 0;
    // Twilio doesn't directly expose rental price on this endpoint.
    // We use the Pricing API instead: GET /v1/PhoneNumbers/{phoneNumber}
    // For now, we store 0 and let the admin set it manually, OR we fetch
    // it from Twilio Pricing API. We query the number's monthly fee via
    // the Usage Records API which DOES have a category for phone-numbers.
    return 0; // will be calculated from usage records monthly category
  } catch {
    return 0;
  }
}

// ── Fetch phone number rental cost from Twilio Pricing API ───────────
// Endpoint: GET https://pricing.twilio.com/v1/PhoneNumbers/Countries/{isoCountry}
// This gives us the monthly price for the number type.
// Since this is expensive to call repeatedly, we only call it once and cache it.
async function fetchRentalCostFromPricing(phoneNumber) {
  try {
    // Use Usage Records with category=phone-numbers for this month to get rental cost
    const now = new Date();
    const firstOfMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const data = await twilioGet('/Usage/Records.json', {
      Category: 'phonenumbers',
      StartDate: firstOfMonth,
    });
    if (!data || !data.usage_records || data.usage_records.length === 0) return 0;
    // Sum the price across all phone-number usage records this month
    const total = data.usage_records.reduce((sum, r) => sum + Math.abs(parseFloat(r.price || '0')), 0);
    // Divide by number of phone numbers to get per-number estimate
    // (this is approximate — exact per-number rental is not available via Usage API)
    const numNumbers = parseInt(data.usage_records[0]?.count || '1', 10) || 1;
    return total / numNumbers;
  } catch {
    return 0;
  }
}

// ── Main billing sync: update one voice_agent row ────────────────────
async function syncAgentBilling(agent, db) {
  if (!agent.twilio_phone_number || !agent.twilio_phone_sid) return;

  const now = new Date();

  // Determine billing period start (reset monthly on same day number was added)
  let periodStart = agent.twilio_billing_period_start;
  if (!periodStart) {
    // First time: set period start to first of current month
    periodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  // Check if we need to roll over to a new billing period (30 days)
  const periodStartDate = new Date(periodStart);
  const daysSincePeriodStart = Math.floor((now - periodStartDate) / (1000 * 60 * 60 * 24));
  if (daysSincePeriodStart >= 30) {
    // Reset billing period
    periodStart = now.toISOString().split('T')[0];
  }

  // Fetch call costs for this number since the billing period started
  let callCost = 0;
  try {
    callCost = await fetchCallCostForNumber(agent.twilio_phone_number, periodStart);
  } catch (err) {
    console.warn(`[billing-tracker] fetchCallCost failed for ${agent.twilio_phone_number}:`, err.message);
    return; // skip this agent if Twilio is unreachable
  }

  // Rental cost: if not set yet, try to get it
  let rentalCost = parseFloat(agent.twilio_monthly_rental_usd || '0');
  if (rentalCost === 0) {
    rentalCost = await fetchRentalCostFromPricing(agent.twilio_phone_number);
  }

  const totalBilling = callCost + rentalCost;

  // Write back to DB
  const { error } = await db
    .from('voice_agents')
    .update({
      twilio_billing_usd: totalBilling.toFixed(4),
      twilio_monthly_rental_usd: rentalCost.toFixed(4),
      twilio_billing_period_start: periodStart,
      twilio_billing_updated_at: now.toISOString(),
    })
    .eq('id', agent.id);

  if (error) {
    console.warn(`[billing-tracker] DB update failed for agent ${agent.id}:`, error.message);
  } else {
    console.log(
      `[billing-tracker] ${agent.twilio_phone_number}: calls=$${callCost.toFixed(4)} ` +
      `rental=$${rentalCost.toFixed(4)} total=$${totalBilling.toFixed(4)}`
    );
  }
}

// ── runOnce: sync billing for ALL voice agents with a number ──────────
// Called by the Vercel Cron route AND by the setInterval in start().
async function runOnce() {
  const db = getSupabase();

  const { data: agents, error } = await db
    .from('voice_agents')
    .select('id, twilio_phone_number, twilio_phone_sid, twilio_billing_usd, twilio_monthly_rental_usd, twilio_billing_period_start, twilio_billing_updated_at')
    .neq('twilio_phone_number', '')
    .not('twilio_phone_number', 'is', null)
    .neq('twilio_phone_sid', '')
    .not('twilio_phone_sid', 'is', null);

  if (error) {
    console.error('[billing-tracker] DB query failed:', error.message);
    return;
  }

  if (!agents || agents.length === 0) return;

  // Process agents sequentially to avoid hammering Twilio API rate limits
  // Twilio rate limit: ~100 reads/sec for most resources, but be conservative
  for (const agent of agents) {
    await syncAgentBilling(agent, db);
    // Small delay between agents to be a good API citizen
    await new Promise(r => setTimeout(r, 200));
  }
}

// ── start: kick off the interval loop (local dev / always-on servers) ─
let _interval = null;

function start() {
  if (_interval) return; // already running

  // Only run in environments where Twilio is configured
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    console.log('[billing-tracker] Skipping — Twilio credentials not set.');
    return;
  }

  console.log('[billing-tracker] Starting per-number billing tracker (every 30s)...');

  // Run immediately on start, then every 30 seconds
  void runOnce();
  _interval = setInterval(() => {
    void runOnce();
  }, 30 * 1000);

  // Prevent the interval from keeping the process alive unnecessarily
  if (_interval.unref) _interval.unref();
}

function stop() {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}

module.exports = { start, stop, runOnce };
