"use strict";
/**
 * a4: measure answer quality, starting with the part that actually limits it.
 *
 * a1 recorded the ceiling precisely: retrieval is LEXICAL. knowledge_chunks
 * carries a tsvector and, although pgvector 0.8.0 is installed, there is not a
 * single vector column in the schema. So a caller who phrases a question
 * differently from the source text can miss a chunk that means the same thing,
 * and the generated answer is then confidently wrong or an "I don't know".
 *
 * This measures THAT, not prose quality. Retrieval is the floor: if the right
 * chunk never reaches the model, no amount of prompt work recovers it, and a
 * judged-by-LLM eval would spend money measuring a symptom.
 *
 * METHOD, and its honest limits.
 *
 * Cases are generated FROM the tenant's own chunks, so this needs no curated
 * answer key and cannot go stale as content changes. For each sampled chunk we
 * build three questions:
 *
 *   literal     — words lifted straight from the chunk. A miss here is a
 *                 broken index, not a paraphrase problem.
 *   paraphrase  — the same intent with common synonyms substituted. This is
 *                 the lexical ceiling, and the number to watch.
 *   typo        — one transposition, to exercise the fuzzy fallback.
 *
 * A case PASSES if the source chunk is returned in the top K. That is recall@K
 * and nothing more — it does not claim the final answer was good.
 *
 * Read-only. Runs against whatever database .env points at.
 *
 *   node infra/run-answer-eval.js                 # sample 20 chunks
 *   node infra/run-answer-eval.js --sample 60 --k 5
 *   node infra/run-answer-eval.js --org <uuid>
 */
const path = require("path");

const SERVER = path.join(__dirname, "..");
require(path.join(SERVER, "node_modules", "dotenv")).config({
  path: path.join(SERVER, ".env"),
});
const { createClient } = require(path.join(SERVER, "node_modules", "@supabase/supabase-js"));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const SAMPLE = Number(arg("sample", 20));
const K = Number(arg("k", 5));
const ORG = arg("org", null);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

/* Substitutions a real caller makes. Deliberately ordinary — the point is to
   test everyday rewording, not adversarial phrasing. */
const SYNONYMS = [
  [/\bprice|pricing|cost\b/gi, "how much"],
  [/\bhours?\b/gi, "when are you open"],
  [/\bcontact\b/gi, "get in touch"],
  [/\bservices?\b/gi, "what you offer"],
  [/\bdeveloped?\b/gi, "built"],
  [/\bexperience\b/gi, "background"],
  [/\bproject\b/gi, "work"],
  [/\bimplement(ed)?\b/gi, "set up"],
  [/\bcollaborated\b/gi, "worked with"],
  [/\blaunched\b/gi, "released"],
];

const STOP = new Set(
  ("the a an and or of to in for on with is are was were this that it as at by from " +
    "title url source published time markdown content image http https www").split(" "),
);

function keywords(text, count) {
  const words = String(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
  const seen = new Set();
  const out = [];
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= count) break;
  }
  return out;
}

function buildCases(chunk) {
  const words = keywords(chunk.content, 6);
  if (words.length < 3) return [];

  const literal = words.slice(0, 5).join(" ");

  let paraphrase = literal;
  for (const [re, replacement] of SYNONYMS) {
    if (re.test(paraphrase)) {
      paraphrase = paraphrase.replace(re, replacement);
      break;
    }
  }
  // If nothing matched, reorder and drop a term — still a rewording.
  if (paraphrase === literal) paraphrase = words.slice(1, 5).reverse().join(" ");

  const typo = (() => {
    const w = words[0];
    if (w.length < 4) return literal;
    const swapped = w.slice(0, 1) + w[2] + w[1] + w.slice(3);
    return [swapped, ...words.slice(1, 4)].join(" ");
  })();

  return [
    { kind: "literal", query: literal },
    { kind: "paraphrase", query: paraphrase },
    { kind: "typo", query: typo },
  ].map((c) => ({ ...c, chunkId: chunk.id, organizationId: chunk.organization_id }));
}

async function retrieve({ organizationId, query }) {
  const { data, error } = await db.rpc("search_knowledge_chunks", {
    p_organization_id: organizationId,
    p_knowledge_base_ids: null,
    p_query: query,
    p_limit: K,
    p_max_chars: 8000,
  });
  if (error) return { ids: [], error: error.message };
  return { ids: (data || []).map((r) => r.id), error: null };
}

(async () => {
  let q = db.from("knowledge_chunks").select("id, content, organization_id").limit(SAMPLE);
  if (ORG) q = q.eq("organization_id", ORG);
  const { data: chunks, error } = await q;
  if (error) throw new Error(error.message);
  if (!chunks?.length) throw new Error("no knowledge chunks to evaluate");

  const cases = chunks.flatMap(buildCases);
  console.log(`chunks sampled : ${chunks.length}`);
  console.log(`cases          : ${cases.length}  (recall@${K})\n`);

  const byKind = {};
  const failures = [];
  let rpcError = null;

  for (const c of cases) {
    const { ids, error: err } = await retrieve(c);
    if (err) { rpcError = err; break; }
    const hit = ids.includes(c.chunkId);
    const k = (byKind[c.kind] ||= { total: 0, hit: 0 });
    k.total++;
    if (hit) k.hit++;
    else failures.push(c);
  }

  if (rpcError) {
    console.log(`RETRIEVAL RPC FAILED: ${rpcError}`);
    console.log("Nothing measured. This is a result too — the path the product depends on is not callable.");
    process.exit(1);
  }

  for (const [kind, k] of Object.entries(byKind)) {
    const pct = k.total ? ((k.hit / k.total) * 100).toFixed(0) : "–";
    console.log(`  ${kind.padEnd(11)} ${String(k.hit).padStart(3)}/${String(k.total).padEnd(3)}  recall@${K} ${pct}%`);
  }

  const lit = byKind.literal;
  const par = byKind.paraphrase;
  console.log("\nreading:");
  if (lit && lit.hit / Math.max(lit.total, 1) < 0.9) {
    console.log("  LITERAL recall is below 90% — that is an indexing problem, not a phrasing one.");
  }
  if (lit && par) {
    const drop = lit.hit / Math.max(lit.total, 1) - par.hit / Math.max(par.total, 1);
    console.log(`  paraphrase costs ${(drop * 100).toFixed(0)} percentage points of recall.`);
    console.log(
      drop > 0.2
        ? "  That is the lexical ceiling a1 predicted, measured. Embeddings would target exactly this."
        : "  The lexical index is holding up better than a1 feared on this corpus.",
    );
  }
  console.log(`\n  ${failures.length} case(s) missed. Sample:`);
  for (const f of failures.slice(0, 5)) console.log(`    [${f.kind}] "${f.query}"`);
  console.log("\nThis measures RETRIEVAL only. It does not claim the generated answer was good.");
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
