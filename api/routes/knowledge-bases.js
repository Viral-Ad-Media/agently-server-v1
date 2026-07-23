"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const {
  ensureWalletCreditOrRespond,
} = require("../../lib/billing-credit-enforcement");
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
  const base = await verifyKnowledgeBase(db, {
    organizationId,
    knowledgeBaseId,
  });
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

function isMissingDeleteTableError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    error?.code === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table") ||
    msg.includes("could not find")
  );
}

async function countKnowledgeBaseRows(
  db,
  { organizationId, knowledgeBaseId, table, label },
) {
  try {
    const { count, error } = await db
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("organization_id", organizationId)
      .eq("knowledge_base_id", knowledgeBaseId);
    if (error) {
      if (!isMissingDeleteTableError(error)) {
        console.warn(
          `[knowledge-bases] ${label} count:`,
          error.message || error,
        );
      }
      return 0;
    }
    return count || 0;
  } catch (error) {
    if (!isMissingDeleteTableError(error)) {
      console.warn(`[knowledge-bases] ${label} count:`, error.message || error);
    }
    return 0;
  }
}

async function deleteKnowledgeBaseRows(
  db,
  { organizationId, knowledgeBaseId, table, label },
) {
  try {
    const { error } = await db
      .from(table)
      .delete()
      .eq("organization_id", organizationId)
      .eq("knowledge_base_id", knowledgeBaseId);
    if (error) {
      if (isMissingDeleteTableError(error)) return;
      throw error;
    }
  } catch (error) {
    if (isMissingDeleteTableError(error)) return;
    console.error(
      `[knowledge-bases] ${label} delete failed:`,
      error.message || error,
    );
    throw error;
  }
}

async function loadKnowledgeBaseDeleteStatus(
  db,
  organizationId,
  knowledgeBaseId,
) {
  const base = await verifyKnowledgeBase(db, {
    organizationId,
    knowledgeBaseId,
  });
  if (!base?.id) return null;

  const [voiceAgents, chatbots, agentLinks, chatbotLinks] = await Promise.all([
    safeDb(
      "delete check voice agents",
      () =>
        db
          .from("voice_agents")
          .select("id,name,knowledge_base_id")
          .eq("organization_id", organizationId),
      [],
    ),
    safeDb(
      "delete check chatbots",
      () =>
        db
          .from("chatbots")
          .select("id,name,knowledge_base_id")
          .eq("organization_id", organizationId),
      [],
    ),
    safeDb(
      "delete check voice links",
      () =>
        db
          .from("agent_knowledge_base_links")
          .select("voice_agent_id")
          .eq("organization_id", organizationId)
          .eq("knowledge_base_id", knowledgeBaseId),
      [],
    ),
    safeDb(
      "delete check chatbot links",
      () =>
        db
          .from("chatbot_knowledge_base_links")
          .select("chatbot_id")
          .eq("organization_id", organizationId)
          .eq("knowledge_base_id", knowledgeBaseId),
      [],
    ),
  ]);

  const voiceById = new Map(
    (voiceAgents || []).map((agent) => [agent.id, agent]),
  );
  const chatbotById = new Map(
    (chatbots || []).map((chatbot) => [chatbot.id, chatbot]),
  );
  const voiceIds = new Set(
    [
      ...(voiceAgents || [])
        .filter((agent) => agent.knowledge_base_id === knowledgeBaseId)
        .map((agent) => agent.id),
      ...(agentLinks || [])
        .map((link) => link.voice_agent_id)
        .filter((id) => {
          const direct = voiceById.get(id)?.knowledge_base_id || null;
          return !direct || direct === knowledgeBaseId;
        }),
    ].filter(Boolean),
  );
  const chatbotIds = new Set(
    [
      ...(chatbots || [])
        .filter((chatbot) => chatbot.knowledge_base_id === knowledgeBaseId)
        .map((chatbot) => chatbot.id),
      ...(chatbotLinks || [])
        .map((link) => link.chatbot_id)
        .filter((id) => {
          const direct = chatbotById.get(id)?.knowledge_base_id || null;
          return !direct || direct === knowledgeBaseId;
        }),
    ].filter(Boolean),
  );

  const attachedVoiceAgents = [...voiceIds].map((id) => {
    const agent = voiceById.get(id) || {};
    return {
      id,
      name: cleanText(agent.name) || `Voice agent ${String(id).slice(0, 8)}`,
      type: "voice_agent",
      assignmentType:
        agent.knowledge_base_id === knowledgeBaseId ? "direct" : "link",
    };
  });
  const attachedChatbots = [...chatbotIds].map((id) => {
    const chatbot = chatbotById.get(id) || {};
    return {
      id,
      name: cleanText(chatbot.name) || `Chatbot ${String(id).slice(0, 8)}`,
      type: "chatbot",
      assignmentType:
        chatbot.knowledge_base_id === knowledgeBaseId ? "direct" : "link",
    };
  });

  const [sourceCount, chunkCount, productCount, faqCount] = await Promise.all([
    countKnowledgeBaseRows(db, {
      organizationId,
      knowledgeBaseId,
      table: "knowledge_sources",
      label: "sources",
    }),
    countKnowledgeBaseRows(db, {
      organizationId,
      knowledgeBaseId,
      table: "knowledge_chunks",
      label: "chunks",
    }),
    countKnowledgeBaseRows(db, {
      organizationId,
      knowledgeBaseId,
      table: "scraped_products",
      label: "products",
    }),
    countKnowledgeBaseRows(db, {
      organizationId,
      knowledgeBaseId,
      table: "faqs",
      label: "FAQs",
    }),
  ]);

  const blockers = {
    voiceAgents: attachedVoiceAgents,
    chatbots: attachedChatbots,
  };
  const blockerCount = attachedVoiceAgents.length + attachedChatbots.length;
  return {
    knowledgeBase: serializeKnowledgeBase(base, {
      linkedVoiceAgentIds: attachedVoiceAgents.map((agent) => agent.id),
      linkedChatbotIds: attachedChatbots.map((chatbot) => chatbot.id),
    }),
    canDelete: blockerCount === 0,
    blockerCount,
    blockers,
    cleanup: {
      sources: sourceCount,
      chunks: chunkCount,
      products: productCount,
      faqs: faqCount,
    },
  };
}

async function deleteKnowledgeBaseData(
  db,
  { organizationId, knowledgeBaseId },
) {
  // Delete scoped knowledge first so no scraped data, FAQs, or source rows remain
  // if the knowledge base itself is removed successfully.
  await deleteKnowledgeBaseRows(db, {
    organizationId,
    knowledgeBaseId,
    table: "scraped_products",
    label: "products",
  });
  await deleteKnowledgeBaseRows(db, {
    organizationId,
    knowledgeBaseId,
    table: "knowledge_chunks",
    label: "chunks",
  });
  await deleteKnowledgeBaseRows(db, {
    organizationId,
    knowledgeBaseId,
    table: "faqs",
    label: "FAQs",
  });
  await deleteKnowledgeBaseRows(db, {
    organizationId,
    knowledgeBaseId,
    table: "knowledge_sources",
    label: "sources",
  });
  await deleteKnowledgeBaseRows(db, {
    organizationId,
    knowledgeBaseId,
    table: "agent_knowledge_base_links",
    label: "voice agent links",
  });
  await deleteKnowledgeBaseRows(db, {
    organizationId,
    knowledgeBaseId,
    table: "chatbot_knowledge_base_links",
    label: "chatbot links",
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
      cleanText(body.name) ||
      `${businessName || titleFromDomain(domain)} Knowledge Base`;

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
    const shouldBePrimary =
      body.isPrimary === true || currentBases.length === 0;

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
        metadata:
          body.metadata && typeof body.metadata === "object"
            ? body.metadata
            : {},
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const body = req.body || {};
    const updates = { updated_at: new Date().toISOString() };
    if (body.name !== undefined) updates.name = cleanText(body.name);
    if (body.businessName !== undefined || body.business_name !== undefined) {
      updates.business_name = cleanText(
        body.businessName || body.business_name,
      );
    }
    if (body.description !== undefined)
      updates.description = cleanText(body.description);
    if (body.industry !== undefined)
      updates.industry = cleanText(body.industry);
    if (body.status !== undefined)
      updates.status = cleanText(body.status) || "active";
    if (body.metadata !== undefined && typeof body.metadata === "object") {
      updates.metadata = body.metadata;
    }
    if (
      body.primaryUrl !== undefined ||
      body.primary_url !== undefined ||
      body.website !== undefined
    ) {
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
        error: {
          message: error?.message || "Failed to update knowledge base.",
        },
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

router.get(
  "/:id/delete-check",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const status = await loadKnowledgeBaseDeleteStatus(
      db,
      req.orgId,
      req.params.id,
    );
    if (!status) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }
    res.json(status);
  }),
);

router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const status = await loadKnowledgeBaseDeleteStatus(
      db,
      req.orgId,
      req.params.id,
    );
    if (!status) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    if (!status.canDelete) {
      return res.status(409).json({
        error: {
          message:
            "This knowledge base is still assigned to active agents. Reassign those agents to another knowledge base or delete the agents first.",
          details: status,
        },
      });
    }

    const { data: replacement } = await db
      .from("knowledge_bases")
      .select("id")
      .eq("organization_id", req.orgId)
      .neq("id", req.params.id)
      .order("is_primary", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    try {
      await deleteKnowledgeBaseData(db, {
        organizationId: req.orgId,
        knowledgeBaseId: req.params.id,
      });

      const { error } = await db
        .from("knowledge_bases")
        .delete()
        .eq("id", req.params.id)
        .eq("organization_id", req.orgId);
      if (error) throw error;

      if (replacement?.id) {
        await db
          .from("knowledge_bases")
          .update({ is_primary: true, updated_at: new Date().toISOString() })
          .eq("id", replacement.id)
          .eq("organization_id", req.orgId);
      }

      res.json({
        success: true,
        deletedId: req.params.id,
        cleanup: status.cleanup,
        replacementPrimaryKnowledgeBaseId: replacement?.id || null,
      });
    } catch (error) {
      res.status(500).json({
        error: { message: error.message || "Failed to delete knowledge base." },
      });
    }
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }
    const url = normalizeUrl(
      req.body?.url || req.body?.website || req.body?.sourceUrl,
    );
    if (!url) {
      return res
        .status(400)
        .json({ error: { message: "A valid source URL is required." } });
    }
    const source = await findOrCreateKnowledgeSource(db, {
      organizationId: req.orgId,
      knowledgeBaseId: base.id,
      url,
      title: cleanText(req.body?.title) || "",
      isPrimary: req.body?.isPrimary === true,
    });
    if (!source?.id) {
      return res
        .status(500)
        .json({ error: { message: "Failed to create source." } });
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }
    const updates = { updated_at: new Date().toISOString() };
    if (req.body?.title !== undefined)
      updates.title = cleanText(req.body.title);
    if (req.body?.isPrimary !== undefined)
      updates.is_primary = req.body.isPrimary === true;
    if (req.body?.scrapeStatus !== undefined)
      updates.scrape_status = cleanText(req.body.scrapeStatus);
    if (
      req.body?.metadata !== undefined &&
      typeof req.body.metadata === "object"
    ) {
      updates.metadata = req.body.metadata;
    }
    if (
      req.body?.url !== undefined ||
      req.body?.website !== undefined ||
      req.body?.sourceUrl !== undefined
    ) {
      const url = normalizeUrl(
        req.body.url || req.body.website || req.body.sourceUrl,
      );
      if (!url) {
        return res
          .status(400)
          .json({ error: { message: "A valid source URL is required." } });
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
      return res.status(500).json({
        error: { message: error.message || "Failed to delete source." },
      });
    }
    res.json({ success: true });
  }),
);

async function performKnowledgeSourceSync({
  db,
  organizationId,
  base,
  source,
}) {
  let scrapeAndStore;
  try {
    ({ scrapeAndStore } = require("../../lib/scraper.service"));
  } catch (depErr) {
    console.error(
      "[knowledge-bases] scraper.service failed to load:",
      depErr.message,
    );
    throw new Error(
      "Website scraping is temporarily unavailable. A server dependency is missing. Please contact support.",
    );
  }

  await db
    .from("knowledge_sources")
    .update({
      scrape_status: "scraping",
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", source.id)
    .eq("organization_id", organizationId);

  await db
    .from("knowledge_bases")
    .update({
      sync_status: "scraping",
      updated_at: new Date().toISOString(),
    })
    .eq("id", base.id)
    .eq("organization_id", organizationId);

  try {
    const result = await scrapeAndStore({
      url: source.normalized_url || source.url,
      organizationId,
      voiceAgentId: null,
      chatbotId: null,
      knowledgeBaseId: base.id,
      knowledgeSourceId: source.id,
    });

    const { data: updatedSource } = await db
      .from("knowledge_sources")
      .select("*")
      .eq("id", source.id)
      .eq("organization_id", organizationId)
      .maybeSingle();

    return {
      success: true,
      chunksStored: result.chunksStored || 0,
      pagesScraped: result.pagesScraped || 0,
      pagesDiscovered: result.pagesDiscovered || 0,
      productsFound: result.productsFound || 0,
      productsStored: result.productsStored || 0,
      scrapeReport: result.scrapeReport || null,
      strategy: result.strategy || "scraper-v2",
      source: serializeKnowledgeSource(updatedSource || source),
      result,
    };
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
      .eq("organization_id", organizationId);
    await db
      .from("knowledge_bases")
      .update({
        sync_status: "failed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", base.id)
      .eq("organization_id", organizationId);
    throw new Error(message);
  }
}

router.post(
  "/:id/sources/:sourceId/sync",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const creditAllowed = await ensureWalletCreditOrRespond(req, res, {
      organizationId: req.orgId,
      action: "knowledge_sync",
    });
    if (creditAllowed !== true) return;

    const db = getSupabase();
    const base = await verifyKnowledgeBase(db, {
      organizationId: req.orgId,
      knowledgeBaseId: req.params.id,
    });
    if (!base?.id) {
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
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

    const wantsBackground =
      req.body?.background === true || req.query.background === "true";
    if (wantsBackground) {
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

      const run = () =>
        performKnowledgeSourceSync({
          db,
          organizationId: req.orgId,
          base,
          source,
        }).catch((error) => {
          console.error(
            "[knowledge-bases] background sync failed:",
            error.message,
          );
        });

      if (typeof setImmediate === "function") setImmediate(run);
      else setTimeout(run, 0);

      return res.status(202).json({
        success: true,
        accepted: true,
        background: true,
        message: "Knowledge sync started in the background.",
        source: serializeKnowledgeSource({
          ...source,
          scrape_status: "scraping",
        }),
      });
    }

    try {
      const result = await performKnowledgeSourceSync({
        db,
        organizationId: req.orgId,
        base,
        source,
      });
      return res.json(result);
    } catch (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to sync this source." },
      });
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
    chatbotId: null,
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const { data, error } = await db
      .from("faqs")
      .select(
        "id,question,answer,voice_agent_id,knowledge_base_id,knowledge_source_id,source_type,metadata,created_at,updated_at",
      )
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .order("created_at", { ascending: true });

    if (error) {
      return res
        .status(500)
        .json({ error: { message: error.message || "Failed to load FAQs." } });
    }

    const faqs = (data || []).map(serializeFaqRow);
    res.json({
      knowledgeBaseId: req.params.id,
      faqs,
      manualFaqs: faqs.filter((faq) =>
        ["manual", "knowledge_base_manual", "chatbot_manual"].includes(
          String(faq.sourceType || "").toLowerCase(),
        ),
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const faqs = normalizeFaqPayload(req.body?.faqs);
    const sourceEditor = isUuid(
      req.body?.chatbotId || req.body?.chatbot_id || "",
    )
      ? "chatbot_page"
      : isUuid(req.body?.voiceAgentId || req.body?.voice_agent_id || "")
        ? "voice_agent_page"
        : "knowledge_base_page";
    const voiceAgentId = isUuid(
      req.body?.voiceAgentId || req.body?.voice_agent_id || "",
    )
      ? String(req.body.voiceAgentId || req.body.voice_agent_id)
      : null;

    // ── FIX: "duplicate key value violates unique constraint uq_faqs_kb_question"
    //
    // This delete only removes MANUAL rows, then blindly inserts. Migration 001
    // added a unique index on (knowledge_base_id, lower(btrim(question))) which
    // spans every source_type — so saving a manual FAQ whose question matches a
    // SCRAPED one already in the same KB now aborts the whole save. Editing an
    // onboarding-generated FAQ hits this every time, which is why the chatbot
    // page could not be saved at all.
    //
    // Two changes:
    //   1. Deduplicate the incoming payload. The editor can legitimately end up
    //      with two rows reading "New FAQ question" before either is filled in,
    //      and a self-collision in one insert batch is otherwise fatal.
    //   2. Upsert on the unique index instead of insert. A manual edit now
    //      OVERWRITES the scraped answer for the same question, which is what
    //      the tenant means when they edit it.
    const seenQuestions = new Set();
    const cleanFaqs = [];
    for (const faq of faqs) {
      const question = String(faq?.question || "").trim();
      if (!question) continue;
      const key = question.toLowerCase();
      if (seenQuestions.has(key)) continue;
      seenQuestions.add(key);
      cleanFaqs.push({ question, answer: String(faq?.answer || "").trim() });
    }

    // Remove manual rows the tenant deleted in the editor. Scraped rows are
    // left alone; the upsert below takes them over where questions match.
    let deleteQuery = db
      .from("faqs")
      .delete()
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .in("source_type", ["manual", "knowledge_base_manual", "chatbot_manual"]);
    if (cleanFaqs.length) {
      deleteQuery = deleteQuery.not(
        "question",
        "in",
        `(${cleanFaqs.map((f) => `"${f.question.replace(/"/g, '""')}"`).join(",")})`,
      );
    }
    await deleteQuery;

    if (cleanFaqs.length) {
      const rows = cleanFaqs.map((faq) => ({
        organization_id: req.orgId,
        knowledge_base_id: req.params.id,
        voice_agent_id: voiceAgentId,
        question: faq.question,
        answer: faq.answer,
        source_type: "knowledge_base_manual",
        is_published: true,
        metadata: {
          source: "knowledge_base_manual_editor",
          updatedFrom: sourceEditor,
        },
        updated_at: new Date().toISOString(),
      }));

      const { error: insertError } = await db.from("faqs").upsert(rows, {
        onConflict: "knowledge_base_id,question",
        ignoreDuplicates: false,
      });

      if (insertError) {
        // The unique index is on lower(btrim(question)), which PostgREST cannot
        // name as a conflict target. If the upsert is rejected for that reason,
        // fall back to per-row update-then-insert, which respects the index
        // without needing to name it.
        console.warn(
          "[knowledge-bases] FAQ upsert fell back to per-row:",
          insertError.message,
        );
        for (const row of rows) {
          const { data: existing } = await db
            .from("faqs")
            .select("id")
            .eq("organization_id", req.orgId)
            .eq("knowledge_base_id", req.params.id)
            .ilike("question", row.question)
            .maybeSingle();

          if (existing?.id) {
            await db
              .from("faqs")
              .update({
                answer: row.answer,
                source_type: "knowledge_base_manual",
                is_published: true,
                metadata: row.metadata,
                updated_at: row.updated_at,
              })
              .eq("id", existing.id);
          } else {
            const { error: rowError } = await db.from("faqs").insert(row);
            if (rowError && rowError.code !== "23505") {
              return res.status(500).json({
                error: {
                  message:
                    "We couldn't save your FAQs. Please check for duplicate questions and try again.",
                },
              });
            }
          }
        }
      }
    }

    const { data, error } = await db
      .from("faqs")
      .select(
        "id,question,answer,voice_agent_id,knowledge_base_id,knowledge_source_id,source_type,metadata,created_at,updated_at",
      )
      .eq("organization_id", req.orgId)
      .eq("knowledge_base_id", req.params.id)
      .order("created_at", { ascending: true });

    if (error) {
      return res.status(500).json({
        error: { message: error.message || "Failed to reload FAQs." },
      });
    }

    const allFaqs = (data || []).map(serializeFaqRow);
    res.json({
      success: true,
      knowledgeBaseId: req.params.id,
      faqs: allFaqs,
      manualFaqs: allFaqs.filter((faq) =>
        ["manual", "knowledge_base_manual", "chatbot_manual"].includes(
          String(faq.sourceType || "").toLowerCase(),
        ),
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const query = cleanText(req.body?.query || req.body?.q || "");
    const limit = Math.min(Math.max(Number(req.body?.limit || 12), 1), 25);
    const [chunks, faqs] = await Promise.all([
      searchScopedKnowledgeChunks(db, {
        organizationId: req.orgId,
        knowledgeBaseIds: [req.params.id],
        query,
        limit,
        maxChars: Math.min(
          Math.max(Number(req.body?.maxChars || 900), 300),
          1800,
        ),
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
      return res
        .status(404)
        .json({ error: { message: "Knowledge base not found." } });
    }

    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 250);
    let query = db
      .from("scraped_products")
      .select(
        "id,name,slug,url,description,price,price_text,currency,availability,brand,sku,image_url,variants,raw_source,knowledge_source_id,metadata,created_at,updated_at",
      )
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
      if (
        msg.includes("does not exist") ||
        msg.includes("schema cache") ||
        msg.includes("could not find")
      ) {
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
    res.json({
      success: true,
      knowledgeBase: serializeKnowledgeBase(result.knowledgeBase),
    });
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
    res.json({
      success: true,
      knowledgeBase: serializeKnowledgeBase(result.knowledgeBase),
    });
  }),
);

module.exports = router;
