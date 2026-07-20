"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");

function base32Encode(buffer) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  let output = "";
  for (let index = 0; index < bits.length; index += 5) {
    output += alphabet[Number.parseInt(bits.slice(index, index + 5).padEnd(5, "0"), 2)];
  }
  return output;
}

async function main() {
  const email = String(process.argv[2] || "owner@example.com").trim().toLowerCase();
  const password = String(process.argv[3] || "");
  if (password.length < 14) {
    console.error("Usage: node scripts/generate-super-admin-secrets.js owner@example.com 'A-strong-14+-character-password'");
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 13);
  const jwtSecret = crypto.randomBytes(48).toString("base64url");
  const totpSecret = base32Encode(crypto.randomBytes(20));
  const otpUri = `otpauth://totp/Agently:${encodeURIComponent(email)}?secret=${totpSecret}&issuer=Agently&algorithm=SHA1&digits=6&period=30`;

  console.log("\nAdd these only to agently-server environment variables:\n");
  console.log("SUPER_ADMIN_ENABLED=true");
  console.log(`SUPER_ADMIN_EMAIL=${email}`);
  console.log(`SUPER_ADMIN_PASSWORD_HASH='${passwordHash}'`);
  console.log(`SUPER_ADMIN_JWT_SECRET=${jwtSecret}`);
  console.log(`SUPER_ADMIN_TOTP_SECRET=${totpSecret}`);
  console.log("SUPER_ADMIN_SESSION_MINUTES=30");
  console.log("# Optional: SUPER_ADMIN_ALLOWED_IPS=203.0.113.10");
  console.log("\nAuthenticator setup URI (do not store in frontend):\n");
  console.log(otpUri);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
