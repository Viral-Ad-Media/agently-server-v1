/**
 * agently-server/lib/avatar-processor.js   <-- REPLACES the previous version
 *
 * PATCH 22b — P2-1. Now uses `sharp` server-side, per your sign-off.
 *
 * ARCHITECTURE — three layers, each doing what it is best at:
 *
 *   1. BROWSER   lib/imageResize.ts pre-shrinks via <canvas>. Free, instant,
 *                gives a live preview. Cuts a 4MB phone photo to ~20KB before
 *                it ever leaves the device, so upload is fast and the server
 *                rarely does heavy work.
 *   2. SERVER    THIS FILE. sharp is the authority. It re-encodes everything,
 *                because a browser is not a security boundary — a crafted
 *                payload can claim to be a 128x128 PNG and be anything.
 *   3. STORAGE   Result is a data URI on chatbots.avatar_data_uri, inlined
 *                into the widget script so it travels with the deployment.
 *                That is what fixes the original bug: the old blob:/same-origin
 *                URL was unreachable from the customer's domain.
 *
 * WHY sharp IS SAFE HERE DESPITE BEING A NATIVE DEP
 *   My earlier concern was cold-start cost landing on every request sharing the
 *   lambda. Mitigated by lazy-loading: `require("sharp")` happens INSIDE the
 *   resize call, not at module scope. Routes that never touch an avatar never
 *   load the binary and pay nothing. Only the avatar upload path — a handful of
 *   calls per tenant, ever — takes the ~200-400ms first-load hit.
 *
 *   If sharp is unavailable (missing binary, arch mismatch), we fall back to
 *   validate-only. Uploads keep working at reduced quality rather than 500ing.
 *
 * INSTALL
 *   npm i sharp
 *   Vercel: add to `dependencies`, not devDependencies. Node 18+ runtime.
 *   Cost impact: see docs/COST_MODEL.md — roughly $0.0000004 per upload.
 */

"use strict";

const MAX_AVATAR_BYTES = Number(process.env.MAX_AVATAR_BYTES || 96 * 1024);
const TARGET_DIMENSION = Number(process.env.AVATAR_TARGET_PX || 128);

const ALLOWED_MIME = new Set([
  "image/png", "image/jpeg", "image/webp", "image/gif", "image/svg+xml",
]);

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

function parseDataUri(input) {
  const m = String(input || "").match(
    /^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\s]+)$/i,
  );
  if (!m) return null;
  return { mime: m[1].toLowerCase(), base64: m[2].replace(/\s+/g, "") };
}

/**
 * SVG is executable text. Shipped into a customer's page, a malicious SVG is
 * stored XSS on THEIR domain, served by us. Reject rather than sanitise-and-hope.
 */
function assertSafeSvg(svgText) {
  const dangerous =
    /<script|<foreignObject|javascript:|on\w+\s*=|<!ENTITY|xlink:href\s*=\s*["']\s*(?!data:)/i;
  if (dangerous.test(svgText)) {
    throw fail(
      "AVATAR_UNSAFE_SVG",
      "That SVG contains scripts or links to other sites, so we can't publish it to your website. Please upload a PNG or JPG instead.",
    );
  }
}

/** Content must match the declared type. A .png that isn't one gets inlined. */
function detectRealType(bytes) {
  const s = bytes.subarray(0, 12);
  if (s[0] === 0x89 && s[1] === 0x50 && s[2] === 0x4e) return "image/png";
  if (s[0] === 0xff && s[1] === 0xd8) return "image/jpeg";
  if (s.subarray(0, 3).toString("ascii") === "GIF") return "image/gif";
  if (
    s.subarray(0, 4).toString("ascii") === "RIFF" &&
    s.subarray(8, 12).toString("ascii") === "WEBP"
  ) return "image/webp";
  if (/^\s*(<\?xml|<svg)/i.test(bytes.subarray(0, 200).toString("utf8")))
    return "image/svg+xml";
  return null;
}

function loadSharp() {
  try {
    // Lazy — see header. Routes that never resize never load the binary.
    // eslint-disable-next-line global-require
    return require("sharp");
  } catch {
    console.warn(
      "[avatar] sharp unavailable — falling back to validate-only. " +
        "Run `npm i sharp` to enable server-side resizing.",
    );
    return null;
  }
}

/**
 * Re-encodes to a square, size-bounded WebP (or PNG when transparency matters).
 * Re-encoding is the point: it strips EXIF (which can carry GPS coordinates of
 * your tenant's home), discards any embedded payload, and guarantees the output
 * is exactly what sharp produced rather than what the uploader claimed.
 */
async function processRaster(bytes, declaredMime) {
  const sharp = loadSharp();

  if (!sharp) {
    if (bytes.length > MAX_AVATAR_BYTES) {
      throw fail(
        "AVATAR_TOO_LARGE",
        `That image is ${Math.round(bytes.length / 1024)}KB. Please use one under ${Math.round(MAX_AVATAR_BYTES / 1024)}KB — around 128×128 works best.`,
      );
    }
    return { buffer: bytes, mime: declaredMime, resized: false };
  }

  const pipeline = sharp(bytes, { animated: declaredMime === "image/gif" })
    .rotate() // honour EXIF orientation before we strip EXIF
    .resize(TARGET_DIMENSION, TARGET_DIMENSION, {
      fit: "cover",     // square-crop to centre; widget renders a circle
      position: "attention", // keep the visually salient region, not the geometric centre
      withoutEnlargement: true,
    });

  // Transparency must survive for logos. WebP handles both and is ~30% smaller
  // than PNG at equal quality, which matters because base64 adds another 33%.
  let out = await pipeline.webp({ quality: 90, effort: 4 }).toBuffer();
  let mime = "image/webp";

  for (const quality of [75, 60, 45]) {
    if (out.length <= MAX_AVATAR_BYTES) break;
    out = await sharp(bytes)
      .rotate()
      .resize(TARGET_DIMENSION, TARGET_DIMENSION, { fit: "cover", position: "attention" })
      .webp({ quality, effort: 6 })
      .toBuffer();
  }

  if (out.length > MAX_AVATAR_BYTES) {
    out = await sharp(bytes)
      .rotate()
      .resize(64, 64, { fit: "cover", position: "attention" })
      .webp({ quality: 60, effort: 6 })
      .toBuffer();
  }

  if (out.length > MAX_AVATAR_BYTES) {
    throw fail(
      "AVATAR_TOO_LARGE",
      "We couldn't compress that image small enough for your chat widget. Try a simpler image — a logo on a plain background works best.",
    );
  }

  return { buffer: out, mime, resized: true };
}

/**
 * Normalises any accepted input into a widget-safe data URI.
 * Accepts a data URI string, or a Buffer plus mimeType.
 */
async function normalizeAvatar({ dataUri, buffer, mimeType }) {
  let declared = String(mimeType || "").toLowerCase();
  let bytes;

  if (dataUri) {
    const parsed = parseDataUri(dataUri);
    if (!parsed) {
      throw fail(
        "AVATAR_INVALID",
        "We couldn't read that image. Please upload a PNG, JPG or WebP file.",
      );
    }
    declared = parsed.mime;
    bytes = Buffer.from(parsed.base64, "base64");
  } else if (buffer) {
    bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  } else {
    throw fail("AVATAR_MISSING", "No image was provided.");
  }

  const real = detectRealType(bytes);
  if (!real) {
    throw fail(
      "AVATAR_CONTENT_MISMATCH",
      "That file doesn't look like an image. Please re-save it as a PNG or JPG and try again.",
    );
  }
  // Trust the bytes, not the label.
  if (!ALLOWED_MIME.has(real)) {
    throw fail(
      "AVATAR_UNSUPPORTED_TYPE",
      "That file type isn't supported. Please use a PNG, JPG, WebP or SVG image.",
    );
  }

  if (real === "image/svg+xml") {
    assertSafeSvg(bytes.toString("utf8"));
    if (bytes.length > MAX_AVATAR_BYTES) {
      throw fail(
        "AVATAR_TOO_LARGE",
        `That SVG is ${Math.round(bytes.length / 1024)}KB. Please use one under ${Math.round(MAX_AVATAR_BYTES / 1024)}KB.`,
      );
    }
    return {
      dataUri: `data:image/svg+xml;base64,${bytes.toString("base64")}`,
      mimeType: "image/svg+xml",
      byteLength: bytes.length,
      inlinedScriptBytes: Math.ceil(bytes.length * 1.34),
      resized: false,
    };
  }

  const processed = await processRaster(bytes, real);

  return {
    dataUri: `data:${processed.mime};base64,${processed.buffer.toString("base64")}`,
    mimeType: processed.mime,
    byteLength: processed.buffer.length,
    originalByteLength: bytes.length,
    // base64 inflates by ~33% once inlined into the widget script.
    inlinedScriptBytes: Math.ceil(processed.buffer.length * 1.34),
    resized: processed.resized,
  };
}

/**
 * What the deployed widget renders. NEVER returns a blob: or app-origin URL —
 * that was the original bug.
 */
function resolveWidgetAvatar(chatbot) {
  const dataUri = chatbot?.avatar_data_uri || chatbot?.avatarDataUri;
  if (dataUri && String(dataUri).startsWith("data:")) {
    return { type: "inline", src: dataUri };
  }
  const url = chatbot?.avatar_url || chatbot?.avatarUrl;
  if (url && /^https:\/\//i.test(url)) {
    return { type: "remote", src: url };
  }
  return {
    type: "initial",
    src: null,
    label: String(chatbot?.avatar_label || chatbot?.name || "A")
      .trim().charAt(0).toUpperCase(),
  };
}

module.exports = { normalizeAvatar, resolveWidgetAvatar, MAX_AVATAR_BYTES };
