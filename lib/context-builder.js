"use strict";

function uniq(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function normalizeFaqs(rows) {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      question: String(row?.question || "").trim(),
      answer: String(row?.answer || "").trim(),
    }))
    .filter((row) => row.question && row.answer);
}

function normalizeChunk(row) {
  return {
    id: row?.id || null,
    content: String(row?.content || "").trim(),
    sourceUrl: String(row?.source_url || "").trim(),
    sourceTitle: String(row?.source_title || row?.source_url || "").trim(),
    chatbotId: row?.chatbot_id || null,
    voiceAgentId: row?.voice_agent_id || null,
    organizationId: row?.organization_id || null,
    knowledgeBaseId: row?.knowledge_base_id || null,
  };
}

function tokenize(text) {
  return uniq(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s:/._-]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2)
      .slice(0, 24),
  );
}

// --- Fuzzy (typo-tolerant) matching -----------------------------------------
// Same general, tenant-agnostic helper used everywhere else in the codebase
// this pattern appears (assistant-intelligence.js, knowledge-retrieval.js,
// and agently-ws-server/lib/context-builder.js).
function levenshteinWithinBound(a, b, maxDist) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > maxDist) return maxDist + 1;
  let prevRow = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prevRow[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const currRow = new Array(b.length + 1);
    currRow[0] = i;
    let rowMin = currRow[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        prevRow[j] + 1,
        currRow[j - 1] + 1,
        prevRow[j - 1] + cost,
      );
      if (currRow[j] < rowMin) rowMin = currRow[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    prevRow = currRow;
  }
  return prevRow[b.length];
}

function fuzzyMaxDistFor(len) {
  if (len >= 9) return 2;
  if (len >= 5) return 1;
  return 0;
}

function fuzzyTokenMatches(token, haystackWords) {
  const maxDist = fuzzyMaxDistFor(token.length);
  if (maxDist === 0 || !haystackWords || !haystackWords.length) return false;
  let checked = 0;
  for (const word of haystackWords) {
    if (Math.abs(word.length - token.length) > maxDist) continue;
    if (++checked > 200) break;
    if (levenshteinWithinBound(token, word, maxDist) <= maxDist) return true;
  }
  return false;
}

function scoreText(text, keywords) {
  const haystack = String(text || "").toLowerCase();
  if (!haystack) return 0;
  let score = 0;
  let haystackWords = null;
  for (const keyword of keywords) {
    if (!keyword) continue;
    if (haystack.includes(keyword)) {
      score += 2;
      continue;
    }
    const parts = keyword.split(/[-_/]/).filter(Boolean);
    if (parts.length > 1 && parts.some((part) => haystack.includes(part))) {
      score += 1;
      continue;
    }
    if (!haystackWords) {
      haystackWords = [
        ...new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean)),
      ];
    }
    if (fuzzyTokenMatches(keyword, haystackWords)) score += 1;
  }
  return score;
}

function chooseRelevantChunks(rows, query, max = 5) {
  const chunks = (rows || []).map(normalizeChunk).filter((row) => row.content);
  if (chunks.length === 0) return [];
  const keywords = tokenize(query);
  if (keywords.length === 0) return chunks.slice(0, max);

  const ranked = chunks
    .map((chunk) => ({
      chunk,
      score: scoreText(
        chunk.content + "\n" + chunk.sourceTitle + "\n" + chunk.sourceUrl,
        keywords,
      ),
    }))
    .sort(
      (a, b) =>
        b.score - a.score || a.chunk.content.length - b.chunk.content.length,
    );

  const filtered = ranked
    .filter((entry) => entry.score > 0)
    .slice(0, max)
    .map((entry) => entry.chunk);
  return filtered.length > 0 ? filtered : chunks.slice(0, max);
}

function chooseRelevantLinks(rows, query, max = 6) {
  const keywords = tokenize(query);
  const candidates = [];
  const seen = new Set();
  for (const row of rows || []) {
    const chunk = normalizeChunk(row);
    if (!chunk.sourceUrl) continue;
    if (seen.has(chunk.sourceUrl)) continue;
    seen.add(chunk.sourceUrl);
    const label = chunk.sourceTitle || chunk.sourceUrl;
    const score = scoreText(
      label + "\n" + chunk.content + "\n" + chunk.sourceUrl,
      keywords,
    );
    candidates.push({ label, url: chunk.sourceUrl, score });
  }
  const ranked = candidates.sort(
    (a, b) => b.score - a.score || a.label.length - b.label.length,
  );
  const chosen = ranked.filter((item) => item.score > 0).slice(0, max);
  return chosen.length > 0
    ? chosen
    : ranked.slice(0, Math.min(max, ranked.length));
}

function cleanId(value) {
  return String(value || "").trim();
}

async function safeQuery(label, fn, fallback) {
  try {
    const result = await fn();
    if (result?.error) {
      console.warn(
        `[context-builder] ${label}:`,
        result.error.message || result.error,
      );
      return fallback;
    }
    return result?.data ?? fallback;
  } catch (err) {
    console.warn(`[context-builder] ${label}:`, err.message || String(err));
    return fallback;
  }
}

async function resolveAssignedKnowledgeBaseId(db, orgId, agentRow) {
  if (!agentRow?.id) return "";
  const direct = cleanId(
    agentRow?.knowledge_base_id || agentRow?.knowledgeBaseId,
  );
  if (direct) return direct;
  const ignoredLinks = await safeQuery(
    "agent_knowledge_base_links diagnostic only",
    () =>
      db
        .from("agent_knowledge_base_links")
        .select("knowledge_base_id")
        .eq("organization_id", orgId)
        .eq("voice_agent_id", agentRow.id)
        .limit(5),
    [],
  );
  if ((ignoredLinks || []).length) {
    console.warn(
      "[context-builder] legacy KB links ignored; direct voice_agents.knowledge_base_id is required",
      {
        orgId,
        agentId: agentRow.id,
        ignoredLinkCount: ignoredLinks.length,
      },
    );
  }
  return "";
}

function buildFormattingRules() {
  return [
    "FORMAT RULES:",
    "- Use clear, polished English with proper punctuation.",
    "- Use short paragraphs.",
    "- Use **bold headings** only when headings genuinely help.",
    "- Use bullet lists only for options or steps.",
    "- When sharing a URL, format it as a markdown link like [About page](https://example.com/about).",
  ].join("\n");
}

function buildChatPrompt({
  businessName,
  customPrompt,
  faqs,
  chunks,
  links,
  collectLeads,
}) {
  const parts = [];
  parts.push(
    `You are the website assistant for ${businessName || "this business"}.`,
  );
  parts.push(
    "Answer using only the information relevant to the user's request. Do not dump unrelated FAQs or unrelated website text.",
  );
  parts.push(
    "When the user is specific, give the exact answer or direct page link. When the user is broad or there are several plausible matches, present the best options and ask one short clarifying question so the user can choose.",
  );
  parts.push(
    "Never say something is 'not available,' 'not in my knowledge base,' or similar — instead help with the closest genuinely relevant alternative, framed as a real answer, not an apology.",
  );
  parts.push(
    "If the user asks for a list, give the actual specific items by name, not just a category summary. If a specific product/service has a URL, include it directly as a link; if the user wants to buy/checkout, link the specific product page.",
  );
  parts.push(
    "If useful links are available, include them directly. Prefer the most relevant links first.",
  );
  if (collectLeads) {
    parts.push(
      "If the user shows strong purchase, booking, pricing, or contact intent and the information is not fully resolved in chat, it is acceptable to ask for contact details so the team can follow up.",
    );
  }
  if (customPrompt) parts.push(`CUSTOM INSTRUCTIONS:\n${customPrompt}`);
  if ((faqs || []).length) {
    parts.push(
      "FAQS:\n" +
        faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n"),
    );
  }
  if ((chunks || []).length) {
    parts.push(
      "RELEVANT WEBSITE KNOWLEDGE:\n" +
        chunks
          .map((chunk, index) => `[Source ${index + 1}] ${chunk.content}`)
          .join("\n\n---\n\n"),
    );
  }
  if ((links || []).length) {
    parts.push(
      "RELEVANT PAGES:\n" +
        links.map((link) => `- ${link.label}: ${link.url}`).join("\n"),
    );
  }
  parts.push(buildFormattingRules());
  return parts.join("\n\n");
}

function agentBusinessName(agentRow = {}) {
  return String(
    agentRow.knowledge_base_business_name ||
      agentRow.knowledge_base_name ||
      agentRow.business_name ||
      agentRow.businessName ||
      agentRow.name ||
      "this business",
  )
    .replace(/\s+/g, " ")
    .trim();
}

function buildInboundVoicePrompt({ agentRow, faqs, relevantKnowledge }) {
  const businessName = agentBusinessName(agentRow);
  const captureFields = Array.isArray(agentRow?.data_capture_fields)
    ? agentRow.data_capture_fields.join(", ")
    : "name, phone, email, reason";
  const parts = [
    `You are ${agentRow?.name || "the AI receptionist"}, an AI ${agentRow?.tone || "Professional"} receptionist for ${businessName}.`,
    "The selected Knowledge Base business identity overrides the parent workspace/organization name.",
  ];
  parts.push(
    "This is an inbound voice conversation. Be concise, natural, helpful, and speak in short phone-friendly sentences.",
  );
  parts.push(
    `Business hours: ${agentRow?.business_hours || "9am-5pm Monday-Friday"}.`,
  );
  parts.push(`Capture the caller's ${captureFields} when appropriate.`);
  parts.push(
    "If you can answer the caller accurately from the available information, do so. Match their wording loosely (typos, mishearing, abbreviations) against the knowledge below before concluding something isn't covered. If you genuinely cannot answer, never say you lack information or mention a knowledge base — warmly offer to take a message and say someone can follow up.",
  );
  parts.push(
    "If asked for a list, name the actual specific items. If a specific product/service has a link and the caller wants to buy/checkout, offer to send that specific link.",
  );
  parts.push(
    'If the caller asks for a human or transfer, you may offer transfer when escalation is configured. End the transfer response with {"action":"transfer"}.',
  );
  if ((faqs || []).length) {
    parts.push(
      "VOICE FAQS:\n" +
        faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n"),
    );
  }
  if (relevantKnowledge)
    parts.push(`Relevant business knowledge:\n${relevantKnowledge}`);
  parts.push(
    'On the final line of your final reply when the conversation is ending, output captured details as JSON exactly like {"captured": {"name": "...", "phone": "...", "email": "...", "reason": "..."}}.',
  );
  return parts.join("\n\n");
}

function buildOutboundVoicePrompt({
  agentRow,
  faqs,
  relevantKnowledge,
  callPurposes,
  assignmentContext,
}) {
  const businessName = agentBusinessName(agentRow);
  const parts = [
    `You are ${agentRow?.name || "the AI agent"}, an AI ${agentRow?.tone || "Professional"} outbound caller for ${businessName}.`,
    "The selected Knowledge Base business identity overrides the parent workspace/organization name.",
  ];
  parts.push(
    "This is an outbound voice conversation. Open clearly, explain why you are calling, and keep the conversation concise and respectful.",
  );
  if ((callPurposes || []).length) {
    parts.push(
      "CALL PURPOSES:\n" + callPurposes.map((item) => `- ${item}`).join("\n"),
    );
  }
  if (assignmentContext)
    parts.push(`LEAD-SPECIFIC CONTEXT:\n${assignmentContext}`);
  if ((faqs || []).length) {
    parts.push(
      "SUPPORTING FAQS:\n" +
        faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n"),
    );
  }
  if (relevantKnowledge)
    parts.push(`Relevant business knowledge:\n${relevantKnowledge}`);
  parts.push(
    "Do not read large blocks of information. Use only the parts that help this call objective.",
  );
  parts.push(
    "Match the recipient's wording loosely (typos, mishearing) against the knowledge above before concluding something isn't covered. If you genuinely cannot answer, never say you lack information or mention a knowledge base — warmly offer to have someone follow up.",
  );
  parts.push(
    'On the final line of your final reply when the conversation is ending, output captured details as JSON exactly like {"captured": {"name": "...", "phone": "...", "email": "...", "reason": "..."}}.',
  );
  return parts.join("\n\n");
}

async function loadChatbotContext(db, chatbotId, query) {
  const { data: chatbot } = await db
    .from("chatbots")
    .select(
      "id, organization_id, voice_agent_id, header_title, custom_prompt, faqs, collect_leads",
    )
    .eq("id", chatbotId)
    .single();
  if (!chatbot) return null;

  const faqJson = normalizeFaqs(
    Array.isArray(chatbot.faqs) ? chatbot.faqs : [],
  );
  const chunkQueries = [
    db
      .from("knowledge_chunks")
      .select(
        "id, content, source_url, source_title, chatbot_id, voice_agent_id",
      )
      .eq("chatbot_id", chatbot.id)
      .limit(120),
  ];
  if (chatbot.voice_agent_id) {
    chunkQueries.push(
      db
        .from("knowledge_chunks")
        .select(
          "id, content, source_url, source_title, chatbot_id, voice_agent_id",
        )
        .eq("voice_agent_id", chatbot.voice_agent_id)
        .limit(120),
    );
  }
  const results = await Promise.all(chunkQueries);
  const rawChunks = results.flatMap((result) => result.data || []);
  const relevantChunks = chooseRelevantChunks(rawChunks, query, 5);
  const links = chooseRelevantLinks(rawChunks, query, 6);

  return {
    chatbot,
    faqs: faqJson,
    chunks: relevantChunks,
    links,
    systemPrompt: buildChatPrompt({
      businessName: chatbot.header_title,
      customPrompt: chatbot.custom_prompt,
      faqs: faqJson,
      chunks: relevantChunks,
      links,
      collectLeads: chatbot.collect_leads,
    }),
  };
}

async function loadVoiceContext(db, orgId, agentRow, query, extra = {}) {
  if (!agentRow) return null;
  const knowledgeBaseId = await resolveAssignedKnowledgeBaseId(
    db,
    orgId,
    agentRow,
  );
  let faqs = [];
  let allChunks = [];
  let selectedKnowledgeBase = null;

  if (knowledgeBaseId) {
    selectedKnowledgeBase = await safeQuery(
      "selected knowledge_bases by id",
      () =>
        db
          .from("knowledge_bases")
          .select(
            "id,name,business_name,description,industry,primary_url,domain,metadata",
          )
          .eq("organization_id", orgId)
          .eq("id", knowledgeBaseId)
          .maybeSingle(),
      null,
    );
    if (selectedKnowledgeBase) {
      agentRow = {
        ...agentRow,
        knowledge_base_name: selectedKnowledgeBase.name || "",
        knowledge_base_business_name:
          selectedKnowledgeBase.business_name ||
          selectedKnowledgeBase.name ||
          "",
      };
    }
    const [faqRows, chunkRows] = await Promise.all([
      safeQuery(
        "faqs by selected knowledge_base_id",
        () =>
          db
            .from("faqs")
            .select("*")
            .eq("organization_id", orgId)
            .eq("knowledge_base_id", knowledgeBaseId)
            .limit(80),
        [],
      ),
      safeQuery(
        "knowledge_chunks by selected knowledge_base_id",
        () =>
          db
            .from("knowledge_chunks")
            .select("*")
            .eq("organization_id", orgId)
            .eq("knowledge_base_id", knowledgeBaseId)
            .limit(160),
        [],
      ),
    ]);
    faqs = normalizeFaqs(faqRows || []);
    allChunks = (chunkRows || []).filter(
      (row) => cleanId(row.knowledge_base_id) === knowledgeBaseId,
    );
  } else {
    // Strict KB isolation: if the agent has no saved KB assignment, do not load
    // legacy voice_agent/chatbot/org chunks. This prevents onboarding KB leakage.
    faqs = [];
    allChunks = [];
  }

  const relevantChunks = chooseRelevantChunks(allChunks, query, 4);
  const relevantKnowledge = relevantChunks
    .map((chunk) => chunk.content)
    .join("\n\n---\n\n");
  const callPurposes = Array.isArray(agentRow.call_purposes)
    ? agentRow.call_purposes
        .map((item) => String(item || "").trim())
        .filter(Boolean)
    : [];
  const assignmentContext = String(extra.assignmentContext || "").trim();
  const systemPrompt =
    agentRow.direction === "outbound"
      ? buildOutboundVoicePrompt({
          agentRow,
          faqs,
          relevantKnowledge,
          callPurposes,
          assignmentContext,
        })
      : buildInboundVoicePrompt({ agentRow, faqs, relevantKnowledge });

  return {
    faqs,
    relevantChunks,
    relevantKnowledge,
    callPurposes,
    systemPrompt,
    selectedKnowledgeBaseId: knowledgeBaseId || null,
    selectedKnowledgeBase,
  };
}

module.exports = {
  tokenize,
  chooseRelevantChunks,
  chooseRelevantLinks,
  loadChatbotContext,
  loadVoiceContext,
  buildChatPrompt,
};
