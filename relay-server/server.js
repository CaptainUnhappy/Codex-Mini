#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const jsQR = require('jsqr');
const { readBarcodes } = require('zxing-wasm/reader');
const { hmac, hashPassphrase, timingSafeEqualString, verifyPassphrase } = require('./lib/crypto');

const PORT = Number(process.env.PORT || process.env.CODEX_MINI_RELAY_PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const DEVICES_FILE = process.env.CODEX_MINI_RELAY_DEVICES || path.join(__dirname, 'devices.json');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.CODEX_MINI_RELAY_ADMIN_TOKEN || '';
const ADMIN_PASSWORD = process.env.CODEX_MINI_RELAY_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD_HASH = process.env.CODEX_MINI_RELAY_ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD_HASH || '';
const ADMIN_SESSION_SECRET = process.env.CODEX_MINI_RELAY_ADMIN_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET || ADMIN_TOKEN || ADMIN_PASSWORD_HASH || ADMIN_PASSWORD || crypto.randomBytes(32).toString('base64url');
const REGISTRATION_KEY = process.env.CODEX_MINI_RELAY_REGISTRATION_KEY || process.env.RELAY_REGISTRATION_KEY || '';
const MAX_BODY_BYTES = Number(process.env.CODEX_MINI_RELAY_MAX_BODY_BYTES || 32 * 1024 * 1024);
const QR_LOGIN_MAX_BYTES = Number(process.env.CODEX_MINI_QR_LOGIN_MAX_BYTES || 8 * 1024 * 1024);
const QR_DECODE_MAX_PIXELS = Number(process.env.CODEX_MINI_QR_DECODE_MAX_PIXELS || 64 * 1024 * 1024);
const QR_ZXING_MAX_SIDE = Number(process.env.CODEX_MINI_QR_ZXING_MAX_SIDE || 3200);
const REQUEST_TIMEOUT_MS = Number(process.env.CODEX_MINI_RELAY_TIMEOUT_MS || 70 * 1000);
const MAX_DEVICE_CONCURRENCY = Number(process.env.CODEX_MINI_RELAY_MAX_CONCURRENCY || 8);
const MAX_DEVICE_REQUESTS_PER_MINUTE = Number(process.env.CODEX_MINI_RELAY_MAX_REQUESTS_PER_MINUTE || 120);
const LOGIN_MIN_PASSPHRASE_LENGTH = 8;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IP_BLOCK_MS = 10 * 60 * 1000;
const LOGIN_GLOBAL_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_GLOBAL_BLOCK_MS = 60 * 1000;
const COOKIE_NAME = 'codexMiniRelaySession';
const ADMIN_COOKIE_NAME = 'codexMiniRelayAdmin';
const SESSION_MAX_AGE_SECONDS = 10 * 365 * 24 * 60 * 60;
const TUNNEL_TIMESTAMP_SKEW_MS = 60 * 1000;
const HEARTBEAT_MS = 30 * 1000;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

let registry = loadDevices();
let registrySignature = '';
const tunnels = new Map();
const loginFailuresByIp = new Map();
let globalLoginFailures = { windowStart: 0, count: 0, blockedUntil: 0 };
const deviceRateState = new Map();
let sharpModule = null;

function nowIso() {
  return new Date().toISOString();
}

function logMeta(message, fields = {}) {
  const safeFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`);
  console.log(`[${nowIso()}] ${message}${safeFields.length ? ` ${safeFields.join(' ')}` : ''}`);
}

function htmlEscape(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const raw = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch {
      cookies[key] = raw;
    }
  }
  return cookies;
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? { devices: parsed } : parsed;
}

function normalizeDevice(device) {
  const deviceId = String(device && device.deviceId || '').trim();
  const relaySecret = String(device && device.relaySecret || '').trim();
  const passphraseHash = String(device && device.passphraseHash || '').trim();
  if (!deviceId || !relaySecret || !passphraseHash) return null;
  return {
    deviceId,
    name: String(device.name || deviceId),
    relaySecret,
    passphraseHash,
    sessionVersion: Number(device.sessionVersion || 1) || 1,
    approved: device.approved !== false,
    fingerprint: String(device.fingerprint || ''),
    createdAt: String(device.createdAt || ''),
    approvedAt: String(device.approvedAt || ''),
  };
}

function sanitizeDeviceId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

function loadDevices() {
  try {
    const parsed = readJsonFile(DEVICES_FILE);
    const devices = (parsed.devices || []).map(normalizeDevice).filter(Boolean);
    return {
      devices,
      byId: new Map(devices.map(device => [device.deviceId, device])),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      logMeta('devices_missing', { file: DEVICES_FILE });
      return { devices: [], byId: new Map() };
    }
    logMeta('devices_load_failed', { error: error.message });
    return { devices: [], byId: new Map() };
  }
}

function saveDevices(devices) {
  const payload = { devices: devices.map(device => ({
    deviceId: device.deviceId,
    name: device.name || device.deviceId,
    relaySecret: device.relaySecret,
    passphraseHash: device.passphraseHash,
    sessionVersion: Number(device.sessionVersion || 1) || 1,
    approved: device.approved !== false,
    fingerprint: device.fingerprint || '',
    createdAt: device.createdAt || '',
    approvedAt: device.approvedAt || '',
  })) };
  const tmp = `${DEVICES_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tmp, DEVICES_FILE);
  registrySignature = '';
  reloadDevicesIfChanged();
}

function updateDevice(deviceId, updater) {
  reloadDevicesIfChanged();
  const devices = registry.devices.map(device => ({ ...device }));
  const target = devices.find(device => device.deviceId === deviceId);
  if (!target) return null;
  updater(target);
  saveDevices(devices);
  return registry.byId.get(deviceId) || target;
}

function upsertDevice(device) {
  reloadDevicesIfChanged();
  const devices = registry.devices.map(item => ({ ...item }));
  const existingIndex = devices.findIndex(item => item.deviceId === device.deviceId);
  const existing = existingIndex >= 0 ? devices[existingIndex] : null;
  const now = new Date().toISOString();
  const next = {
    deviceId: device.deviceId,
    name: device.name || device.deviceId,
    relaySecret: device.relaySecret,
    passphraseHash: hashPassphrase(device.passphrase),
    sessionVersion: Number(existing && existing.sessionVersion || 0) + 1,
    approved: device.approved === true,
    fingerprint: device.fingerprint || existing && existing.fingerprint || '',
    createdAt: existing && existing.createdAt || now,
    approvedAt: device.approved === true ? (existing && existing.approvedAt || now) : '',
  };
  if (existingIndex >= 0) devices[existingIndex] = next;
  else devices.push(next);
  saveDevices(devices);
  return registry.byId.get(device.deviceId) || next;
}

function approveDevice(deviceId) {
  return updateDevice(deviceId, device => {
    device.approved = true;
    device.approvedAt = new Date().toISOString();
    device.sessionVersion = Number(device.sessionVersion || 1) + 1;
  });
}

function reloadDevicesIfChanged() {
  let signature = '';
  try {
    const stat = fs.statSync(DEVICES_FILE);
    signature = `${stat.mtimeMs}:${stat.size}`;
  } catch {
    signature = 'missing';
  }
  if (signature !== registrySignature) {
    registrySignature = signature;
    registry = loadDevices();
  }
}

function findDeviceByPassphrase(passphrase, options = {}) {
  reloadDevicesIfChanged();
  const matches = [];
  for (const device of registry.devices) {
    if (device.approved === false && options.includePending !== true) continue;
    if (verifyPassphrase(passphrase, device.passphraseHash)) matches.push(device);
  }
  if (matches.length <= 1) return matches[0] || null;
  const onlineApproved = matches.find(device => device.approved !== false && isDeviceOnline(device.deviceId));
  if (onlineApproved) return onlineApproved;
  const approved = matches.find(device => device.approved !== false);
  return approved || matches[0] || null;
}

function getSharp() {
  if (sharpModule) return sharpModule;
  try {
    sharpModule = require('sharp');
    return sharpModule;
  } catch (error) {
    const wrapped = new Error('服务器缺少图片解码组件，请更新 relay 依赖后重试。');
    wrapped.status = 503;
    wrapped.code = 'QR_DECODER_UNAVAILABLE';
    wrapped.cause = error;
    throw wrapped;
  }
}

function makeSessionCookie(device) {
  const payload = {
    deviceId: device.deviceId,
    sessionVersion: device.sessionVersion,
    issuedAt: Date.now(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmac(device.relaySecret, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifySessionCookie(cookieValue) {
  reloadDevicesIfChanged();
  const [encodedPayload, signature] = String(cookieValue || '').split('.');
  if (!encodedPayload || !signature) return null;
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const device = registry.byId.get(String(payload.deviceId || ''));
  if (!device) return null;
  if (Number(payload.sessionVersion) !== Number(device.sessionVersion)) return null;
  if (!timingSafeEqualString(hmac(device.relaySecret, encodedPayload), signature)) return null;
  return device;
}

function sessionCookieHeader(device) {
  return `${COOKIE_NAME}=${encodeURIComponent(makeSessionCookie(device))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearSessionCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function getSessionDevice(req) {
  const value = parseCookies(req.headers.cookie || '')[COOKIE_NAME];
  return verifySessionCookie(value);
}

function clientIp(req) {
  return req.socket && req.socket.remoteAddress || 'unknown';
}

function resetWindow(entry, now, windowMs) {
  if (!entry.windowStart || now - entry.windowStart > windowMs) {
    entry.windowStart = now;
    entry.count = 0;
  }
}

function loginBlocked(req) {
  const now = Date.now();
  if (globalLoginFailures.blockedUntil > now) return Math.ceil((globalLoginFailures.blockedUntil - now) / 1000);
  const ip = clientIp(req);
  const entry = loginFailuresByIp.get(ip);
  if (entry && entry.blockedUntil > now) return Math.ceil((entry.blockedUntil - now) / 1000);
  return 0;
}

function recordLoginFailure(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const entry = loginFailuresByIp.get(ip) || { windowStart: now, count: 0, blockedUntil: 0 };
  resetWindow(entry, now, LOGIN_WINDOW_MS);
  entry.count += 1;
  if (entry.count >= 8) entry.blockedUntil = now + LOGIN_IP_BLOCK_MS;
  loginFailuresByIp.set(ip, entry);

  resetWindow(globalLoginFailures, now, LOGIN_GLOBAL_WINDOW_MS);
  globalLoginFailures.count += 1;
  if (globalLoginFailures.count >= 100) globalLoginFailures.blockedUntil = now + LOGIN_GLOBAL_BLOCK_MS;
}

function recordLoginSuccess(req) {
  loginFailuresByIp.delete(clientIp(req));
}

function json(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function text(res, status, body, headers = {}) {
  const data = Buffer.from(String(body || ''), 'utf8');
  res.writeHead(status, {
    ...headers,
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': data.length,
  });
  res.end(data);
}

function html(res, status, body, headers = {}) {
  const data = Buffer.from(String(body || ''), 'utf8');
  res.writeHead(status, {
    ...headers,
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'permissions-policy': 'camera=(self)',
    'content-length': data.length,
  });
  res.end(data);
}

function stripPublicBasePath(pathname) {
  for (const prefix of ['/codex', '/codex-mini', '/mini']) {
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || '/';
  }
  return pathname;
}

function serveRelayAsset(req, res, pathname) {
  const assetPath = stripPublicBasePath(pathname);
  if (assetPath === '/vendor/jsQR.js') {
    const filePath = path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist', 'jsQR.js');
    fs.readFile(filePath, (error, data) => {
      if (error) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end('Not found');
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': data.length,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
    return true;
  }
  if (assetPath === '/manifest.webmanifest') {
    const body = Buffer.from(JSON.stringify({
      name: 'Codex Mini Relay',
      short_name: 'Codex Mini',
      display: 'standalone',
      scope: './',
      start_url: './',
      background_color: '#0d0f14',
      theme_color: '#0d0f14',
    }), 'utf8');
    res.writeHead(200, {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'content-length': body.length,
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }
  if (
    assetPath === '/favicon.ico' ||
    assetPath === '/favicon.png' ||
    assetPath === '/apple-touch-icon.png' ||
    assetPath.startsWith('/icons/')
  ) {
    res.writeHead(204, { 'cache-control': 'public, max-age=3600' });
    res.end();
    return true;
  }
  return false;
}

function readBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('request body too large'), { status: 413, code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function keyFromQrValue(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw, 'https://codex-mini.local/');
    const hashKey = new URLSearchParams(url.hash.replace(/^#/, '')).get('k');
    if (hashKey) return hashKey.trim();
  } catch {}
  const match = raw.match(/(?:^|[#&])k=([^&]+)/);
  if (match) {
    try {
      return decodeURIComponent(match[1].replace(/\+/g, '%20')).trim();
    } catch {
      return match[1].trim();
    }
  }
  if (/^[A-Za-z0-9_-]{8,160}$/.test(raw)) return raw;
  return '';
}

function qrCropCandidates(width, height) {
  const candidates = [{ left: 0, top: 0, width, height }];
  const square = Math.min(width, height);
  const centerX = width / 2;
  const centerY = height / 2;
  for (const ratio of [1, 0.82, 0.64, 0.48]) {
    const size = Math.max(1, Math.round(square * ratio));
    candidates.push({
      left: Math.max(0, Math.round(centerX - size / 2)),
      top: Math.max(0, Math.round(centerY - size / 2)),
      width: size,
      height: size,
    });
  }
  const tileWidth = Math.max(1, Math.round(width * 0.62));
  const tileHeight = Math.max(1, Math.round(height * 0.62));
  for (const left of [0, width - tileWidth]) {
    for (const top of [0, height - tileHeight]) {
      candidates.push({
        left: Math.max(0, left),
        top: Math.max(0, top),
        width: tileWidth,
        height: tileHeight,
      });
    }
  }
  return candidates.filter((candidate, index, list) => {
    if (candidate.left + candidate.width > width || candidate.top + candidate.height > height) return false;
    return list.findIndex(item =>
      item.left === candidate.left &&
      item.top === candidate.top &&
      item.width === candidate.width &&
      item.height === candidate.height
    ) === index;
  });
}

function clampQrCrop(crop, imageWidth, imageHeight) {
  const left = Math.max(0, Math.min(Math.floor(Number(crop.left || 0)), imageWidth - 1));
  const top = Math.max(0, Math.min(Math.floor(Number(crop.top || 0)), imageHeight - 1));
  const width = Math.max(1, Math.min(Math.floor(Number(crop.width || 0)), imageWidth - left));
  const height = Math.max(1, Math.min(Math.floor(Number(crop.height || 0)), imageHeight - top));
  if (left < 0 || top < 0 || width < 1 || height < 1) return null;
  if (left + width > imageWidth || top + height > imageHeight) return null;
  return { left, top, width, height };
}

function qrDecodePlans(width, height) {
  const crops = qrCropCandidates(width, height);
  const plans = [];
  for (const crop of crops) {
    for (const rotation of [0, 90, 180, 270]) {
      plans.push({
        crop,
        rotation,
        maxSide: crop.width === width && crop.height === height ? 2400 : 1800,
      });
    }
  }
  return plans;
}

async function decodeQrWithZxing(imageBuffer) {
  const results = await readBarcodes(new Uint8Array(imageBuffer), {
    formats: ['QRCode'],
    tryHarder: true,
    tryRotate: true,
    tryInvert: true,
    tryDownscale: true,
    tryDenoise: true,
    maxNumberOfSymbols: 1,
    textMode: 'Plain',
  });
  for (const result of results || []) {
    if (!result || result.isValid === false) continue;
    const key = keyFromQrValue(result.text || '');
    if (key) return { key, raw: result.text || '', engine: 'zxing' };
  }
  return null;
}

async function decodeQrWithJsQrFallback(normalized, width, height) {
  const sharp = getSharp();
  for (const plan of qrDecodePlans(width, height)) {
    const crop = clampQrCrop(plan.crop, width, height);
    if (!crop) continue;
    try {
      const image = sharp(normalized, { limitInputPixels: QR_DECODE_MAX_PIXELS })
        .extract(crop)
        .rotate(plan.rotation)
        .resize({
          width: plan.maxSide,
          height: plan.maxSide,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .ensureAlpha()
        .raw();
      const { data, info } = await image.toBuffer({ resolveWithObject: true });
      const pixels = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
      const code = jsQR(pixels, info.width, info.height, { inversionAttempts: 'attemptBoth' });
      if (!code || !code.data) continue;
      const key = keyFromQrValue(code.data);
      if (key) return { key, raw: code.data, engine: 'jsqr' };
    } catch (error) {
      if (/extract_area|bad extract area|extract/i.test(String(error && error.message || ''))) continue;
      throw error;
    }
  }
  return null;
}

async function decodeQrImageBuffer(buffer) {
  const sharp = getSharp();
  const normalized = await sharp(buffer, {
    failOn: 'none',
    limitInputPixels: QR_DECODE_MAX_PIXELS,
  })
    .rotate()
    .resize({
      width: QR_ZXING_MAX_SIDE,
      height: QR_ZXING_MAX_SIDE,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png()
    .toBuffer();

  const zxingResult = await decodeQrWithZxing(normalized);
  if (zxingResult) return zxingResult;

  const metadata = await sharp(normalized, { limitInputPixels: QR_DECODE_MAX_PIXELS }).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);
  if (!width || !height) {
    const error = new Error('图片格式无法识别。');
    error.status = 422;
    error.code = 'IMAGE_UNREADABLE';
    throw error;
  }

  return decodeQrWithJsQrFallback(normalized, width, height);
}

function publicBasePath(pathname) {
  for (const prefix of ['/codex', '/codex-mini', '/mini']) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) return prefix;
  }
  return '';
}

let cachedJsQrBrowserScript = '';
function jsQrBrowserScript() {
  if (cachedJsQrBrowserScript) return cachedJsQrBrowserScript;
  try {
    cachedJsQrBrowserScript = fs
      .readFileSync(path.join(__dirname, '..', 'node_modules', 'jsqr', 'dist', 'jsQR.js'), 'utf8')
      .replace(/<\/script/gi, '<\\/script');
  } catch {
    cachedJsQrBrowserScript = '';
  }
  return cachedJsQrBrowserScript;
}

function loginPage(message = '', assetBasePath = '') {
  const jsQrScript = jsQrBrowserScript();
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Codex Mini Relay</title>
  <meta name="theme-color" content="#0d0f14" />
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d0f14; color: #f6f7f9; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 22px; background: #0d0f14; }
    main { width: min(390px, 100%); }
    .panel { border: 1px solid #2a3140; border-radius: 8px; background: rgba(16, 19, 27, .94); padding: 22px; box-shadow: 0 18px 60px rgba(0,0,0,.34); }
    .eyebrow { margin: 0 0 8px; color: #8da2c0; font-size: 12px; font-weight: 700; letter-spacing: 0; text-transform: uppercase; }
    h1 { font-size: 24px; line-height: 1.15; margin: 0 0 6px; font-weight: 700; }
    .copy { margin: 0 0 18px; color: #aeb8c8; font-size: 14px; line-height: 1.55; }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 7px; color: #cad2df; font-size: 13px; font-weight: 650; }
    input, button { width: 100%; height: 46px; border-radius: 8px; font-size: 16px; }
    input { border: 1px solid #3b4659; padding: 0 12px; background: #0b0d12; color: #f6f7f9; outline: none; }
    input:focus { border-color: #7aa7ff; box-shadow: 0 0 0 3px rgba(122,167,255,.18); }
    button { border: 0; background: #f6f7f9; color: #0d0f14; font-weight: 750; cursor: pointer; }
    button.secondary { border: 1px solid #3b4659; background: #151a24; color: #e6ecf7; }
    button:disabled { cursor: wait; opacity: .64; }
    .scan-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; margin-top: 12px; }
    .scan-actions button { height: 40px; font-size: 14px; }
    .file-input { position: fixed; left: -9999px; top: -9999px; width: 1px; height: 1px; opacity: 0; }
    .scanner-panel { display: grid; gap: 10px; margin: 12px 0 0; }
    .scanner-panel[hidden] { display: none; }
    .scanner-video-wrap { position: relative; overflow: hidden; border: 1px solid #2f3a4e; border-radius: 8px; background: #05070b; aspect-ratio: 1 / 1; }
    video { width: 100%; height: 100%; object-fit: cover; display: block; }
    .scan-frame { position: absolute; inset: 18%; border: 2px solid rgba(246,247,249,.9); border-radius: 16px; box-shadow: 0 0 0 999px rgba(0,0,0,.28); pointer-events: none; }
    .message { min-height: 20px; margin: 12px 0 0; color: #ffb4a8; font-size: 14px; line-height: 1.45; }
    .message.is-pending { color: #ffd98a; }
    .message.is-ok { color: #8ff0b6; }
    .hint { margin: 14px 0 0; color: #7f8ca2; font-size: 12px; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <section class="panel">
      <p class="eyebrow">Self-hosted relay</p>
      <h1>Codex Mini</h1>
      <p class="copy">输入这台电脑的设备密钥后，手机端会连接到对应的在线桌面端。</p>
      <form id="login-form" autocomplete="off">
        <label>设备密钥
          <input id="passphrase" type="password" minlength="8" placeholder="粘贴或扫码填入的设备密钥" autofocus />
        </label>
        <button id="submit" type="submit">登录</button>
      </form>
      <div class="scan-actions">
        <button class="secondary" id="camera-scan" type="button">打开摄像头扫码</button>
        <button class="secondary" id="album-scan" type="button">相册扫码</button>
      </div>
      <input class="file-input" id="camera-file" type="file" accept="image/*" capture="environment" />
      <input class="file-input" id="qr-file" type="file" accept="image/*" />
      <div class="scanner-panel" id="scanner-panel" hidden>
        <div class="scanner-video-wrap">
          <video id="scanner-video" playsinline muted autoplay></video>
          <div class="scan-frame" aria-hidden="true"></div>
        </div>
        <button class="secondary" id="close-scanner" type="button">关闭摄像头</button>
      </div>
      <p id="message" class="message">${htmlEscape(message)}</p>
      <p class="hint">二维码里的 #k 只会填入输入框；登录成功后才会从地址栏清理。</p>
    </section>
  </main>
  ${jsQrScript ? `<script>${jsQrScript}</script>` : ''}
  <script>
    const form = document.getElementById('login-form');
    const input = document.getElementById('passphrase');
    const submit = document.getElementById('submit');
    const message = document.getElementById('message');
    const cameraScan = document.getElementById('camera-scan');
    const albumScan = document.getElementById('album-scan');
    const cameraFile = document.getElementById('camera-file');
    const qrFile = document.getElementById('qr-file');
    const scannerPanel = document.getElementById('scanner-panel');
    const scannerVideo = document.getElementById('scanner-video');
    const closeScanner = document.getElementById('close-scanner');
    let barcodeDetector = null;
    let cameraStream = null;
    let scanTimer = 0;
    let scanCanvas = null;
    function cleanHash() {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
    function setMessage(text, type) {
      message.textContent = text || '';
      message.className = type ? 'message is-' + type : 'message';
    }
    function cameraCapabilityReport() {
      return {
        secureContext: Boolean(window.isSecureContext),
        protocol: location.protocol,
        hasMediaDevices: Boolean(navigator.mediaDevices),
        hasModernGetUserMedia: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
        hasLegacyGetUserMedia: Boolean(legacyGetUserMedia()),
        userAgent: navigator.userAgent || '',
      };
    }
    function cameraErrorName(error) {
      return String(error && error.name || error && error.code || 'CameraError');
    }
    function cameraErrorDetail(error) {
      const parts = [cameraErrorName(error)];
      if (error && error.constraint) parts.push('constraint=' + error.constraint);
      if (error && error.message) parts.push(String(error.message));
      return parts.filter(Boolean).join(' / ');
    }
    function cameraUnavailableMessage(error) {
      const report = cameraCapabilityReport();
      const name = cameraErrorName(error);
      if (!report.secureContext) return '实时摄像头需要 HTTPS 安全页面；当前页面不能调用实时相机，已切换为拍照扫码。';
      if (!report.hasModernGetUserMedia && !report.hasLegacyGetUserMedia) {
        return '当前 Android 浏览器没有暴露实时摄像头 API，已切换为拍照扫码。建议用 Chrome/Edge 打开同一个 HTTPS 链接。';
      }
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return '摄像头权限被拒绝，已切换为拍照扫码。请在浏览器站点权限里允许相机后重试。';
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return '没有找到可用摄像头，已切换为拍照扫码。';
      if (name === 'NotReadableError' || name === 'TrackStartError') return '摄像头被系统或其他应用占用，已切换为拍照扫码。';
      if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return '浏览器不支持请求的摄像头参数，已切换为拍照扫码。';
      if (name === 'NotSupportedError') return '当前 Android 浏览器不支持网页实时视频流，已切换为拍照扫码。建议用 Chrome/Edge 打开同一个 HTTPS 链接。';
      if (name === 'AbortError') return '浏览器中断了摄像头启动，已切换为拍照扫码。';
      return '无法打开实时摄像头（' + cameraErrorDetail(error) + '），已切换为拍照扫码。';
    }
    function reportCameraDiagnostic(stage, error, extra) {
      try {
        const payload = Object.assign(cameraCapabilityReport(), extra || {}, {
          stage,
          errorName: error ? cameraErrorName(error) : '',
          errorMessage: error && error.message ? String(error.message).slice(0, 240) : '',
          errorConstraint: error && error.constraint ? String(error.constraint) : '',
        });
        fetch('camera-diagnostic', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          keepalive: true,
        }).catch(() => {});
      } catch {}
    }
    async function getBarcodeDetector() {
      if (!('BarcodeDetector' in window)) {
        return null;
      }
      if (!barcodeDetector) {
        if (BarcodeDetector.getSupportedFormats) {
          const formats = await BarcodeDetector.getSupportedFormats();
          if (formats && !formats.includes('qr_code')) return null;
        }
        barcodeDetector = new BarcodeDetector({ formats: ['qr_code'] });
      }
      return barcodeDetector;
    }
    function keyFromQr(rawValue) {
      const raw = String(rawValue || '').trim();
      if (!raw) return '';
      try {
        const url = new URL(raw, location.href);
        const hashKey = new URLSearchParams(url.hash.replace(/^#/, '')).get('k');
        if (hashKey) return hashKey.trim();
      } catch {}
      const match = raw.match(/(?:^|[#&])k=([^&]+)/);
      if (match) {
        try {
          return decodeURIComponent(match[1].replace(/\\+/g, '%20')).trim();
        } catch {
          return match[1].trim();
        }
      }
      if (/^[A-Za-z0-9_-]{8,160}$/.test(raw)) return raw;
      return '';
    }
    function fillScannedKey(rawValue) {
      const key = keyFromQr(rawValue);
      if (!key) {
        setMessage('没有从二维码中识别到 #k 设备密钥。', '');
        return false;
      }
      input.value = key;
      setMessage('已识别设备密钥，正在登录...', 'ok');
      login(key);
      return true;
    }
    function decodeQrFromCanvas(canvas) {
      if (typeof window.jsQR !== 'function') return '';
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      const code = window.jsQR(imageData.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      return code && code.data ? code.data : '';
    }
    function withTimeout(promise, ms, label) {
      let timer = 0;
      const timeout = new Promise((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(label || 'timeout')), ms);
      });
      return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
    }
    function imageLoadPromise(image) {
      if (image.complete && image.naturalWidth) return Promise.resolve();
      return new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
      });
    }
    function imageCropCandidates(width, height, isVideo) {
      if (isVideo) return [{ sx: 0, sy: 0, sw: width, sh: height }];
      const candidates = [{ sx: 0, sy: 0, sw: width, sh: height }];
      const square = Math.min(width, height);
      const centerX = width / 2;
      const centerY = height / 2;
      for (const ratio of [1, 0.78, 0.58]) {
        const size = Math.max(1, Math.round(square * ratio));
        candidates.push({
          sx: Math.max(0, Math.round(centerX - size / 2)),
          sy: Math.max(0, Math.round(centerY - size / 2)),
          sw: size,
          sh: size,
        });
      }
      const tileWidth = Math.round(width * 0.58);
      const tileHeight = Math.round(height * 0.58);
      for (const x of [0, width - tileWidth]) {
        for (const y of [0, height - tileHeight]) {
          candidates.push({
            sx: Math.max(0, x),
            sy: Math.max(0, y),
            sw: Math.max(1, tileWidth),
            sh: Math.max(1, tileHeight),
          });
        }
      }
      return candidates;
    }
    function drawQrCandidate(source, crop, maxSide, rotation) {
      const sourceWidth = crop.sw;
      const sourceHeight = crop.sh;
      const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
      const scaledWidth = Math.max(1, Math.round(sourceWidth * scale));
      const scaledHeight = Math.max(1, Math.round(sourceHeight * scale));
      const rotated = rotation === 90 || rotation === 270;
      const targetWidth = rotated ? scaledHeight : scaledWidth;
      const targetHeight = rotated ? scaledWidth : scaledHeight;
      scanCanvas = scanCanvas || document.createElement('canvas');
      scanCanvas.width = targetWidth;
      scanCanvas.height = targetHeight;
      const context = scanCanvas.getContext('2d', { willReadFrequently: true });
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, targetWidth, targetHeight);
      if (rotation === 90) {
        context.translate(targetWidth, 0);
        context.rotate(Math.PI / 2);
      } else if (rotation === 180) {
        context.translate(targetWidth, targetHeight);
        context.rotate(Math.PI);
      } else if (rotation === 270) {
        context.translate(0, targetHeight);
        context.rotate(-Math.PI / 2);
      }
      context.drawImage(source, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, scaledWidth, scaledHeight);
      context.setTransform(1, 0, 0, 1, 0, 0);
      return scanCanvas;
    }
    function decodeQrWithJsQr(source) {
      const width = source.videoWidth || source.naturalWidth || source.width || 0;
      const height = source.videoHeight || source.naturalHeight || source.height || 0;
      if (!width || !height) return '';
      const isVideo = Boolean(source.videoWidth);
      const crops = imageCropCandidates(width, height, isVideo);
      const plans = isVideo
        ? [{ crop: crops[0], maxSide: 960, rotation: 0 }]
        : [
          { crop: crops[0], maxSide: 2200, rotation: 0 },
          { crop: crops[1], maxSide: 1800, rotation: 0 },
          { crop: crops[2], maxSide: 1800, rotation: 0 },
          { crop: crops[3], maxSide: 1600, rotation: 0 },
          { crop: crops[0], maxSide: 1400, rotation: 90 },
          { crop: crops[0], maxSide: 1400, rotation: 270 },
          { crop: crops[1], maxSide: 1400, rotation: 90 },
          { crop: crops[1], maxSide: 1400, rotation: 270 },
          { crop: crops[4], maxSide: 1400, rotation: 0 },
          { crop: crops[5], maxSide: 1400, rotation: 0 },
          { crop: crops[6], maxSide: 1400, rotation: 0 },
          { crop: crops[7], maxSide: 1400, rotation: 0 },
        ].filter(plan => plan.crop);
      let lastError = null;
      for (const plan of plans) {
        try {
          const candidate = drawQrCandidate(source, plan.crop, plan.maxSide, plan.rotation);
          const raw = decodeQrFromCanvas(candidate);
          if (raw) return raw;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return '';
    }
    async function detectQrFromSource(source) {
      let nativeError = null;
      try {
        const detector = await getBarcodeDetector();
        if (detector) {
          const codes = await detector.detect(source);
          const first = codes && codes[0];
          if (first && first.rawValue) return first.rawValue;
        }
      } catch (error) {
        nativeError = error;
      }
      try {
        return decodeQrWithJsQr(source);
      } catch (error) {
        if (nativeError) throw nativeError;
        throw error;
      }
    }
    async function loginWithQrFile(file) {
      if (!file) return;
      setMessage('正在上传二维码并登录...', 'ok');
      setLoginBusy(true, '正在登录...');
      try {
        const response = await fetch('qr-login', {
          method: 'POST',
          headers: { 'content-type': file.type || 'application/octet-stream' },
          body: file,
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          const error = new Error(data.message || '二维码登录失败');
          error.code = data.code || '';
          throw error;
        }
        cleanHash();
        location.replace('./');
      } catch (error) {
        setMessage(error.message || '二维码登录失败', error.code === 'DEVICE_PENDING_AUTHORIZATION' ? 'pending' : '');
        setLoginBusy(false);
      }
    }
    async function decodeImageFile(file) {
      return loginWithQrFile(file);
    }
    function stopCameraScan() {
      window.clearTimeout(scanTimer);
      scanTimer = 0;
      if (cameraStream) {
        for (const track of cameraStream.getTracks()) track.stop();
      }
      cameraStream = null;
      scannerVideo.srcObject = null;
      scannerPanel.hidden = true;
      cameraScan.disabled = false;
    }
    async function scanVideoFrame() {
      if (!cameraStream) return;
      try {
        if (scannerVideo.readyState >= 2) {
          const raw = await detectQrFromSource(scannerVideo);
          if (raw) {
            stopCameraScan();
            if (fillScannedKey(raw)) return;
            return;
          }
        }
      } catch (error) {
        stopCameraScan();
        setMessage(error.message || '摄像头扫码失败。', '');
        return;
      }
      scanTimer = window.setTimeout(scanVideoFrame, 350);
    }
    function legacyGetUserMedia() {
      return navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia || navigator.msGetUserMedia || null;
    }
    function canRequestCamera() {
      return Boolean((navigator.mediaDevices && navigator.mediaDevices.getUserMedia) || legacyGetUserMedia());
    }
    function requestCameraStream(constraints) {
      const legacy = legacyGetUserMedia();
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        return navigator.mediaDevices.getUserMedia(constraints).catch(modernError => {
          if (!legacy) throw modernError;
          reportCameraDiagnostic('getUserMedia-modern-failed-trying-legacy', modernError, { constraints: JSON.stringify(constraints) });
          return new Promise((resolve, reject) => {
            legacy.call(navigator, constraints, resolve, legacyError => {
              legacyError = legacyError || modernError;
              if (!legacyError.name && modernError && modernError.name) {
                try { legacyError.name = modernError.name; } catch {}
              }
              reject(legacyError);
            });
          });
        });
      }
      if (!legacy) return Promise.reject(new Error('camera api unavailable'));
      return new Promise((resolve, reject) => {
        legacy.call(navigator, constraints, resolve, reject);
      });
    }
    function waitForVideoReady(video, ms) {
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) return Promise.resolve();
      return withTimeout(new Promise((resolve, reject) => {
        const cleanup = () => {
          video.removeEventListener('loadedmetadata', onReady);
          video.removeEventListener('loadeddata', onReady);
          video.removeEventListener('canplay', onReady);
          video.removeEventListener('error', onError);
        };
        const onReady = () => {
          if (video.videoWidth && video.videoHeight) {
            cleanup();
            resolve();
          }
        };
        const onError = () => {
          cleanup();
          reject(new Error('video element failed'));
        };
        video.addEventListener('loadedmetadata', onReady);
        video.addEventListener('loadeddata', onReady);
        video.addEventListener('canplay', onReady);
        video.addEventListener('error', onError);
      }), ms || 3000, 'video metadata timeout');
    }
    async function openCameraStream() {
      const attempts = [
        { video: { facingMode: { ideal: 'environment' } }, audio: false },
        { video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false },
        { video: true, audio: false },
      ];
      let lastError = null;
      for (let index = 0; index < attempts.length; index += 1) {
        const constraints = attempts[index];
        try {
          return await requestCameraStream(constraints);
        } catch (error) {
          lastError = error;
          reportCameraDiagnostic('getUserMedia-attempt-failed', error, { attempt: index + 1, constraints: JSON.stringify(constraints) });
        }
      }
      throw lastError || new Error('camera unavailable');
    }
    async function startCameraScan() {
      try {
        reportCameraDiagnostic('camera-click');
        if (!canRequestCamera()) {
          const error = new Error('camera api unavailable');
          reportCameraDiagnostic('camera-api-unavailable', error);
          setMessage(cameraUnavailableMessage(error), '');
          cameraFile.click();
          return;
        }
        cameraScan.disabled = true;
        setMessage('正在打开摄像头...', 'ok');
        cameraStream = await openCameraStream();
        scannerVideo.muted = true;
        scannerVideo.playsInline = true;
        scannerVideo.setAttribute('playsinline', '');
        scannerVideo.setAttribute('autoplay', '');
        scannerVideo.setAttribute('muted', '');
        scannerVideo.srcObject = cameraStream;
        scannerPanel.hidden = false;
        await waitForVideoReady(scannerVideo, 3000);
        await scannerVideo.play();
        setMessage('请把二维码放入取景框。', 'ok');
        reportCameraDiagnostic('camera-open-ok', null, { videoWidth: scannerVideo.videoWidth, videoHeight: scannerVideo.videoHeight });
        scanVideoFrame();
      } catch (error) {
        reportCameraDiagnostic('camera-open-failed', error);
        stopCameraScan();
        setMessage(cameraUnavailableMessage(error), '');
        cameraFile.click();
      }
    }
    function setLoginBusy(isBusy, label) {
      submit.disabled = isBusy;
      cameraScan.disabled = isBusy;
      albumScan.disabled = isBusy;
      submit.textContent = isBusy ? (label || '正在登录...') : '登录';
    }
    async function login(passphrase) {
      setMessage('', '');
      setLoginBusy(true, '正在登录...');
      try {
        const response = await fetch('login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ passphrase }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) {
          const error = new Error(data.message || '登录失败');
          error.code = data.code || '';
          throw error;
        }
        cleanHash();
        location.replace('./');
      } catch (error) {
        setMessage(error.message || '登录失败', error.code === 'DEVICE_PENDING_AUTHORIZATION' ? 'pending' : '');
        setLoginBusy(false);
      }
    }
    form.addEventListener('submit', event => {
      event.preventDefault();
      login(input.value.trim());
    });
    const key = new URLSearchParams(location.hash.replace(/^#/, '')).get('k');
    if (key) {
      input.value = key;
    }
    cameraScan.addEventListener('click', startCameraScan);
    albumScan.addEventListener('click', () => qrFile.click());
    cameraFile.addEventListener('change', () => decodeImageFile(cameraFile.files && cameraFile.files[0]).finally(() => { cameraFile.value = ''; }).catch(error => setMessage(error.message || '拍照扫码失败。', '')));
    qrFile.addEventListener('change', () => decodeImageFile(qrFile.files && qrFile.files[0]).finally(() => { qrFile.value = ''; }).catch(error => setMessage(error.message || '相册扫码失败。', '')));
    closeScanner.addEventListener('click', stopCameraScan);
    window.addEventListener('pagehide', stopCameraScan);
  </script>
</body>
</html>`;
}

function handleLoginPage(req, res, message = '') {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '请先登录。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  html(res, 200, req.method === 'HEAD' ? '' : loginPage(message, publicBasePath(url.pathname)));
}

function finishPassphraseLogin(req, res, passphrase, source = 'login') {
  passphrase = String(passphrase || '').trim();
  if (passphrase.length < LOGIN_MIN_PASSPHRASE_LENGTH) {
    recordLoginFailure(req);
    return json(res, 401, { ok: false, code: 'BAD_PASSPHRASE', message: '设备密钥不正确。' });
  }

  const device = findDeviceByPassphrase(passphrase, { includePending: true });
  if (!device) {
    recordLoginFailure(req);
    logMeta('login_failed', { source, ip: clientIp(req) });
    return json(res, 401, { ok: false, code: 'BAD_PASSPHRASE', message: '设备密钥不正确。' });
  }

  if (device.approved === false) {
    logMeta('login_pending_authorization', { source, deviceId: device.deviceId, ip: clientIp(req) });
    return json(res, 403, { ok: false, code: 'DEVICE_PENDING_AUTHORIZATION', message: '等待授权' });
  }

  recordLoginSuccess(req);
  const online = isDeviceOnline(device.deviceId);
  logMeta('login_ok', { source, deviceId: device.deviceId, online });
  return json(res, 200, {
    ok: true,
    deviceId: device.deviceId,
    name: device.name,
    online,
  }, {
    'set-cookie': sessionCookieHeader(device),
  });
}

async function handleLogin(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  const blockedFor = loginBlocked(req);
  if (blockedFor) return json(res, 429, { ok: false, code: 'LOGIN_RATE_LIMITED', message: `登录尝试过多，请 ${blockedFor} 秒后再试。` });

  let payload = {};
  try {
    const body = await readBody(req, 16 * 1024);
    payload = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求格式不正确。' });
  }

  return finishPassphraseLogin(req, res, payload.passphrase, 'login');
}

async function handleCameraDiagnostic(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  let payload = {};
  try {
    const body = await readBody(req, 8 * 1024);
    payload = JSON.parse(body.toString('utf8') || '{}');
  } catch {
    payload = {};
  }
  const pick = key => String(payload[key] || '').slice(0, 240);
  logMeta('camera_diagnostic', {
    ip: clientIp(req),
    stage: pick('stage'),
    secureContext: Boolean(payload.secureContext),
    protocol: pick('protocol'),
    hasMediaDevices: Boolean(payload.hasMediaDevices),
    hasModernGetUserMedia: Boolean(payload.hasModernGetUserMedia),
    hasLegacyGetUserMedia: Boolean(payload.hasLegacyGetUserMedia),
    errorName: pick('errorName'),
    errorMessage: pick('errorMessage'),
    errorConstraint: pick('errorConstraint'),
    attempt: Number(payload.attempt || 0) || undefined,
    videoWidth: Number(payload.videoWidth || 0) || undefined,
    videoHeight: Number(payload.videoHeight || 0) || undefined,
    userAgent: pick('userAgent'),
  });
  return json(res, 200, { ok: true });
}

async function handleQrLogin(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  const blockedFor = loginBlocked(req);
  if (blockedFor) return json(res, 429, { ok: false, code: 'LOGIN_RATE_LIMITED', message: `登录尝试过多，请 ${blockedFor} 秒后再试。` });

  const contentType = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (contentType && !contentType.startsWith('image/') && contentType !== 'application/octet-stream') {
    return json(res, 415, { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', message: '请选择二维码图片。' });
  }

  let body = null;
  try {
    body = await readBody(req, QR_LOGIN_MAX_BYTES);
  } catch (error) {
    return json(res, error.status || 400, {
      ok: false,
      code: error.code || 'BAD_REQUEST',
      message: error.code === 'BODY_TOO_LARGE' ? '二维码图片太大，请选择 8MB 以内的图片。' : '图片上传失败。',
    });
  }
  if (!body || body.length === 0) {
    return json(res, 400, { ok: false, code: 'EMPTY_IMAGE', message: '请选择二维码图片。' });
  }

  let decoded = null;
  try {
    decoded = await decodeQrImageBuffer(body);
  } catch (error) {
    logMeta('qr_login_decode_failed', { code: error.code || 'QR_DECODE_FAILED', ip: clientIp(req) });
    return json(res, error.status || 422, {
      ok: false,
      code: error.code || 'QR_DECODE_FAILED',
      message: error.message || '二维码图片识别失败。',
    });
  }
  if (!decoded || !decoded.key) {
    return json(res, 422, { ok: false, code: 'QR_NOT_FOUND', message: '没有识别到可登录的二维码。' });
  }
  return finishPassphraseLogin(req, res, decoded.key, `qr_login_${decoded.engine || 'unknown'}`);
}

function handleLogout(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = { 'set-cookie': clearSessionCookieHeader() };
  if (url.searchParams.get('next') === 'login') {
    return redirect(res, './', headers);
  }
  return json(res, 200, { ok: true }, headers);
}

function wantsHtmlPage(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const fetchMode = String(req.headers['sec-fetch-mode'] || '');
  const accept = String(req.headers.accept || '');
  return fetchMode === 'navigate' || accept.includes('text/html');
}

function deviceOfflinePage(req, device) {
  const deviceName = htmlEscape(device.name || device.deviceId || 'Codex Mini');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>设备离线 - Codex Mini</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #171a1f; }
    main { width: min(420px, calc(100vw - 32px)); }
    h1 { margin: 0 0 10px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
    p { margin: 0 0 18px; color: #555c68; line-height: 1.6; }
    .panel { border: 1px solid #d9dde5; border-radius: 8px; background: #fff; padding: 24px; box-shadow: 0 12px 40px rgba(20, 28, 40, .08); }
    .device { font-size: 13px; color: #6b7280; word-break: break-all; }
    button { width: 100%; border: 0; border-radius: 8px; min-height: 46px; padding: 0 16px; font-size: 16px; font-weight: 700; color: #fff; background: #1f6feb; }
    button:active { transform: scale(.99); }
    @media (prefers-color-scheme: dark) {
      body { background: #111318; color: #f4f6fb; }
      .panel { background: #191d24; border-color: #2d3440; box-shadow: none; }
      p, .device { color: #aab2c0; }
    }
  </style>
</head>
<body>
  <main>
    <section class="panel">
      <h1>设备离线</h1>
      <p>当前桌面端未连接到中继服务器。可以切换到另一台已授权设备。</p>
      <p class="device">${deviceName}</p>
      <form method="post" action="logout?next=login">
        <button type="submit">切换设备</button>
      </form>
    </section>
  </main>
</body>
</html>`;
}

function isAdmin(req) {
  const value = parseCookies(req.headers.cookie || '')[ADMIN_COOKIE_NAME];
  return Boolean(verifyAdminCookie(value));
}

function adminPasswordMatches(password) {
  const raw = String(password || '');
  if (ADMIN_PASSWORD_HASH) return verifyPassphrase(raw, ADMIN_PASSWORD_HASH);
  if (!ADMIN_PASSWORD) return false;
  return timingSafeEqualString(raw, ADMIN_PASSWORD);
}

function makeAdminCookie() {
  const payload = {
    role: 'admin',
    issuedAt: Date.now(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = hmac(ADMIN_SESSION_SECRET, encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyAdminCookie(cookieValue) {
  const [encodedPayload, signature] = String(cookieValue || '').split('.');
  if (!encodedPayload || !signature) return null;
  let payload = null;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!payload || payload.role !== 'admin') return null;
  if (!timingSafeEqualString(hmac(ADMIN_SESSION_SECRET, encodedPayload), signature)) return null;
  return payload;
}

function adminCookieHeader() {
  return `${ADMIN_COOKIE_NAME}=${encodeURIComponent(makeAdminCookie())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

function clearAdminCookieHeader() {
  return `${ADMIN_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function redirect(res, location, headers = {}) {
  res.writeHead(303, {
    ...headers,
    location,
    'cache-control': 'no-store',
  });
  res.end();
}

function adminLoginPage(message = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
  <title>Codex Mini Admin</title>
  <meta name="theme-color" content="#0d0f14" />
  <style>
    :root { color-scheme: dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0d0f14; color: #f6f7f9; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 22px; background: #0d0f14; }
    main { width: min(390px, 100%); border: 1px solid #2a3140; border-radius: 8px; background: #10131b; padding: 22px; }
    .eyebrow { margin: 0 0 8px; color: #8da2c0; font-size: 12px; font-weight: 700; text-transform: uppercase; }
    h1 { font-size: 24px; margin: 0 0 18px; font-weight: 750; }
    form { display: grid; gap: 12px; }
    input, button { width: 100%; height: 46px; border-radius: 8px; font-size: 16px; }
    input { border: 1px solid #3b4659; padding: 0 12px; background: #0b0d12; color: #f6f7f9; outline: none; }
    input:focus { border-color: #7aa7ff; box-shadow: 0 0 0 3px rgba(122,167,255,.18); }
    button { border: 0; background: #f6f7f9; color: #0d0f14; font-weight: 750; cursor: pointer; }
    p { min-height: 20px; margin: 12px 0 0; color: #ffb4a8; font-size: 14px; }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Relay admin</p>
    <h1>Codex Mini 管理端</h1>
    <form method="post" action="login" autocomplete="off">
      <input name="password" type="password" placeholder="管理员密码" autofocus required />
      <button type="submit">登录</button>
    </form>
    <p>${htmlEscape(message)}</p>
  </main>
</body>
</html>`;
}

function handleAdminHome(req, res) {
  if (isAdmin(req)) return handleAdminStatus(req, res);
  return html(res, 200, adminLoginPage());
}

async function handleAdminLogin(req, res) {
  if (req.method !== 'POST') return html(res, 200, adminLoginPage());
  if (!ADMIN_PASSWORD && !ADMIN_PASSWORD_HASH) return html(res, 503, adminLoginPage('管理端密码未配置。'));
  let payload = {};
  try {
    payload = await readAdminPayload(req);
  } catch {
    return html(res, 400, adminLoginPage('请求格式不正确。'));
  }
  if (!adminPasswordMatches(payload.password)) {
    logMeta('admin_login_failed', { ip: clientIp(req) });
    return html(res, 401, adminLoginPage('管理员密码不正确。'));
  }
  logMeta('admin_login_ok', { ip: clientIp(req) });
  return redirect(res, './', { 'set-cookie': adminCookieHeader() });
}

function handleAdminLogout(req, res) {
  return redirect(res, './', { 'set-cookie': clearAdminCookieHeader() });
}

function parseFormBody(buffer) {
  const params = new URLSearchParams(buffer.toString('utf8'));
  return Object.fromEntries(params.entries());
}

async function readAdminPayload(req) {
  const body = await readBody(req, 64 * 1024);
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) return JSON.parse(body.toString('utf8') || '{}');
  return parseFormBody(body);
}

async function handleAdminDevicePassphrase(req, res) {
  if (!isAdmin(req)) return html(res, 401, adminLoginPage('请先登录管理端。'));
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  let payload = {};
  try {
    payload = await readAdminPayload(req);
  } catch {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求格式不正确。' });
  }
  const deviceId = String(payload.deviceId || '').trim();
  const passphrase = String(payload.passphrase || '').trim();
  if (passphrase.length < LOGIN_MIN_PASSPHRASE_LENGTH) {
    return json(res, 400, { ok: false, code: 'WEAK_PASSPHRASE', message: '设备密钥至少需要 8 个字符。' });
  }
  const updated = updateDevice(deviceId, device => {
    device.passphraseHash = hashPassphrase(passphrase);
    device.sessionVersion = Number(device.sessionVersion || 1) + 1;
  });
  if (!updated) return json(res, 404, { ok: false, code: 'DEVICE_NOT_FOUND', message: '设备不存在。' });
  logMeta('admin_passphrase_updated', { deviceId });
  return redirect(res, '../');
}

async function handleDeviceRegister(req, res) {
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  if (!REGISTRATION_KEY) {
    return json(res, 503, { ok: false, code: 'REGISTRATION_KEY_NOT_CONFIGURED', message: 'Device registration key is not configured.' });
  }
  let payload = {};
  try {
    payload = await readAdminPayload(req);
  } catch {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Request body is invalid.' });
  }
  const submittedKey = String(payload.registrationKey || req.headers['x-relay-registration-key'] || req.headers['x-registration-key'] || '');
  if (!timingSafeEqualString(submittedKey, REGISTRATION_KEY)) {
    logMeta('device_register_denied', { ip: clientIp(req) });
    return json(res, 401, { ok: false, code: 'BAD_REGISTRATION_KEY', message: 'Device registration key is incorrect.' });
  }

  const deviceId = sanitizeDeviceId(payload.deviceId);
  const name = String(payload.name || deviceId).trim().slice(0, 120) || deviceId;
  const relaySecret = String(payload.relaySecret || '').trim();
  const passphrase = String(payload.passphrase || '').trim();
  const fingerprint = String(payload.fingerprint || '').replace(/[^a-zA-Z0-9._-]+/g, '').slice(0, 80);

  if (!deviceId) return json(res, 400, { ok: false, code: 'BAD_DEVICE_ID', message: 'Device id is required.' });
  if (relaySecret.length < 24) return json(res, 400, { ok: false, code: 'WEAK_RELAY_SECRET', message: 'Relay secret is too short.' });
  if (passphrase.length < LOGIN_MIN_PASSPHRASE_LENGTH) {
    return json(res, 400, { ok: false, code: 'WEAK_PASSPHRASE', message: 'Device passphrase must be at least 8 characters.' });
  }

  reloadDevicesIfChanged();
  const existing = registry.byId.get(deviceId);
  if (existing && existing.approved !== false) {
    return json(res, 409, { ok: false, code: 'DEVICE_ALREADY_APPROVED', message: 'Device id is already approved.' });
  }

  const device = upsertDevice({ deviceId, name, relaySecret, passphrase, fingerprint, approved: false });
  logMeta('device_pending_registered', { deviceId: device.deviceId, ip: clientIp(req) });
  return json(res, 200, {
    ok: true,
    deviceId: device.deviceId,
    name: device.name,
    approved: false,
    sessionVersion: device.sessionVersion,
  });
}

async function handleAdminDeviceApprove(req, res) {
  if (!isAdmin(req)) return html(res, 401, adminLoginPage('Please login first.'));
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  let payload = {};
  try {
    payload = await readAdminPayload(req);
  } catch {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: 'Request body is invalid.' });
  }
  const deviceId = sanitizeDeviceId(payload.deviceId);
  const updated = approveDevice(deviceId);
  if (!updated) return json(res, 404, { ok: false, code: 'DEVICE_NOT_FOUND', message: 'Device not found.' });
  logMeta('admin_device_approved', { deviceId });
  return redirect(res, '../');
}

async function handleAdminDeviceRevoke(req, res) {
  if (!isAdmin(req)) return html(res, 401, adminLoginPage('请先登录管理端。'));
  if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
  let payload = {};
  try {
    payload = await readAdminPayload(req);
  } catch {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: '请求格式不正确。' });
  }
  const deviceId = String(payload.deviceId || '').trim();
  const updated = updateDevice(deviceId, device => {
    device.sessionVersion = Number(device.sessionVersion || 1) + 1;
  });
  if (!updated) return json(res, 404, { ok: false, code: 'DEVICE_NOT_FOUND', message: '设备不存在。' });
  logMeta('admin_sessions_revoked', { deviceId });
  return redirect(res, '../');
}

function handleAdminStatus(req, res) {
  if (!isAdmin(req)) return html(res, 401, adminLoginPage('请先登录管理端。'));
  reloadDevicesIfChanged();
  const devices = registry.devices;
  const pendingCount = devices.filter(device => device.approved === false).length;
  const onlineCount = devices.filter(device => isDeviceOnline(device.deviceId)).length;
  const formatTime = value => {
    if (!value) return '';
    const numeric = Number(value);
    let time = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(value);
    if (Number.isFinite(time) && time > 0 && time < 1000000000000) time *= 1000;
    if (!Number.isFinite(time)) return String(value);
    return new Date(time).toLocaleString('zh-CN', { hour12: false });
  };
  const formatDuration = seconds => {
    const value = Number(seconds || 0);
    if (!value) return '';
    const h = Math.floor(value / 3600);
    const m = Math.floor((value % 3600) / 60);
    const s = value % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  };
  const rows = devices.map(device => {
    const tunnel = tunnels.get(device.deviceId);
    const approved = device.approved !== false;
    const online = Boolean(tunnel && tunnel.ws.readyState === 1);
    const status = approved ? (online ? 'online' : 'offline') : 'pending';
    const statusText = status === 'pending' ? '等待授权' : status === 'online' ? '在线' : '离线';
    const connectedFor = tunnel ? Math.round((Date.now() - tunnel.connectedAt) / 1000) : 0;
    const rateState = deviceRateState.get(device.deviceId) || {};
    const activeRequests = Number(rateState.active || 0);
    const minuteRequests = Number(rateState.count || 0);
    const approveForm = approved ? '' : `
        <form method="post" action="device/approve">
          <input type="hidden" name="deviceId" value="${htmlEscape(device.deviceId)}">
          <button class="primary" type="submit">授权设备</button>
        </form>`;
    return `<tr class="is-${status}">
      <td><span class="badge ${status}">${statusText}</span></td>
      <td>
        <strong>${htmlEscape(device.name)}</strong>
        <small>创建：${htmlEscape(formatTime(device.createdAt) || '-')}</small>
      </td>
      <td class="mono">${htmlEscape(device.deviceId)}</td>
      <td class="mono">${htmlEscape(device.fingerprint || '-')}</td>
      <td>${htmlEscape(tunnel && tunnel.remoteAddress || '')}</td>
      <td>${htmlEscape(formatDuration(connectedFor))}</td>
      <td>${htmlEscape(tunnel && tunnel.lastRequestAt ? formatTime(tunnel.lastRequestAt) : '')}</td>
      <td>${Number(tunnel && tunnel.requestCount || 0)}</td>
      <td>${activeRequests}/${MAX_DEVICE_CONCURRENCY}</td>
      <td>${minuteRequests}/${MAX_DEVICE_REQUESTS_PER_MINUTE}</td>
      <td>${htmlEscape(tunnel && tunnel.lastError || '')}</td>
      <td>${Number(device.sessionVersion || 1)}</td>
      <td>
        ${approveForm}
        <form method="post" action="device/passphrase">
          <input type="hidden" name="deviceId" value="${htmlEscape(device.deviceId)}">
          <input name="passphrase" type="password" minlength="8" placeholder="新密钥" required>
          <button type="submit">更新密钥</button>
        </form>
        <form method="post" action="device/revoke">
          <input type="hidden" name="deviceId" value="${htmlEscape(device.deviceId)}">
          <button class="danger" type="submit">踢掉旧登录</button>
        </form>
      </td>
    </tr>`;
  }).join('\n') || '<tr><td class="empty" colspan="13">暂无设备。启动桌面端后，这里会出现待授权设备。</td></tr>';
  html(res, 200, `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Mini Relay Admin</title>
<style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d0f14;color:#f6f7f9}*{box-sizing:border-box}body{margin:0;background:#0d0f14;color:#f6f7f9}.page{width:min(1180px,calc(100vw - 32px));margin:0 auto;padding:24px 0 32px}header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px}.eyebrow{margin:0 0 7px;color:#8da2c0;font-size:12px;font-weight:700;text-transform:uppercase}h1{margin:0;font-size:24px}.muted{color:#95a1b5;font-size:13px}.summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:18px 0}.metric{border:1px solid #283142;border-radius:8px;background:#10131b;padding:14px}.metric strong{display:block;font-size:24px}.metric span{color:#95a1b5;font-size:13px}.table-wrap{overflow:auto;border:1px solid #283142;border-radius:8px;background:#10131b}table{border-collapse:collapse;width:100%;min-width:980px}td,th{border-bottom:1px solid #242b39;padding:10px;text-align:left;vertical-align:top}th{font-size:12px;color:#95a1b5;font-weight:700;background:#151a24;white-space:nowrap}tr:last-child td{border-bottom:0}tr.is-pending{background:rgba(255,217,138,.06)}strong{display:block;margin-bottom:4px}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12px;color:#d6deeb;word-break:break-all}small{display:block;color:#8793a8;font-size:12px}.badge{display:inline-flex;align-items:center;height:24px;border-radius:999px;padding:0 9px;font-size:12px;font-weight:750}.badge.online{background:#123c2b;color:#8ff0b6}.badge.offline{background:#343947;color:#c7d0df}.badge.pending{background:#473818;color:#ffd98a}form{display:flex;gap:6px;margin:0 0 7px}input{height:32px;min-width:130px;border:1px solid #3b4659;border-radius:7px;background:#0b0d12;color:#f6f7f9;padding:0 8px}button{height:32px;border:1px solid #3b4659;border-radius:7px;background:#1a2030;color:#f6f7f9;padding:0 10px;font-weight:700;white-space:nowrap;cursor:pointer}.primary{background:#f6f7f9;color:#0d0f14;border-color:#f6f7f9}.danger{color:#ffb4a8}.empty{color:#95a1b5;text-align:center;padding:26px}@media(max-width:720px){.page{width:calc(100vw - 20px);padding-top:16px}header{display:block}.summary{grid-template-columns:1fr}header form{margin-top:12px}}
</style>
</head><body><main class="page"><header><div><p class="eyebrow">Relay admin</p><h1>Codex Mini Relay</h1><p class="muted">只展示设备元数据，不记录设备密钥、会话 cookie、请求正文或 Codex 回复内容。</p></div><form method="post" action="logout"><button type="submit">退出管理端</button></form></header><section class="summary"><div class="metric"><strong>${devices.length}</strong><span>全部设备</span></div><div class="metric"><strong>${pendingCount}</strong><span>等待授权</span></div><div class="metric"><strong>${onlineCount}</strong><span>当前在线</span></div></section><section class="table-wrap"><table><thead><tr><th>状态</th><th>设备名称</th><th>Device ID</th><th>Fingerprint</th><th>IP</th><th>在线时长</th><th>最近请求</th><th>总请求</th><th>并发</th><th>分钟请求</th><th>最后错误</th><th>Session</th><th>操作</th></tr></thead><tbody>${rows}</tbody></table></section></main></body></html>`);
}

function isDeviceOnline(deviceId) {
  const tunnel = tunnels.get(deviceId);
  return Boolean(tunnel && tunnel.ws.readyState === 1);
}

function checkDeviceRate(deviceId) {
  const now = Date.now();
  const state = deviceRateState.get(deviceId) || { active: 0, windowStart: now, count: 0 };
  resetWindow(state, now, 60 * 1000);
  if (state.active >= MAX_DEVICE_CONCURRENCY) {
    deviceRateState.set(deviceId, state);
    return { ok: false, code: 'DEVICE_BUSY', status: 429, message: '设备请求过多，请稍后再试。' };
  }
  if (state.count >= MAX_DEVICE_REQUESTS_PER_MINUTE) {
    deviceRateState.set(deviceId, state);
    return { ok: false, code: 'RATE_LIMITED', status: 429, message: '请求过于频繁，请稍后再试。' };
  }
  state.active += 1;
  state.count += 1;
  deviceRateState.set(deviceId, state);
  return { ok: true };
}

function finishDeviceRequest(deviceId) {
  const state = deviceRateState.get(deviceId);
  if (!state) return;
  state.active = Math.max(0, state.active - 1);
}

function sanitizeRequestHeaders(headers) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'cookie') continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

function sanitizeResponseHeaders(headers, bodyLength) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === 'set-cookie') continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  out['content-length'] = String(bodyLength);
  return out;
}

async function proxyToDevice(req, res, device) {
  const tunnel = tunnels.get(device.deviceId);
  if (!tunnel || tunnel.ws.readyState !== 1) {
    if (wantsHtmlPage(req)) {
      return html(res, 503, req.method === 'HEAD' ? '' : deviceOfflinePage(req, device));
    }
    return json(res, 503, { ok: false, code: 'DEVICE_OFFLINE', message: '设备离线。' });
  }

  const rate = checkDeviceRate(device.deviceId);
  if (!rate.ok) return json(res, rate.status, { ok: false, code: rate.code, message: rate.message });

  const start = Date.now();
  let body = Buffer.alloc(0);
  try {
    body = await readBody(req);
  } catch (error) {
    finishDeviceRequest(device.deviceId);
    return json(res, error.status || 400, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '请求读取失败。' });
  }

  const id = crypto.randomBytes(12).toString('base64url');
  const pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  const timer = setTimeout(() => {
    const pending = tunnel.pending.get(id);
    if (!pending) return;
    tunnel.pending.delete(id);
    finishDeviceRequest(device.deviceId);
    tunnel.lastError = 'DEVICE_TIMEOUT';
    json(res, 504, { ok: false, code: 'DEVICE_TIMEOUT', message: '设备响应超时。' });
    logMeta('proxy_timeout', { deviceId: device.deviceId, path: pathname, durationMs: Date.now() - start });
  }, REQUEST_TIMEOUT_MS);

  tunnel.pending.set(id, {
    res,
    timer,
    start,
    path: pathname,
  });
  tunnel.lastRequestAt = Date.now();
  tunnel.requestCount += 1;

  const message = {
    type: 'request',
    id,
    method: req.method,
    path: req.url,
    headers: sanitizeRequestHeaders(req.headers),
    bodyBase64: body.toString('base64'),
  };

  tunnel.ws.send(JSON.stringify(message), error => {
    if (!error) return;
    const pending = tunnel.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    tunnel.pending.delete(id);
    finishDeviceRequest(device.deviceId);
    tunnel.lastError = 'TUNNEL_SEND_FAILED';
    json(res, 502, { ok: false, code: 'TUNNEL_SEND_FAILED', message: '转发到设备失败。' });
  });
}

function handleTunnelMessage(tunnel, raw) {
  let message = null;
  try {
    message = JSON.parse(String(raw || ''));
  } catch {
    return;
  }
  if (!message || message.type !== 'response' && message.type !== 'error') return;
  const pending = tunnel.pending.get(String(message.id || ''));
  if (!pending) return;
  clearTimeout(pending.timer);
  tunnel.pending.delete(String(message.id || ''));
  finishDeviceRequest(tunnel.deviceId);

  if (message.type === 'error') {
    tunnel.lastError = String(message.code || 'DEVICE_ERROR');
    json(pending.res, 502, { ok: false, code: message.code || 'DEVICE_ERROR', message: message.message || '设备处理请求失败。' });
    return;
  }

  const body = Buffer.from(String(message.bodyBase64 || ''), 'base64');
  const status = Number(message.status || 502);
  const headers = sanitizeResponseHeaders(message.headers || {}, body.length);
  pending.res.writeHead(status, headers);
  pending.res.end(body);
  logMeta('proxy_ok', {
    deviceId: tunnel.deviceId,
    path: pending.path,
    status,
    durationMs: Date.now() - pending.start,
    bytes: body.length,
  });
}

function closePending(tunnel, code, message) {
  for (const [id, pending] of tunnel.pending) {
    clearTimeout(pending.timer);
    finishDeviceRequest(tunnel.deviceId);
    json(pending.res, 503, { ok: false, code, message });
    tunnel.pending.delete(id);
  }
}

function authenticateTunnel(req) {
  reloadDevicesIfChanged();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const deviceId = String(url.searchParams.get('deviceId') || '');
  const timestamp = Number(url.searchParams.get('timestamp') || 0);
  const nonce = String(url.searchParams.get('nonce') || '');
  const signature = String(url.searchParams.get('signature') || '');
  const device = registry.byId.get(deviceId);
  if (!device || !timestamp || !nonce || !signature) return null;
  if (device.approved === false) return null;
  if (Math.abs(Date.now() - timestamp) > TUNNEL_TIMESTAMP_SKEW_MS) return null;
  const expected = hmac(device.relaySecret, `${deviceId}.${timestamp}.${nonce}`);
  if (!timingSafeEqualString(expected, signature)) return null;
  return device;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const routePath = stripPublicBasePath(url.pathname);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-admin-token',
    });
    return res.end();
  }
  if (routePath === '/health') return json(res, 200, { ok: true, service: 'codex-mini-relay', now: new Date().toISOString() });
  if (routePath === '/device/register') return handleDeviceRegister(req, res);
  if (routePath === '/login') return handleLogin(req, res);
  if (routePath === '/camera-diagnostic') return handleCameraDiagnostic(req, res);
  if (routePath === '/qr-login') return handleQrLogin(req, res);
  if (routePath === '/logout') return handleLogout(req, res);
  if (routePath === '/admin' || routePath === '/admin/') return handleAdminHome(req, res);
  if (routePath === '/admin/login') return handleAdminLogin(req, res);
  if (routePath === '/admin/logout') return handleAdminLogout(req, res);
  if (routePath === '/admin/status') return handleAdminStatus(req, res);
  if (routePath === '/admin/device/passphrase') return handleAdminDevicePassphrase(req, res);
  if (routePath === '/admin/device/approve') return handleAdminDeviceApprove(req, res);
  if (routePath === '/admin/device/revoke') return handleAdminDeviceRevoke(req, res);
  if ((req.method === 'GET' || req.method === 'HEAD') && routePath === '/favicon.ico') {
    if (serveRelayAsset(req, res, url.pathname)) return;
  }

  const device = getSessionDevice(req);
  if (!device) {
    if ((req.method === 'GET' || req.method === 'HEAD') && serveRelayAsset(req, res, url.pathname)) return;
    return handleLoginPage(req, res);
  }
  return proxyToDevice(req, res, device);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: Math.ceil(MAX_BODY_BYTES * 1.5) + 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/tunnel') {
    socket.destroy();
    return;
  }
  const device = authenticateTunnel(req);
  if (!device) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    wss.emit('connection', ws, req, device);
  });
});

wss.on('connection', (ws, req, device) => {
  const previous = tunnels.get(device.deviceId);
  if (previous && previous.ws.readyState === 1) {
    previous.ws.close(4000, 'replaced');
    closePending(previous, 'DEVICE_REPLACED', '设备连接已被新的连接替换。');
  }

  const tunnel = {
    deviceId: device.deviceId,
    name: device.name,
    ws,
    pending: new Map(),
    connectedAt: Date.now(),
    remoteAddress: clientIp(req),
    lastRequestAt: 0,
    requestCount: 0,
    lastError: '',
    alive: true,
  };
  tunnels.set(device.deviceId, tunnel);
  logMeta('tunnel_connected', { deviceId: device.deviceId, ip: tunnel.remoteAddress });

  ws.on('pong', () => {
    tunnel.alive = true;
  });
  ws.on('message', raw => handleTunnelMessage(tunnel, raw));
  ws.on('close', () => {
    if (tunnels.get(device.deviceId) === tunnel) tunnels.delete(device.deviceId);
    closePending(tunnel, 'DEVICE_OFFLINE', '设备离线。');
    logMeta('tunnel_disconnected', { deviceId: device.deviceId });
  });
  ws.on('error', error => {
    tunnel.lastError = error.message || 'WEBSOCKET_ERROR';
  });
});

setInterval(() => {
  for (const tunnel of tunnels.values()) {
    if (!tunnel.alive) {
      tunnel.ws.terminate();
      continue;
    }
    tunnel.alive = false;
    try {
      tunnel.ws.ping();
    } catch {
      tunnel.ws.terminate();
    }
  }
}, HEARTBEAT_MS).unref();

server.listen(PORT, HOST, () => {
  reloadDevicesIfChanged();
  logMeta('relay_listening', { host: HOST, port: PORT, devices: registry.devices.length });
  if (!ADMIN_PASSWORD && !ADMIN_PASSWORD_HASH) logMeta('admin_login_disabled', { reason: 'ADMIN_PASSWORD_missing' });
});
