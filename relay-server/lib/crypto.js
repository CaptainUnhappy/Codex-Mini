'use strict';

const crypto = require('crypto');

const PBKDF2_DIGEST = 'sha256';
const PBKDF2_ITERATIONS = 120000;
const PBKDF2_KEY_BYTES = 32;

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function randomToken(bytes = 32) {
  return base64url(crypto.randomBytes(bytes));
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function hmac(secret, value) {
  return crypto.createHmac('sha256', String(secret || '')).update(String(value || '')).digest('base64url');
}

function hashPassphrase(passphrase, options = {}) {
  const salt = options.salt || randomToken(18);
  const iterations = Number(options.iterations || PBKDF2_ITERATIONS);
  const hash = crypto.pbkdf2Sync(String(passphrase || ''), salt, iterations, PBKDF2_KEY_BYTES, PBKDF2_DIGEST).toString('base64url');
  return `pbkdf2-${PBKDF2_DIGEST}$${iterations}$${salt}$${hash}`;
}

function verifyPassphrase(passphrase, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== `pbkdf2-${PBKDF2_DIGEST}`) return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isFinite(iterations) || iterations < 1 || !salt || !expected) return false;
  const actual = crypto.pbkdf2Sync(String(passphrase || ''), salt, iterations, PBKDF2_KEY_BYTES, PBKDF2_DIGEST).toString('base64url');
  return timingSafeEqualString(actual, expected);
}

module.exports = {
  hmac,
  hashPassphrase,
  randomToken,
  timingSafeEqualString,
  verifyPassphrase,
};
