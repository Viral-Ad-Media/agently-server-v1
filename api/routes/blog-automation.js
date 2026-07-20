"use strict";

// ═══════════════════════════════════════════════════════════════
// Blog ↔ n8n automation bridge
//
// Flow:
//   1. Super admin clicks "Generate with n8n" in the blog tab and picks a
//      topic + template. The frontend calls POST /trigger.
//   2. /trigger forwards that brief to the n8n webhook configured in
//      N8N_BLOG_WEBHOOK_URL, along with a callback URL and a secret the
//      n8n workflow must echo back.
//   3. The n8n workflow (its own agent/skill) writes the post and calls
//      POST /ingest with the finished content. That request is not a
//      super-admin session — it is authenticated with the shared secret
//      instead — and it creates a draft blog_posts row using the exact
//      same sanitization as the manual editor.
//   4. The post shows up as a draft in the super-admin Blog tab, ready to
//      review, pick a template for, and publish.
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");
const { requireSuperAdmin, logSecurityEvent } = require("../../lib/super-admin-auth");
const {
  ALLOWED_TEMPLATES,
  sanitizeBlocks,
  markdownToBlocks,
  uniqueSlug,
  serializePost,
} = require("../../lib/blog-content");

const router = express.Router();

function n8nWebhookUrl() {
  return String(process.env.N8N_BLOG_WEBHOOK_URL || "").trim();
}

function ingestSecret() {
  return String(process.env.N8N_BLOG_INGEST_SECRET || "").trim();
}

function ingestUrl(req) {
  const configured = String(process.env.API_URL || "").trim().replace(/\/$/, "");
  const base = configured || `${req.protocol}://${req.get("host")}`;
  return `${base}/api/blog-automation/ingest`;
}

// ── GET /api/super-admin/blog-automation/status ──────────────────
// Lets the super-admin UI show whether the n8n side is wired up yet, and
// gives the admin the exact callback URL to paste into the n8n workflow.
router.get(
  "/status",
  requireSuperAdmin,
  (req, res) => {
    res.json({
      configured: Boolean(n8nWebhookUrl() && ingestSecret()),
      webhookConfigured: Boolean(n8nWebhookUrl()),
      secretConfigured: Boolean(ingestSecret()),
      ingestUrl: ingestUrl(req),
    });
  },
);

// ── POST /api/super-admin/blog-automation/trigger ────────────────
// Kicks off generation. Body: { topic, keywords, templateKey, tone, notes,
// authorName, autoPublish }.
router.post(
  "/trigger",
  requireSuperAdmin,
  asyncHandler(async (req, res) => {
    const webhookUrl = n8nWebhookUrl();
    const secret = ingestSecret();
    if (!webhookUrl || !secret) {
      return res.status(503).json({
        error: {
          message:
            "n8n is not configured yet. Set N8N_BLOG_WEBHOOK_URL and N8N_BLOG_INGEST_SECRET on the backend, then add a Webhook node in n8n that calls back to the ingest URL below with the shared secret.",
          ingestUrl: ingestUrl(req),
        },
      });
    }

    const body = req.body || {};
    const topic = String(body.topic || "").trim().slice(0, 300);
    if (!topic) {
      return res
        .status(400)
        .json({ error: { message: "A topic or brief is required." } });
    }
    const templateKey = ALLOWED_TEMPLATES.has(body.templateKey)
      ? body.templateKey
      : "product_update";
    const requestId = `blog-gen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const payload = {
      requestId,
      topic,
      keywords: Array.isArray(body.keywords)
        ? body.keywords.slice(0, 20).map((k) => String(k).slice(0, 80))
        : String(body.keywords || "")
            .split(",")
            .map((k) => k.trim())
            .filter(Boolean)
            .slice(0, 20),
      templateKey,
      tone: String(body.tone || "confident, plain-spoken").slice(0, 200),
      notes: String(body.notes || "").slice(0, 2000),
      authorName: String(body.authorName || "Agently Team").slice(0, 160),
      autoPublish: Boolean(body.autoPublish),
      callback: {
        url: ingestUrl(req),
        secretHeader: "x-agently-automation-secret",
        secret,
      },
    };

    let n8nResponse;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      n8nResponse = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));
    } catch (error) {
      await logSecurityEvent(req, "blog_automation_trigger_failed", false, {
        adminEmail: req.superAdmin.email,
        requestId,
        topic,
        error: error?.message || String(error),
      });
      return res.status(502).json({
        error: {
          message: `Could not reach the n8n webhook: ${error?.message || error}`,
        },
      });
    }

    await logSecurityEvent(req, "blog_automation_triggered", true, {
      adminEmail: req.superAdmin.email,
      requestId,
      topic,
      templateKey,
      n8nStatus: n8nResponse.status,
    });

    return res.status(202).json({
      success: true,
      requestId,
      message:
        "Sent to n8n. The generated post will appear as a draft in the Blog tab once the workflow finishes and calls back.",
      n8nStatus: n8nResponse.status,
    });
  }),
);

// ── POST /api/blog-automation/ingest ──────────────────────────────
// Called BY n8n, not by the browser. Auth is the shared secret header, not
// a super-admin session/JWT, because the automation runs outside a logged
// in browser tab.
router.post(
  "/ingest",
  asyncHandler(async (req, res) => {
    const secret = ingestSecret();
    const provided = String(req.headers["x-agently-automation-secret"] || "");
    if (!secret || provided !== secret) {
      return res.status(401).json({ error: { message: "Invalid or missing automation secret." } });
    }

    const body = req.body || {};
    const title = String(body.title || "").trim().slice(0, 250);
    if (!title) {
      return res.status(400).json({ error: { message: "A title is required." } });
    }

    const db = getSupabase();
    const templateKey = ALLOWED_TEMPLATES.has(body.templateKey)
      ? body.templateKey
      : "product_update";
    const contentBlocks = Array.isArray(body.contentBlocks)
      ? sanitizeBlocks(body.contentBlocks)
      : markdownToBlocks(body.content || body.markdown || "");
    const requestedStatus = String(body.status || "draft").toLowerCase();
    // n8n may request "published" (e.g. the trigger had autoPublish set),
    // but everything else defaults to a safe draft that a human reviews.
    const status = requestedStatus === "published" ? "published" : "draft";
    const slug = await uniqueSlug(db, body.slug || title);
    const now = new Date().toISOString();

    const payload = {
      slug,
      title,
      excerpt: String(body.excerpt || "").trim().slice(0, 1200),
      status,
      template_key: templateKey,
      cover_image_url: String(body.coverImageUrl || "").trim().slice(0, 3000) || null,
      author_name: String(body.authorName || "Agently Team").trim().slice(0, 160),
      content_blocks: contentBlocks,
      seo_title: String(body.seoTitle || "").trim().slice(0, 250) || null,
      seo_description: String(body.seoDescription || "").trim().slice(0, 500) || null,
      published_at: status === "published" ? now : null,
      created_by: "n8n-automation",
      updated_by: "n8n-automation",
      updated_at: now,
    };

    const { data, error } = await db
      .from("blog_posts")
      .insert(payload)
      .select("*")
      .single();
    if (error) throw error;

    await logSecurityEvent(req, "blog_automation_ingested", true, {
      adminEmail: "n8n-automation",
      postId: data.id,
      requestId: body.requestId || null,
      status,
    });

    return res.status(201).json({ success: true, post: serializePost(data) });
  }),
);

module.exports = router;
