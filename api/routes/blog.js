"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

function publicPost(row, includeContent = false) {
  const post = {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt || "",
    templateKey: row.template_key || "product_update",
    coverImageUrl: row.cover_image_url || "",
    authorName: row.author_name || "Agently Team",
    publishedAt: row.published_at || row.created_at,
    updatedAt: row.updated_at || row.published_at || row.created_at,
    seoTitle: row.seo_title || row.title,
    seoDescription: row.seo_description || row.excerpt || "",
  };
  if (includeContent)
    post.contentBlocks = Array.isArray(row.content_blocks)
      ? row.content_blocks
      : [];
  return post;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit || 12), 1), 50);
    const db = getSupabase();
    const { data, error } = await db
      .from("blog_posts")
      .select(
        "id,slug,title,excerpt,template_key,cover_image_url,author_name,published_at,updated_at,created_at,seo_title,seo_description",
      )
      .eq("status", "published")
      .not("published_at", "is", null)
      .order("published_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    res.setHeader(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=300",
    );
    res.json({ posts: (data || []).map((row) => publicPost(row)) });
  }),
);

router.get(
  "/:slug",
  asyncHandler(async (req, res) => {
    const slug = String(req.params.slug || "")
      .trim()
      .toLowerCase();
    if (!slug)
      return res
        .status(404)
        .json({ error: { message: "Blog post not found." } });
    const db = getSupabase();
    const { data, error } = await db
      .from("blog_posts")
      .select("*")
      .eq("slug", slug)
      .eq("status", "published")
      .single();
    if (error || !data) {
      return res
        .status(404)
        .json({ error: { message: "Blog post not found." } });
    }
    res.setHeader(
      "Cache-Control",
      "public, max-age=60, stale-while-revalidate=300",
    );
    return res.json({ post: publicPost(data, true) });
  }),
);

module.exports = router;
