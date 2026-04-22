"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { getSupabase } = require("../../lib/supabase");
const { signToken } = require("../../lib/auth");
const { serializeUser } = require("../../lib/serializers");
const { sendMagicLinkEmail, sendWelcomeEmail } = require("../../lib/email");
const { requireAuth } = require("../../middleware/auth");
const { asyncHandler } = require("../../middleware/error");

const router = express.Router();

// ─────────────────────────────────────────────────────────────
// POST /api/auth/login
// Body: { email: string, password: string }
// ─────────────────────────────────────────────────────────────
router.post(
  "/login",
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};

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

    // Use a generic message for both "not found" and "wrong password"
    // to avoid leaking which emails are registered.
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

    return res.json({ token, user: serializeUser(user) });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/register
// Body: { name, companyName, email, password }
// ─────────────────────────────────────────────────────────────
router.post(
  "/register",
  asyncHandler(async (req, res) => {
    const { name, companyName, email, password } = req.body || {};

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
    const normalizedEmail = email.toLowerCase().trim();

    // Check for existing account
    const { data: existing } = await db
      .from("users")
      .select("id")
      .eq("email", normalizedEmail)
      .single();

    if (existing) {
      return res.status(409).json({
        error: { message: "An account with this email already exists." },
      });
    }

    // Create organization first
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
      console.error("[register] org creation failed:", orgErr);
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
        email: normalizedEmail,
        password_hash: passwordHash,
        role: "Owner",
      })
      .select()
      .single();

    if (userErr || !user) {
      console.error("[register] user creation failed:", userErr);
      // Roll back the org we just created
      await db.from("organizations").delete().eq("id", org.id);
      return res
        .status(500)
        .json({ error: { message: "Failed to create user account." } });
    }

    // Seed a blank invoice record for billing history
    await db.from("invoices").insert([
      {
        id: `INV-${Date.now()}-001`,
        organization_id: org.id,
        amount: 0,
        status: "Paid",
        date: new Date().toISOString(),
      },
    ]);

    // Send welcome email — non-blocking, never fail registration because of it
    try {
      await sendWelcomeEmail(normalizedEmail, name.trim(), companyName.trim());
    } catch (emailErr) {
      console.warn("[register] welcome email failed:", emailErr.message);
    }

    const token = signToken({ userId: user.id, orgId: org.id });

    return res.status(201).json({ token, user: serializeUser(user) });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/magic-link
// Body: { email: string }
// Sends a one-time sign-in link to the user's email.
// ─────────────────────────────────────────────────────────────
router.post(
  "/magic-link",
  asyncHandler(async (req, res) => {
    const { email } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: { message: "Email is required." } });
    }

    const db = getSupabase();
    const normalizedEmail = email.toLowerCase().trim();

    // Generate a secure token (two UUIDs concatenated, no hyphens)
    const token = uuidv4().replace(/-/g, "") + uuidv4().replace(/-/g, "");
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString(); // 15 minutes

    // Invalidate any existing unused tokens for this email
    await db
      .from("magic_link_tokens")
      .update({ used: true })
      .eq("email", normalizedEmail)
      .eq("used", false);

    // Store the new token
    await db.from("magic_link_tokens").insert({
      email: normalizedEmail,
      token,
      expires_at: expiresAt,
    });

    const appUrl = (process.env.APP_URL || "http://localhost:3000").trim();
    const magicLinkUrl = `${appUrl}/#/login?magic=${token}`;

    // Send the email — non-blocking
    try {
      await sendMagicLinkEmail(normalizedEmail, magicLinkUrl);
    } catch (emailErr) {
      console.warn("[magic-link] email failed:", emailErr.message);
    }

    return res.json({
      message: "Magic link sent. Check your email.",
      email: normalizedEmail,
      magicLinkToken: token,
      // Only expose the URL in non-production (useful for local dev testing)
      magicLinkUrl: process.env.NODE_ENV !== "production" ? magicLinkUrl : null,
    });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/magic-link/verify
// Body: { token: string }
// ─────────────────────────────────────────────────────────────
router.post(
  "/magic-link/verify",
  asyncHandler(async (req, res) => {
    const { token } = req.body || {};

    if (!token) {
      return res.status(400).json({ error: { message: "Token is required." } });
    }

    const db = getSupabase();

    const { data: record, error } = await db
      .from("magic_link_tokens")
      .select("*")
      .eq("token", token)
      .eq("used", false)
      .single();

    if (error || !record) {
      return res
        .status(400)
        .json({ error: { message: "Invalid or already-used magic link." } });
    }

    if (new Date(record.expires_at) < new Date()) {
      return res.status(400).json({
        error: {
          message: "This magic link has expired. Please request a new one.",
        },
      });
    }

    // Mark the token as used immediately to prevent replay
    await db
      .from("magic_link_tokens")
      .update({ used: true })
      .eq("id", record.id);

    // Find the existing user or auto-create one for new sign-ups
    let user;
    const { data: existingUser } = await db
      .from("users")
      .select("id, name, email, role, avatar, organization_id")
      .eq("email", record.email)
      .single();

    if (existingUser) {
      user = existingUser;
    } else {
      // Auto-create org + user for first-time magic link sign-ups
      const emailName = record.email.split("@")[0];

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

      const { data: newUser } = await db
        .from("users")
        .insert({
          organization_id: newOrg.id,
          name: emailName,
          email: record.email,
          role: "Owner",
        })
        .select()
        .single();

      user = newUser;
    }

    if (!user) {
      return res
        .status(500)
        .json({ error: { message: "Failed to resolve user account." } });
    }

    const authToken = signToken({
      userId: user.id,
      orgId: user.organization_id,
    });

    return res.json({ token: authToken, user: serializeUser(user) });
  }),
);

// ─────────────────────────────────────────────────────────────
// POST /api/auth/logout
// JWT is stateless — we just acknowledge the logout.
// The client should discard its stored token.
// ─────────────────────────────────────────────────────────────
router.post(
  "/logout",
  requireAuth,
  asyncHandler(async (_req, res) => {
    return res.json({ success: true });
  }),
);

module.exports = router;
