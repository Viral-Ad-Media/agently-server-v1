"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const bv = require("../lib/business-verification");
const numberCountries = require("../lib/number-countries");
const { pickCountryVoiceRate, voiceCountryFromE164 } = require("../lib/usage-ledger");

// Trimmed copies of the carrier's live regulations (2026-11-26).
const GB_LOCAL = {
  sid: "RN61b6f858c1a0b46ae2631346138a283c",
  requirements: {
    end_user: [
      {
        detailed_fields: [
          { machine_name: "business_name", friendly_name: "Business Name", constraint: "business['business_name'] != null", description: "" },
          {
            machine_name: "business_registration_identifier",
            friendly_name: "Registration Authority",
            constraint: "business['business_registration_identifier'] =~ '^(UK:CRN|US:EIN|CA:CBN|AU:ACN|OTHER)$'",
            description: "Choose one",
          },
          { machine_name: "comments", friendly_name: "Comments (Optional)", constraint: "", description: "optional" },
        ],
      },
    ],
    supporting_document: [
      [
        {
          requirement_name: "business_address",
          name: "Business Address (Proof of Address)",
          description: "Must be within United Kingdom;  a PO Box is not acceptable.",
          accepted_documents: [
            {
              type: "business_address",
              name: "Business address",
              detailed_fields: [{ machine_name: "address_sids", friendly_name: "Business Address sid" }],
            },
          ],
        },
      ],
    ],
  },
};

const AU_MOBILE = {
  sid: "RNede12e527be2628b51290c0187de7ee4",
  requirements: {
    end_user: [{ detailed_fields: [{ machine_name: "business_name", friendly_name: "Business Name", constraint: "x != null" }] }],
    supporting_document: [
      [
        {
          requirement_name: "business_name_info",
          name: "Business Name",
          description: "",
          accepted_documents: [
            { type: "commercial_registrar_excerpt", name: "Commercial register", detailed_fields: [{ machine_name: "business_name" }] },
          ],
        },
      ],
      [
        {
          requirement_name: "business_id_no_info",
          name: "Business ID Number",
          description: "",
          accepted_documents: [
            { type: "commercial_registrar_excerpt", name: "Commercial registry", detailed_fields: [{ machine_name: "document_number", friendly_name: "Document number" }] },
          ],
        },
      ],
    ],
  },
};

test("regulation: UK needs details + address, no file upload", () => {
  const r = bv.normalizeRegulation(GB_LOCAL, { country: "GB", numberType: "local" });
  assert.equal(r.required, true);
  assert.equal(r.regulationSid, GB_LOCAL.sid);
  assert.deepEqual(r.businessFields.map((f) => f.key), ["business_name", "business_registration_identifier", "comments"]);
  assert.deepEqual(r.businessFields[1].options, ["UK:CRN", "US:EIN", "CA:CBN", "AU:ACN", "OTHER"]);
  assert.equal(r.businessFields[2].required, false);
  assert.equal(r.needsAddress, true);
  assert.equal(r.documents.length, 1);
  assert.equal(r.documents[0].addressOnly, true);
  assert.equal(r.documents[0].options[0].needsFile, false);
});

test("regulation: Australia mobile needs real document uploads", () => {
  const r = bv.normalizeRegulation(AU_MOBILE, { country: "AU", numberType: "mobile" });
  assert.equal(r.needsAddress, false);
  assert.equal(r.documents.length, 2);
  assert.ok(r.documents.every((doc) => !doc.addressOnly));
  const idDoc = r.documents[1].options[0];
  assert.equal(idDoc.needsFile, true);
  // The same type covers both requirements (carrier: one document per type),
  // so each option carries the union of the fields: name (auto) + ID number.
  for (const doc of r.documents) {
    const keys = doc.options[0].fields.map((f) => `${f.key}:${f.auto}`).sort();
    assert.deepEqual(keys, ["business_name:true", "document_number:false"]);
  }
});

test("US and Canada never need verification (no network call)", async () => {
  for (const iso of ["US", "CA", "us"]) {
    const r = await bv.getRequirements(iso, "local");
    assert.equal(r.required, false);
  }
});

test("carrier statuses map to ours", () => {
  assert.equal(bv.mapCarrierStatus("twilio-approved"), "approved");
  assert.equal(bv.mapCarrierStatus("provisionally-approved"), "approved");
  assert.equal(bv.mapCarrierStatus("twilio-rejected"), "rejected");
  assert.equal(bv.mapCarrierStatus("in-review"), "in_review");
  assert.equal(bv.mapCarrierStatus("pending-review"), "submitted");
  assert.equal(bv.mapCarrierStatus("weird"), null);
});

test("number types normalise", () => {
  assert.equal(bv.normalizeNumberType("Local"), "local");
  assert.equal(bv.normalizeNumberType("Mobile"), "mobile");
  assert.equal(bv.normalizeNumberType("TollFree"), "toll-free");
  assert.equal(bv.normalizeNumberType(undefined), "local");
});

test("details validation: required, options, phone and email formats", () => {
  const r = bv.normalizeRegulation(GB_LOCAL, { country: "GB", numberType: "local" });
  const missing = bv.validateDetails(r, {}).missing;
  assert.ok(missing.includes("Business Name"));
  assert.ok(missing.includes("Registration Authority"));
  assert.ok(!missing.some((m) => m.startsWith("Comments")));
  const badOption = bv.validateDetails(r, { business_name: "Acme", business_registration_identifier: "XX" }).missing;
  assert.ok(badOption[0].startsWith("Registration Authority: choose one of"));
  const ok = bv.validateDetails(r, { business_name: " Acme  Ltd ", business_registration_identifier: "UK:CRN" });
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.clean.business_name, "Acme Ltd");
});

test("address validation", () => {
  assert.equal(bv.validateAddress({}, "GB").missing.length, 4);
  const ok = bv.validateAddress({ street: "1 High St", city: "London", region: "Greater London", postalCode: "EC1A 1BB" }, "gb");
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.clean.country, "GB");
});

test("pre-check problems become plain sentences", () => {
  const issues = bv.evaluationIssues({
    status: "noncompliant",
    results: [
      { passed: true, friendly_name: "Business" },
      {
        passed: false,
        friendly_name: "Proof of Address",
        failure_reason: "Address must be in the United Kingdom",
        fields: [{ passed: false, friendly_name: "Business Address" }],
      },
    ],
  });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /Proof of Address — check Business Address — Address must be in the United Kingdom/);
});

function fakeCountryDb(rows, error = null) {
  const builder = {
    select: () => builder,
    order: async () => ({ data: rows, error }),
  };
  return { from: () => builder };
}

test("country switches: only enabled countries pass", async () => {
  numberCountries.clearCache();
  const db = fakeCountryDb([
    { iso_country: "US", enabled: true },
    { iso_country: "CA", enabled: true },
    { iso_country: "GB", enabled: false },
  ]);
  assert.deepEqual(await numberCountries.filterEnabled(["US", "CA", "GB", "AU"], db), ["US", "CA"]);
  assert.equal(await numberCountries.isCountryEnabled("gb", db), false);
  numberCountries.clearCache();
});

test("country switches: unreadable table falls back to US + Canada only", async () => {
  numberCountries.clearCache();
  const db = fakeCountryDb(null, { code: "PGRST205", message: "missing" });
  assert.deepEqual(await numberCountries.enabledCountries(db), ["US", "CA"]);
  numberCountries.clearCache();
});

test("country-off error message names the country", () => {
  const e = numberCountries.countryUnavailableError("IE", "calls");
  assert.equal(e.code, "COUNTRY_NOT_AVAILABLE");
  assert.equal(e.message, "Calls to Ireland aren't available yet.");
});

test("voice pricing: destination country from E.164", () => {
  assert.equal(voiceCountryFromE164("+447700900123"), "GB");
  assert.equal(voiceCountryFromE164("+353851234567"), "IE");
  assert.equal(voiceCountryFromE164("+61412345678"), "AU");
  assert.equal(voiceCountryFromE164("+14155550100"), "US");
  assert.equal(voiceCountryFromE164("+4915112345678"), null);
});

test("voice pricing: outbound uses max(standard, mobile), ignores premium/surcharge", () => {
  const row = (cost, name, at = "2026-07-01") => ({
    unit_cost_usd: cost,
    effective_from: at,
    metadata: { raw_item: { friendly_name: name } },
  });
  const rows = [
    row(0.0158, "Programmable Outbound Minute - United Kingdom"),
    row(0.0305, "Programmable Outbound Minute - United Kingdom - Mobile"),
    row(1.0479, "Programmable Outbound Minute - United Kingdom - Premium Services"),
    row(0.473, "Programmable Outbound Minute - United Kingdom - Mobile - from SurchargeZone1"),
  ];
  assert.equal(pickCountryVoiceRate(rows, "outbound"), 0.0305);
  const inbound = [
    { unit_cost_usd: 0.0798, effective_from: "2026-07-01", metadata: { raw_item: { number_type: "toll free" } } },
    { unit_cost_usd: 0.01, effective_from: "2026-07-01", metadata: { raw_item: { number_type: "national" } } },
  ];
  assert.equal(pickCountryVoiceRate(inbound, "inbound"), 0.01);
  assert.equal(pickCountryVoiceRate([], "outbound"), null);
});
