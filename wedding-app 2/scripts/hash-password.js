#!/usr/bin/env node
// Usage: npm run hash-password -- "the password"
// Prints a hash to paste into AUTH_USER_1_PASSWORD_HASH / AUTH_USER_2_PASSWORD_HASH.
// Uses only Node's built-in crypto module (see auth.js) — runs anywhere
// Node runs, no npm install required.

const path = require("path");
const auth = require(path.join(__dirname, "..", "auth.js"));

const password = process.argv[2];
if (!password) {
  console.error('Usage: npm run hash-password -- "your password"');
  process.exit(1);
}

console.log(auth.hashPassword(password));
