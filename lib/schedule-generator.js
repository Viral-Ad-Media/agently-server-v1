"use strict";

const {
  DEFAULT_TIMEZONE,
  localDateTimeToUtc,
  normalizeArray,
} = require("./outreach-utils");

const DAY_ALIASES = {
  sun: "sun",
  sunday: "sun",
  mon: "mon",
  monday: "mon",
  tue: "tue",
  tues: "tue",
  tuesday: "tue",
  wed: "wed",
  wednesday: "wed",
  thu: "thu",
  thur: "thu",
  thurs: "thu",
  thursday: "thu",
  fri: "fri",
  friday: "fri",
  sat: "sat",
  saturday: "sat",
};
const DAY_ORDER = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DEFAULT_MAX_RUNS = 1000;
const DEFAULT_MAX_MONTHS_AHEAD = 12;
const DEFAULT_MIN_LEAD_SECONDS = 60;
const VALID_BATCH_MODES = new Set([
  "spread_recipients_across_times",
  "all_recipients_each_time",
]);

class ScheduleValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ScheduleValidationError";
    this.code = code;
    this.details = details;
  }
}

function intEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = parseInt(String(process.env[name] || ""), 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(max, Math.max(min, value));
}

function validateTimezone(timezone) {
  const tz = String(timezone || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(new Date());
    return tz;
  } catch (_) {
    throw new ScheduleValidationError(
      "INVALID_TIMEZONE",
      "timezone must be a valid IANA timezone name.",
      { timezone: tz },
    );
  }
}

function normalizeDate(value, field = "date") {
  const date = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new ScheduleValidationError(
      "INVALID_DATE",
      `${field} must be in YYYY-MM-DD format.`,
      { field, value },
    );
  }
  const [year, month, day] = date.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month - 1 ||
    d.getUTCDate() !== day
  ) {
    throw new ScheduleValidationError("INVALID_DATE", `${field} is not a valid calendar date.`, {
      field,
      value,
    });
  }
  return date;
}

function normalizeTime(value, field = "time") {
  const raw = String(value || "").trim();
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    throw new ScheduleValidationError(
      "INVALID_TIME",
      `${field} must be a valid HH:mm time, for example 10:40 or 09:00.`,
      { field, value },
    );
  }
  return `${String(Number(match[1])).padStart(2, "0")}:${match[2]}`;
}

function normalizeTimeArray(value, field = "times") {
  const raw = normalizeArray(value);
  if (!raw.length) {
    throw new ScheduleValidationError("INVALID_TIME", `${field} must include at least one time.`);
  }
  const times = raw.map((item, index) => normalizeTime(item, `${field}[${index}]`));
  return [...new Set(times)].sort();
}

function normalizeScheduleType(value) {
  const type = String(value || "one_time").trim().toLowerCase();
  if (type === "monthly_sequence") return "recurring_monthly";
  if (type === "custom_windows") return "custom_rule";
  return type;
}

function normalizeBatchMode(value) {
  const mode = String(value || "spread_recipients_across_times").trim().toLowerCase();
  return VALID_BATCH_MODES.has(mode) ? mode : "spread_recipients_across_times";
}

function normalizeDay(value, field = "day") {
  const key = String(value || "").trim().toLowerCase();
  const day = DAY_ALIASES[key];
  if (!day) {
    throw new ScheduleValidationError("INVALID_DAY_OF_WEEK", `${field} must be a valid day of week.`, {
      field,
      value,
    });
  }
  return day;
}

function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  const d = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0));
  return d.toISOString().slice(0, 10);
}

function compareDates(a, b) {
  return String(a).localeCompare(String(b));
}

function daysBetweenInclusive(startDate, endDate) {
  const [sy, sm, sd] = startDate.split("-").map(Number);
  const [ey, em, ed] = endDate.split("-").map(Number);
  const start = Date.UTC(sy, sm - 1, sd, 12, 0, 0);
  const end = Date.UTC(ey, em - 1, ed, 12, 0, 0);
  return Math.floor((end - start) / 86400000) + 1;
}

function weekdayForDate(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return DAY_ORDER[new Date(Date.UTC(year, month - 1, day, 12, 0, 0)).getUTCDay()];
}

function lastDayOfMonth(year, monthOneBased) {
  return new Date(Date.UTC(year, monthOneBased, 0, 12, 0, 0)).getUTCDate();
}

function addMonthsClamped(dateString, monthsToAdd, monthEndBehavior = "last_day") {
  const [year, month, day] = dateString.split("-").map(Number);
  const zeroMonth = month - 1 + monthsToAdd;
  const targetYear = year + Math.floor(zeroMonth / 12);
  const targetMonthZero = ((zeroMonth % 12) + 12) % 12;
  const targetMonth = targetMonthZero + 1;
  const lastDay = lastDayOfMonth(targetYear, targetMonth);
  if (day > lastDay && monthEndBehavior === "same_day_or_skip") return null;
  const targetDay = Math.min(day, lastDay);
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(targetDay).padStart(2, "0")}`;
}

function localDateTimeFromUtc(iso, timezone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(iso)).map((part) => [part.type, part.value]),
  );
  const hour = String(parts.hour === "24" ? "00" : parts.hour).padStart(2, "0");
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    localTime: `${hour}:${parts.minute}`,
  };
}

function scheduledUtcIso(localDate, localTime, timezone) {
  return localDateTimeToUtc({ date: localDate, time: localTime, timezone }).toISOString();
}

function assertFuture(iso, nowMs, minLeadSeconds, code = "SCHEDULE_TIME_IN_PAST") {
  const earliest = nowMs + minLeadSeconds * 1000;
  if (new Date(iso).getTime() < earliest) {
    throw new ScheduleValidationError(
      code,
      "Schedule time is already in the past. Please choose a future time.",
      {
        scheduledForUtc: iso,
        earliestAllowedUtc: new Date(earliest).toISOString(),
        minimumLeadSeconds: minLeadSeconds,
      },
    );
  }
}

function normalizeRecipients(recipients = []) {
  const normalized = normalizeArray(recipients)
    .filter((recipient) => recipient && typeof recipient === "object")
    .map((recipient, index) => ({
      ...recipient,
      occurrenceRecipientIndex: index,
    }));
  if (!normalized.length) {
    throw new ScheduleValidationError(
      "RECIPIENTS_REQUIRED",
      "Provide at least one leadId or one direct recipient phone number.",
    );
  }
  return normalized;
}

function pushOccurrence(list, { recipient, localDate, localTime, timezone, occurrenceIndex }) {
  list.push({
    recipient,
    localDate,
    localTime,
    timezone,
    scheduledForUtc: scheduledUtcIso(localDate, localTime, timezone),
    occurrenceIndex,
  });
}

function buildSlotOccurrences({ slots, recipients, batchMode, timezone }) {
  const occurrences = [];
  let index = 0;
  if (batchMode === "all_recipients_each_time") {
    for (const slot of slots) {
      for (const recipient of recipients) {
        index += 1;
        pushOccurrence(occurrences, {
          recipient,
          localDate: slot.localDate,
          localTime: slot.localTime,
          timezone,
          occurrenceIndex: index,
        });
      }
    }
    return occurrences;
  }

  for (let i = 0; i < recipients.length; i += 1) {
    const slot = slots[i % slots.length];
    index += 1;
    pushOccurrence(occurrences, {
      recipient: recipients[i],
      localDate: slot.localDate,
      localTime: slot.localTime,
      timezone,
      occurrenceIndex: index,
    });
  }
  return occurrences;
}

function summarizePreview(occurrences, limit = 20) {
  const grouped = new Map();
  for (const occurrence of occurrences) {
    const key = `${occurrence.localDate}|${occurrence.localTime}|${occurrence.scheduledForUtc}`;
    const current = grouped.get(key) || {
      localDate: occurrence.localDate,
      localTime: occurrence.localTime,
      scheduledForUtc: occurrence.scheduledForUtc,
      recipientCount: 0,
    };
    current.recipientCount += 1;
    grouped.set(key, current);
  }
  return [...grouped.values()]
    .sort((a, b) => String(a.scheduledForUtc).localeCompare(String(b.scheduledForUtc)))
    .slice(0, limit);
}

function generateScheduleOccurrences(input = {}) {
  const scheduleType = normalizeScheduleType(input.scheduleType || input.schedule_type);
  const timezone = validateTimezone(input.timezone || DEFAULT_TIMEZONE);
  const recipients = normalizeRecipients(input.recipients || []);
  const now = input.now instanceof Date ? input.now : new Date(input.now || Date.now());
  const nowMs = now.getTime();
  const minLeadSeconds = Number.isFinite(Number(input.minLeadSeconds))
    ? Number(input.minLeadSeconds)
    : intEnv("SCHEDULE_MIN_LEAD_SECONDS", DEFAULT_MIN_LEAD_SECONDS, { min: 0 });
  const maxRuns = Number.isFinite(Number(input.maxGeneratedRuns))
    ? Number(input.maxGeneratedRuns)
    : intEnv("MAX_GENERATED_RUNS_PER_SCHEDULE", DEFAULT_MAX_RUNS, { min: 1 });
  const maxMonthsAhead = intEnv("MAX_SCHEDULE_MONTHS_AHEAD", DEFAULT_MAX_MONTHS_AHEAD, {
    min: 1,
    max: 60,
  });
  const warnings = [];
  let occurrences = [];

  if (scheduleType === "one_time") {
    if (Array.isArray(input.startTime || input.start_time)) {
      throw new ScheduleValidationError(
        "INVALID_ONE_TIME_START_TIME",
        "For one_time schedules, startTime must be a single HH:mm string. Use one_time_batch for multiple times.",
      );
    }
    let localDate = input.startLocalDate || input.start_local_date || input.localDate || input.date;
    let localTime = input.startTime || input.start_time || input.localTime || input.time;
    let iso = null;
    if (!localDate && !localTime && (input.startAt || input.start_at)) {
      iso = new Date(input.startAt || input.start_at).toISOString();
      const local = localDateTimeFromUtc(iso, timezone);
      localDate = local.localDate;
      localTime = local.localTime;
    } else {
      localDate = normalizeDate(localDate, "startLocalDate");
      localTime = normalizeTime(localTime, "startTime");
      iso = scheduledUtcIso(localDate, localTime, timezone);
    }
    localDate = normalizeDate(localDate, "startLocalDate");
    localTime = normalizeTime(localTime, "startTime");
    assertFuture(iso, nowMs, minLeadSeconds);
    occurrences = recipients.map((recipient, index) => ({
      recipient,
      localDate,
      localTime,
      timezone,
      scheduledForUtc: iso,
      occurrenceIndex: index + 1,
    }));
  } else if (scheduleType === "one_time_batch") {
    const localDate = normalizeDate(input.startLocalDate || input.start_local_date || input.localDate || input.date, "startLocalDate");
    const startTimes = normalizeTimeArray(input.startTimes || input.start_times || input.startTime || input.start_time, "startTimes");
    const batchMode = normalizeBatchMode(input.batchMode || input.batch_mode);
    const slots = startTimes.map((localTime) => ({ localDate, localTime }));
    for (const slot of slots) {
      assertFuture(scheduledUtcIso(slot.localDate, slot.localTime, timezone), nowMs, minLeadSeconds);
    }
    occurrences = buildSlotOccurrences({ slots, recipients, batchMode, timezone });
  } else if (scheduleType === "recurring_monthly") {
    const repeat = input.repeat && typeof input.repeat === "object" ? input.repeat : {};
    const frequency = String(repeat.frequency || "monthly").toLowerCase();
    const interval = Math.max(1, parseInt(String(repeat.interval || 1), 10));
    const count = parseInt(String(repeat.count || ""), 10);
    if (frequency !== "monthly") {
      throw new ScheduleValidationError("INVALID_REPEAT", "recurring_monthly requires repeat.frequency = monthly.");
    }
    if (!Number.isFinite(count) || count < 1 || count > 12) {
      throw new ScheduleValidationError("INVALID_REPEAT_COUNT", "repeat.count is required and must be between 1 and 12.");
    }
    if (interval > maxMonthsAhead) {
      throw new ScheduleValidationError("INVALID_REPEAT_INTERVAL", `repeat.interval cannot exceed ${maxMonthsAhead} months.`);
    }
    const startDate = normalizeDate(input.startLocalDate || input.start_local_date, "startLocalDate");
    const startTime = normalizeTime(input.startTime || input.start_time, "startTime");
    const monthEndBehavior = String(input.monthEndBehavior || input.month_end_behavior || "last_day").toLowerCase();
    const slots = [];
    for (let i = 0; i < count; i += 1) {
      const localDate = addMonthsClamped(startDate, i * interval, monthEndBehavior);
      if (!localDate) continue;
      const iso = scheduledUtcIso(localDate, startTime, timezone);
      if (i === 0) assertFuture(iso, nowMs, minLeadSeconds);
      slots.push({ localDate, localTime: startTime });
    }
    occurrences = buildSlotOccurrences({
      slots,
      recipients,
      batchMode: "all_recipients_each_time",
      timezone,
    });
  } else if (scheduleType === "custom_rule") {
    const config = input.scheduleConfig || input.schedule_config || {};
    const dateRange = config.dateRange || config.date_range || {};
    const startDate = normalizeDate(dateRange.startDate || dateRange.start_date || input.startLocalDate || input.start_local_date, "dateRange.startDate");
    const endDate = normalizeDate(dateRange.endDate || dateRange.end_date || input.endLocalDate || input.end_local_date, "dateRange.endDate");
    if (compareDates(endDate, startDate) < 0) {
      throw new ScheduleValidationError("INVALID_DATE_RANGE", "dateRange.endDate must be on or after dateRange.startDate.");
    }
    const totalDays = daysBetweenInclusive(startDate, endDate);
    if (totalDays > maxMonthsAhead * 31) {
      throw new ScheduleValidationError("DATE_RANGE_TOO_LONG", `date range cannot exceed ${maxMonthsAhead} months.`);
    }
    const weeklyRules = normalizeArray(config.weeklyRules || config.weekly_rules);
    if (!weeklyRules.length) {
      throw new ScheduleValidationError("INVALID_WEEKLY_RULES", "custom_rule requires at least one weeklyRules entry.");
    }
    const normalizedRules = weeklyRules.map((rule, ruleIndex) => {
      const days = [...new Set(normalizeArray(rule.daysOfWeek || rule.days_of_week).map((day, dayIndex) => normalizeDay(day, `weeklyRules[${ruleIndex}].daysOfWeek[${dayIndex}]`)))];
      const times = normalizeTimeArray(rule.times || rule.time, `weeklyRules[${ruleIndex}].times`);
      if (!days.length) {
        throw new ScheduleValidationError("INVALID_WEEKLY_RULES", `weeklyRules[${ruleIndex}] must include at least one day.`);
      }
      return { days, times };
    });
    const slots = [];
    for (let offset = 0; offset < totalDays; offset += 1) {
      const localDate = addDays(startDate, offset);
      const weekday = weekdayForDate(localDate);
      for (const rule of normalizedRules) {
        if (!rule.days.includes(weekday)) continue;
        for (const localTime of rule.times) {
          const iso = scheduledUtcIso(localDate, localTime, timezone);
          if (new Date(iso).getTime() >= nowMs + minLeadSeconds * 1000) {
            slots.push({ localDate, localTime });
          }
        }
      }
    }
    if (!slots.length) {
      throw new ScheduleValidationError("SCHEDULE_TIME_IN_PAST", "No future call times were generated for this schedule.");
    }
    slots.sort((a, b) => {
      const aIso = scheduledUtcIso(a.localDate, a.localTime, timezone);
      const bIso = scheduledUtcIso(b.localDate, b.localTime, timezone);
      return String(aIso).localeCompare(String(bIso));
    });
    const batchMode = normalizeBatchMode(config.batchMode || input.batchMode || input.batch_mode);
    if (batchMode === "all_recipients_each_time") {
      occurrences = buildSlotOccurrences({ slots, recipients, batchMode, timezone });
    } else {
      occurrences = slots.map((slot, index) => ({
        recipient: recipients[index % recipients.length],
        localDate: slot.localDate,
        localTime: slot.localTime,
        timezone,
        scheduledForUtc: scheduledUtcIso(slot.localDate, slot.localTime, timezone),
        occurrenceIndex: index + 1,
      }));
    }
  } else {
    throw new ScheduleValidationError("INVALID_SCHEDULE_TYPE", "Unsupported scheduleType.", {
      scheduleType,
    });
  }

  occurrences.sort((a, b) => String(a.scheduledForUtc).localeCompare(String(b.scheduledForUtc)));
  if (occurrences.length > maxRuns) {
    throw new ScheduleValidationError(
      "SCHEDULE_TOO_LARGE",
      `This schedule would create ${occurrences.length} call attempts. The maximum is ${maxRuns}.`,
      { totalRuns: occurrences.length, maxGeneratedRuns: maxRuns },
    );
  }
  if (occurrences.length > Math.max(100, Math.floor(maxRuns * 0.75))) {
    warnings.push({
      code: "SCHEDULE_LARGE_BATCH",
      message: `This schedule will create ${occurrences.length} call attempts. Calls will be processed according to your plan limits.`,
    });
  }

  return {
    scheduleType,
    timezone,
    recipientCount: recipients.length,
    totalRuns: occurrences.length,
    occurrences,
    preview: summarizePreview(occurrences, 20),
    warnings,
    firstRunAt: occurrences[0]?.scheduledForUtc || null,
    lastRunAt: occurrences[occurrences.length - 1]?.scheduledForUtc || null,
  };
}

module.exports = {
  ScheduleValidationError,
  generateScheduleOccurrences,
  summarizePreview,
  normalizeTime,
  normalizeBatchMode,
};
