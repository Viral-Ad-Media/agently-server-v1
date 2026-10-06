"use strict";

/**
 * Calendar booking tool definitions for the realtime voice agents.
 *
 * CANONICAL COPY for agently-server-v1 (the webcall bridge in
 * lib/openai-realtime-bridge.js imports this). The ws-server keeps its own
 * copy in lib/calendar-tools.js because it is a separate deployment; keep the
 * two in sync — same names, same required fields — since both drive the same
 * booking service (lib/calendar-booking.js, exposed to ws-server over
 * /api/internal/calendar/*).
 */

function checkAvailabilityToolDefinition() {
  return {
    type: "function",
    name: "check_calendar_availability",
    description:
      "Check which appointment slots are currently open on the business's connected calendar (Calendly or Google Calendar). Call this when the caller asks to book, reschedule, or asks 'when are you free'. Silent to the caller; never mention using it.",
    parameters: {
      type: "object",
      properties: {
        from_date: {
          type: "string",
          description:
            "Start date to search from, YYYY-MM-DD. Defaults to today. Use the caller's words ('tomorrow', 'next week') converted to a date.",
        },
        days: {
          type: "integer",
          description: "How many days ahead to look (1-14). Default 7.",
        },
      },
      additionalProperties: false,
    },
  };
}

function bookAppointmentToolDefinition() {
  return {
    type: "function",
    name: "book_appointment",
    description:
      "Book the appointment into the business's connected calendar. Only call after the caller has chosen a specific slot from check_calendar_availability and given their name. The booking is immediate and real.",
    parameters: {
      type: "object",
      properties: {
        start_time: {
          type: "string",
          description:
            "The slot's exact start time, copied verbatim from check_calendar_availability (ISO format). Never invent or round a time.",
        },
        attendee_name: {
          type: "string",
          description: "The caller's full name. Required.",
        },
        attendee_email: {
          type: "string",
          description: "The caller's email, if they gave one. Used for the calendar invite.",
        },
        attendee_phone: {
          type: "string",
          description: "The caller's phone number, if known.",
        },
        notes: {
          type: "string",
          description: "Anything the caller asked to add to the booking (reason for visit, etc.).",
        },
      },
      required: ["start_time", "attendee_name"],
      additionalProperties: false,
    },
  };
}

function cancelAppointmentToolDefinition() {
  return {
    type: "function",
    name: "cancel_appointment",
    description:
      "Cancel a booking the agent made earlier in this call. Only use the appointment id returned by book_appointment.",
    parameters: {
      type: "object",
      properties: {
        appointment_id: {
          type: "string",
          description: "The appointment id returned by book_appointment.",
        },
      },
      required: ["appointment_id"],
      additionalProperties: false,
    },
  };
}

function calendarToolDefinitions() {
  return [
    checkAvailabilityToolDefinition(),
    bookAppointmentToolDefinition(),
    cancelAppointmentToolDefinition(),
  ];
}

const CALENDAR_TOOL_NAMES = new Set([
  "check_calendar_availability",
  "book_appointment",
  "cancel_appointment",
]);

function isCalendarTool(name) {
  return CALENDAR_TOOL_NAMES.has(String(name));
}

module.exports = {
  calendarToolDefinitions,
  isCalendarTool,
  CALENDAR_TOOL_NAMES,
};
