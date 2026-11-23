"use strict";

/**
 * Owner-mode tools for the web call ("talk to your agent as its boss").
 *
 * Called ONLY by the ws-server, ONLY from a web-call session it verified as
 * the owner (signed token userId + user row). The phone path never advertises
 * these tools. Shared-secret auth, like /api/internal/calendar.
 *
 *   POST /knowledge       what the agent knows: KB, sources, files, FAQs
 *   POST /leads           find leads by tag / name
 *   POST /email/prepare   AI-draft one personal email per recipient (no send)
 *   POST /email/send      send drafts that /prepare produced
 *   POST /reschedule      move an appointment: book the new slot, cancel the old
 *
 * Every read is scoped to organizationId. /email/send re-checks each address
 * against the lead or appointment it claims to belong to, so neither the model
 * nor a tampered request can redirect an email to an arbitrary address.
 */

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { requireInternalSecret } = require("../../middleware/internal-secret");
const { bookAppointment, cancelAppointment } = require("../../lib/calendar-booking");
const gmail = require("../../lib/gmail-send");

const { getOperatorScope, ownsLead, requireCalendar, requireSender } = require("../../lib/operator-scope");
const router = express.Router();
router.use(requireInternalSecret);
router.use(asyncHandler(async (req, res, next) => {
  req.operatorScope = await getOperatorScope(getSupabase(), req.body.organizationId, req.body.voiceAgentId);
  next();
}));

const MAX_BATCH = 25;

function requireOrg(req, res) {
  const organizationId = req.body && req.body.organizationId;
  if (!organizationId) {
    res.status(400).json({ error: { code: "missing_organization", message: "organizationId is required." } });
    return null;
  }
  return String(organizationId);
}

function tagsOf(lead) {
  const raw = lead && lead.tags;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  return list.map((t) => String(t).trim()).filter(Boolean);
}

function formatWhen(iso, timeZone) {
  try {
    return new Date(iso).toLocaleString("en-US", {
      timeZone: timeZone || "UTC",
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  } catch (_) {
    return String(iso);
  }
}

// --- knowledge ---------------------------------------------------------------

router.post(
  "/knowledge",
  asyncHandler(async (req, res) => {
    const organizationId = requireOrg(req, res);
    if (!organizationId) return;
    const db = getSupabase();
    const { data: agent } = await db
      .from("voice_agents")
      .select("id, name, knowledge_base_id")
      .eq("organization_id", organizationId)
      .eq("id", String(req.body.voiceAgentId || ""))
      .maybeSingle();
    const kbId = agent && agent.knowledge_base_id;
    if (!kbId) {
      return res.json({ success: true, knowledgeBase: null, message: "No knowledge base is assigned to this agent yet." });
    }
    const [kb, sources, files, faqs] = await Promise.all([
      db.from("knowledge_bases").select("name, business_name, primary_url, last_synced_at").eq("organization_id", organizationId).eq("id", kbId).maybeSingle(),
      db.from("knowledge_sources").select("title, url, source_type, page_count, product_count, scrape_status").eq("organization_id", organizationId).eq("knowledge_base_id", kbId),
      db.from("knowledge_source_files").select("filename, file_type, status").eq("organization_id", organizationId).eq("knowledge_base_id", kbId),
      db.from("faqs").select("id").eq("organization_id", organizationId).eq("knowledge_base_id", kbId),
    ]);
    const fileRows = (files.data || []).filter((f) => f.status !== "deleted");
    const sourceRows = (sources.data || []).filter((s) => s.source_type !== "file");
    res.json({
      success: true,
      knowledgeBase: kb.data ? { name: kb.data.name || kb.data.business_name, website: kb.data.primary_url, lastSynced: kb.data.last_synced_at } : null,
      websites: sourceRows.slice(0, 20).map((s) => ({ title: s.title, url: s.url, pages: s.page_count || 0, products: s.product_count || 0 })),
      uploadedFiles: fileRows.slice(0, 30).map((f) => ({ name: f.filename, type: f.file_type, status: f.status })),
      counts: {
        websites: sourceRows.length,
        uploadedFiles: fileRows.length,
        faqs: (faqs.data || []).length,
        products: sourceRows.reduce((n, s) => n + (s.product_count || 0), 0),
      },
    });
  }),
);

// --- leads -------------------------------------------------------------------

async function loadLeads(db, organizationId, scope) {
  const { data, error } = await db
    .from("leads")
    .select("id, name, email, phone, tags, status, crm_stage, lead_temperature, ai_summary, reason, last_contacted_at, voice_agent_id")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (error) throw error;
  return (data || []).filter((lead) => ownsLead(scope, lead));
}

function matchLeads(leads, { tag, search }) {
  const wantTag = String(tag || "").trim().toLowerCase();
  const wantText = String(search || "").trim().toLowerCase();
  return leads.filter((lead) => {
    if (wantTag && !tagsOf(lead).some((t) => t.toLowerCase() === wantTag)) return false;
    if (wantText && ![lead.name, lead.email, lead.phone].some((v) => String(v || "").toLowerCase().includes(wantText))) return false;
    return true;
  });
}

router.post(
  "/leads",
  asyncHandler(async (req, res) => {
    const organizationId = requireOrg(req, res);
    if (!organizationId) return;
    const leads = await loadLeads(getSupabase(), organizationId, req.operatorScope);
    const matched = matchLeads(leads, req.body);
    const limit = Math.min(50, Math.max(1, Number(req.body.limit) || 20));
    const allTags = [...new Set(leads.flatMap(tagsOf))].slice(0, 40);
    res.json({
      success: true,
      total: matched.length,
      leads: matched.slice(0, limit).map((l) => ({
        id: l.id,
        name: l.name,
        hasEmail: Boolean(l.email),
        email: l.email || null,
        phone: l.phone || null,
        tags: tagsOf(l),
        stage: l.crm_stage || l.status,
        temperature: l.lead_temperature,
      })),
      availableTags: allTags,
    });
  }),
);

// --- email -------------------------------------------------------------------
router.post("/lead/contact", asyncHandler(async (req, res) => {
  const organizationId = requireOrg(req, res);
  if (!organizationId) return;
  const email = String(req.body.email || "").trim();
  if (!gmail._internals.isValidEmail(email)) return res.json({ success: false, code: "invalid_email", message: "Please spell a valid email address before confirming the change." });
  const allowed = await loadLeads(getSupabase(), organizationId, req.operatorScope);
  if (!allowed.some(l => l.id === req.body.leadId)) return res.json({success:false, message:"That lead belongs to another business or is not assigned to this agent."});
  const { data, error } = await getSupabase().from("leads").update({ email })
    .eq("organization_id", organizationId).eq("id", String(req.body.leadId || ""))
    .select("id,name,email").maybeSingle();
  if (error) throw error;
  if (!data) return res.json({ success: false, code: "not_found", message: "That contact was not found in this business." });
  res.json({ success: true, lead: data });
}));

router.post(
  "/email/prepare",
  asyncHandler(async (req, res) => {
    const organizationId = requireOrg(req, res);
    if (!organizationId) return;
    const db = getSupabase();
    const body = req.body || {};

    let sender;
    try {
      sender = await requireSender(db, organizationId, req.operatorScope);
    } catch (_) {
      sender = null;
    }
    if (!sender) {
      return res.json({ success: false, code: "gmail_not_connected", message: "No Gmail is connected yet. Connect one in Integrations to send email." });
    }

    // Recipients: an appointment's attendee, explicit leads, or a tag.
    const recipients = [];
    if (body.appointmentId) {
      const { data: appt } = await db
        .from("appointments")
        .select("id, integration_id, lead_id, attendee_name, attendee_email, starts_at, timezone, title, reschedule_url")
        .eq("organization_id", organizationId)
        .eq("id", String(body.appointmentId))
        .maybeSingle();
      if (appt && appt.integration_id === req.operatorScope.calendar_integration_id) {
        let lead = null;
        // Resolve only an explicitly selected lead or the appointment's saved
        // link. A similar name alone must never determine an email recipient.
        const leadId = appt.lead_id || (Array.isArray(body.leadIds) && body.leadIds.length === 1 ? body.leadIds[0] : null);
        if (!appt.attendee_email && leadId) {
          const result = await db.from("leads").select("id,name,email,ai_summary,reason,voice_agent_id")
            .eq("organization_id", organizationId).eq("id", String(leadId)).maybeSingle();
          lead = ownsLead(req.operatorScope, result.data) ? result.data : null;
        }
        recipients.push({ appointmentId: appt.id, leadId: lead?.id || null, name: lead?.name || appt.attendee_name,
          email: appt.attendee_email || lead?.email, appointment: appt, lead });
      }
    } else {
      const leads = await loadLeads(db, organizationId, req.operatorScope);
      const ids = Array.isArray(body.leadIds) ? body.leadIds.map(String) : null;
      const chosen = ids ? leads.filter((l) => ids.includes(l.id)) : body.tag || body.search ? matchLeads(leads, body) : [];
      for (const lead of chosen) recipients.push({ leadId: lead.id, name: lead.name, email: lead.email, lead });
    }
    if (recipients.length === 0) {
      return res.json({ success: false, code: "no_recipients", message: "No matching leads or appointment were found." });
    }

    const skipped = recipients.filter((r) => !gmail._internals.isValidEmail(r.email || "")).map((r) => ({ name: r.name, reason: "no email on file" }));
    const sendable = recipients.filter((r) => gmail._internals.isValidEmail(r.email || ""));
    const overCap = sendable.length > MAX_BATCH;
    const batch = sendable.slice(0, MAX_BATCH);

    const { data: org } = await db.from("organizations").select("name").eq("id", organizationId).maybeSingle();
    const drafts = [];
    // Small concurrency so 25 drafts don't take 25 round-trips in series.
    for (let i = 0; i < batch.length; i += 5) {
      const slice = batch.slice(i, i + 5);
      const results = await Promise.all(
        slice.map(async (r) => {
          try {
            const draft = await gmail.draftEmail(
              {
                purpose: body.purpose,
                businessName: (org && org.name) || "",
                senderName: sender.label || "",
                lead: r.lead
                  ? { name: r.lead.name, summary: r.lead.ai_summary, notes: r.lead.reason }
                  : { name: r.name },
                appointment: r.appointment ? { when: formatWhen(r.appointment.starts_at, r.appointment.timezone), title: r.appointment.title } : null,
                link: body.link || (r.appointment && r.appointment.reschedule_url) || null,
                notes: body.notes || null,
              },
              { usageContext: { organizationId, leadId: r.leadId || null } },
            );
            return { leadId: r.leadId || null, appointmentId: r.appointmentId || null, name: r.name, to: r.email, subject: draft.subject, body: draft.body, purpose: draft.purpose };
          } catch (_) {
            skipped.push({ name: r.name, reason: "draft failed" });
            return null;
          }
        }),
      );
      drafts.push(...results.filter(Boolean));
    }
    res.json({
      success: drafts.length > 0,
      from: sender.provider_user_email,
      drafts,
      skipped,
      truncated: overCap,
      message: overCap ? `Only the first ${MAX_BATCH} recipients were drafted.` : undefined,
    });
  }),
);

router.post(
  "/email/send",
  asyncHandler(async (req, res) => {
    const organizationId = requireOrg(req, res);
    if (!organizationId) return;
    const db = getSupabase();
    const sender = await requireSender(db, organizationId, req.operatorScope);
    const drafts = Array.isArray(req.body.drafts) ? req.body.drafts.slice(0, MAX_BATCH) : [];
    const results = [];
    for (const [index,d] of drafts.entries()) {
      // The address must be the one on file for that lead / appointment.
      let onFile = null;
      if (d.leadId) {
        const { data } = await db.from("leads").select("email,voice_agent_id").eq("organization_id", organizationId).eq("id", String(d.leadId)).maybeSingle();
        onFile = ownsLead(req.operatorScope, data) ? data.email : null;
      } else if (d.appointmentId) {
        const { data } = await db.from("appointments").select("attendee_email,integration_id").eq("organization_id", organizationId).eq("id", String(d.appointmentId)).maybeSingle();
        onFile = data?.integration_id === req.operatorScope.calendar_integration_id ? data.attendee_email : null;
      }
      if (!onFile || String(onFile).trim().toLowerCase() !== String(d.to || "").trim().toLowerCase()) {
        results.push({ name: d.name, sent: false, reason: "address does not match the record" });
        continue;
      }
      try {
        await require("../../lib/operator-send").sendOnce(db, organizationId, require("crypto").createHash("sha256").update(JSON.stringify([req.body.batchId, req.body.voiceAgentId, d.to, d.subject, d.body])).digest("hex"), {
          connectionId: sender.id,
          to: d.to,
          subject: d.subject,
          body: d.body,
          purpose: d.purpose,
          leadId: d.leadId || null,
          appointmentId: d.appointmentId || null,
          voiceAgentId: req.body.voiceAgentId || null,
        });
        results.push({ name: d.name, sent: true });
      } catch (error) {
        results.push({ name: d.name, sent: false, reason: error.message });
        // A dead grant or the cap will fail every remaining send the same way.
        if (["needs_reconnect", "daily_cap", "gmail_not_connected"].includes(error.code)) {
          for(const skipped of drafts.slice(index+1)) results.push({name:skipped.name,sent:false,reason:"Not attempted after Gmail could not continue."});
          break;
        }
      }
    }
    const sent = results.filter((r) => r.sent).length;
    res.json({ success: sent === drafts.length && drafts.length > 0, partial:sent>0 && sent<drafts.length, sent, failed: results.length - sent, results });
  }),
);

// --- reschedule -------------------------------------------------------------

router.post(
  "/reschedule",
  asyncHandler(async (req, res) => {
    const organizationId = requireOrg(req, res);
    if (!organizationId) return;
    const db = getSupabase();
    const { appointmentId, newStartISO, voiceAgentId } = req.body || {};
    const { data: old } = await db
      .from("appointments")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("id", String(appointmentId || ""))
      .maybeSingle();
    const connection = await requireCalendar(db, organizationId, req.operatorScope);
    if (!old || old.status === "cancelled" || old.integration_id !== connection.id) {
      return res.json({ success: false, code: "not_found", message: "I couldn't find that appointment." });
    }
    // Book first, cancel second: a failed booking leaves the original intact.
    const booked = await bookAppointment(
      organizationId,
      {
        startISO: newStartISO,
        attendeeName: old.attendee_name,
        attendeeEmail: old.attendee_email,
        attendeePhone: old.attendee_phone,
        title: old.title,
        voiceAgentId: voiceAgentId || old.voice_agent_id || null,
      },
      db,
    );
    if (!booked.success) return res.json(booked);
    const cancelled = await cancelAppointment(organizationId, old.id, db);
    res.json({
      success: true,
      newAppointmentId: booked.appointmentId,
      attendeeName: old.attendee_name,
      attendeeHasEmail: Boolean(old.attendee_email),
      startsAt: booked.startsAt,
      oldCancelled: Boolean(cancelled && cancelled.success),
      message: cancelled && cancelled.success
        ? `Moved ${old.attendee_name || "the appointment"} to the new time.`
        : `Booked the new time, but the old one could not be cancelled automatically: please remove it.`,
    });
  }),
);

module.exports = router;
