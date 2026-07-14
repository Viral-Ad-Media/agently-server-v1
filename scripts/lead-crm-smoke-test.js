"use strict";

const baseUrl = String(
  process.env.AGENTLY_API_BASE_URL || "http://localhost:4000",
).replace(/\/$/, "");
const token = process.env.AGENTLY_AUTH_TOKEN;

if (!token) {
  console.error(
    "Missing AGENTLY_AUTH_TOKEN. Log in locally, copy the Bearer token, then rerun.",
  );
  process.exit(1);
}

async function request(path, accept = "application/json") {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept,
    },
  });
  const text = await response.text();
  let body = {};
  if (accept === "text/csv") {
    body = { raw: text };
  } else {
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = { raw: text };
    }
  }
  if (!response.ok) {
    throw new Error(
      `${path} failed with ${response.status}: ${body?.error?.message || body?.message || text}`,
    );
  }
  return body;
}

async function main() {
  const checks = [
    ["CRM health", "/api/leads-crm/health"],
    ["Pipeline stages", "/api/leads-crm/stages"],
    ["CRM summary", "/api/leads-crm/summary"],
    ["Lead sources", "/api/leads-crm/sources"],
    ["Leads page 1", "/api/leads-crm?page=1&limit=20&sort=priority"],
    ["Leads sorted by due", "/api/leads-crm?page=1&limit=20&sort=due"],
    ["Safe search", "/api/leads-crm?page=1&limit=20&search=test%20lead"],
    ["Duplicates filter", "/api/leads-crm?page=1&limit=20&duplicates=true"],
  ];

  for (const [label, path] of checks) {
    const body = await request(path);
    const count = typeof body.count === "number" ? ` count=${body.count}` : "";
    console.log(`OK ${label}${count}`);
  }

  const csv = await request("/api/leads-crm/export.csv?limit=5", "text/csv");
  if (!String(csv.raw || "").includes("Name,Email,Phone")) {
    throw new Error("CRM export did not return the expected CSV header.");
  }
  console.log("OK CSV export");
}

main().catch((error) => {
  console.error(`Lead CRM smoke test failed: ${error.message}`);
  process.exit(1);
});
