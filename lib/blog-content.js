"use strict";

const { v4: uuidv4 } = require("uuid");

const ALLOWED_TEMPLATES = new Set(["product_update", "editorial", "guide"]);
const ALLOWED_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "image",
  "quote",
  "bullets",
  "video",
]);

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 110);
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(Math.max(numeric, min), max);
}

function sanitizeColor(value) {
  const raw = String(value || "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw : undefined;
}

function sanitizeBlockStyle(value) {
  if (!value || typeof value !== "object") return undefined;
  const allowedFonts = new Set(["default", "sans", "serif", "display", "mono"]);
  const allowedAlignments = new Set(["left", "center", "right"]);
  const allowedFits = new Set(["cover", "contain"]);
  const style = {};
  const fontFamily = String(value.fontFamily || "").trim();
  const textAlign = String(value.textAlign || "").trim();
  const mediaFit = String(value.mediaFit || "").trim();
  if (allowedFonts.has(fontFamily)) style.fontFamily = fontFamily;
  if (allowedAlignments.has(textAlign)) style.textAlign = textAlign;
  if (allowedFits.has(mediaFit)) style.mediaFit = mediaFit;
  const textColor = sanitizeColor(value.textColor);
  const backgroundColor = sanitizeColor(value.backgroundColor);
  if (textColor) style.textColor = textColor;
  if (backgroundColor) style.backgroundColor = backgroundColor;
  if (value.fontSize !== undefined)
    style.fontSize = clamp(value.fontSize, 12, 92, 18);
  if (value.widthPercent !== undefined)
    style.widthPercent = clamp(value.widthPercent, 35, 100, 100);
  if (value.paddingY !== undefined)
    style.paddingY = clamp(value.paddingY, 0, 96, 0);
  if (value.borderRadius !== undefined)
    style.borderRadius = clamp(value.borderRadius, 0, 48, 20);
  if (value.overlayOpacity !== undefined)
    style.overlayOpacity = clamp(value.overlayOpacity, 0, 0.92, 0.5);
  const backgroundImageUrl = String(value.backgroundImageUrl || "")
    .trim()
    .slice(0, 3000);
  if (backgroundImageUrl) style.backgroundImageUrl = backgroundImageUrl;
  return Object.keys(style).length ? style : undefined;
}

function sanitizeBlocks(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const type = String(block.type || "").toLowerCase();
    if (!ALLOWED_BLOCK_TYPES.has(type)) return [];
    const id = String(block.id || uuidv4());
    const style = sanitizeBlockStyle(block.style);
    const withStyle = style ? { style } : {};
    if (type === "image") {
      const url = String(block.url || "")
        .trim()
        .slice(0, 3000);
      if (!url) return [];
      return [
        {
          id,
          type,
          url,
          alt: String(block.alt || "")
            .trim()
            .slice(0, 300),
          caption: String(block.caption || "")
            .trim()
            .slice(0, 500),
          ...withStyle,
        },
      ];
    }
    if (type === "video") {
      const url = String(block.url || "")
        .trim()
        .slice(0, 3000);
      if (!url) return [];
      return [
        {
          id,
          type,
          url,
          caption: String(block.caption || "")
            .trim()
            .slice(0, 500),
          posterUrl: String(block.posterUrl || "")
            .trim()
            .slice(0, 3000),
          ...withStyle,
        },
      ];
    }
    if (type === "bullets") {
      const items = Array.isArray(block.items)
        ? block.items
            .map((item) =>
              String(item || "")
                .trim()
                .slice(0, 1000),
            )
            .filter(Boolean)
            .slice(0, 30)
        : [];
      return [
        { id, type, items, readAloud: Boolean(block.readAloud), ...withStyle },
      ];
    }
    return [
      {
        id,
        type,
        text: String(block.text || "")
          .trim()
          .slice(0, type === "heading" ? 500 : 12000),
        readAloud: Boolean(block.readAloud),
        ...withStyle,
      },
    ];
  });
}

// n8n / an LLM writing agent will usually hand back plain markdown-ish text
// rather than pre-shaped content blocks. This gives automation producers a
// simple contract: send `content` (a markdown string) OR `contentBlocks`
// (already-shaped blocks) — either works.
function markdownToBlocks(markdown) {
  const text = String(markdown || "").replace(/\r\n/g, "\n");
  if (!text.trim()) return [];
  const chunks = text.split(/\n{2,}/);
  const blocks = [];
  for (const rawChunk of chunks) {
    const chunk = rawChunk.trim();
    if (!chunk) continue;
    const headingMatch = chunk.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({
        id: uuidv4(),
        type: "heading",
        text: headingMatch[2].trim().slice(0, 500),
      });
      continue;
    }
    if (/^>\s+/.test(chunk)) {
      blocks.push({
        id: uuidv4(),
        type: "quote",
        text: chunk.replace(/^>\s+/, "").trim().slice(0, 12000),
      });
      continue;
    }
    const lines = chunk.split("\n").map((line) => line.trim());
    const isBulletList = lines.every((line) => /^[-*]\s+/.test(line));
    if (isBulletList) {
      blocks.push({
        id: uuidv4(),
        type: "bullets",
        items: lines
          .map((line) =>
            line
              .replace(/^[-*]\s+/, "")
              .trim()
              .slice(0, 1000),
          )
          .filter(Boolean)
          .slice(0, 20),
      });
      continue;
    }
    blocks.push({
      id: uuidv4(),
      type: "paragraph",
      text: chunk.slice(0, 12000),
    });
  }
  return blocks.slice(0, 80);
}

async function uniqueSlug(db, base, postId = null) {
  const root = slugify(base) || `update-${Date.now()}`;
  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? root : `${root}-${index + 1}`;
    let query = db
      .from("blog_posts")
      .select("id")
      .eq("slug", candidate)
      .limit(1);
    if (postId) query = query.neq("id", postId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data?.length) return candidate;
  }
  return `${root}-${Date.now()}`;
}

function serializePost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || "",
    status: row.status || "draft",
    templateKey: row.template_key || "product_update",
    coverImageUrl: row.cover_image_url || "",
    authorName: row.author_name || "Agently Team",
    contentBlocks: Array.isArray(row.content_blocks) ? row.content_blocks : [],
    seoTitle: row.seo_title || "",
    seoDescription: row.seo_description || "",
    publishedAt: row.published_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by || "",
  };
}

module.exports = {
  ALLOWED_TEMPLATES,
  ALLOWED_BLOCK_TYPES,
  slugify,
  sanitizeBlocks,
  markdownToBlocks,
  uniqueSlug,
  serializePost,
};
