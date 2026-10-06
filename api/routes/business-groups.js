"use strict";

/**
 * Business groups: explicit links between businesses that share one owner's
 * time (cross-business double-booking guard).
 *
 * Each login is scoped to a single org, so linking uses pairing codes:
 * business A creates a group and shows a code; the owner pastes it while
 * logged into business B. Codes expire after 24h.
 *
 *   GET    /api/integrations/business-groups        (admin) my groups + members
 *   POST   /api/integrations/business-groups        (admin) create + invite code
 *   POST   /api/integrations/business-groups/join   (admin) join with code
 *   PUT    /api/integrations/business-groups/:id    (admin) policy / label / new code
 *   DELETE /api/integrations/business-groups/:id    (admin) leave (deletes group when empty)
 *
 * policy: 'flag_for_review' (book, then notify the tenant of the clash) or
 * 'block' (treat the overlapping slot as taken).
 */

const express = require("express");
const crypto = require("crypto");
const { getSupabase } = require("../../lib/supabase");
const { requireAuth, requireAdmin } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");
const { invalidateAvailabilityCache } = require("../../lib/calendar-booking");

const router = express.Router();
const INVITE_TTL_MS = 24 * 3600 * 1000;

function newInviteCode() {
  return crypto.randomBytes(6).toString("hex"); // 12 chars, typable
}

async function getGroupWithMembers(db, groupId) {
  const { data: group, error } = await db
    .from("business_groups")
    .select("id, owner_label, policy, invite_code, invite_expires_at, created_at, updated_at")
    .eq("id", groupId)
    .maybeSingle();
  if (error) throw error;
  if (!group) return null;
  const { data: members, error: memberError } = await db
    .from("business_group_members")
    .select("organization_id, created_at")
    .eq("group_id", groupId);
  if (memberError) throw memberError;
  const orgIds = (members || []).map((m) => m.organization_id);
  let names = {};
  if (orgIds.length > 0) {
    const { data: orgs } = await db.from("organizations").select("id, name").in("id", orgIds);
    names = Object.fromEntries((orgs || []).map((o) => [o.id, o.name || "Unnamed business"]));
  }
  // Hide spent codes from the response.
  const codeValid = group.invite_code && group.invite_expires_at && new Date(group.invite_expires_at).getTime() > Date.now();
  return {
    id: group.id,
    owner_label: group.owner_label,
    policy: group.policy,
    invite_code: codeValid ? group.invite_code : null,
    invite_expires_at: codeValid ? group.invite_expires_at : null,
    members: (members || []).map((m) => ({
      organization_id: m.organization_id,
      name: names[m.organization_id] || "Unnamed business",
      joined_at: m.created_at,
    })),
    created_at: group.created_at,
    updated_at: group.updated_at,
  };
}

async function myGroupIds(db, orgId) {
  const { data, error } = await db
    .from("business_group_members")
    .select("group_id")
    .eq("organization_id", orgId);
  if (error) throw error;
  return (data || []).map((r) => r.group_id);
}

async function requireMember(db, groupId, orgId, res) {
  const ids = await myGroupIds(db, orgId);
  if (!ids.includes(groupId)) {
    res.status(404).json({ error: { code: "not_found", message: "Business group not found." } });
    return false;
  }
  return true;
}

async function invalidateMembers(db, groupId) {
  try {
    const { data } = await db
      .from("business_group_members")
      .select("organization_id")
      .eq("group_id", groupId);
    for (const m of data || []) invalidateAvailabilityCache(m.organization_id);
  } catch (_) {
    // advisory
  }
}

router.get(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const ids = await myGroupIds(db, req.orgId);
    const groups = [];
    for (const id of ids) {
      const g = await getGroupWithMembers(db, id);
      if (g) groups.push(g);
    }
    res.json({ groups });
  }),
);

router.post(
  "/",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    const existing = await myGroupIds(db, req.orgId);
    if (existing.length > 0) {
      return res.status(400).json({
        error: {
          code: "already_grouped",
          message: "This business is already in a linked group. Leave it first to create a new one.",
        },
      });
    }
    const code = newInviteCode();
    const now = new Date().toISOString();
    const { data: group, error } = await db
      .from("business_groups")
      .insert({
        owner_label: String(req.body.owner_label || "").slice(0, 80),
        policy: "flag_for_review",
        invite_code: code,
        invite_expires_at: new Date(Date.now() + INVITE_TTL_MS).toISOString(),
        created_at: now,
        updated_at: now,
      })
      .select("id")
      .single();
    if (error) throw error;
    const { error: memberError } = await db
      .from("business_group_members")
      .insert({ group_id: group.id, organization_id: req.orgId, created_at: now });
    if (memberError) throw memberError;
    const full = await getGroupWithMembers(db, group.id);
    res.status(201).json({ group: full });
  }),
);

router.post(
  "/join",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const code = String(req.body.code || "").trim().toLowerCase();
    if (!code) {
      return res.status(400).json({ error: { code: "missing_code", message: "An invite code is required." } });
    }
    const db = getSupabase();
    const existing = await myGroupIds(db, req.orgId);
    if (existing.length > 0) {
      return res.status(400).json({
        error: {
          code: "already_grouped",
          message: "This business is already in a linked group. Leave it first to join another.",
        },
      });
    }
    const { data: group, error } = await db
      .from("business_groups")
      .select("id, invite_expires_at")
      .eq("invite_code", code)
      .maybeSingle();
    if (error) throw error;
    if (!group || !group.invite_expires_at || new Date(group.invite_expires_at).getTime() < Date.now()) {
      return res.status(404).json({
        error: { code: "invalid_code", message: "That invite code is invalid or expired." },
      });
    }
    const { error: memberError } = await db
      .from("business_group_members")
      .insert({ group_id: group.id, organization_id: req.orgId, created_at: new Date().toISOString() });
    if (memberError) {
      if (memberError.code === "23505") {
        return res.status(400).json({ error: { code: "already_member", message: "This business is already in that group." } });
      }
      throw memberError;
    }
    await invalidateMembers(db, group.id);
    const full = await getGroupWithMembers(db, group.id);
    res.json({ group: full });
  }),
);

router.put(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    if (!(await requireMember(db, req.params.id, req.orgId, res))) return;
    const updates = { updated_at: new Date().toISOString() };
    if (req.body.policy !== undefined) {
      if (req.body.policy !== "block" && req.body.policy !== "flag_for_review") {
        return res.status(400).json({
          error: { code: "invalid_policy", message: "policy must be \"block\" or \"flag_for_review\"." },
        });
      }
      updates.policy = req.body.policy;
    }
    if (req.body.owner_label !== undefined) {
      updates.owner_label = String(req.body.owner_label).slice(0, 80);
    }
    if (req.body.regenerate_code) {
      updates.invite_code = newInviteCode();
      updates.invite_expires_at = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    }
    const { error } = await db.from("business_groups").update(updates).eq("id", req.params.id);
    if (error) throw error;
    await invalidateMembers(db, req.params.id);
    const full = await getGroupWithMembers(db, req.params.id);
    res.json({ group: full });
  }),
);

router.delete(
  "/:id",
  requireAuth,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const db = getSupabase();
    if (!(await requireMember(db, req.params.id, req.orgId, res))) return;
    await db
      .from("business_group_members")
      .delete()
      .eq("group_id", req.params.id)
      .eq("organization_id", req.orgId);
    const { data: remaining } = await db
      .from("business_group_members")
      .select("organization_id")
      .eq("group_id", req.params.id);
    if (!remaining || remaining.length === 0) {
      await db.from("business_groups").delete().eq("id", req.params.id);
    }
    invalidateAvailabilityCache(req.orgId);
    res.json({ left: true });
  }),
);

module.exports = router;
