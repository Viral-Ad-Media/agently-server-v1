"use strict";

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function json(value) {
  if (!value || typeof value !== "object") return {};
  return value;
}

function timestamp(value) {
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function timeBucket(value, minutes = 15) {
  const size = minutes * 60 * 1000;
  return Math.floor(timestamp(value) / size);
}

function usageText(charge, event) {
  return `${charge?.provider || ""} ${charge?.service || ""} ${charge?.event_type || ""} ${charge?.unit || ""} ${event?.provider || ""} ${event?.service || ""} ${event?.event_type || ""}`.toLowerCase();
}

function eventMetadata(event, charge) {
  return { ...json(charge?.metadata), ...json(event?.metadata) };
}

function resolveCallId(event, charge) {
  const metadata = eventMetadata(event, charge);
  return (
    event?.call_id ||
    metadata.call_id ||
    metadata.callId ||
    metadata.call_record_id ||
    metadata.callRecordId ||
    null
  );
}

function resolveKnowledgeBaseId(event, charge) {
  const metadata = eventMetadata(event, charge);
  return (
    event?.knowledge_base_id ||
    metadata.knowledgeBaseId ||
    metadata.knowledge_base_id ||
    null
  );
}

function isNotification(text, event, charge) {
  const metadata = eventMetadata(event, charge);
  return (
    /notification|email|digest/.test(text) ||
    metadata.emailType === "notification_digest"
  );
}

function categoryFor(charge, event) {
  const text = usageText(charge, event);
  if (isNotification(text, event, charge)) return "notification";
  if (resolveCallId(event, charge)) return "call";
  if (/call|telephony|twilio|realtime|transcription|tts|runtime/.test(text)) {
    return "call";
  }
  if (/knowledge|scrape|sync|discovery|change_check/.test(text))
    return "knowledge";
  if (/voice_preview|preview/.test(text)) return "preview";
  if (/chat|message|conversation/.test(text)) return "chat";
  if (/number_purchase|phone_number|number_rental|rental/.test(text))
    return "number";
  return "platform";
}

function groupKey(charge, event) {
  const category = categoryFor(charge, event);
  const callId = resolveCallId(event, charge);
  if (callId) return `call:${callId}`;

  if (category === "knowledge") {
    const knowledgeBaseId = resolveKnowledgeBaseId(event, charge) || "unknown";
    const metadata = eventMetadata(event, charge);
    const jobId =
      metadata.jobId ||
      metadata.job_id ||
      metadata.discoveryId ||
      metadata.discovery_id;
    if (jobId) return `knowledge:${knowledgeBaseId}:${jobId}`;
    return `knowledge:${knowledgeBaseId}:${timeBucket(charge.created_at, 30)}`;
  }

  // Some legacy call components were metered before call_id was added. Keep
  // carrier, AI, TTS and runtime components from the same short call together.
  if (category === "call")
    return `legacy-call:${timeBucket(charge.created_at, 10)}`;

  return `${category}:${event?.external_id || charge.id}`;
}

function titleFor(category) {
  if (category === "call") return "Call usage";
  if (category === "knowledge") return "Knowledge Base sync";
  if (category === "preview") return "Voice preview";
  if (category === "chat") return "Website assistant usage";
  if (category === "number") return "Business-number usage";
  if (category === "notification") return "Notification delivery";
  return "Platform usage";
}

function formatQuantity(value) {
  const rounded = Math.round(number(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function subtitleFor(group) {
  if (group.category === "call") {
    const minutes = group.quantities.minute || 0;
    const seconds = group.quantities.second || group.quantities.seconds || 0;
    const durationMinutes = minutes || seconds / 60;
    if (durationMinutes > 0) {
      return `${formatQuantity(durationMinutes)} min call · all processing included`;
    }
    return "1 call · carrier, AI, voice and runtime included";
  }

  if (group.category === "knowledge") {
    const pages =
      group.quantities.page ||
      group.quantities.pages ||
      group.quantities.url ||
      group.quantities.discovery ||
      0;
    return pages > 0
      ? `${formatQuantity(pages)} page${pages === 1 ? "" : "s"} · discovery and sync included`
      : "Website discovery and sync";
  }

  const units = Object.entries(group.quantities).filter(
    ([, value]) => value > 0,
  );
  if (units.length) {
    const [unit, quantity] = units[0];
    const normalized = unit === "characters" ? "characters" : unit;
    return `${formatQuantity(quantity)} ${normalized}`;
  }
  return "Usage";
}

function buildCustomerBillingActivity({
  charges = [],
  usageEvents = [],
  transactions = [],
} = {}) {
  const eventById = new Map(
    (usageEvents || []).map((event) => [event.id, event]),
  );
  const transactionById = new Map(
    (transactions || []).map((tx) => [tx.id, tx]),
  );
  const groups = new Map();
  const linkedTransactionIds = new Set();

  for (const charge of charges || []) {
    const event = eventById.get(charge.usage_event_id) || null;
    const amount = number(charge.customer_charge_usd);
    const text = usageText(charge, event);
    const billable = event ? event.billable !== false : amount > 0;

    // Non-billable operational telemetry is useful to admins but should never
    // fill the tenant's wallet history with $0.00 email/discovery rows.
    if (amount <= 0 || !billable) continue;

    const key = groupKey(charge, event);
    const category = categoryFor(charge, event);
    const current = groups.get(key) || {
      id: key,
      category,
      createdAt: charge.created_at,
      amountUsd: 0,
      quantities: {},
      transaction: null,
    };

    current.amountUsd += amount;
    if (timestamp(charge.created_at) > timestamp(current.createdAt)) {
      current.createdAt = charge.created_at;
    }
    const unit = String(charge.unit || event?.unit || "unit").toLowerCase();
    current.quantities[unit] =
      number(current.quantities[unit]) + number(charge.quantity);

    if (charge.wallet_transaction_id) {
      linkedTransactionIds.add(charge.wallet_transaction_id);
      const tx = transactionById.get(charge.wallet_transaction_id) || null;
      if (
        !current.transaction ||
        timestamp(tx?.created_at) > timestamp(current.transaction?.created_at)
      ) {
        current.transaction = tx;
      }
    }
    groups.set(key, current);
  }

  const activity = [...groups.values()].map((group) => ({
    id: `usage-${group.id}`,
    createdAt: group.createdAt,
    title: titleFor(group.category),
    subtitle: subtitleFor(group),
    amountUsd: -Math.abs(number(group.amountUsd)),
    tone: "debit",
    balanceAfterUsd:
      group.transaction?.balance_after_usd == null
        ? null
        : number(group.transaction.balance_after_usd),
  }));

  for (const tx of transactions || []) {
    if (linkedTransactionIds.has(tx.id)) continue;
    const amount = number(tx.amount_usd);
    // Do not show internal zero-value bookkeeping transactions.
    if (amount === 0) continue;
    const raw = `${tx.transaction_type || ""} ${tx.source || ""}`.toLowerCase();
    activity.push({
      id: `tx-${tx.id}`,
      createdAt: tx.created_at,
      title: raw.includes("refund")
        ? "Credit refund"
        : amount > 0
          ? "Credit added"
          : "Wallet adjustment",
      subtitle: tx.source || "wallet",
      amountUsd: amount,
      tone: amount > 0 ? "credit" : "debit",
      balanceAfterUsd:
        tx.balance_after_usd == null ? null : number(tx.balance_after_usd),
    });
  }

  return activity.sort(
    (a, b) => timestamp(b.createdAt) - timestamp(a.createdAt),
  );
}

module.exports = { buildCustomerBillingActivity };
