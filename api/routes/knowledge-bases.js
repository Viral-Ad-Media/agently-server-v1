"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  cleanText,
  normalizeUrl,
  domainFromUrl,
  titleFromDomain,
  serializeKnowledgeBase,
  serializeKnowledgeSource,
  ensureDefaultKnowledgeBaseForOrg,
  listKnowledgeBasesForOrg,
  verifyKnowledgeBase,
  assignVoiceAgentKnowledgeBase,
  assignChatbotKnowledgeBase,
  findOrCreateKnowledgeSource,
  safeDb,
  isUuid,
} = require("../../lib/knowledge-bases");

const {
  searchScopedKnowledgeChunks,
  searchScopedFaqs,
} = require("../../lib/knowledge-retrieval");

const router = express.Router();

function requestedWebsite(body = {}) {
  return (
    body.primaryUrl ||
    body.primary_url ||
    body.website ||
    body.url ||
    body.domain ||
    ""
  );
}

function serializeWithSources(row, sources = []) {
  return serializeKnowledgeBase(row, { sources });
}

async function loadKnowledgeBaseDetails(db, organizationId, knowledgeBaseId) {
  const base = await verifyKnowledgeBase(db, { organizationId, knowledgeBaseId });
  if (!base?.id) return null;
  const [sources, agentLinks, chatbotLinks] = await Promise.all([
    safeDb(
      "knowledge base sources",
      () =>
        db
          .from("knowledge_sources")
          .select("*")
          .eq("organization_id", organizationId)
          .eq("knowledge_base_id", knowledgeBaseId)
          .order("is_primary", { ascending: false })
          .order("created_at", { ascending: true }),
      [],
    ),
    safeDb(
      "knowledge base voice links",
      () =>
        db
          .from("agent_knowledge_base_links")
          .select("voice_agent_id")
          .eq("organization_id", organizationId)
          .eq("knowledge_base_id", knowledgeBaseId),
      [],
    ),
    safeDb(
      "knowledge base chatbot links",
      () =>
        db
          .from("chatbot_knowledge_base_links")
          .select("chatbot_id")
          .eq("organization_id", organizationId)
          .eq("knowledge_base_id", knowledgeBaseId),
      [],
    ),
  ]);
  return serializeKnowledgeBase(base, {
    sources: sources || [],
    linkedVoiceAgentIds: (agentLinks || []).map((x) => x.voice_agent_id),
    linkedChatbotIds: (chatbotLinks || []).map((x) => x.chatbot_id),
  });
}

router.get(
  "/",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    await ensureDefaultKnowledgeBaseForOrg(db, req.organization);
    const knowledgeBases = await listKnowledgeBasesForOrg(db, req.orgId);
    res.json({ knowledgeBases });
  }),
);

router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const body = req.body || {};
    const primaryUrl = normalizeUrl(requestedWebsite(body));
    if (!primaryUrl) {
      return res.status(400).json({
        error: { message: "A valid primary website URL is required." },
      });
    }

    const domain = domainFromUrl(primaryUrl);
    const businessName =
      cleanText(body.businessName || body.business_name || body.name) ||
      titleFromDomain(domain);
    const name =
      cleanText(body.name) || `${businessName || titleFromDomain(domain)} Knowledge Base`;

    const existing = await safeDb(
      "existing knowledge base domain",
      () =>
        db
          .from("knowledge_bases")
          .select("*")
          .eq("organization_id", req.orgId)
          .eq("domain", domain)
          .maybeSingle(),
      null,
    );
    if (existing?.id) {
      return res.status(409).json({
        error: {
          message: "A business knowledge base already exists for this domain.",
          details: { knowledgeBaseId: existing.id },
        },
      });
    }

    const currentBases = await listKnowledgeBasesForOrg(db, req.orgId);
    const shouldBePrimary = body.isPrimary === true || currentBases.length === 0;

    const { data: base, error } = await db
      .from("knowledge_bases")
      .insert({
        organization_id: req.orgId,
        name,
        business_name: businessName,
        description: cleanText(body.description),
        industry: cleanText(body.industry),
        primary_url: primaryUrl,
        domain,
        is_primary: shouldBePrimary,
        status: "active",
        sync_status: "pending",
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
      })
      .select()
      .single();

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to create knowledge base." },
      });
    }

    const source = await findOrCreateKnowledgeSource(db, {
      organizationId: req.orgId,
      knowledgeBaseId: base.id,
      url: primaryUrl,
      title: name,
      isPrimary: true,
    });

    res.status(201).json({
      knowledgeBase: serializeWithSources(base, source ? [source] : []),
    });
  }),
);

router.get(
  "/:id",
  requireAuth,
  asyncHandler(async (req, res) => {
    const details = await loadKnowledgeBaseDetails(
      getSupabase(),
      req.orgId,
      req.params.id,
    );
    if (!details) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }
    res.json({ knowledgeBase: details });
  }),
);

router.patch(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const existing = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!existing?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }

    const body = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) updates.name = cleanText(body.name);
    if (body.businessName !== undefined || body.business_name !== undefined) {
      updates.business_name = cleanText(body.businessName || body.business_name);
    }
    if (body.description !== undefined) updates.description = cleanText(body.description);
    if (body.industry !== undefined) updates.industry = cleanText(body.industry);
    if (body.status !== undefined) updates.status = cleanText(body.status) || "active";
    if (body.metadata !== undefined && typeof body.metadata === "object") {
      updates.metadata = body.metadata;
    }
    if (body.primaryUrl !== undefined || body.primary_url !== undefined || body.website !== undefined) {
      const primaryUrl = normalizeUrl(requestedWebsite(body));
      if (!primaryUrl) {
        return res.status(400).json({
          error: { message: "A valid primary website URL is required." },
        });
      }
      updates.primary_url = primaryUrl;
      updates.domain = domainFromUrl(primaryUrl);
    }
    if (body.isPrimary === true) {
      updates.is_primary = true;
      await db
        .from("knowledge_bases")
        .update({ is_primary: false, updated_at: new Date().toISOString() })
        .eq("organization_id", req.orgId)
        .neq("id", req.params.id);
    }

    const { data: updated, error } = await db
      .from("knowledge_bases")
      .update(updates)
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId)
      .select()
      .single();

    if (error || !updated) {
      return res.status(500).json({
        error: { message: error?.message || "Failed to update knowledge base." },
      });
    }

    if (updates.primary_url) {
      await findOrCreateKnowledgeSource(db, {
        organizationId: req.orgId,
        knowledgeBaseId: updated.id,
        url: updates.primary_url,
        title: updated.name,
        isPrimary: true,
      });
    }

    const details = await loadKnowledgeBaseDetails(db, req.orgId, updated.id);
    res.json({ knowledgeBase: details || serializeKnowledgeBase(updated) });
  }),
);

router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const details = await loadKnowledgeBaseDetails(db, req.orgId, req.params.id);
    if (!details) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }
    if (details.isPrimary) {
      return res.status(400).json({
        error: { message: "The primary knowledge base cannot be deleted." },
      });
    }
    if (details.agentCount || details.chatbotCount) {
      return res.status(400).json({
        error: {
          message:
            "Unassign all voice agents and chatbots from this knowledge base before deleting it.",
        },
      });
    }
    const { error } = await db
      .from("knowledge_bases")
      .delete()
      .eq("id", req.params.id)
      .eq("organization_id", req.orgId);
    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to delete knowledge base." },
      });
    }
    res.json({ success: true });
  }),
);

router.post(
  "/:id/sources",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }
    const url = normalizeUrl(req.body?.url || req.body?.website || req.body?.sourceUrl);
    if (!url) {
      return res.status(400).json({ error: { message: "A valid source URL is required." } });
    }
    const source = await findOrCreateKnowledgeSource(db, {
      organizationId: req.orgId,
      knowledgeBaseId: base.id,
      url,
      title: cleanText(req.body?.title) || "",
      isPrimary: req.body?.isPrimary === true,
    });
    if (!source?.id) {
      return res.status(500).json({ error: { message: "Failed to create source." } });
    }
    res.status(201).json({ source: serializeKnowledgeSource(source) });
  }),
);

router.patch(
  "/:id/sources/:sourceId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }
    const updates = { updated_at: new Date().toISOString() };
    if (req.body?.title !== undefined) updates.title = cleanText(req.body.title);
    if (req.body?.isPrimary !== undefined) updates.is_primary = req.body.isPrimary === true;
    if (req.body?.scrapeStatus !== undefined) updates.scrape_status = cleanText(req.body.scrapeStatus);
    if (req.body?.metadata !== undefined && typeof req.body.metadata === "object") {
      updates.metadata = req.body.metadata;
    }
    if (req.body?.url !== undefined || req.body?.website !== undefined || req.body?.sourceUrl !== undefined) {
      const url = normalizeUrl(req.body.url || req.body.website || req.body.sourceUrl);
      if (!url) {
        return res.status(400).json({ error: { message: "A valid source URL is required." } });
      }
      updates.url = url;
      updates.normalized_url = url;
      updates.domain = domainFromUrl(url);
    }

    const { data: source, error } = await db
      .from("knowledge_sources")
      .update(updates)
      .eq("id", req.params.sourceId)
      .eq("knowledge_base_id", req.params.id)
      .eq("organization_id", req.orgId)
      .select()
      .single();
    if (error || !source) {
      return res.status(404).json({ error: { message: "Source not found." } });
    }
    res.json({ source: serializeKnowledgeSource(source) });
  }),
);

router.delete(
  "/:id/sources/:sourceId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const { data: source } = await db
      .from("knowledge_sources")
      .select("id,is_primary")
      .eq("id", req.params.sourceId)
      .eq("knowledge_base_id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();
    if (!source?.id) {
      return res.status(404).json({ error: { message: "Source not found." } });
    }
    if (source.is_primary) {
      return res.status(400).json({
        error: { message: "The primary source cannot be deleted." },
      });
    }
    await db
      .from("knowledge_chunks")
      .delete()
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .eq("knowledge_source_id", req.params.sourceId);
    const { error } = await db
      .from("knowledge_sources")
      .delete()
      .eq("id", req.params.sourceId)
      .eq("knowledge_base_id", req.params.id)
      .eq("organization_id", req.orgId);
    if (error) {
      return res.status(500).json({ error: { message: error.message || "Failed to delete source." } });
    }
    res.json({ success: true });
  }),
);

router.post(
  "/:id/sources/:sourceId/sync",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }

    const { data: source, error: sourceError } = await db
      .from("knowledge_sources")
      .select("*")
      .eq("id", req.params.sourceId)
      .eq("knowledge_base_id", req.params.id)
      .eq("organization_id", req.orgId)
      .maybeSingle();

    if (sourceError || !source?.id) {
      return res.status(404).json({ error: { message: "Source not found." } });
    }

    let scrapeAndStore;
    try {
      ({ scrapeAndStore } = require("../../lib/scraper.service"));
    } catch (depErr) {
      console.error("[knowledge-bases] scraper.service failed to load:", depErr.message);
      return res.status(500).json({
        error: {
          message:
            "Website scraping is temporarily unavailable. A server dependency is missing. Please contact support.",
          detail: depErr.message,
        },
      });
    }

    await db
      .from("knowledge_sources")
      .update({
        scrape_status: "scraping",
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id)
      .eq("organization_id", req.orgId);

    await db
      .from("knowledge_bases")
      .update({
        sync_status: "scraping",
        updated_at: new Date().toISOString(),
      })
      .eq("id", base.id)
      .eq("organization_id", req.orgId);

    try {
      const result = await scrapeAndStore({
        url: source.normalized_url || source.url,
        organizationId: req.orgId,
        voiceAgentId: null,
        chatbotId: null,
        knowledgeBaseId: base.id,
        knowledgeSourceId: source.id,
      });

      const { data: updatedSource } = await db
        .from("knowledge_sources")
        .select("*")
        .eq("id", source.id)
        .eq("organization_id", req.orgId)
        .maybeSingle();

      res.json({
        success: true,
        chunksStored: result.chunksStored || 0,
        pagesScraped: result.pagesScraped || 0,
        pagesDiscovered: result.pagesDiscovered || 0,
        productsFound: result.productsFound || 0,
        productsStored: result.productsStored || 0,
        strategy: result.strategy || "scraper-v2",
        source: serializeKnowledgeSource(updatedSource || source),
        result,
      });
    } catch (error) {
      const message = error?.message || "Failed to sync this source.";
      await db
        .from("knowledge_sources")
        .update({
          scrape_status: "failed",
          last_error: message,
          updated_at: new Date().toISOString(),
        })
        .eq("id", source.id)
        .eq("organization_id", req.orgId);
      await db
        .from("knowledge_bases")
        .update({
          sync_status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", base.id)
        .eq("organization_id", req.orgId);
      return res.status(500).json({ error: { message } });
    }
  }),
);

function serializeFaqRow(row) {
  return {
    id: row.id,
    question: row.question || "",
    answer: row.answer || "",
    knowledgeBaseId: row.knowledge_base_id || null,
    knowledgeSourceId: row.knowledge_source_id || null,
    voiceAgentId: row.voice_agent_id || null,
    chatbotId: row.chatbot_id || null,
    sourceType: row.source_type || "manual",
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function normalizeFaqPayload(value) {
  return (Array.isArray(value) ? value : [])
    .slice(0, 120)
    .map((item) => ({
      question: cleanText(item?.question || item?.q || ""),
      answer: cleanText(item?.answer || item?.a || ""),
    }))
    .filter((item) => item.question && item.answer);
}

router.get(
  "/:id/faqs",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }

    const { data, error } = await db
      .from("faqs")
      .select("id,question,answer,voice_agent_id,chatbot_id,knowledge_base_id,knowledge_source_id,source_type,metadata,created_at,updated_at")
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .order("created_at", { ascending: true });

    if (error) {
      return res.status(500).json({ error: { message: error.message || "Failed to load FAQs." } });
    }

    const faqs = (data || []).map(serializeFaqRow);
    res.json({
      knowledgeBaseId: req.params.id,
      faqs,
      manualFaqs: faqs.filter((faq) =>
        ["manual", "knowledge_base_manual", "chatbot_manual"].includes(String(faq.sourceType || "").toLowerCase()),
      ),
    });
  }),
);

router.put(
  "/:id/faqs",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }

    const faqs = normalizeFaqPayload(req.body?.faqs);
    const chatbotId = isUuid(req.body?.chatbotId || req.body?.chatbot_id || "")
      ? String(req.body.chatbotId || req.body.chatbot_id)
      : null;
    const voiceAgentId = isUuid(req.body?.voiceAgentId || req.body?.voice_agent_id || "")
      ? String(req.body.voiceAgentId || req.body.voice_agent_id)
      : null;

    let deleteQuery = db
      .from("faqs")
      .delete()
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .in("source_type", ["manual", "knowledge_base_manual", "chatbot_manual"]);
    await deleteQuery;

    if (faqs.length) {
      const rows = faqs.map((faq) => ({
        organization_id: req.orgId,
        knowledge_base_id: req.params.id,
        chatbot_id: chatbotId,
        voice_agent_id: voiceAgentId,
        question: faq.question,
        answer: faq.answer,
        source_type: "knowledge_base_manual",
        metadata: {
          source: "knowledge_base_manual_editor",
          updatedFrom: chatbotId ? "chatbot_page" : voiceAgentId ? "voice_agent_page" : "knowledge_base_page",
        },
      }));
      const { error: insertError } = await db.from("faqs").insert(rows);
      if (insertError) {
        return res.status(500).json({ error: { message: insertError.message || "Failed to save FAQs." } });
      }
    }

    const { data, error } = await db
      .from("faqs")
      .select("id,question,answer,voice_agent_id,chatbot_id,knowledge_base_id,knowledge_source_id,source_type,metadata,created_at,updated_at")
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .order("created_at", { ascending: true });

    if (error) {
      return res.status(500).json({ error: { message: error.message || "Failed to reload FAQs." } });
    }

    const allFaqs = (data || []).map(serializeFaqRow);
    res.json({
      success: true,
      knowledgeBaseId: req.params.id,
      faqs: allFaqs,
      manualFaqs: allFaqs.filter((faq) =>
        ["manual", "knowledge_base_manual", "chatbot_manual"].includes(String(faq.sourceType || "").toLowerCase()),
      ),
    });
  }),
);

router.post(
  "/:id/search",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }

    const query = cleanText(req.body?.query || req.body?.q || "");
    const limit = Math.min(Math.max(Number(req.body?.limit || 12), 1), 25);
    const [chunks, faqs] = await Promise.all([
      searchScopedKnowledgeChunks(db, {
        organizationId: req.orgId,
        knowledgeBaseIds: [req.params.id],
        query,
        limit,
        maxChars: Math.min(Math.max(Number(req.body?.maxChars || 900), 300), 1800),
      }),
      searchScopedFaqs(db, {
        organizationId: req.orgId,
        knowledgeBaseIds: [req.params.id],
        query,
        limit: Math.min(limit, 12),
      }),
    ]);

    res.json({
      query,
      knowledgeBaseId: req.params.id,
      chunks,
      faqs,
      stats: {
        chunks: chunks.length,
        faqs: faqs.length,
      },
    });
  }),
);

router.get(
  "/:id/products",
  requireAuth,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res.status(404).json({ error: { message: "Knowledge base not found." } });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
    let query = db
      .from("scraped_products")
      .select("id,name,slug,url,description,price,price_text,currency,availability,brand,sku,image_url,variants,raw_source,knowledge_source_id,metadata,created_at,updated_at")
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .order("name", { ascending: true })
      .limit(limit);
    if (req.query.sourceId) {
      query = query.eq("knowledge_source_id", String(req.query.sourceId));
    }

    const { data, error } = await query;
    if (error) {
      const msg = String(error.message || "").toLowerCase();
      if (msg.includes("does not exist") || msg.includes("schema cache") || msg.includes("could not find")) {
        return res.json({ products: [] });
      }
      return res.status(500).json({ error: { message: error.message } });
    }

    res.json({
      products: (data || []).map((product) => ({
        id: product.id,
        name: product.name,
        slug: product.slug,
        url: product.url,
        description: product.description || "",
        price: product.price,
        priceText: product.price_text || "",
        currency: product.currency || "",
        availability: product.availability || "",
        brand: product.brand || "",
        sku: product.sku || "",
        imageUrl: product.image_url || "",
        variants: product.variants || [],
        rawSource: product.raw_source || "",
        knowledgeSourceId: product.knowledge_source_id || null,
        metadata: product.metadata || {},
        createdAt: product.created_at || null,
        updatedAt: product.updated_at || null,
      })),
    });
  }),
);

router.put(
  "/:id/voice-agents/:agentId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.params.agentId)) {
      return res.status(400).json({ error: { message: "Invalid ID." } });
    }
    const result = await assignVoiceAgentKnowledgeBase(getSupabase(), {
      organizationId: req.orgId,
      agentId: req.params.agentId,
      knowledgeBaseId: req.params.id,
    });
    if (!result.ok) {
      return res.status(404).json({ error: { message: result.message } });
    }
    res.json({ success: true, knowledgeBase: serializeKnowledgeBase(result.knowledgeBase) });
  }),
);

router.put(
  "/:id/chatbots/:chatbotId",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    if (!isUuid(req.params.id) || !isUuid(req.params.chatbotId)) {
      return res.status(400).json({ error: { message: "Invalid ID." } });
    }
    const result = await assignChatbotKnowledgeBase(getSupabase(), {
      organizationId: req.orgId,
      chatbotId: req.params.chatbotId,
      knowledgeBaseId: req.params.id,
    });
    if (!result.ok) {
      return res.status(404).json({ error: { message: result.message } });
    }
    res.json({ success: true, knowledgeBase: serializeKnowledgeBase(result.knowledgeBase) });
  }),
);

module.exports = router;
