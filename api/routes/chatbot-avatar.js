"use strict";

const express = require("express");
const { getSupabase } = require("../../lib/supabase");

const router = express.Router();
const CHATBOT_AVATAR_BUCKET = process.env.CHATBOT_AVATAR_BUCKET || "chatbot-avatars";

function isSafeAvatarFileName(fileName) {
  return /^avatar\.(png|jpe?g|webp|gif)$/i.test(String(fileName || ""));
}

function contentTypeFor(fileName) {
  const lower = String(fileName || "").toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}

router.get("/:id/:fileName", async (req, res) => {
  try {
    const { id, fileName } = req.params;
    if (!id || !isSafeAvatarFileName(fileName)) {
      return res.status(404).end();
    }

    const db = getSupabase();
    const { data: chatbot, error } = await db
      .from("chatbots")
      .select("id, organization_id")
      .eq("id", id)
      .single();

    if (error || !chatbot?.organization_id) {
      return res.status(404).end();
    }

    const objectPath = `${chatbot.organization_id}/${id}/${fileName}`;
    const { data, error: downloadError } = await db.storage
      .from(CHATBOT_AVATAR_BUCKET)
      .download(objectPath);

    if (downloadError || !data) {
      return res.status(404).end();
    }

    let buffer;
    if (Buffer.isBuffer(data)) {
      buffer = data;
    } else if (typeof data.arrayBuffer === "function") {
      buffer = Buffer.from(await data.arrayBuffer());
    } else {
      buffer = Buffer.from(data);
    }

    res.setHeader("Content-Type", contentTypeFor(fileName));
    res.setHeader("Cache-Control", "public, max-age=3600, stale-while-revalidate=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).send(buffer);
  } catch (error) {
    console.error("[chatbot-avatar] failed:", error && error.message ? error.message : error);
    return res.status(404).end();
  }
});

module.exports = router;
