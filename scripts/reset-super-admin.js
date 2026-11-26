#!/usr/bin/env node
"use strict";

/*
 * Break-glass: get back into the Agently Super Admin.
 *
 * Run on the owner's PC (needs the AWS CLI profile "agently" for the live app):
 *
 *   node scripts/reset-super-admin.js                      new password + new authenticator + new recovery codes
 *   node scripts/reset-super-admin.js --keep-authenticator keep the current authenticator entry on your phone
 *   node scripts/reset-super-admin.js --password "your own words here"
 *   node scripts/reset-super-admin.js --local-only         only this PC's .env files, not the live app
 *
 * What it does:
 *   1. issues a password (an easy-to-type passphrase unless --password is given)
 *      and, unless --keep-authenticator, a new authenticator (TOTP) key;
 *   2. issues 10 one-time recovery codes (stored on the server only as SHA-256);
 *   3. writes them to .env and .env.docker;
 *   4. updates the live API container on Lightsail (agently-ingest / api) by
 *      copying its current deployment and changing only these variables
 *      (--api-image :agently-ingest.api.N also swaps the image);
 *   5. saves a private setup page with the QR code + credentials to
 *      ../../Agently-AWS-backups/super-admin-<date>/open-me-admin-setup.html.
 *
 * Nothing secret is printed to the terminal. The live change takes ~3 minutes
 * to roll out; the previous deployment is saved next to the setup page.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");

const SERVER_DIR = path.resolve(__dirname, "..");
const BACKUPS = path.resolve(SERVER_DIR, "..", "..", "Agently-AWS-backups");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const WORDS = (
  "amber anchor apple arrow aspen atlas autumn badge bamboo banner basil beacon berry birch bison blaze bloom " +
  "bolt breeze brick brook cabin cactus camel candle canyon carbon cargo cedar chalk cherry cider citrus clover " +
  "cobalt comet copper coral cotton crane crystal cypress daisy delta denim desert dolphin dragon drift eagle " +
  "echo ember falcon fern fiber flint forest fossil fox galaxy garnet ginger glacier granite gravel harbor " +
  "hazel heron honey horizon husky iris island ivory jade jasper jungle kayak kernel kettle koala lagoon lantern " +
  "lava lemon lilac linen lotus lunar maple marble meadow melon meteor mint mosaic nectar nickel nova oak oasis " +
  "olive onyx orbit orchid otter oyster panda papaya pebble pepper pine planet plum polar pollen poppy prism " +
  "quartz quill rabbit radar raven reef ripple river robin rocket ruby saffron sage salmon sapphire satin " +
  "shadow shell sierra silver sky slate solar sparrow spice spruce stone storm summit sunset swan tango thunder " +
  "tiger timber topaz tulip tundra velvet violet walnut willow winter wolf zebra zephyr"
).split(" ");

function passphrase() {
  const picks = [];
  while (picks.length < 4) {
    const word = WORDS[crypto.randomInt(WORDS.length)];
    if (!picks.includes(word)) picks.push(word);
  }
  return `${picks.map((w) => w[0].toUpperCase() + w.slice(1)).join("-")}-${crypto.randomInt(10, 100)}`;
}

function base32(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5) out += alphabet[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}

function recoveryCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let raw = "";
  while (raw.length < 12) raw += alphabet[crypto.randomInt(alphabet.length)];
  if (!/[A-Z]/.test(raw)) return recoveryCode();
  return raw.match(/.{4}/g).join("-");
}

function setEnvLine(file, key, value) {
  if (!fs.existsSync(file)) return;
  let text = fs.readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `${key}='${value}'`;
  const re = new RegExp(`^${key}=.*$`, "m");
  text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}${eol}${line}${eol}`;
  fs.writeFileSync(file, text);
}

const escapeHtml = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function main() {
  const env = dotenv.parse(fs.readFileSync(path.join(SERVER_DIR, ".env")));
  const email = String(env.SUPER_ADMIN_EMAIL || "").trim().toLowerCase();
  if (!email) throw new Error("SUPER_ADMIN_EMAIL is not set in agently-server/.env");

  const password = option("--password") || passphrase();
  if (password.length < 12) throw new Error("Choose a password of at least 12 characters.");
  const hash = await bcrypt.hash(password, 13);
  const keepTotp = flag("--keep-authenticator") && String(env.SUPER_ADMIN_TOTP_SECRET || "").trim();
  const totp = keepTotp ? String(env.SUPER_ADMIN_TOTP_SECRET).trim() : base32(crypto.randomBytes(20));
  const codes = Array.from({ length: 10 }, recoveryCode);
  const codeHashes = codes
    .map((code) => crypto.createHash("sha256").update(code.replace(/-/g, "")).digest("hex"))
    .join(",");

  const updates = {
    SUPER_ADMIN_PASSWORD_HASH: hash,
    SUPER_ADMIN_TOTP_SECRET: totp,
    SUPER_ADMIN_RECOVERY_CODES: codeHashes,
  };
  for (const file of [".env", ".env.docker"]) {
    for (const [key, value] of Object.entries(updates)) setEnvLine(path.join(SERVER_DIR, file), key, value);
  }
  console.log("Local .env files updated.");

  const stamp = new Date().toISOString().slice(0, 10);
  const outDir = path.join(BACKUPS, `super-admin-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  if (!flag("--local-only")) {
    const awsEnv = { ...process.env, AWS_PROFILE: process.env.AWS_PROFILE || "agently", AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "us-east-1" };
    const aws = (a) => execFileSync("aws", a, { env: awsEnv, encoding: "utf8", maxBuffer: 1e8 });
    const service = JSON.parse(aws(["lightsail", "get-container-services", "--service-name", "agently-ingest", "--output", "json"])).containerServices[0];
    const current = service.currentDeployment;
    fs.writeFileSync(path.join(outDir, `agently-ingest-before-deployment-${current.version}.json`), JSON.stringify(current, null, 2));
    const containers = JSON.parse(JSON.stringify(current.containers));
    Object.assign(containers.api.environment, updates);
    if (option("--api-image")) containers.api.image = option("--api-image");
    const inputFile = path.join(outDir, "deployment-input.json");
    fs.writeFileSync(inputFile, JSON.stringify({ serviceName: "agently-ingest", containers, publicEndpoint: current.publicEndpoint }));
    try {
      const result = JSON.parse(aws(["lightsail", "create-container-service-deployment", "--cli-input-json", `file://${inputFile}`, "--output", "json"]));
      console.log(`Live app: deployment ${result.containerService.nextDeployment?.version} is rolling out (about 3 minutes).`);
    } finally {
      fs.unlinkSync(inputFile);
    }
  }

  const label = `Agently Admin (${stamp})`;
  const uri = `otpauth://totp/${encodeURIComponent(label)}:${encodeURIComponent(email)}?secret=${totp}&issuer=${encodeURIComponent("Agently Admin")}&algorithm=SHA1&digits=6&period=30`;
  const QRCode = require("qrcode");
  const qrDataUrl = await QRCode.toDataURL(uri, { width: 420, margin: 2 });
  await QRCode.toFile(path.join(outDir, "authenticator-qr.png"), uri, { width: 420, margin: 2 });

  const keyGroups = totp.match(/.{1,4}/g).join(" ");
  fs.writeFileSync(
    path.join(outDir, "super-admin-credentials.txt"),
    [
      `Agently Super Admin — ${stamp}. PRIVATE: save in a password manager, then delete this folder.`,
      "",
      "Sign in:   https://www.agentlycall.com/admin",
      `Email:     ${email}`,
      `Password:  ${password}`,
      "",
      keepTotp
        ? "Authenticator: unchanged — keep using your existing Agently entry."
        : `Authenticator: scan authenticator-qr.png (entry "${label}"), or enter this key manually (time based):\n  ${keyGroups}`,
      "",
      "Recovery codes (each works ONCE, typed in place of the 6-digit code):",
      ...codes.map((code) => `  ${code}`),
      "",
      "Locked out completely? On this PC run:  node agently-server/scripts/reset-super-admin.js",
    ].join("\r\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "open-me-admin-setup.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agently Super Admin setup</title>
<style>body{margin:0;background:#f6f5f1;color:#101216;font:15px/1.55 system-ui,sans-serif;display:flex;justify-content:center;padding:32px 16px}
.card{background:#fff;border:1px solid #d9d7d0;border-radius:14px;padding:28px;max-width:480px;width:100%}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:22px 0 6px}p{color:#5a5b61;margin:6px 0 14px}
.qr{display:block;margin:8px auto 14px;width:240px;height:240px}dt{font-size:12px;color:#76736b;margin-top:12px}
dd{margin:2px 0 0;font:600 16px/1.4 ui-monospace,Consolas,monospace;word-break:break-all}ol{padding-left:18px;color:#3b3c42}
.codes{display:grid;grid-template-columns:1fr 1fr;gap:6px;font:600 14px ui-monospace,Consolas,monospace}
.codes span{background:#faf9f5;border:1px solid #ece9e1;border-radius:8px;padding:6px 8px;text-align:center}
.warn{margin-top:18px;font-size:12px;color:#8a2c0a;background:#fff6f1;border:1px solid #f3b79c;border-radius:10px;padding:10px}</style></head>
<body><div class="card"><h1>Agently Super Admin</h1><p>Issued ${escapeHtml(stamp)}. Sign in at <b>www.agentlycall.com/admin</b>.</p>
<dl><dt>Email</dt><dd>${escapeHtml(email)}</dd><dt>Password</dt><dd>${escapeHtml(password)}</dd></dl>
${keepTotp ? `<h2>Authenticator</h2><p>Unchanged — keep using your existing Agently entry.</p>` : `<h2>Authenticator</h2>
<ol><li>In Google Authenticator, <b>delete any older “Agently” entries</b>.</li><li>Tap <b>+</b> → <b>Scan a QR code</b> and scan this. The new entry is called <b>${escapeHtml(label)}</b>.</li></ol>
<img class="qr" alt="Authenticator QR code" src="${qrDataUrl}">
<p>Can't scan? Choose “Enter a setup key”, type this key and pick <b>Time based</b>:</p><dl><dd>${escapeHtml(keyGroups)}</dd></dl>`}
<h2>Recovery codes</h2><p>Each works once, typed into the code box instead of the 6-digit code — for when your phone isn't with you.</p>
<div class="codes">${codes.map((c) => `<span>${escapeHtml(c)}</span>`).join("")}</div>
<div class="warn">Private. Save these in a password manager, then delete this folder. Locked out completely? On your PC run <b>node agently-server/scripts/reset-super-admin.js</b>.</div>
</div></body></html>`,
  );

  console.log(`Setup page saved: ${path.join(outDir, "open-me-admin-setup.html")}`);
}

main().catch((error) => {
  console.error("Reset failed:", error.message);
  process.exit(1);
});
