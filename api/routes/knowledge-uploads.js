"use strict";

/**
 * ============================================================
 * api/routes/knowledge-uploads.js
 * ============================================================
 * Drag-and-drop Knowledge Base file upload (PDF/DOCX/EPUB/TXT).
 *
 * This route only issues signed Supabase Storage upload URLs and
 * registers uploaded files as ingest jobs. Parsing/chunking happens
 * entirely in agently-ws-server/lib/knowledge-ingest-worker.js — Vercel
 * cannot host a long-running parse job any more than it could the
 * scrape worker.
 *
 * Additive only — new route, new tables. Nothing existing is modified.
 * Mounted at a distinct prefix (not /api/knowledge-bases) specifically so
 * this file never touches api/routes/knowledge-bases.js.
 * ============================================================
 */

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { verifyKnowledgeBase } = require("../../lib/knowledge-bases");
const {
  ensureWalletCreditOrRespond,
} = require("../../lib/billing-credit-enforcement");

const router = express.Router();

const BUCKET = process.env.KNOWLEDGE_UPLOADS_BUCKET || "knowledge-uploads";
const MAX_FILE_SIZE_BYTES = Math.max(
  1,
  Number(process.env.KNOWLEDGE_UPLOAD_MAX_MB || 25),
) * 1024 * 1024;

const ALLOWED_TYPES = {
  pdf: { mime: "application/pdf", ext: "pdf" },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ext: "docx",
  },
  epub: { mime: "application/epub+zip", ext: "epub" },
  txt: { mime: "text/plain", ext: "txt" },
};

function detectFileType(filename = "", declared = "") {
  const byDeclared = String(declared || "").toLowerCase();
  if (ALLOWED_TYPES[byDeclared]) return byDeclared;
  const ext = String(filename).split(".").pop()?.toLowerCase() || "";
  if (ALLOWED_TYPES[ext]) return ext;
  return null;
}

function sanitizeFilename(name) {
  return String(name || "file")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 180);
}

function serializeSourceFile(row) {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    filename: row.filename,
    fileType: row.file_type,
    fileSizeBytes: row.file_size_bytes || 0,
    status: row.status,
    statusReason: row.status_reason || "",
    createdAt: row.created_at,
    indexedAt: row.indexed_at || null,
  };
}

// ── POST /api/knowledge-uploads/:knowledgeBaseId/upload-url ─────────────
// Returns a signed Supabase Storage upload URL. The browser PUTs the file
// bytes directly to Storage — file bodies never pass through this Vercel
// function, avoiding its request-size/duration limits entirely.
router.post(
  "/:knowledgeBaseId/upload-url",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { knowledgeBaseId } = req.params;
    const db = getSupabase();
    const kb = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId,
    });
    if (!kb) {
      return res
        .status(404)
        .json({ error: { code: "KB_NOT_FOUND", message: "Knowledge base not found." } });
    }

    const filename = String(req.body?.filename || "").trim();
    const declaredType = String(req.body?.fileType || "").trim();
    const fileSizeBytes = Number(req.body?.fileSizeBytes || 0);
    if (!filename) {
      return res.status(400).json({
        error: { code: "FILENAME_REQUIRED", message: "filename is required." },
      });
    }
    const fileType = detectFileType(filename, declaredType);
    if (!fileType) {
      const isZip = /\.zip$/i.test(filename);
      return res.status(400).json({
        error: {
          code: "UNSUPPORTED_FILE_TYPE",
          message: isZip
            ? "Zip files aren't supported — upload the PDF, DOCX, EPUB, or TXT file directly."
            : "Only PDF, DOCX, EPUB, and TXT files are supported.",
        },
      });
    }
    if (fileSizeBytes > MAX_FILE_SIZE_BYTES) {
      return res.status(400).json({
        error: {
          code: "FILE_TOO_LARGE",
          message: `File exceeds the ${Math.round(MAX_FILE_SIZE_BYTES / (1024 * 1024))}MB limit.`,
        },
      });
    }

    const storagePath = `${req.orgId}/${knowledgeBaseId}/${crypto.randomUUID()}-${sanitizeFilename(filename)}`;
    const { data, error } = await db.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);
    if (error) throw new Error(error.message || "Could not create upload URL.");

    res.json({
      signedUrl: data.signedUrl,
      token: data.token,
      storagePath,
      fileType,
      bucket: BUCKET,
    });
  }),
);

// ── POST /api/knowledge-uploads/:knowledgeBaseId/files ───────────────────
// Called after the browser finishes the direct Storage upload. Creates the
// source-file row, a matching knowledge_sources row (same table every other
// source type already uses), and queues the ingest job.
router.post(
  "/:knowledgeBaseId/files",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { knowledgeBaseId } = req.params;
    const db = getSupabase();
    const kb = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId,
    });
    if (!kb) {
      return res
        .status(404)
        .json({ error: { code: "KB_NOT_FOUND", message: "Knowledge base not found." } });
    }

    const filename = String(req.body?.filename || "").trim();
    const storagePath = String(req.body?.storagePath || "").trim();
    const fileType = detectFileType(filename, req.body?.fileType);
    const fileSizeBytes = Number(req.body?.fileSizeBytes || 0);
    if (!filename || !storagePath || !fileType) {
      return res.status(400).json({
        error: {
          code: "INVALID_FILE_REGISTRATION",
          message: "filename, storagePath, and a supported fileType are required.",
        },
      });
    }
    // storagePath must actually belong to this org/KB — otherwise a caller
    // could register (and trigger ingestion of) a path outside their tenant.
    if (!storagePath.startsWith(`${req.orgId}/${knowledgeBaseId}/`)) {
      return res.status(403).json({
        error: { code: "PATH_MISMATCH", message: "storagePath does not belong to this knowledge base." },
      });
    }

    // Same gate/402 shape as every other metered action (webcall, scrape) —
    // the frontend's existing credit-required modal already handles this
    // response, no new UI wiring needed.
    const allowed = await ensureWalletCreditOrRespond(req, res, {
      action: "knowledge_sync",
    });
    if (allowed !== true) return;

    const uploadUrl = `upload://${storagePath}`;
    const { data: source, error: sourceError } = await db
      .from("knowledge_sources")
      .insert({
        organization_id: req.orgId,
        knowledge_base_id: knowledgeBaseId,
        source_type: "upload",
        url: uploadUrl,
        normalized_url: uploadUrl,
        title: filename,
        scrape_status: "processing",
      })
      .select("id")
      .single();
    if (sourceError) throw new Error(sourceError.message);

    const { data: fileRow, error: fileError } = await db
      .from("knowledge_source_files")
      .insert({
        organization_id: req.orgId,
        knowledge_base_id: knowledgeBaseId,
        knowledge_source_id: source.id,
        filename,
        file_type: fileType,
        file_size_bytes: fileSizeBytes || null,
        storage_path: storagePath,
        status: "processing",
        uploaded_by_user_id: req.user?.id || null,
      })
      .select("*")
      .single();
    if (fileError) throw new Error(fileError.message);

    const { error: jobError } = await db.from("knowledge_ingest_jobs").insert({
      organization_id: req.orgId,
      knowledge_base_id: knowledgeBaseId,
      source_file_id: fileRow.id,
      status: "queued",
    });
    if (jobError) throw new Error(jobError.message);

    res.json({ file: serializeSourceFile(fileRow) });
  }),
);

// ── GET /api/knowledge-uploads/:knowledgeBaseId/files ────────────────────
// Polled by the frontend for live per-file status (PageSelector already
// establishes polling as this app's convention for exactly this kind of
// live ingestion progress).
router.get(
  "/:knowledgeBaseId/files",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { knowledgeBaseId } = req.params;
    const db = getSupabase();
    const kb = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId,
    });
    if (!kb) {
      return res
        .status(404)
        .json({ error: { code: "KB_NOT_FOUND", message: "Knowledge base not found." } });
    }

    const { data, error } = await db
      .from("knowledge_source_files")
      .select("*")
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", knowledgeBaseId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);

    res.json({ files: (data || []).map(serializeSourceFile) });
  }),
);

// ── DELETE /api/knowledge-uploads/:knowledgeBaseId/files/:fileId ─────────
// Removes the file's chunks, its knowledge_sources row, the storage object,
// and the file row itself — so a removed document is fully gone from what
// the agent can retrieve, not just hidden in the UI.
router.delete(
  "/:knowledgeBaseId/files/:fileId",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { knowledgeBaseId, fileId } = req.params;
    const db = getSupabase();
    const kb = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId,
    });
    if (!kb) {
      return res
        .status(404)
        .json({ error: { code: "KB_NOT_FOUND", message: "Knowledge base not found." } });
    }

    const { data: fileRow, error: fileErr } = await db
      .from("knowledge_source_files")
      .select("*")
      .eq("id", fileId)
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", knowledgeBaseId)
      .maybeSingle();
    if (fileErr) throw new Error(fileErr.message);
    if (!fileRow) {
      return res
        .status(404)
        .json({ error: { code: "FILE_NOT_FOUND", message: "File not found." } });
    }

    const uploadUrl = `upload://${fileRow.storage_path}`;
    await db
      .from("knowledge_chunks")
      .delete()
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", knowledgeBaseId)
      .eq("source_url", uploadUrl);

    if (fileRow.knowledge_source_id) {
      await db
        .from("knowledge_sources")
        .delete()
        .eq("id", fileRow.knowledge_source_id)
        .eq("organization_id", req.orgId);
    }

    await db.storage.from(BUCKET).remove([fileRow.storage_path]);

    await db
      .from("knowledge_source_files")
      .delete()
      .eq("id", fileId)
      .eq("organization_id", req.orgId);

    res.json({ removed: true });
  }),
);

module.exports = router;
