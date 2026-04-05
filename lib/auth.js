"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { getSupabase } = require("../../lib/supabase");
const { signToken } = require("../../lib/auth");
const { serializeUser } = require("../../lib/serializers");
const { sendMagicLinkEmail } = require("../../lib/email"); // keep magic link only
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

// ── POST /api/auth/register (simplified, no welcome email) ──
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { name, companyName, email, password } = req.body;

    if (!name || !companyName || !email || !password) {
      return res
        .status(400)
        .json({ error: { message: "All fields are required." } });
    }
    if (password.length < 8) {
      return res.status(400).json({
        error: { message: "Password must be at least 8 characters." },
      });
    }

    const db = getSupabase();

    // Check existing user
    const { data: existing } = await db
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase().trim())
      .single();
    if (existing) {
      return res.status(409).json({
        error: { message: "An account with this email already exists." },
      });
    }

    // Create organization
    const { data: org, error: orgErr } = await db
      .from("organizations")
      .insert({
        name: companyName.trim(),
        onboarded: false,
        plan: "Starter",
        subscription_status: "trialing",
        subscription_period_end: new Date(
          Date.now() + 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .select()
      .single();

    if (orgErr) {
      console.error("Org creation error:", orgErr);
      return res
        .status(500)
        .json({ error: { message: "Failed to create organization." } });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Create user
    const { data: user, error: userErr } = await db
      .from("users")
      .insert({
        organization_id: org.id,
        name: name.trim(),
        email: email.toLowerCase().trim(),
        password_hash: passwordHash,
        role: "Owner",
      })
      .select()
      .single();

    if (userErr) {
      console.error("User creation error:", userErr);
      await db.from("organizations").delete().eq("id", org.id);
      return res
        .status(500)
        .json({ error: { message: "Failed to create user account." } });
    }

    // Create seed invoice
    await db.from("invoices").insert({
      id: `INV-${Date.now()}-001`,
      organization_id: org.id,
      amount: 0,
      status: "Paid",
      date: new Date().toISOString(),
    });

    const token = signToken({ userId: user.id, orgId: org.id });

    res.status(201).json({
      token,
      user: serializeUser(user),
    });
  }),
);

// ── other routes (login, magic-link, logout) remain unchanged ──
// (copy them from your original auth.js, they are fine)

module.exports = router;
