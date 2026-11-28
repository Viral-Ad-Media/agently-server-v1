"use strict";

/**
 * BUSINESS VERIFICATION — the paperwork some countries demand before a phone
 * number can be issued there (UK, Australia, Ireland, New Zealand, ...).
 *
 * The owner sees one Agently flow: fill in business details, add an address,
 * upload the documents the country asks for, submit, watch the status, get
 * notified, buy the number with one click. The carrier underneath (Twilio
 * Regulatory Compliance "bundles") never appears in the product.
 *
 * Requirements are read live from the carrier's regulation for the country
 * and number type, so the form follows the carrier's rules as they change
 * instead of a hard-coded list per country.
 *
 * Files go straight to the carrier and are NOT stored by Agently: a passport
 * or utility bill is a liability to keep, and nothing here needs it again.
 * Only the file name, type and the carrier's document id are recorded.
 *
 * Carrier objects live in the tenant's own sub-account, because a number can
 * only be bought with a bundle that belongs to the same account.
 */

const { getSupabase } = require("./supabase");
const { countryName } = require("./number-countries");

const REGULATION_BASE = "https://numbers.twilio.com/v2/RegulatoryCompliance";
const UPLOAD_BASE = "https://numbers-upload.twilio.com/v2/RegulatoryCompliance";
const API_BASE = "https://api.twilio.com/2010-04-01";

/** Countries whose numbers need no paperwork. Skips a network call. */
const NO_VERIFICATION = new Set(["US", "CA"]);
const REQUIREMENTS_CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/jpg",
]);

const requirementsCache = new Map();
const subaccountTokenCache = new Map();

const OPEN_STATUSES = ["draft", "needs_changes", "submitted", "in_review"];
const IN_FLIGHT = ["submitted", "in_review"];

// ── small helpers ───────────────────────────────────────────

function masterCreds() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || "").trim();
  const token = String(process.env.TWILIO_AUTH_TOKEN || "").trim();
  if (!sid || !token) {
    throw Object.assign(new Error("Phone provider is not configured."), {
      status: 503,
      code: "CARRIER_NOT_CONFIGURED",
    });
  }
  return { sid, token };
}

function basicAuth({ sid, token }) {
  return "Basic " + Buffer.from(`${sid}:${token}`).toString("base64");
}

function normalizeNumberType(value) {
  const raw = String(value || "local")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (raw === "tollfree" || raw === "toll-free") return "toll-free";
  if (raw === "mobile") return "mobile";
  if (raw === "national") return "national";
  return "local";
}

function normalizeIso(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

// Carrier error codes the owner can act on, in plain words.
const FRIENDLY_CARRIER_ERRORS = {
  21628:
    "We couldn't verify that address. Check the street, city, state and postcode match your official business address exactly.",
  21629:
    "That address is outside the area this number type requires. Use an address in the same country.",
  21615: "This number type needs a local address in the same country.",
};

function carrierError(data, status, fallback) {
  const message =
    FRIENDLY_CARRIER_ERRORS[Number(data?.code)] ||
    (data && (data.message || data.detail)) ||
    fallback ||
    "Request failed.";
  return Object.assign(new Error(message), {
    status: status >= 500 ? 502 : 400,
    code: "VERIFICATION_PROVIDER_ERROR",
    providerCode: data?.code || null,
    providerStatus: status,
  });
}

async function carrierFetch(url, { method = "GET", creds, form, multipart } = {}) {
  const headers = { Authorization: basicAuth(creds) };
  let body;
  if (multipart) {
    body = multipart;
  } else if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value === undefined || value === null || value === "") continue;
      params.append(key, String(value));
    }
    body = params.toString();
  }
  const response = await fetch(url, { method, headers, body });
  if (response.status === 204) return null;
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text.slice(0, 300) };
  }
  if (!response.ok) throw carrierError(data, response.status);
  return data;
}

/** Credentials for a tenant sub-account. The parent account can read them. */
async function subaccountCreds(accountSid) {
  const master = masterCreds();
  if (!accountSid || accountSid === master.sid) return master;
  const cached = subaccountTokenCache.get(accountSid);
  if (cached) return cached;
  const account = await carrierFetch(`${API_BASE}/Accounts/${accountSid}.json`, {
    creds: master,
  });
  if (!account?.auth_token) {
    throw Object.assign(new Error("Could not open the workspace's phone account."), {
      status: 502,
      code: "CARRIER_ACCOUNT_UNAVAILABLE",
    });
  }
  const creds = { sid: accountSid, token: account.auth_token };
  subaccountTokenCache.set(accountSid, creds);
  return creds;
}

// ── requirements ────────────────────────────────────────────

/** Carrier wording that should never reach the owner. */
function plainHelp(text) {
  return String(text || "")
    .replace(/\bRC Bundle\b/gi, "verification")
    .replace(/\bregulatory bundle\b/gi, "verification")
    .replace(/a number which you've acquired from a CPaaS provider/gi, "a number from a phone or messaging service")
    .replace(/\bCPaaS\b/g, "phone-service")
    .replace(/\bTwilio\b/gi, "the phone carrier")
    .trim();
}

/** "=~ '^(A|B|C)$'" -> ["A","B","C"] */
function enumOptions(constraint) {
  const match = String(constraint || "").match(/\^\(([^)]+)\)\$/);
  if (!match) return null;
  return match[1].split("|").map((value) => value.trim()).filter(Boolean);
}

const AUTO_DOCUMENT_FIELDS = new Set(["address_sids", "business_name"]);

/**
 * Turn the carrier's regulation into the form the owner fills in. Pure, so it
 * is unit-tested against recorded regulations.
 */
function normalizeRegulation(regulation, { country, numberType }) {
  const requirements = regulation?.requirements || {};
  const endUser = (requirements.end_user || [])[0] || null;
  const businessFields = (endUser?.detailed_fields || []).map((field) => ({
    key: field.machine_name,
    label: String(field.friendly_name || field.machine_name).replace(/\s*\(optional\)\s*$/i, ""),
    help: plainHelp(field.description),
    required: Boolean(String(field.constraint || "").trim()),
    options: enumOptions(field.constraint),
  }));

  const documents = [];
  let needsAddress = false;
  const addressNotes = [];
  for (const group of requirements.supporting_document || []) {
    for (const requirement of group || []) {
      const options = (requirement.accepted_documents || []).map((doc) => {
        const fields = (doc.detailed_fields || []).map((field) => ({
          key: field.machine_name,
          label: field.friendly_name || field.machine_name,
          help: plainHelp(field.description),
          auto: AUTO_DOCUMENT_FIELDS.has(field.machine_name),
        }));
        if (fields.some((field) => field.key === "address_sids")) needsAddress = true;
        return {
          type: doc.type,
          label: doc.name || doc.type,
          // A "business_address" document is the address itself; nothing to upload.
          needsFile: doc.type !== "business_address",
          fields,
        };
      });
      if (options.some((option) => option.fields.some((f) => f.key === "address_sids"))) {
        if (requirement.description) addressNotes.push(plainHelp(requirement.description));
      }
      documents.push({
        key: requirement.requirement_name || requirement.name,
        label: requirement.name || requirement.requirement_name,
        help: plainHelp(requirement.description),
        options,
        // Satisfied with the address alone when that is an accepted option.
        addressOnly: options.some((option) => !option.needsFile),
      });
    }
  }

  /*
   * The carrier allows ONE document of each type per bundle, and the same type
   * often satisfies several requirements (an AU company extract proves the
   * name, the address and the ID number). So every option of a type carries
   * the union of the fields all its requirements need, and one upload of that
   * type covers all of them.
   */
  const fieldsByType = new Map();
  for (const doc of documents) {
    for (const option of doc.options) {
      const known = fieldsByType.get(option.type) || new Map();
      for (const field of option.fields) known.set(field.key, field);
      fieldsByType.set(option.type, known);
    }
  }
  for (const doc of documents) {
    for (const option of doc.options) {
      option.fields = [...(fieldsByType.get(option.type) || new Map()).values()];
    }
  }

  const required = Boolean(businessFields.length || documents.length);
  return {
    country,
    countryName: countryName(country),
    numberType,
    regulationSid: regulation?.sid || null,
    required,
    businessFields,
    needsAddress,
    addressNote: addressNotes[0] || "",
    documents,
  };
}

async function getRequirements(country, numberType = "local") {
  const iso = normalizeIso(country);
  const type = normalizeNumberType(numberType);
  if (NO_VERIFICATION.has(iso)) {
    return {
      country: iso,
      countryName: countryName(iso),
      numberType: type,
      regulationSid: null,
      required: false,
      businessFields: [],
      needsAddress: false,
      addressNote: "",
      documents: [],
    };
  }
  const key = `${iso}:${type}`;
  const cached = requirementsCache.get(key);
  if (cached && Date.now() - cached.at < REQUIREMENTS_CACHE_MS) return cached.value;

  const url =
    `${REGULATION_BASE}/Regulations?IsoCountry=${encodeURIComponent(iso)}` +
    `&NumberType=${encodeURIComponent(type)}&EndUserType=business&IncludeConstraints=true&PageSize=5`;
  const data = await carrierFetch(url, { creds: masterCreds() });
  const regulation = (data?.results || [])[0] || null;
  const value = normalizeRegulation(regulation, { country: iso, numberType: type });
  requirementsCache.set(key, { at: Date.now(), value });
  return value;
}

// ── records ─────────────────────────────────────────────────

function isTableMissing(error) {
  return Boolean(error && ["42P01", "PGRST205"].includes(error.code));
}

function migrationRequired() {
  return Object.assign(
    new Error(
      "Business verification is being set up. Please try again shortly.",
    ),
    { status: 503, code: "MIGRATION_REQUIRED" },
  );
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    country: row.iso_country,
    countryName: countryName(row.iso_country),
    numberType: row.number_type,
    status: row.status,
    businessName: row.business_name || "",
    details: row.details || {},
    address: row.address || {},
    documents: (row.documents || []).map((doc) => ({
      requirement: doc.requirement,
      type: doc.type,
      label: doc.label,
      fileName: doc.fileName || null,
      uploadedAt: doc.uploadedAt || null,
    })),
    issues: row.issues || [],
    rejectionReason: row.rejection_reason || null,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function loadVerification(db, organizationId, id) {
  const { data, error } = await db
    .from("business_verifications")
    .select("*")
    .eq("id", id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) {
    if (isTableMissing(error)) throw migrationRequired();
    throw error;
  }
  if (!data) {
    throw Object.assign(new Error("Verification not found."), { status: 404 });
  }
  return data;
}

async function updateRow(db, id, patch) {
  const { data, error } = await db
    .from("business_verifications")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function listVerifications(db, organizationId) {
  const { data, error } = await db
    .from("business_verifications")
    .select("*")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    if (isTableMissing(error)) return [];
    throw error;
  }
  return data || [];
}

/** The approved verification a purchase in this country/type can use. */
async function findApprovedVerification(db, organizationId, country, numberType) {
  const { data, error } = await db
    .from("business_verifications")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("iso_country", normalizeIso(country))
    .eq("number_type", normalizeNumberType(numberType))
    .eq("status", "approved")
    .order("decided_at", { ascending: false })
    .limit(1);
  if (error) {
    if (isTableMissing(error)) return null;
    throw error;
  }
  return (data || [])[0] || null;
}

// ── validation ──────────────────────────────────────────────

function cleanText(value, max = 300) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function validateDetails(requirements, details = {}) {
  const clean = {};
  const missing = [];
  for (const field of requirements.businessFields) {
    const value = cleanText(details[field.key]);
    if (value) {
      if (field.options && !field.options.includes(value)) {
        missing.push(`${field.label}: choose one of ${field.options.join(", ")}`);
        continue;
      }
      clean[field.key] = value;
    } else if (field.required) {
      missing.push(field.label);
    }
  }
  if (clean.phone_number && !/^\+[1-9]\d{1,14}$/.test(clean.phone_number)) {
    missing.push("Phone number must be in international format, e.g. +447700900123");
  }
  if (clean.email && !/^\S+@\S+\.\S+$/.test(clean.email)) {
    missing.push("Email address is not valid");
  }
  return { clean, missing };
}

function validateAddress(address = {}, country) {
  const clean = {
    street: cleanText(address.street, 200),
    street2: cleanText(address.street2, 200),
    city: cleanText(address.city, 120),
    region: cleanText(address.region, 120),
    postalCode: cleanText(address.postalCode, 40),
    country: normalizeIso(address.country || country),
  };
  const missing = [];
  if (!clean.street) missing.push("Street address");
  if (!clean.city) missing.push("City");
  if (!clean.region) missing.push("State / county / region");
  if (!clean.postalCode) missing.push("Postcode");
  if (!/^[A-Z]{2}$/.test(clean.country)) missing.push("Country");
  return { clean, missing };
}

function invalid(messages) {
  return Object.assign(
    new Error(`Please complete: ${messages.join("; ")}.`),
    { status: 400, code: "VERIFICATION_INCOMPLETE", details: { missing: messages } },
  );
}

// ── carrier steps ───────────────────────────────────────────

async function createCarrierAddress(accountSid, businessName, address) {
  const creds = masterCreds();
  const created = await carrierFetch(`${API_BASE}/Accounts/${accountSid}/Addresses.json`, {
    method: "POST",
    creds,
    form: {
      CustomerName: businessName,
      FriendlyName: `${businessName} business address`.slice(0, 64),
      Street: address.street,
      StreetSecondary: address.street2,
      City: address.city,
      Region: address.region,
      PostalCode: address.postalCode,
      IsoCountry: address.country,
    },
  });
  return created.sid;
}

function documentAttributes(option, row, fields = {}) {
  const attributes = {};
  for (const field of option.fields) {
    if (field.key === "address_sids") {
      if (row.provider_address_sid) attributes.address_sids = [row.provider_address_sid];
    } else if (field.key === "business_name") {
      attributes.business_name = row.business_name || row.details?.business_name || "";
    } else {
      const value = cleanText(fields[field.key] ?? row.details?.[field.key]);
      if (value) attributes[field.key] = value;
    }
  }
  return attributes;
}

// ── lifecycle ───────────────────────────────────────────────

/**
 * Step 1: the owner's business details and address. Creates the address with
 * the carrier straight away because uploaded documents must reference it.
 */
async function createVerification({
  db = getSupabase(),
  organizationId,
  organizationName,
  userId,
  country,
  numberType,
  details,
  address,
  ensureAccount,
}) {
  const iso = normalizeIso(country);
  const type = normalizeNumberType(numberType);
  const requirements = await getRequirements(iso, type);
  if (!requirements.required) {
    throw Object.assign(
      new Error(`${countryName(iso)} numbers don't need business verification.`),
      { status: 400, code: "VERIFICATION_NOT_NEEDED" },
    );
  }

  const { clean: cleanDetails, missing } = validateDetails(requirements, details);
  const businessName =
    cleanDetails.business_name || cleanText(details?.business_name) || cleanText(organizationName);
  if (!businessName) missing.unshift("Business name");
  let cleanAddress = {};
  if (requirements.needsAddress) {
    const result = validateAddress(address, iso);
    cleanAddress = result.clean;
    missing.push(...result.missing);
  }
  if (missing.length) throw invalid(missing);

  const account = await ensureAccount();
  let addressSid = null;
  if (requirements.needsAddress) {
    addressSid = await createCarrierAddress(account.account_sid, businessName, cleanAddress);
  }

  const { data, error } = await db
    .from("business_verifications")
    .insert({
      organization_id: organizationId,
      iso_country: iso,
      number_type: type,
      status: "draft",
      business_name: businessName,
      details: cleanDetails,
      address: cleanAddress,
      documents: [],
      regulation_sid: requirements.regulationSid,
      provider_account_sid: account.account_sid,
      provider_address_sid: addressSid,
      created_by: userId || null,
    })
    .select("*")
    .single();
  if (error) {
    if (isTableMissing(error)) throw migrationRequired();
    throw error;
  }
  return data;
}

/** Step 2: one uploaded document. Replaces an earlier upload for the same requirement. */
async function uploadDocument({
  db = getSupabase(),
  organizationId,
  id,
  requirementKey,
  documentType,
  fields,
  fileName,
  mimeType,
  buffer,
}) {
  const row = await loadVerification(db, organizationId, id);
  if (!["draft", "needs_changes"].includes(row.status)) {
    throw Object.assign(new Error("This verification can no longer be changed."), {
      status: 409,
    });
  }
  const requirements = await getRequirements(row.iso_country, row.number_type);
  const requirement = requirements.documents.find((doc) => doc.key === requirementKey);
  const option = requirement?.options.find((opt) => opt.type === documentType);
  if (!requirement || !option || !option.needsFile) {
    throw Object.assign(new Error("That document type isn't accepted here."), {
      status: 400,
    });
  }
  const type = String(mimeType || "").toLowerCase();
  if (!ALLOWED_MIME.has(type)) {
    throw Object.assign(new Error("Upload a PDF, JPG or PNG file."), { status: 400 });
  }
  if (!buffer?.length) {
    throw Object.assign(new Error("The file is empty."), { status: 400 });
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error("Files must be 10 MB or smaller."), { status: 400 });
  }

  const creds = await subaccountCreds(row.provider_account_sid);
  const form = new FormData();
  form.append("FriendlyName", `${row.business_name} - ${option.label}`.slice(0, 64));
  form.append("Type", option.type);
  form.append("Attributes", JSON.stringify(documentAttributes(option, row, fields)));
  form.append(
    "File",
    new Blob([buffer], { type }),
    cleanText(fileName, 120) || `document.${type.split("/")[1] || "pdf"}`,
  );
  const created = await carrierFetch(`${UPLOAD_BASE}/SupportingDocuments`, {
    method: "POST",
    creds,
    multipart: form,
  });

  // One document per requirement and per type: a new upload replaces both,
  // and the replaced copy is deleted at the carrier rather than left behind.
  const replaced = (row.documents || []).filter(
    (doc) => doc.requirement === requirementKey || doc.type === option.type,
  );
  for (const old of replaced) {
    if (!old.providerSid) continue;
    await carrierFetch(`${REGULATION_BASE}/SupportingDocuments/${old.providerSid}`, {
      method: "DELETE",
      creds,
    }).catch(() => null);
  }
  const documents = (row.documents || []).filter((doc) => !replaced.includes(doc));
  documents.push({
    requirement: requirementKey,
    type: option.type,
    label: option.label,
    fileName: cleanText(fileName, 120) || null,
    providerSid: created.sid,
    uploadedAt: new Date().toISOString(),
  });
  return updateRow(db, row.id, { documents });
}

function complianceEmail() {
  return (
    String(process.env.REGULATORY_CONTACT_EMAIL || "").trim() ||
    String(process.env.SUPER_ADMIN_EMAIL || "").trim() ||
    "support@agentlycall.com"
  );
}

/** Turn the carrier's evaluation into plain sentences for the owner. */
function evaluationIssues(evaluation) {
  const issues = [];
  for (const result of evaluation?.results || []) {
    if (result.passed) continue;
    const label = result.friendly_name || result.requirement_friendly_name || "Requirement";
    const fieldProblems = (result.fields || [])
      .filter((field) => field.passed === false)
      .map((field) => field.friendly_name || field.object_field || field.field_type)
      .filter(Boolean);
    const reason = result.failure_reason || result.error_code_description || "";
    issues.push(
      [label, fieldProblems.length ? `check ${fieldProblems.join(", ")}` : "", reason]
        .filter(Boolean)
        .join(" — "),
    );
  }
  return issues;
}

/**
 * Step 3: assemble everything, pre-check it, and send it for review. A failed
 * pre-check is returned to the owner as plain issues to fix — nothing is sent
 * for review until it passes.
 */
async function submitVerification({ db = getSupabase(), organizationId, id, callbackUrl }) {
  const row = await loadVerification(db, organizationId, id);
  if (!["draft", "needs_changes"].includes(row.status)) {
    throw Object.assign(new Error("This verification has already been submitted."), {
      status: 409,
    });
  }
  const requirements = await getRequirements(row.iso_country, row.number_type);
  const uploadedTypes = new Map((row.documents || []).map((doc) => [doc.type, doc]));
  const coveringUpload = (doc) =>
    doc.options.map((option) => uploadedTypes.get(option.type)).find(Boolean) || null;
  const missing = requirements.documents
    .filter((doc) => !coveringUpload(doc) && !doc.addressOnly)
    .map((doc) => doc.label);
  if (missing.length) throw invalid(missing.map((label) => `upload ${label}`));

  const creds = await subaccountCreds(row.provider_account_sid);

  // A previous draft bundle from a failed pre-check is replaced, not reused.
  if (row.provider_bundle_sid) {
    await carrierFetch(`${REGULATION_BASE}/Bundles/${row.provider_bundle_sid}`, {
      method: "DELETE",
      creds,
    }).catch(() => null);
  }

  const itemSids = [];
  if (requirements.businessFields.length) {
    const endUser = await carrierFetch(`${REGULATION_BASE}/EndUsers`, {
      method: "POST",
      creds,
      form: {
        FriendlyName: row.business_name.slice(0, 64),
        Type: "business",
        Attributes: JSON.stringify({ business_name: row.business_name, ...(row.details || {}) }),
      },
    });
    itemSids.push(endUser.sid);
    row.provider_end_user_sid = endUser.sid;
  }

  let addressDocAdded = false;
  for (const doc of requirements.documents) {
    const upload = coveringUpload(doc);
    if (upload?.providerSid) {
      itemSids.push(upload.providerSid);
      continue;
    }
    // One address document covers every address-only requirement.
    if (addressDocAdded) continue;
    addressDocAdded = true;
    // Address-only requirement: the address itself is the document.
    const addressDoc = await carrierFetch(`${REGULATION_BASE}/SupportingDocuments`, {
      method: "POST",
      creds,
      form: {
        FriendlyName: `${row.business_name} address`.slice(0, 64),
        Type: "business_address",
        Attributes: JSON.stringify({ address_sids: [row.provider_address_sid] }),
      },
    });
    itemSids.push(addressDoc.sid);
  }

  const bundle = await carrierFetch(`${REGULATION_BASE}/Bundles`, {
    method: "POST",
    creds,
    form: {
      FriendlyName: `${row.business_name} ${row.iso_country} ${row.number_type}`.slice(0, 64),
      Email: complianceEmail(),
      StatusCallback: callbackUrl,
      RegulationSid: requirements.regulationSid,
    },
  });
  for (const sid of [...new Set(itemSids)]) {
    await carrierFetch(`${REGULATION_BASE}/Bundles/${bundle.sid}/ItemAssignments`, {
      method: "POST",
      creds,
      form: { ObjectSid: sid },
    });
  }

  const evaluation = await carrierFetch(`${REGULATION_BASE}/Bundles/${bundle.sid}/Evaluations`, {
    method: "POST",
    creds,
  });
  if (evaluation?.status && evaluation.status !== "compliant") {
    const issues = evaluationIssues(evaluation);
    return updateRow(db, row.id, {
      status: "needs_changes",
      issues: issues.length ? issues : ["Some details don't meet this country's rules. Check them and try again."],
      provider_bundle_sid: bundle.sid,
      provider_end_user_sid: row.provider_end_user_sid || null,
    });
  }

  await carrierFetch(`${REGULATION_BASE}/Bundles/${bundle.sid}`, {
    method: "POST",
    creds,
    form: { Status: "pending-review" },
  });
  return updateRow(db, row.id, {
    status: "submitted",
    issues: [],
    provider_bundle_sid: bundle.sid,
    provider_end_user_sid: row.provider_end_user_sid || null,
    submitted_at: new Date().toISOString(),
    last_checked_at: new Date().toISOString(),
  });
}

/** Carrier status -> ours. */
function mapCarrierStatus(status) {
  switch (String(status || "").toLowerCase()) {
    case "twilio-approved":
    case "provisionally-approved":
      return "approved";
    case "twilio-rejected":
      return "rejected";
    case "in-review":
      return "in_review";
    case "pending-review":
      return "submitted";
    case "draft":
      return "needs_changes";
    default:
      return null;
  }
}

/**
 * Re-read the carrier's status (the only source we trust; a callback is just
 * a nudge) and notify the owner on a decision, exactly once per decision.
 */
async function refreshVerification({ db = getSupabase(), row, failureReason, notify }) {
  if (!row?.provider_bundle_sid || !IN_FLIGHT.includes(row.status)) return row;
  const creds = await subaccountCreds(row.provider_account_sid);
  const bundle = await carrierFetch(`${REGULATION_BASE}/Bundles/${row.provider_bundle_sid}`, {
    creds,
  });
  const next = mapCarrierStatus(bundle?.status) || row.status;
  const patch = { last_checked_at: new Date().toISOString() };
  if (next !== row.status) {
    patch.status = next;
    if (["approved", "rejected"].includes(next)) patch.decided_at = new Date().toISOString();
    if (next === "rejected") {
      patch.rejection_reason =
        cleanText(failureReason, 500) ||
        "The reviewer couldn't accept these documents. Make sure every detail matches your official records, then start a new verification.";
    }
  }
  let updated = await updateRow(db, row.id, patch);
  if (["approved", "rejected"].includes(updated.status) && updated.notified_status !== updated.status) {
    if (typeof notify === "function") {
      await notify(updated).catch((error) =>
        console.warn("[business-verification] notify failed:", error?.message || error),
      );
    }
    updated = await updateRow(db, row.id, { notified_status: updated.status });
  }
  return updated;
}

async function refreshByBundleSid({ db = getSupabase(), bundleSid, failureReason, notify }) {
  const { data, error } = await db
    .from("business_verifications")
    .select("*")
    .eq("provider_bundle_sid", String(bundleSid || ""))
    .maybeSingle();
  if (error || !data) return null;
  return refreshVerification({ db, row: data, failureReason, notify });
}

async function deleteVerification({ db = getSupabase(), organizationId, id }) {
  const row = await loadVerification(db, organizationId, id);
  if (["submitted", "in_review", "approved"].includes(row.status)) {
    throw Object.assign(
      new Error("A verification under review or approved can't be deleted."),
      { status: 409 },
    );
  }
  if (row.provider_bundle_sid) {
    try {
      const creds = await subaccountCreds(row.provider_account_sid);
      await carrierFetch(`${REGULATION_BASE}/Bundles/${row.provider_bundle_sid}`, {
        method: "DELETE",
        creds,
      });
    } catch (_) {
      // A leftover draft at the carrier is harmless; the record still goes.
    }
  }
  await db.from("business_verifications").delete().eq("id", row.id);
  return { deleted: true };
}

module.exports = {
  NO_VERIFICATION,
  OPEN_STATUSES,
  IN_FLIGHT,
  normalizeNumberType,
  normalizeRegulation,
  plainHelp,
  enumOptions,
  evaluationIssues,
  mapCarrierStatus,
  validateDetails,
  validateAddress,
  getRequirements,
  serialize,
  listVerifications,
  loadVerification,
  findApprovedVerification,
  createVerification,
  uploadDocument,
  submitVerification,
  refreshVerification,
  refreshByBundleSid,
  deleteVerification,
};
