"use strict";
/*
 * Customer photo / video uploads from the chat widget (Front Desk port).
 *
 * What matters most here: uploads are what they claim to be, a phone photo's
 * GPS never survives, a visitor cannot attach files to someone else's lead,
 * and media from visitors who never leave details is actually deleted.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const sharp = require("sharp");

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-chat-media";
const media = require("../lib/chat-media");
const widget = require("../lib/chat-media-widget");
const { makeFakeSupabase } = require("./helpers/fake-supabase");

async function jpegWithGps() {
  return sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#884422" } })
    .jpeg()
    .withExif({
      IFD0: { Make: "TestPhone", Model: "X" },
      IFD3: { GPSLatitudeRef: "N", GPSLatitude: "32/1 46/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "96/1 48/1 0/1" },
    })
    .toBuffer();
}

test("sniffMime trusts the bytes, not the header", async () => {
  const jpg = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).jpeg().toBuffer();
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "#fff" } }).png().toBuffer();
  assert.equal(media.sniffMime(jpg), "image/jpeg");
  assert.equal(media.sniffMime(png), "image/png");
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]);
  assert.equal(media.sniffMime(webm), "video/webm");
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(20)]);
  assert.equal(media.sniffMime(mp4), "video/mp4");
  assert.equal(media.sniffMime(Buffer.from("<html><script>alert(1)</script></html>")), null);
});

test("classifyUpload refuses HTML dressed up as an image", () => {
  const html = Buffer.from("<html><body>hello there, not an image</body></html>");
  const v = media.classifyUpload(html, "text/html");
  assert.equal(v.ok, false);
  assert.equal(v.status, 415);
  // Declaring an allowed type does not help: the bytes decide.
  assert.equal(media.classifyUpload(html, "image/jpeg").ok, false);
  assert.equal(media.classifyUpload(html, "video/webm").ok, false);
  assert.equal(media.classifyUpload(html, "image/svg+xml").ok, false);
});

test("classifyUpload enforces size limits per kind", () => {
  const bigVideo = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(media.LIMITS.videoBytes)]);
  assert.equal(media.classifyUpload(bigVideo, "video/webm").status, 413);
  const bigImage = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(media.LIMITS.imageBytes)]);
  assert.equal(media.classifyUpload(bigImage, "image/jpeg").status, 413);
  assert.equal(media.classifyUpload(Buffer.alloc(0), "image/jpeg").status, 400);
});

test("normalizeImage strips EXIF/GPS and caps size", async () => {
  const input = await jpegWithGps();
  const before = await sharp(input).metadata();
  assert.ok(before.exif, "fixture should carry EXIF");
  const out = await media.normalizeImage(input);
  const after = await sharp(out.buffer).metadata();
  assert.equal(after.exif, undefined, "EXIF (including GPS) must be gone");
  assert.equal(out.mime, "image/jpeg");
  assert.ok(Math.max(out.width, out.height) <= media.LIMITS.imageMaxEdge);
});

test("decodeFrame accepts a jpeg data URL and rejects anything else", async () => {
  const jpg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).jpeg().toBuffer();
  assert.ok(media.decodeFrame(`data:image/jpeg;base64,${jpg.toString("base64")}`));
  assert.equal(media.decodeFrame(`data:text/html;base64,${Buffer.from("<b>x</b>").toString("base64")}`), null);
  assert.equal(media.decodeFrame("x".repeat(4 * 1024 * 1024)), null);
});

test("media token is bound to its chatbot and cannot be forged", () => {
  const t = media.signMediaToken({ leadId: "lead-1", chatbotId: "bot-1" });
  assert.equal(media.verifyMediaToken(t, "bot-1"), "lead-1");
  assert.equal(media.verifyMediaToken(t, "bot-2"), null, "another tenant's chatbot");
  assert.equal(media.verifyMediaToken("lead-1", "bot-1"), null, "a bare lead id is not a token");
  assert.equal(media.verifyMediaToken(t + "x", "bot-1"), null);
});

test("session ids must look random", () => {
  assert.equal(media.cleanSessionId("a1b2c3d4e5f60718293a4b5c6d7e8f90"), "a1b2c3d4e5f60718293a4b5c6d7e8f90");
  assert.equal(media.cleanSessionId("short"), null);
  assert.equal(media.cleanSessionId("../../etc/passwd/aaaaaaaaaaaaaaa"), null);
});

test("parseAnalysis keeps the reply even when the model ignores JSON", () => {
  const plain = media.parseAnalysis("Looks like a cracked tile. Want to book a visit?");
  assert.match(plain.reply, /cracked tile/);
  assert.equal(plain.parsed, false);
  const good = media.parseAnalysis(
    JSON.stringify({ reply: "Hi", summary: "s", subject: "roof", observations: ["a", "b"], urgency: "HIGH", confidence: 7, needs_human: true }),
  );
  assert.equal(good.urgency, "high");
  assert.equal(good.confidence, 1, "clamped");
  assert.equal(good.needs_human, true);
  assert.equal(media.parseAnalysis(JSON.stringify({ reply: "x", urgency: "panic" })).urgency, "low");
});

test("analyzeMedia sends low-detail images with the business context", async () => {
  let sent = null;
  const fakeOpenAI = {
    chat: {
      completions: {
        create: async (req) => {
          sent = req;
          return {
            model: "gpt-4o-mini",
            usage: { prompt_tokens: 100, completion_tokens: 20 },
            choices: [{ message: { content: JSON.stringify({ reply: "That flashing has lifted.", summary: "Lifted flashing", urgency: "medium", confidence: 0.8 }) } }],
          };
        },
      },
    },
  };
  const assistant = {
    loadChatbotContext: async () => ({ organization: { name: "Halcyon" } }),
    buildAssistantPrompt: () => "BUSINESS PROMPT",
    cleanAssistantResponse: (t) => t,
  };
  const img = Buffer.from("fakejpeg");
  const r = await media.analyzeMedia(
    { chatbotId: "bot-1", kind: "video", images: [img, img], note: "storm last night", languageName: "Spanish" },
    { openai: fakeOpenAI, assistant },
  );
  assert.equal(r.analysis.reply, "That flashing has lifted.");
  assert.equal(r.analysis.urgency, "medium");
  assert.match(sent.messages[0].content, /BUSINESS PROMPT/);
  assert.match(sent.messages[0].content, /2 still frame/);
  assert.match(sent.messages[0].content, /Reply in Spanish/);
  const parts = sent.messages.at(-1).content;
  assert.equal(parts.filter((p) => p.type === "image_url").length, 2);
  assert.ok(parts.every((p) => p.type !== "image_url" || p.image_url.detail === "low"));
  assert.equal(sent.response_format.type, "json_object");
});

function withStorage(db) {
  const removed = [];
  db.storage = {
    from: () => ({
      remove: async (paths) => {
        removed.push(...paths);
        return { error: null };
      },
      createSignedUrls: async (paths) => ({ data: paths.map((p) => ({ path: p, signedUrl: `https://signed/${p}` })) }),
    }),
  };
  return removed;
}

test("capture-lead claims only this visit's pending media", async () => {
  const db = makeFakeSupabase({
    chat_media: [
      { id: "m1", chatbot_id: "bot-1", session_id: "s".repeat(32), lead_id: null, expires_at: "2099-01-01T00:00:00Z" },
      { id: "m2", chatbot_id: "bot-1", session_id: "t".repeat(32), lead_id: null, expires_at: "2099-01-01T00:00:00Z" },
      { id: "m3", chatbot_id: "bot-2", session_id: "s".repeat(32), lead_id: null, expires_at: "2099-01-01T00:00:00Z" },
    ],
  });
  const n = await media.linkSessionMediaToLead(db, { chatbotId: "bot-1", sessionId: "s".repeat(32), leadId: "lead-9" });
  assert.equal(n, 1);
  const rows = db._rows("chat_media");
  assert.equal(rows.find((r) => r.id === "m1").lead_id, "lead-9");
  assert.equal(rows.find((r) => r.id === "m1").expires_at, null, "claimed media stops expiring");
  assert.equal(rows.find((r) => r.id === "m2").lead_id, null, "other visitor untouched");
  assert.equal(rows.find((r) => r.id === "m3").lead_id, null, "other chatbot untouched");
  assert.equal(await media.linkSessionMediaToLead(db, { chatbotId: "bot-1", sessionId: "bad", leadId: "lead-9" }), 0);
});

test("purge deletes expired unclaimed media and its files, nothing else", async () => {
  const db = makeFakeSupabase({
    chat_media: [
      { id: "old", lead_id: null, expires_at: "2026-01-01T00:00:00Z", storage_path: "o/b/old.jpg", poster_path: null },
      { id: "oldvid", lead_id: null, expires_at: "2026-01-01T00:00:00Z", storage_path: "o/b/v.webm", poster_path: "o/b/v-poster.jpg" },
      { id: "fresh", lead_id: null, expires_at: "2099-01-01T00:00:00Z", storage_path: "o/b/fresh.jpg" },
      { id: "kept", lead_id: "lead-1", expires_at: null, storage_path: "o/b/kept.jpg" },
    ],
  });
  const removed = withStorage(db);
  const n = await media.purgeExpiredChatMedia(db, { now: new Date("2026-11-13T00:00:00Z") });
  assert.equal(n, 2);
  assert.deepEqual(removed.sort(), ["o/b/old.jpg", "o/b/v-poster.jpg", "o/b/v.webm"]);
  assert.deepEqual(db._rows("chat_media").map((r) => r.id).sort(), ["fresh", "kept"]);
});

test("listLeadMedia is scoped to the organization", async () => {
  const db = makeFakeSupabase({
    chat_media: [
      { id: "a", organization_id: "org-1", lead_id: "lead-1", kind: "photo", storage_path: "org-1/b/a.jpg", analysis: { summary: "x" }, created_at: "2026-11-13" },
      { id: "b", organization_id: "org-2", lead_id: "lead-1", kind: "photo", storage_path: "org-2/b/b.jpg", created_at: "2026-11-13" },
    ],
  });
  withStorage(db);
  const list = await media.listLeadMedia(db, { organizationId: "org-1", leadId: "lead-1" });
  assert.deepEqual(list.map((m) => m.id), ["a"]);
  assert.equal(list[0].url, "https://signed/org-1/b/a.jpg");
});

test("retention: lead media never expires, visitor media does", () => {
  assert.equal(media.retentionFor("lead-1"), null);
  const t = Date.parse(media.retentionFor(null, Date.parse("2026-11-13T00:00:00Z")));
  assert.equal(t, Date.parse("2026-11-14T00:00:00Z"));
});

test("widget browser script parses", () => {
  // Wrapped the way widget.js wraps it: inside the widget IIFE, with the
  // widget's own names in scope.
  assert.doesNotThrow(() => new Function(`var MEDIA_UPLOADS_ENABLED=true;var sending=false;${widget.SCRIPT}`));
  assert.match(widget.MARKUP, /capture="environment"/);
});
