"use strict";

/**
 * Calendar booking service — the single implementation behind the voice
 * agent's check/book/cancel tools.
 *
 * PROVIDER STRATEGY (per Lawal, 2026-10-05): Calendly first when connected,
 * Google Calendar as fallback. Calendly's POST /invitees is slot-atomic
 * (a taken slot fails server-side), so no lock table is needed there. Google
 * has no check-and-set: bookings are serialized per calendar with an
 * in-process mutex, freeBusy is re-checked immediately before insert, and a
 * short-lived slot hold guards the agent-vs-agent race. The residual race
 * (a human booking in Google's UI in the same seconds) is reconciled by
 * push notifications in Phase 3.
 *
 * CALLERS
 *
 * - In-process: the Express realtime bridge (webcall path) imports this
 *   module directly.
 * - Over HTTP: the ws-server (Twilio voice path) POSTs to
 *   /api/internal/calendar/* (see api/routes/internal.js), which calls these
 *   same functions. One implementation, no drift.
 *
 * Every function returns a plain JSON result — never throws for expected
 * provider outcomes (slot taken, not connected). Only unexpected failures
 * (DB down, programming errors) throw.
 */

const crypto = require("crypto");
const { getSupabase } = require("./supabase");
const { getValidAccessToken, getConnection } = require("./calendar-tokens");

const PROVIDER_TIMEOUT_MS = 12000;
const SLOT_HOLD_TTL_MS = 3 * 60 * 1000;
const MAX_SLOTS_RETURNED = 20;
const DEFAULT_SLOT_MINUTES = 30;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_WORKING_HOURS = {
  mon: [["09:00", "17:00"]],
  tue: [["09:00", "17:00"]],
  wed: [["09:00", "17:00"]],
  thu: [["09:00", "17:00"]],
  fri: [["09:00", "17:00"]],
  sat: [],
  sun: [],
};

// ---------------------------------------------------------------------------
// Timezone helpers (no new dependencies — Intl only)
// ---------------------------------------------------------------------------

function tzOffsetMinutes(timeZone, date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return Math.round((asUtc - date.getTime()) / 60000);
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. DST-safe. */
function wallClockToUtc(year, month, day, hour, minute, timeZone) {
  let guess = Date.UTC(year, month - 1, day, hour, minute);
  for (let i = 0; i < 2; i += 1) {
    const offset = tzOffsetMinutes(timeZone, new Date(guess));
    guess = Date.UTC(year, month - 1, day, hour, minute) - offset * 60000;
  }
  return new Date(guess);
}

function datePartsInZone(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
  const weekday = parts.weekday.toLowerCase(); // mon..sun
  return {
    weekday,
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

function formatSlotLabel(utcDate, timeZone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(utcDate);
}

function parseHm(value) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!m) return null;
  return { h: Number(m[1]), m: Number(m[2]) };
}

// ---------------------------------------------------------------------------
// Slot computation (Google path — Calendly computes its own)
// ---------------------------------------------------------------------------

function bookingSettings(connection) {
  const raw = (connection && connection.booking_settings) || {};
  return {
    slotMinutes: Number(raw.slotMinutes) > 0 ? Number(raw.slotMinutes) : DEFAULT_SLOT_MINUTES,
    windowDays: Number(raw.windowDays) > 0 ? Number(raw.windowDays) : DEFAULT_WINDOW_DAYS,
    workingHours:
      raw.workingHours && typeof raw.workingHours === "object"
        ? raw.workingHours
        : DEFAULT_WORKING_HOURS,
    sendUpdates: raw.sendUpdates === "none" ? "none" : "all",
  };
}

/**
 * Turn freeBusy busy-blocks into bookable slots inside working hours.
 * busy: [{start,end} ISO], from/to: Date (UTC), timeZone: IANA name.
 */
function computeFreeSlots({ busy, from, to, timeZone, slotMinutes, workingHours }) {
  const busyRanges = (busy || [])
    .map((b) => ({ start: new Date(b.start).getTime(), end: new Date(b.end).getTime() }))
    .filter((b) => Number.isFinite(b.start) && Number.isFinite(b.end) && b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const overlaps = (s, e) => busyRanges.some((b) => s < b.end && e > b.start);

  const slots = [];
  // Walk day by day in the connection timezone.
  let cursor = new Date(from.getTime());
  const endTime = to.getTime();
  while (cursor.getTime() < endTime && slots.length < MAX_SLOTS_RETURNED) {
    const { weekday, year, month, day } = datePartsInZone(cursor, timeZone);
    const windows = workingHours[weekday] || [];
    for (const [startHm, endHm] of windows) {
      const s = parseHm(startHm);
      const e = parseHm(endHm);
      if (!s || !e) continue;
      let slotStart = wallClockToUtc(year, month, day, s.h, s.m, timeZone).getTime();
      const windowEnd = wallClockToUtc(year, month, day, e.h, e.m, timeZone).getTime();
      const dayStart = Math.max(slotStart, from.getTime());
      // Align the first slot to the slot grid.
      const gridOffset = (dayStart - slotStart) % (slotMinutes * 60000);
      if (gridOffset > 0) slotStart = dayStart + (slotMinutes * 60000 - gridOffset);
      else slotStart = dayStart;
      while (slotStart + slotMinutes * 60000 <= Math.min(windowEnd, endTime)) {
        const slotEnd = slotStart + slotMinutes * 60000;
        if (!overlaps(slotStart, slotEnd)) {
          const startDate = new Date(slotStart);
          slots.push({
            start: startDate.toISOString(),
            end: new Date(slotEnd).toISOString(),
            label: formatSlotLabel(startDate, timeZone),
          });
          if (slots.length >= MAX_SLOTS_RETURNED) break;
        }
        slotStart = slotEnd;
      }
      if (slots.length >= MAX_SLOTS_RETURNED) break;
    }
    // Advance to the next day (in the connection timezone).
    const next = datePartsInZone(new Date(cursor.getTime() + 24 * 3600 * 1000), timeZone);
    cursor = wallClockToUtc(next.year, next.month, next.day, 0, 0, timeZone);
  }
  return slots;
}

// ---------------------------------------------------------------------------
// Provider HTTP helpers
// ---------------------------------------------------------------------------

async function providerFetch(url, { method = "GET", accessToken, body } = {}) {
  const headers = { authorization: `Bearer ${accessToken}` };
  let payload;
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const response = await fetch(url, {
    method,
    headers,
    body: payload,
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, text: text.slice(0, 500) };
}

function providerError(provider, action, result) {
  const detail =
    (result.json && (result.json.message || result.json.error || result.json.title)) ||
    result.text ||
    `HTTP ${result.status}`;
  const error = new Error(`${provider} ${action} failed: ${detail}`.slice(0, 300));
  error.code = "provider_error";
  error.provider = provider;
  error.providerStatus = result.status;
  error.providerDetail = detail;
  return error;
}

// ---------------------------------------------------------------------------
// Per-calendar mutex + slot holds (Google write serialization, single process)
// ---------------------------------------------------------------------------

const calendarLocks = new Map(); // lockKey -> tail promise
function withCalendarLock(lockKey, fn) {
  const tail = calendarLocks.get(lockKey) || Promise.resolve();
  const work = tail.then(fn, fn);
  calendarLocks.set(lockKey, work.catch(() => {}));
  return work;
}

const slotHolds = new Map(); // holdKey -> expiresAt
function holdKeyFor(organizationId, calendarId, startISO) {
  return `${organizationId}|${calendarId}|${startISO}`;
}
function pruneHolds() {
  const now = Date.now();
  for (const [key, expiresAt] of slotHolds) {
    if (expiresAt <= now) slotHolds.delete(key);
  }
}

// ---------------------------------------------------------------------------
// Availability cache (Phase 3)
// ---------------------------------------------------------------------------
// Short-TTL read cache so repeated check_availability calls inside one call
// don't hammer the provider API. 60 seconds: long enough to help, short
// enough that staleness barely matters — and booking never trusts it:
// bookAppointment always re-checks live (Google) or relies on the provider's
// slot-atomic booking (Calendly). Invalidated on every webhook/push event.
// NOTE: in-memory per API instance; multi-instance deployments converge
// within the TTL. Do not lengthen without a shared store.
const AVAILABILITY_CACHE_TTL_MS = 60 * 1000;
const availabilityCache = new Map(); // key -> { at, result }

function availabilityCacheKey(organizationId, provider, fromISO, toISO) {
  return `${organizationId}|${provider}|${fromISO}|${toISO}`;
}

function readAvailabilityCache(organizationId, provider, fromISO, toISO) {
  const key = availabilityCacheKey(organizationId, provider, fromISO, toISO);
  const entry = availabilityCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > AVAILABILITY_CACHE_TTL_MS) {
    availabilityCache.delete(key);
    return null;
  }
  return entry.result;
}

function writeAvailabilityCache(organizationId, provider, fromISO, toISO, result) {
  if (!result || result.success !== true) return; // never cache failures
  availabilityCache.set(availabilityCacheKey(organizationId, provider, fromISO, toISO), {
    at: Date.now(),
    result,
  });
  // Bound memory: drop the oldest entries past a sane cap.
  if (availabilityCache.size > 2000) {
    const oldest = availabilityCache.keys().next().value;
    availabilityCache.delete(oldest);
  }
}

function invalidateAvailabilityCache(organizationId) {
  const prefix = `${organizationId}|`;
  for (const key of availabilityCache.keys()) {
    if (key.startsWith(prefix)) availabilityCache.delete(key);
  }
}

/**
 * Group-aware cache invalidation: a change on one member's calendar affects
 * every linked business's availability, so clear them all. Falls back to
 * per-org when the org isn't in a group.
 */
async function invalidateGroupAvailabilityCache(supabase, organizationId) {
  try {
    const group = await getBusinessGroup(supabase, organizationId);
    if (group && group.memberOrgIds.length > 1) {
      for (const id of group.memberOrgIds) invalidateAvailabilityCache(id);
      return;
    }
  } catch (_) {
    // fall through to per-org
  }
  invalidateAvailabilityCache(organizationId);
}

// ---------------------------------------------------------------------------
// Business groups (cross-business double-booking guard)
// ---------------------------------------------------------------------------
// A person can own several Agently businesses (separate orgs, separate
// business emails/calendars). A business_groups row explicitly links the
// businesses that share one owner's time — the link is opt-in and never
// inferred, because there is no reliable automatic signal.

async function getBusinessGroup(supabase, organizationId) {
  const { data: member } = await supabase
    .from("business_group_members")
    .select("group_id")
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!member) return null;
  const { data: group } = await supabase
    .from("business_groups")
    .select("id, policy, owner_label")
    .eq("id", member.group_id)
    .maybeSingle();
  if (!group) return null;
  const { data: members } = await supabase
    .from("business_group_members")
    .select("organization_id")
    .eq("group_id", group.id);
  const memberOrgIds = (members || []).map((m) => m.organization_id);
  if (!memberOrgIds.includes(organizationId)) memberOrgIds.push(organizationId);
  return { id: group.id, policy: group.policy, owner_label: group.owner_label, memberOrgIds };
}

async function getOrganizationName(supabase, organizationId) {
  try {
    const { data } = await supabase
      .from("organizations")
      .select("name")
      .eq("id", organizationId)
      .maybeSingle();
    return (data && data.name) || "another of your businesses";
  } catch (_) {
    return "another of your businesses";
  }
}

/**
 * Busy blocks on sibling businesses' calendars. Each block carries the
 * owning org so notifications can name it. Best-effort per sibling: a
 * failing sibling check must never break this org's own availability.
 */
async function getSiblingBusyBlocks(supabase, group, organizationId, from, to) {
  const blocks = [];
  for (const siblingId of group.memberOrgIds) {
    if (siblingId === organizationId) continue;
    // Sibling Google calendar free/busy — live, catches external events.
    try {
      const conn = await getConnection(supabase, siblingId, "google");
      if (conn && conn.status === "connected") {
        const { accessToken } = await getValidAccessToken(siblingId, "google", supabase);
        const calId = conn.calendar_id || "primary";
        const fb = await providerFetch("https://www.googleapis.com/calendar/v3/freeBusy", {
          method: "POST",
          accessToken,
          body: {
            timeMin: from.toISOString(),
            timeMax: to.toISOString(),
            items: [{ id: calId }],
          },
        });
        if (fb.ok) {
          const busy = (((fb.json || {}).calendars || {})[calId] || {}).busy || [];
          for (const b of busy) {
            blocks.push({ start: b.start, end: b.end, organization_id: siblingId, source: "calendar" });
          }
        }
      }
    } catch (_) {
      // ignore — sibling checks are advisory
    }
    // Sibling Agently bookings (both providers — catches sibling Calendly
    // bookings, which expose no busy API).
    try {
      const { data: appts } = await supabase
        .from("appointments")
        .select("starts_at, ends_at, attendee_name, title")
        .eq("organization_id", siblingId)
        .eq("status", "booked")
        .lt("starts_at", to.toISOString())
        .gt("ends_at", from.toISOString());
      for (const a of appts || []) {
        blocks.push({
          start: a.starts_at,
          end: a.ends_at,
          organization_id: siblingId,
          source: "appointment",
          label: a.attendee_name || a.title || null,
        });
      }
    } catch (_) {
      // ignore — sibling checks are advisory
    }
  }
  return blocks;
}

/**
 * Remove slots where the owner is busy on a linked business's calendar.
 * Returns { slots, filtered } — never throws; failures degrade to unfiltered.
 */
async function filterSlotsForGroup(supabase, organizationId, slots, from, to) {
  if (!Array.isArray(slots) || slots.length === 0) return { slots, filtered: 0 };
  try {
    const group = await getBusinessGroup(supabase, organizationId);
    if (!group || group.memberOrgIds.length < 2) return { slots, filtered: 0 };
    const siblingBlocks = await getSiblingBusyBlocks(supabase, group, organizationId, from, to);
    if (siblingBlocks.length === 0) return { slots, filtered: 0 };
    const kept = slots.filter((s) => !findOverlappingBlock(siblingBlocks, s.start, s.end));
    return {
      slots: kept,
      filtered: slots.length - kept.length,
      siblingCount: group.memberOrgIds.length - 1,
    };
  } catch (_) {
    return { slots, filtered: 0 };
  }
}

function findOverlappingBlock(blocks, startISO, endISO) {
  const s = new Date(startISO).getTime();
  const e = new Date(endISO).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e)) return null;
  return (
    blocks.find((b) => {
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      return Number.isFinite(bs) && Number.isFinite(be) && s < be && e > bs;
    }) || null
  );
}

// ---------------------------------------------------------------------------
// Connection + provider selection
// ---------------------------------------------------------------------------

async function getActiveProvider(supabase, organizationId) {
  // Calendly first when connected (Lawal, 2026-10-05); Google as fallback.
  for (const provider of ["calendly", "google"]) {
    const row = await getConnection(supabase, organizationId, provider);
    if (row && (row.status === "connected" || row.status === "needs_reconnect")) {
      return { provider, connection: row };
    }
  }
  return null;
}

function notConnectedResult() {
  return {
    success: false,
    code: "not_connected",
    message:
      "No calendar is connected for this business yet. Offer to take the caller's details so the team can book them back.",
  };
}

function needsReconnectResult(provider, lastError) {
  return {
    success: false,
    code: "needs_reconnect",
    message:
      `The ${provider} calendar connection needs attention` +
      (lastError ? `: ${lastError}` : ".") +
      " Offer to take the caller's details so the team can follow up.",
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

async function calendlyAvailability(supabase, organizationId, connection, { from, to, timeZone }) {
  if (!connection.event_type_uri) {
    return {
      success: false,
      code: "not_configured",
      message: "Calendly is connected but no event type was chosen in Settings → Integrations.",
    };
  }
  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(organizationId, "calendly", supabase));
  } catch (error) {
    if (error.code === "needs_reconnect") return needsReconnectResult("calendly", connection.last_error);
    throw error;
  }
  const params = new URLSearchParams({
    event_type: connection.event_type_uri,
    start_time: from.toISOString(),
    end_time: to.toISOString(),
  });
  const result = await providerFetch(
    `https://api.calendly.com/event_type_available_times?${params.toString()}`,
    { accessToken },
  );
  if (!result.ok) throw providerError("calendly", "availability check", result);
  const slots = (result.json.collection || [])
    .filter((s) => s.status === "available" && s.start_time)
    .slice(0, MAX_SLOTS_RETURNED)
    .map((s) => {
      const start = new Date(s.start_time);
      return {
        start: start.toISOString(),
        end: s.end_time ? new Date(s.end_time).toISOString() : null,
        label: formatSlotLabel(start, connection.timezone || timeZone),
      };
    });
  return {
    success: true,
    provider: "calendly",
    slots,
    message:
      slots.length > 0
        ? `Found ${slots.length} open slot${slots.length === 1 ? "" : "s"}.`
        : "No open slots in that window.",
  };
}

async function googleAvailability(supabase, organizationId, connection, { from, to, timeZone }) {
  const settings = bookingSettings(connection);
  const calendarId = connection.calendar_id || "primary";
  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(organizationId, "google", supabase));
  } catch (error) {
    if (error.code === "needs_reconnect") return needsReconnectResult("google", connection.last_error);
    throw error;
  }
  const result = await providerFetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    accessToken,
    body: {
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      timeZone: connection.timezone || timeZone,
      items: [{ id: calendarId }],
    },
  });
  if (!result.ok) throw providerError("google", "availability check", result);
  const busy = (result.json.calendars && result.json.calendars[calendarId] && result.json.calendars[calendarId].busy) || [];
  const slots = computeFreeSlots({
    busy,
    from,
    to,
    timeZone: connection.timezone || timeZone,
    slotMinutes: settings.slotMinutes,
    workingHours: settings.workingHours,
  });
  return {
    success: true,
    provider: "google",
    slots,
    message:
      slots.length > 0
        ? `Found ${slots.length} open slot${slots.length === 1 ? "" : "s"}.`
        : "No open slots in that window.",
  };
}

/**
 * Check availability. from/to are Dates (UTC). Returns { success, provider,
 * slots: [{start, end, label}], message }.
 */
async function checkAvailability(organizationId, { from, to, timeZone } = {}, supabase = getSupabase()) {
  const active = await getActiveProvider(supabase, organizationId);
  if (!active) return notConnectedResult();
  const { provider, connection } = active;
  if (connection.status === "needs_reconnect") return needsReconnectResult(provider, connection.last_error);

  const tz = timeZone || connection.timezone || "America/New_York";
  const now = new Date();
  const start = from instanceof Date && !Number.isNaN(from.getTime()) ? from : now;
  const windowDays = bookingSettings(connection).windowDays;
  const end =
    to instanceof Date && !Number.isNaN(to.getTime()) && to > start
      ? to
      : new Date(start.getTime() + windowDays * 24 * 3600 * 1000);

  const cached = readAvailabilityCache(organizationId, provider, start.toISOString(), end.toISOString());
  if (cached) return cached;

  try {
    let result;
    if (provider === "calendly") {
      result = await calendlyAvailability(supabase, organizationId, connection, { from: start, to: end, timeZone: tz });
    } else {
      result = await googleAvailability(supabase, organizationId, connection, { from: start, to: end, timeZone: tz });
    }
    // Cross-business guard: filter out slots where the owner is busy on a
    // linked business's calendar. Applied before caching so cached values
    // are already group-filtered.
    if (result.success && Array.isArray(result.slots) && result.slots.length > 0) {
      const filtered = await filterSlotsForGroup(supabase, organizationId, result.slots, start, end);
      if (filtered.filtered > 0) {
        result.slots = filtered.slots;
        result.message =
          `Found ${result.slots.length} open slot${result.slots.length === 1 ? "" : "s"} ` +
          `(some held for your other ${filtered.siblingCount === 1 ? "business" : "businesses"}).`;
      }
    }
    writeAvailabilityCache(organizationId, provider, start.toISOString(), end.toISOString(), result);
    return result;
  } catch (error) {
    if (error.code === "needs_reconnect") return needsReconnectResult(provider, connection.last_error);
    return {
      success: false,
      code: error.code || "provider_error",
      message: "The calendar is temporarily unreachable. Offer to take the caller's details so the team can book them back.",
    };
  }
}

// ---------------------------------------------------------------------------
// Booking
// ---------------------------------------------------------------------------

const eventTypeCache = new Map(); // eventTypeUri -> { at, details }

async function getCalendlyEventType(accessToken, eventTypeUri) {
  const cached = eventTypeCache.get(eventTypeUri);
  if (cached && Date.now() - cached.at < 3600 * 1000) return cached.details;
  const uuid = String(eventTypeUri).split("/").pop();
  const result = await providerFetch(`https://api.calendly.com/event_types/${uuid}`, { accessToken });
  if (!result.ok) return null; // non-fatal: booking proceeds without location hints
  const details = result.json.resource || {};
  eventTypeCache.set(eventTypeUri, { at: Date.now(), details });
  return details;
}

async function calendlyBook(supabase, organizationId, connection, params) {
  const { startISO, attendeeName, attendeeEmail, attendeePhone, title } = params;
  if (!connection.event_type_uri) {
    return {
      success: false,
      code: "not_configured",
      message: "Calendly is connected but no event type was chosen in Settings → Integrations.",
    };
  }
  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(organizationId, "calendly", supabase));
  } catch (error) {
    if (error.code === "needs_reconnect") return needsReconnectResult("calendly", connection.last_error);
    throw error;
  }

  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) {
    return { success: false, code: "validation_error", message: "The chosen start time was not understood. Please pick a slot from the availability list." };
  }

  const body = {
    event_type: connection.event_type_uri,
    start_time: start.toISOString(),
    invitee: {
      name: attendeeName,
      email: attendeeEmail || undefined,
      timezone: connection.timezone || "America/New_York",
    },
  };
  // Phone-type locations: pass the caller's number when we have it.
  const eventType = await getCalendlyEventType(accessToken, connection.event_type_uri);
  const locationKind = eventType && eventType.location && eventType.location.kind;
  if (locationKind === "phone" && attendeePhone) {
    body.invitee.text_reminder_number = attendeePhone;
  }

  const result = await providerFetch("https://api.calendly.com/invitees", {
    method: "POST",
    accessToken,
    body,
  });

  if (!result.ok) {
    const detail = String(
      (result.json && (result.json.message || result.json.title)) || result.text || "",
    );
    // Slot-atomic guard: Calendly rejects a taken/invalid slot server-side.
    if (result.status === 400 || result.status === 422) {
      return {
        success: false,
        code: "slot_taken",
        message:
          "That slot was just taken or is no longer valid. Check availability again and offer the caller the next best open slot.",
        providerDetail: detail.slice(0, 200),
      };
    }
    // Paid-plan gate for the Scheduling API.
    if (result.status === 402 || result.status === 403) {
      await supabase
        .from("calendar_integrations")
        .update({
          status: "error",
          last_error:
            "Calendly API booking needs a paid Calendly plan on the connected account.",
          updated_at: new Date().toISOString(),
        })
        .eq("id", connection.id);
      return {
        success: false,
        code: "plan_required",
        message:
          "Booking needs a paid Calendly plan on the connected account. Offer to take the caller's details so the team can follow up.",
      };
    }
    throw providerError("calendly", "booking", result);
  }

  const resource = result.json.resource || {};
  const eventUri = resource.event || null;
  return {
    success: true,
    provider: "calendly",
    externalEventId: resource.uri || null,
    externalEventUri: eventUri,
    startsAt: resource.start_time || start.toISOString(),
    endsAt: resource.end_time || null,
    timezone: connection.timezone || "America/New_York",
    cancelUrl: resource.cancel_url || null,
    rescheduleUrl: resource.reschedule_url || null,
    attendeeName,
    attendeeEmail: attendeeEmail || null,
    attendeePhone: attendeePhone || null,
    title: title || connection.event_type_name || "Appointment",
  };
}

async function googleBook(supabase, organizationId, connection, params, appointmentId) {
  const { startISO, attendeeName, attendeeEmail, attendeePhone, title, notes } = params;
  const settings = bookingSettings(connection);
  const calendarId = connection.calendar_id || "primary";
  const timeZone = connection.timezone || "America/New_York";

  const start = new Date(startISO);
  if (Number.isNaN(start.getTime())) {
    return { success: false, code: "validation_error", message: "The chosen start time was not understood. Please pick a slot from the availability list." };
  }
  const end = new Date(start.getTime() + settings.slotMinutes * 60000);

  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(organizationId, "google", supabase));
  } catch (error) {
    if (error.code === "needs_reconnect") return needsReconnectResult("google", connection.last_error);
    throw error;
  }

  const lockKey = `${organizationId}|${calendarId}`;
  return withCalendarLock(lockKey, async () => {
    pruneHolds();
    const holdKey = holdKeyFor(organizationId, calendarId, start.toISOString());

    // App-level idempotency: if we already booked this exact slot for this
    // caller recently (e.g. a retried tool call after a timeout), return it
    // instead of double-booking.
    const { data: existing } = await supabase
      .from("appointments")
      .select("id, starts_at, status")
      .eq("organization_id", organizationId)
      .eq("provider", "google")
      .eq("starts_at", start.toISOString())
      .eq("attendee_email", attendeeEmail || "")
      .eq("status", "booked")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return {
        success: true,
        provider: "google",
        duplicatePrevented: true,
        appointmentId: existing.id,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timezone: timeZone,
      };
    }

    if (slotHolds.has(holdKey)) {
      return {
        success: false,
        code: "slot_taken",
        message: "That slot was just taken. Check availability again and offer the caller the next best open slot.",
      };
    }
    slotHolds.set(holdKey, Date.now() + SLOT_HOLD_TTL_MS);
    try {
      // Re-check freeBusy immediately before insert — narrows the race window.
      const fb = await providerFetch("https://www.googleapis.com/calendar/v3/freeBusy", {
        method: "POST",
        accessToken,
        body: {
          timeMin: start.toISOString(),
          timeMax: end.toISOString(),
          timeZone,
          items: [{ id: calendarId }],
        },
      });
      if (!fb.ok) throw providerError("google", "availability re-check", fb);
      const busy =
        (fb.json.calendars && fb.json.calendars[calendarId] && fb.json.calendars[calendarId].busy) || [];
      const clashes = busy.some((b) => {
        const bs = new Date(b.start).getTime();
        const be = new Date(b.end).getTime();
        return start.getTime() < be && end.getTime() > bs;
      });
      if (clashes) {
        return {
          success: false,
          code: "slot_taken",
          message: "That slot was just taken. Check availability again and offer the caller the next best open slot.",
        };
      }

      // Client-generated event id (hex only) makes a retried insert idempotent.
      const eventId = `agently${appointmentId.replace(/-/g, "").slice(0, 24)}`;
      const insert = await providerFetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        {
          method: "POST",
          accessToken,
          body: {
            id: eventId,
            summary: title || `Appointment — ${attendeeName}`,
            description: [
              notes || null,
              attendeePhone ? `Phone: ${attendeePhone}` : null,
              "Booked by the Agently voice agent.",
            ]
              .filter(Boolean)
              .join("\n"),
            start: { dateTime: start.toISOString(), timeZone },
            end: { dateTime: end.toISOString(), timeZone },
            attendees: attendeeEmail
              ? [{ email: attendeeEmail, displayName: attendeeName }]
              : [],
            sendUpdates: settings.sendUpdates,
          },
        },
      );
      if (!insert.ok) {
        // 409 = our idempotent event id already exists → treat as success.
        if (insert.status === 409) {
          return {
            success: true,
            provider: "google",
            duplicatePrevented: true,
            appointmentId,
            startsAt: start.toISOString(),
            endsAt: end.toISOString(),
            timezone: timeZone,
          };
        }
        throw providerError("google", "booking", insert);
      }
      const event = insert.json || {};
      return {
        success: true,
        provider: "google",
        externalEventId: event.id || eventId,
        externalEventUri: event.htmlLink || null,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        timezone: timeZone,
        attendeeName,
        attendeeEmail: attendeeEmail || null,
        attendeePhone: attendeePhone || null,
        title: title || `Appointment — ${attendeeName}`,
      };
    } finally {
      slotHolds.delete(holdKey);
    }
  });
}

async function insertAppointmentRow(supabase, organizationId, integrationId, params) {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .insert({
      id,
      organization_id: organizationId,
      integration_id: integrationId,
      lead_id: params.leadId || null,
      voice_agent_id: params.voiceAgentId || null,
      call_record_id: params.callRecordId || null,
      provider: params.provider,
      title: params.title || null,
      attendee_name: params.attendeeName || null,
      attendee_email: params.attendeeEmail || null,
      attendee_phone: params.attendeePhone || null,
      starts_at: params.startsAt,
      ends_at: params.endsAt,
      timezone: params.timezone || "America/New_York",
      status: "pending",
      created_at: now,
      updated_at: now,
    })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function finalizeAppointmentRow(supabase, appointmentId, booked) {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("appointments")
    .update({
      status: "booked",
      external_event_id: booked.externalEventId || null,
      external_event_uri: booked.externalEventUri || null,
      cancel_url: booked.cancelUrl || null,
      reschedule_url: booked.rescheduleUrl || null,
      raw: {
        provider: booked.provider,
        duplicatePrevented: Boolean(booked.duplicatePrevented),
      },
      updated_at: now,
    })
    .eq("id", appointmentId)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function notifyBooking(supabase, { organizationId, appointment, voiceAgentId, callRecordId, kind }) {
  try {
    const when = formatSlotLabel(new Date(appointment.starts_at), appointment.timezone || "America/New_York");
    const isCancel = kind === "cancelled";
    await supabase.from("tenant_notifications").insert({
      organization_id: organizationId,
      user_id: null,
      type: isCancel ? "appointment_cancelled" : "appointment_booked",
      title: isCancel
        ? `Booking cancelled: ${appointment.attendee_name || "appointment"}`
        : `New booking: ${appointment.attendee_name || "appointment"}`,
      body: isCancel
        ? `The ${when} booking (${appointment.provider}) was cancelled.`
        : `${appointment.attendee_name || "A caller"} booked ${when} via ${appointment.provider === "calendly" ? "Calendly" : "Google Calendar"}.`,
      entity_type: "appointment",
      entity_id: appointment.id,
      voice_agent_id: voiceAgentId || null,
      call_record_id: callRecordId || null,
      is_read: false,
      metadata: {
        provider: appointment.provider,
        starts_at: appointment.starts_at,
        attendee_email: appointment.attendee_email,
        attendee_phone: appointment.attendee_phone,
      },
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    // Notifications must never fail a booking.
    console.warn("[calendar-booking] notification insert failed:", error && error.message);
  }
}

/** Generic tenant notification. Never throws — callers must not fail on it. */
async function notifyTenant(supabase, { organizationId, type, title, body, appointmentId, metadata }) {
  try {
    await supabase.from("tenant_notifications").insert({
      organization_id: organizationId,
      user_id: null,
      type,
      title,
      body,
      entity_type: "appointment",
      entity_id: appointmentId || null,
      voice_agent_id: null,
      call_record_id: null,
      is_read: false,
      metadata: metadata || {},
      created_at: new Date().toISOString(),
    });
  } catch (error) {
    console.warn("[calendar-booking] tenant notification failed:", error && error.message);
  }
}

async function markLeadAppointmentSet(supabase, leadId) {
  if (!leadId) return;
  try {
    await supabase
      .from("leads")
      .update({ crm_stage: "appointment_set", status: "contacted", updated_at: new Date().toISOString() })
      .eq("id", leadId);
  } catch (error) {
    console.warn("[calendar-booking] lead stage update failed:", error && error.message);
  }
}

/**
 * Book an appointment. Creates the row first (status pending) so the row id
 * doubles as the idempotency key, then books at the provider.
 */
async function bookAppointment(
  organizationId,
  {
    startISO,
    attendeeName,
    attendeeEmail,
    attendeePhone,
    title,
    notes,
    leadId,
    callRecordId,
    voiceAgentId,
  } = {},
  supabase = getSupabase(),
) {
  if (!attendeeName || !String(attendeeName).trim()) {
    return { success: false, code: "validation_error", message: "I need the caller's name before I can book." };
  }
  const active = await getActiveProvider(supabase, organizationId);
  if (!active) return notConnectedResult();
  const { provider, connection } = active;
  if (connection.status === "needs_reconnect") return needsReconnectResult(provider, connection.last_error);

  const start = new Date(startISO);
  if (Number.isNaN(start.getTime()) || start.getTime() < Date.now() - 60000) {
    return {
      success: false,
      code: "validation_error",
      message: "That time doesn't look valid — please pick a slot from the availability list.",
    };
  }

  const settings = bookingSettings(connection);
  const endISO =
    provider === "google"
      ? new Date(start.getTime() + settings.slotMinutes * 60000).toISOString()
      : null; // Calendly returns the real end time

  let row;
  try {
    row = await insertAppointmentRow(supabase, organizationId, connection.id, {
      provider,
      title: title || null,
      attendeeName: String(attendeeName).trim(),
      attendeeEmail: attendeeEmail ? String(attendeeEmail).trim() : null,
      attendeePhone: attendeePhone ? String(attendeePhone).trim() : null,
      startsAt: start.toISOString(),
      endsAt: endISO || start.toISOString(),
      timezone: connection.timezone || "America/New_York",
    });
  } catch (error) {
    return { success: false, code: "provider_error", message: "I couldn't start the booking. Please try again." };
  }

  const params = {
    startISO: start.toISOString(),
    attendeeName: String(attendeeName).trim(),
    attendeeEmail: attendeeEmail ? String(attendeeEmail).trim() : null,
    attendeePhone: attendeePhone ? String(attendeePhone).trim() : null,
    title: title || null,
    notes: notes || null,
  };

  // Cross-business guard: final check against linked businesses' calendars
  // before the provider call. Races that slip past the availability filter
  // land here.
  let crossBusinessConflict = null;
  try {
    const group = await getBusinessGroup(supabase, organizationId);
    if (group && group.memberOrgIds.length > 1) {
      const checkEnd = endISO ? new Date(endISO) : new Date(start.getTime() + 30 * 60000);
      const blocks = await getSiblingBusyBlocks(supabase, group, organizationId, start, checkEnd);
      const hit = findOverlappingBlock(blocks, start.toISOString(), checkEnd.toISOString());
      if (hit) {
        const siblingName = await getOrganizationName(supabase, hit.organization_id);
        crossBusinessConflict = {
          group_id: group.id,
          policy: group.policy,
          sibling_organization_id: hit.organization_id,
          sibling_name: siblingName,
          sibling_source: hit.source,
          sibling_label: hit.label || null,
          sibling_start: hit.start,
          sibling_end: hit.end,
        };
        if (group.policy === "block") {
          await supabase.from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", row.id);
          await invalidateGroupAvailabilityCache(supabase, organizationId);
          return {
            success: false,
            code: "slot_taken",
            message:
              "That slot just became unavailable. Check availability again and offer the caller the next best open slot.",
          };
        }
        // flag_for_review: book it, then flag (handled after success below).
      }
    }
  } catch (_) {
    crossBusinessConflict = null; // advisory — never block a booking on group lookup failure
  }

  let booked;
  try {
    booked =
      provider === "calendly"
        ? await calendlyBook(supabase, organizationId, connection, params)
        : await googleBook(supabase, organizationId, connection, params, row.id);
  } catch (error) {
    await supabase.from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", row.id);
    if (error.code === "needs_reconnect") return needsReconnectResult(provider, connection.last_error);
    return {
      success: false,
      code: error.code || "provider_error",
      message: "The booking didn't go through just now. Tell the caller you'll confirm by text shortly, then book it after the call.",
    };
  }

  if (!booked.success) {
    await supabase.from("appointments").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", row.id);
    return booked; // slot_taken / plan_required / validation carry agent instructions
  }

  const final = await finalizeAppointmentRow(supabase, row.id, {
    ...booked,
    provider,
  });
  // Calendly end time arrives with the booking; Google end was computed.
  if (booked.endsAt && booked.endsAt !== final.ends_at) {
    await supabase.from("appointments").update({ ends_at: booked.endsAt }).eq("id", row.id);
    final.ends_at = booked.endsAt;
  }

  // Flag-for-review: the booking went through despite the clash — stamp the
  // flag on the row and notify the tenant so they can take action. The
  // caller was already confirmed normally; the clash is the owner's problem.
  if (crossBusinessConflict && crossBusinessConflict.policy !== "block") {
    const flaggedRaw = { ...(final.raw || {}), cross_business_conflict: crossBusinessConflict };
    await supabase
      .from("appointments")
      .update({ raw: flaggedRaw, updated_at: new Date().toISOString() })
      .eq("id", row.id);
    final.raw = flaggedRaw;
    const tz = final.timezone || "America/New_York";
    const when = formatSlotLabel(new Date(final.starts_at), tz);
    const siblingWhen = formatSlotLabel(new Date(crossBusinessConflict.sibling_start), tz);
    const clashDetail = crossBusinessConflict.sibling_label
      ? `"${crossBusinessConflict.sibling_label}" (${siblingWhen})`
      : `a busy block (${siblingWhen})`;
    await notifyTenant(supabase, {
      organizationId,
      type: "appointment_conflict",
      title: `Booking clash: ${final.attendee_name || "appointment"} — ${when}`,
      body:
        `Heads up: the agent just booked ${final.attendee_name || "a caller"} for ${when} ` +
        `via ${provider === "calendly" ? "Calendly" : "Google Calendar"}, but ` +
        `${crossBusinessConflict.sibling_name} already has ${clashDetail}. ` +
        `Please take action — reschedule or cancel one of them.`,
      appointmentId: final.id,
      metadata: {
        provider,
        origin: "cross_business",
        group_id: crossBusinessConflict.group_id,
        sibling_organization_id: crossBusinessConflict.sibling_organization_id,
        starts_at: final.starts_at,
      },
    });
  }

  await notifyBooking(supabase, {
    organizationId,
    appointment: final,
    voiceAgentId,
    callRecordId,
    kind: "booked",
  });
  await markLeadAppointmentSet(supabase, leadId);

  const when = formatSlotLabel(new Date(final.starts_at), final.timezone || "America/New_York");
  return {
    success: true,
    appointmentId: final.id,
    provider,
    startsAt: final.starts_at,
    endsAt: final.ends_at,
    timezone: final.timezone,
    attendeeName: final.attendee_name,
    cancelUrl: final.cancel_url,
    rescheduleUrl: final.reschedule_url,
    message: `Booked for ${when}. Confirmation reference ${final.id.slice(0, 8)}.`,
  };
}

/**
 * Cancel an appointment by its Agently appointment id.
 */
async function cancelAppointment(organizationId, appointmentId, supabase = getSupabase()) {
  if (!appointmentId) {
    return { success: false, code: "validation_error", message: "No appointment id was provided." };
  }
  const { data: row, error } = await supabase
    .from("appointments")
    .select("*")
    .eq("id", appointmentId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    return { success: false, code: "validation_error", message: "I couldn't find that booking." };
  }
  if (row.status === "cancelled") {
    return { success: true, appointmentId: row.id, message: "That booking was already cancelled." };
  }

  const active = await getActiveProvider(supabase, organizationId);
  if (!active) return notConnectedResult();
  const { provider, connection } = active;
  let accessToken;
  try {
    ({ accessToken } = await getValidAccessToken(organizationId, provider, supabase));
  } catch (err) {
    if (err.code === "needs_reconnect") return needsReconnectResult(provider, connection.last_error);
    throw err;
  }

  try {
    if (provider === "calendly" && row.external_event_uri) {
      const uuid = String(row.external_event_uri).split("/").pop();
      const result = await providerFetch(
        `https://api.calendly.com/scheduled_events/${uuid}/cancellation`,
        { method: "POST", accessToken, body: {} },
      );
      if (!result.ok && result.status !== 404) throw providerError("calendly", "cancellation", result);
    } else if (provider === "google" && row.external_event_id) {
      const calendarId = connection.calendar_id || "primary";
      const result = await providerFetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(row.external_event_id)}?sendUpdates=all`,
        { method: "DELETE", accessToken },
      );
      if (!result.ok && result.status !== 404 && result.status !== 410) {
        throw providerError("google", "cancellation", result);
      }
    }
  } catch (err) {
    return {
      success: false,
      code: err.code || "provider_error",
      message: "I couldn't cancel that booking just now. Please try again.",
    };
  }

  const { data: updated } = await supabase
    .from("appointments")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", row.id)
    .select("*")
    .single();
  await notifyBooking(supabase, {
    organizationId,
    appointment: updated || row,
    voiceAgentId: row.voice_agent_id,
    callRecordId: row.call_record_id,
    kind: "cancelled",
  });
  return {
    success: true,
    appointmentId: row.id,
    message: "The booking has been cancelled.",
  };
}

module.exports = {
  checkAvailability,
  bookAppointment,
  cancelAppointment,
  getActiveProvider,
  invalidateAvailabilityCache,
  invalidateGroupAvailabilityCache,
  getBusinessGroup,
  // Exported for unit tests.
  _internals: {
    computeFreeSlots,
    wallClockToUtc,
    tzOffsetMinutes,
    formatSlotLabel,
    bookingSettings,
    holdKeyFor,
    readAvailabilityCache,
    writeAvailabilityCache,
    findOverlappingBlock,
    filterSlotsForGroup,
    AVAILABILITY_CACHE_TTL_MS,
  },
};
