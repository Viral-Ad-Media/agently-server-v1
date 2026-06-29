"use strict";

function cleanText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function normalizeUrl(value) {
  const raw = cleanText(value).replace(/\/+$/, "");
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withProtocol);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/+$/, "");
  } catch (_) {
    return "";
  }
}

function domainFromUrl(value) {
  const normalized = normalizeUrl(value);
  if (!normalized) return "";
  try {
    return new URL(normalized).hostname.toLowerCase().replace(/^www\./, "");
  } catch (_) {
    return "";
  }
}

function titleFromDomain(domain) {
  const base =
    cleanText(domain)
      .replace(/^www\./, "")
      .split(".")[0] || "Knowledge";
  return base.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function serializeKnowledgeSource(row) {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceType: row.source_type || "website",
    url: row.url || "",
    normalizedUrl: row.normalized_url || row.url || "",
    domain: row.domain || domainFromUrl(row.url),
    title: row.title || "",
    isPrimary: row.is_primary === true,
    scrapeStatus: row.scrape_status || "pending",
    scrapeStrategy: row.scrape_strategy || "",
    lastScrapedAt: row.last_scraped_at || null,
    lastError: row.last_error || "",
    pageCount: row.page_count || 0,
    chunkCount: row.chunk_count || 0,
    productCount: row.product_count || 0,
    metadata: row.metadata || {},
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function serializeKnowledgeBase(row, extras = {}) {
  const linkedVoiceAgentIds = extras.linkedVoiceAgentIds || [];
  const linkedChatbotIds = extras.linkedChatbotIds || [];
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name || row.business_name || "Knowledge Base",
    businessName: row.business_name || row.name || "Knowledge Base",
    description: row.description || "",
    industry: row.industry || "",
    primaryUrl: row.primary_url || "",
    domain: row.domain || domainFromUrl(row.primary_url),
    isPrimary: row.is_primary === true,
    status: row.status || "active",
    syncStatus: row.sync_status || "pending",
    lastSyncedAt: row.last_synced_at || null,
    metadata: row.metadata || {},
    sources: (extras.sources || []).map(serializeKnowledgeSource),
    linkedVoiceAgentIds,
    linkedChatbotIds,
    agentCount: linkedVoiceAgentIds.length,
    chatbotCount: linkedChatbotIds.length,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function isMissingTableError(error) {
  const msg = String(error?.message || error || "").toLowerCase();
  return (
    error?.code === "42P01" ||
    msg.includes("does not exist") ||
    msg.includes("schema cache") ||
    msg.includes("could not find the table")
  );
}

async function safeDb(label, fn, fallback = null) {
  try {
    const { data, error } = await fn();
    if (error) {
      if (!isMissingTableError(error)) {
        console.warn(`[knowledge-bases] ${label}:`, error.message || error);
      }
      return fallback;
    }
    return data === undefined ? fallback : data;
  } catch (e) {
    if (!isMissingTableError(e)) {
      console.warn(`[knowledge-bases] ${label}:`, e.message || e);
    }
    return fallback;
  }
}

async function ensurePrimarySource(db, { organizationId, knowledgeBase }) {
  if (!knowledgeBase?.id || !knowledgeBase.primary_url) return null;
  const normalizedUrl = normalizeUrl(knowledgeBase.primary_url);
  if (!normalizedUrl) return null;
  const domain = domainFromUrl(normalizedUrl);
  const existing = await safeDb(
    "find primary source",
    () =>
      db
        .from("knowledge_sources")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("knowledge_base_id", knowledgeBase.id)
        .eq("normalized_url", normalizedUrl)
        .maybeSingle(),
    null,
  );
  if (existing?.id) return existing;

  return await safeDb(
    "insert primary source",
    () =>
      db
        .from("knowledge_sources")
        .insert({
          organization_id: organizationId,
          knowledge_base_id: knowledgeBase.id,
          source_type: "website",
          url: normalizedUrl,
          normalized_url: normalizedUrl,
          domain,
          title: knowledgeBase.name || titleFromDomain(domain),
          is_primary: true,
          scrape_status: "pending",
        })
        .select()
        .single(),
    null,
  );
}

async function ensureDefaultKnowledgeBaseForOrg(db, org) {
  const organizationId = org?.id;
  if (!organizationId) return null;

  let existing = await safeDb(
    "default knowledge base",
    () =>
      db
        .from("knowledge_bases")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("is_primary", true)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    null,
  );
  if (existing?.id) {
    await ensurePrimarySource(db, { organizationId, knowledgeBase: existing });
    return existing;
  }

  existing = await safeDb(
    "first knowledge base",
    () =>
      db
        .from("knowledge_bases")
        .select("*")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle(),
    null,
  );
  if (existing?.id) return existing;

  const primaryUrl = normalizeUrl(org.website || "");
  const domain = domainFromUrl(primaryUrl);
  const businessName =
    cleanText(org.name) || titleFromDomain(domain) || "Primary Knowledge Base";
  const row = await safeDb(
    "create default knowledge base",
    () =>
      db
        .from("knowledge_bases")
        .insert({
          organization_id: organizationId,
          name: `${businessName} Knowledge Base`,
          business_name: businessName,
          description:
            "Default knowledge base created from onboarding profile.",
          industry: org.industry || "",
          primary_url: primaryUrl || null,
          domain: domain || null,
          is_primary: true,
          status: "active",
          sync_status: "pending",
          metadata: { createdFrom: "runtime-default" },
        })
        .select()
        .single(),
    null,
  );
  if (row?.id)
    await ensurePrimarySource(db, { organizationId, knowledgeBase: row });
  return row;
}

async function listKnowledgeBasesForOrg(db, organizationId) {
  const rows = await safeDb(
    "list knowledge bases",
    () =>
      db
        .from("knowledge_bases")
        .select("*")
        .eq("organization_id", organizationId)
        .order("is_primary", { ascending: false })
        .order("created_at", { ascending: true }),
    [],
  );
  if (!rows?.length) return [];
  const ids = rows.map((r) => r.id);
  const [sources, agentLinks, chatbotLinks, directAgents, directChatbots] =
    await Promise.all([
      safeDb(
        "list sources",
        () =>
          db
            .from("knowledge_sources")
            .select("*")
            .eq("organization_id", organizationId)
            .in("knowledge_base_id", ids)
            .order("is_primary", { ascending: false })
            .order("created_at", { ascending: true }),
        [],
      ),
      safeDb(
        "list voice agent links",
        () =>
          db
            .from("agent_knowledge_base_links")
            .select("knowledge_base_id,voice_agent_id")
            .eq("organization_id", organizationId)
            .in("knowledge_base_id", ids),
        [],
      ),
      safeDb(
        "list chatbot links",
        () =>
          db
            .from("chatbot_knowledge_base_links")
            .select("knowledge_base_id,chatbot_id")
            .eq("organization_id", organizationId)
            .in("knowledge_base_id", ids),
        [],
      ),
      safeDb(
        "list direct voice agent knowledge bases",
        () =>
          db
            .from("voice_agents")
            .select("id,knowledge_base_id")
            .eq("organization_id", organizationId)
            .in("knowledge_base_id", ids),
        [],
      ),
      safeDb(
        "list direct chatbot knowledge bases",
        () =>
          db
            .from("chatbots")
            .select("id,knowledge_base_id")
            .eq("organization_id", organizationId)
            .in("knowledge_base_id", ids),
        [],
      ),
    ]);

  const directAgentBaseById = new Map(
    (directAgents || []).map((agent) => [agent.id, agent.knowledge_base_id]),
  );
  const directChatbotBaseById = new Map(
    (directChatbots || []).map((chatbot) => [
      chatbot.id,
      chatbot.knowledge_base_id,
    ]),
  );

  return rows.map((row) => {
    const linkedVoiceAgentIds = [
      ...(agentLinks || [])
        .filter(
          (l) =>
            l.knowledge_base_id === row.id &&
            (!directAgentBaseById.has(l.voice_agent_id) ||
              directAgentBaseById.get(l.voice_agent_id) === row.id),
        )
        .map((l) => l.voice_agent_id),
      ...(directAgents || [])
        .filter((agent) => agent.knowledge_base_id === row.id)
        .map((agent) => agent.id),
    ];
    const linkedChatbotIds = [
      ...(chatbotLinks || [])
        .filter(
          (l) =>
            l.knowledge_base_id === row.id &&
            (!directChatbotBaseById.has(l.chatbot_id) ||
              directChatbotBaseById.get(l.chatbot_id) === row.id),
        )
        .map((l) => l.chatbot_id),
      ...(directChatbots || [])
        .filter((chatbot) => chatbot.knowledge_base_id === row.id)
        .map((chatbot) => chatbot.id),
    ];
    return serializeKnowledgeBase(row, {
      sources: (sources || []).filter((s) => s.knowledge_base_id === row.id),
      linkedVoiceAgentIds: [...new Set(linkedVoiceAgentIds.filter(Boolean))],
      linkedChatbotIds: [...new Set(linkedChatbotIds.filter(Boolean))],
    });
  });
}

async function verifyKnowledgeBase(db, { organizationId, knowledgeBaseId }) {
  if (!isUuid(knowledgeBaseId)) return null;
  return await safeDb(
    "verify knowledge base",
    () =>
      db
        .from("knowledge_bases")
        .select("*")
        .eq("id", knowledgeBaseId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
    null,
  );
}

async function getAssignedKnowledgeBaseIdsForVoiceAgent(
  db,
  { organizationId, agentId, organization = null },
) {
  if (!organizationId || !agentId) return [];

  // Prefer the direct selected knowledge_base_id on the agent. The link table is
  // still supported, but it should never override a newer direct assignment after
  // a partial merge or failed sync. This prevents a stale link from routing an
  // agent back to an older knowledge base.
  const agent = await safeDb(
    "voice direct knowledge base",
    () =>
      db
        .from("voice_agents")
        .select("knowledge_base_id")
        .eq("id", agentId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
    null,
  );
  if (agent?.knowledge_base_id) return [agent.knowledge_base_id];

  const links = await safeDb(
    "voice assigned knowledge bases",
    () =>
      db
        .from("agent_knowledge_base_links")
        .select("knowledge_base_id")
        .eq("organization_id", organizationId)
        .eq("voice_agent_id", agentId)
        .order("is_primary", { ascending: false })
        .order("priority", { ascending: true }),
    [],
  );
  const ids = (links || []).map((l) => l.knowledge_base_id).filter(Boolean);
  if (ids.length) return ids;

  // Strict KB isolation: do not silently fall back to the onboarding/default KB.
  // An agent with no saved assignment should answer from no KB instead of leaking
  // another business/domain context.
  return [];
}

async function getAssignedKnowledgeBaseIdsForChatbot(
  db,
  { organizationId, chatbotId, voiceAgentId = null, organization = null },
) {
  if (!organizationId || !chatbotId) return [];

  // Same rule as voice agents: the direct chatbot.knowledge_base_id is the
  // source of truth for the selected chatbot. Stale link-table rows must not
  // cause cross-knowledge-base leakage.
  const chatbot = await safeDb(
    "chatbot direct knowledge base",
    () =>
      db
        .from("chatbots")
        .select("knowledge_base_id")
        .eq("id", chatbotId)
        .eq("organization_id", organizationId)
        .maybeSingle(),
    null,
  );
  if (chatbot?.knowledge_base_id) return [chatbot.knowledge_base_id];

  const links = await safeDb(
    "chatbot assigned knowledge bases",
    () =>
      db
        .from("chatbot_knowledge_base_links")
        .select("knowledge_base_id")
        .eq("organization_id", organizationId)
        .eq("chatbot_id", chatbotId)
        .order("is_primary", { ascending: false })
        .order("priority", { ascending: true }),
    [],
  );
  const ids = (links || []).map((l) => l.knowledge_base_id).filter(Boolean);
  if (ids.length) return ids;

  if (voiceAgentId) {
    const agentIds = await getAssignedKnowledgeBaseIdsForVoiceAgent(db, {
      organizationId,
      agentId: voiceAgentId,
      organization,
    });
    if (agentIds.length) return agentIds;
  }

  // Strict KB isolation: do not silently fall back to the onboarding/default KB.
  return [];
}

async function assignVoiceAgentKnowledgeBase(
  db,
  { organizationId, agentId, knowledgeBaseId },
) {
  const [agent, knowledgeBase] = await Promise.all([
    safeDb(
      "verify voice agent",
      () =>
        db
          .from("voice_agents")
          .select("id")
          .eq("id", agentId)
          .eq("organization_id", organizationId)
          .maybeSingle(),
      null,
    ),
    verifyKnowledgeBase(db, { organizationId, knowledgeBaseId }),
  ]);
  if (!agent?.id) return { ok: false, message: "Voice agent not found." };
  if (!knowledgeBase?.id)
    return { ok: false, message: "Knowledge base not found." };

  await safeDb("clear voice KB links", () =>
    db
      .from("agent_knowledge_base_links")
      .delete()
      .eq("organization_id", organizationId)
      .eq("voice_agent_id", agentId),
  );
  const link = await safeDb("insert voice KB link", () =>
    db
      .from("agent_knowledge_base_links")
      .insert({
        organization_id: organizationId,
        voice_agent_id: agentId,
        knowledge_base_id: knowledgeBaseId,
        is_primary: true,
        priority: 1,
      })
      .select()
      .single(),
  );
  await safeDb("update voice direct KB", () =>
    db
      .from("voice_agents")
      .update({
        knowledge_base_id: knowledgeBaseId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", agentId)
      .eq("organization_id", organizationId),
  );
  return { ok: true, link, knowledgeBase };
}

async function assignChatbotKnowledgeBase(
  db,
  { organizationId, chatbotId, knowledgeBaseId },
) {
  const [chatbot, knowledgeBase] = await Promise.all([
    safeDb(
      "verify chatbot",
      () =>
        db
          .from("chatbots")
          .select("id")
          .eq("id", chatbotId)
          .eq("organization_id", organizationId)
          .maybeSingle(),
      null,
    ),
    verifyKnowledgeBase(db, { organizationId, knowledgeBaseId }),
  ]);
  if (!chatbot?.id) return { ok: false, message: "Chatbot not found." };
  if (!knowledgeBase?.id)
    return { ok: false, message: "Knowledge base not found." };

  await safeDb("clear chatbot KB links", () =>
    db
      .from("chatbot_knowledge_base_links")
      .delete()
      .eq("organization_id", organizationId)
      .eq("chatbot_id", chatbotId),
  );
  const link = await safeDb("insert chatbot KB link", () =>
    db
      .from("chatbot_knowledge_base_links")
      .insert({
        organization_id: organizationId,
        chatbot_id: chatbotId,
        knowledge_base_id: knowledgeBaseId,
        is_primary: true,
        priority: 1,
      })
      .select()
      .single(),
  );
  await safeDb("update chatbot direct KB", () =>
    db
      .from("chatbots")
      .update({
        knowledge_base_id: knowledgeBaseId,
        // Legacy chatbot.faqs has no knowledge_base_id. Clear it on assignment
        // so deployed widgets cannot leak answers from a previous knowledge base.
        faqs: [],
        updated_at: new Date().toISOString(),
      })
      .eq("id", chatbotId)
      .eq("organization_id", organizationId),
  );
  return { ok: true, link, knowledgeBase };
}

async function findOrCreateKnowledgeSource(
  db,
  { organizationId, knowledgeBaseId, url, title = "", isPrimary = false },
) {
  const normalizedUrl = normalizeUrl(url);
  if (!normalizedUrl) return null;
  const domain = domainFromUrl(normalizedUrl);
  const existing = await safeDb(
    "find knowledge source",
    () =>
      db
        .from("knowledge_sources")
        .select("*")
        .eq("organization_id", organizationId)
        .eq("knowledge_base_id", knowledgeBaseId)
        .eq("normalized_url", normalizedUrl)
        .maybeSingle(),
    null,
  );
  if (existing?.id) return existing;
  return await safeDb(
    "create knowledge source",
    () =>
      db
        .from("knowledge_sources")
        .insert({
          organization_id: organizationId,
          knowledge_base_id: knowledgeBaseId,
          source_type: "website",
          url: normalizedUrl,
          normalized_url: normalizedUrl,
          domain,
          title: title || titleFromDomain(domain),
          is_primary: !!isPrimary,
          scrape_status: "pending",
        })
        .select()
        .single(),
    null,
  );
}

module.exports = {
  cleanText,
  isUuid,
  normalizeUrl,
  domainFromUrl,
  titleFromDomain,
  serializeKnowledgeBase,
  serializeKnowledgeSource,
  safeDb,
  ensureDefaultKnowledgeBaseForOrg,
  ensurePrimarySource,
  listKnowledgeBasesForOrg,
  verifyKnowledgeBase,
  getAssignedKnowledgeBaseIdsForVoiceAgent,
  getAssignedKnowledgeBaseIdsForChatbot,
  assignVoiceAgentKnowledgeBase,
  assignChatbotKnowledgeBase,
  findOrCreateKnowledgeSource,
};
