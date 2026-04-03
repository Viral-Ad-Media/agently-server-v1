"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { getSupabase } = require("../../lib/supabase");
const { signToken } = require("../../lib/auth");
const { serializeUser } = require("../../lib/serializers");
const { sendMagicLinkEmail } = require("../../lib/email");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

// ── POST /api/auth/login ─────────────────────────────────────
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: { message: "Email and password are required." } });
    }

    const db = getSupabase();
    const { data: user, error } = await db
      .from("users")
      .select("id, name, email, role, avatar, password_hash, organization_id")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (error || !user || !user.password_hash) {
      return res
        .status(401)
        .json({ error: { message: "Invalid email or password." } });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res
        .status(401)
        .json({ error: { message: "Invalid email or password." } });
    }

    const token = signToken({ userId: user.id, orgId: user.organization_id });

    res.json({
      token,
      user: serializeUser(user),
    });
  }),
);

// ── POST /api/auth/register ──────────────────────────────────
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
      return res
        .status(400)
        .json({
          error: { message: "Password must be at least 8 characters." },
        });
    }

    const db = getSupabase();

    // Check if email already exists
    const { data: existing } = await db
      .from("users")
      .select("id")
      .eq("email", email.toLowerCase().trim())
      .single();

    if (existing) {
      return res
        .status(409)
        .json({
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

    if (orgErr || !org) {
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

    if (userErr || !user) {
      console.error("User creation error:", userErr);
      // Cleanup org
      await db.from("organizations").delete().eq("id", org.id);
      return res
        .status(500)
        .json({ error: { message: "Failed to create user account." } });
    }

    // Create seed invoices for new org
    await db.from("invoices").insert([
      {
        id: `INV-${Date.now()}-001`,
        organization_id: org.id,
        amount: 0,
        status: "Paid",
        date: new Date().toISOString(),
      },
    ]);

    const token = signToken({ userId: user.id, orgId: org.id });

    res.status(201).json({
      token,
      user: serializeUser(user),
    });
  }),
);

// ── POST /api/auth/magic-link ────────────────────────────────
router.post(
  "/magic-link",
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: { message: "Email is required." } });
    }

    const db = getSupabase();
    const token = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes
    const normalizedEmail = email.toLowerCase().trim();

    // Invalidate any existing tokens for this email
    await db
      .from("magic_link_tokens")
      .update({ used: true })
      .eq("email", normalizedEmail)
      .eq("used", false);

    // Insert new token
    await db.from("magic_link_tokens").insert({
      email: normalizedEmail,
      token,
      expires_at: expiresAt,
    });

    const appUrl = process.env.APP_URL || "http://localhost:3000";
    const apiUrl = process.env.API_URL || "http://localhost:4000";
    const magicLinkUrl = `${appUrl}/#/login?magic=${token}`;
    const verifyEndpoint = `${apiUrl}/api/auth/magic-link/verify`;

    // Send email (non-blocking, don't fail if email fails)
    try {
      await sendMagicLinkEmail(normalizedEmail, magicLinkUrl);
    } catch (emailErr) {
      console.warn("Magic link email failed:", emailErr.message);
    }

    res.json({
      message: "Magic link sent. Check your email.",
      email: normalizedEmail,
      magicLinkToken: token,
      verifyEndpoint,
      // Only return URL in dev mode
      magicLinkUrl: process.env.NODE_ENV !== "production" ? magicLinkUrl : null,
    });
  }),
);

// ── POST /api/auth/magic-link/verify ────────────────────────
router.post(
  "/magic-link/verify",
  asyncHandler(async (req, res) => {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: { message: "Token is required." } });
    }

    const db = getSupabase();

    const { data: linkRecord, error } = await db
      .from("magic_link_tokens")
      .select("*")
      .eq("token", token)
      .eq("used", false)
      .single();

    if (error || !linkRecord) {
      return res
        .status(400)
        .json({ error: { message: "Invalid or expired magic link." } });
    }

    if (new Date(linkRecord.expires_at) < new Date()) {
      return res
        .status(400)
        .json({
          error: {
            message: "This magic link has expired. Please request a new one.",
          },
        });
    }

    // Mark token as used
    await db
      .from("magic_link_tokens")
      .update({ used: true })
      .eq("id", linkRecord.id);

    // Find or create user
    let user;
    const { data: existingUser } = await db
      .from("users")
      .select("id, name, email, role, avatar, organization_id")
      .eq("email", linkRecord.email)
      .single();

    if (existingUser) {
      user = existingUser;
    } else {
      // Auto-create org and user for new magic link signups
      const { data: newOrg } = await db
        .from("organizations")
        .insert({
          name: "My Business",
          onboarded: false,
          plan: "Starter",
          subscription_status: "trialing",
          subscription_period_end: new Date(
            Date.now() + 30 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        })
        .select()
        .single();

      const emailName = linkRecord.email.split("@")[0];
      const { data: newUser } = await db
        .from("users")
        .insert({
          organization_id: newOrg.id,
          name: emailName,
          email: linkRecord.email,
          role: "Owner",
        })
        .select()
        .single();

      user = newUser;
    }

    const authToken = signToken({
      userId: user.id,
      orgId: user.organization_id,
    });

    res.json({
      token: authToken,
      user: serializeUser(user),
    });
  }),
);

// ── POST /api/auth/logout ────────────────────────────────────
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    // JWT is stateless; client clears the token.
    // We just acknowledge.
    res.json({ success: true });
  }),
);

module.exports = router;
