#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
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
  for (const device of registry.devices) {
    if (device.approved === false && options.includePending !== true) continue;
    if (verifyPassphrase(passphrase, device.passphraseHash)) return device;
  }
  return null;
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

function loginPage(message = '') {
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
    button:disabled { cursor: wait; opacity: .64; }
    .message { min-height: 20px; margin: 12px 0 0; color: #ffb4a8; font-size: 14px; line-height: 1.45; }
    .message.is-pending { color: #ffd98a; }
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
      <p id="message" class="message">${htmlEscape(message)}</p>
      <p class="hint">二维码里的 #k 只会填入输入框；登录成功后才会从地址栏清理。</p>
    </section>
  </main>
  <script>
    const form = document.getElementById('login-form');
    const input = document.getElementById('passphrase');
    const submit = document.getElementById('submit');
    const message = document.getElementById('message');
    function cleanHash() {
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
    async function login(passphrase) {
      message.textContent = '';
      message.className = 'message';
      submit.disabled = true;
      submit.textContent = '正在登录...';
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
        message.textContent = error.message || '登录失败';
        if (error.code === 'DEVICE_PENDING_AUTHORIZATION') message.className = 'message is-pending';
        submit.disabled = false;
        submit.textContent = '登录';
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
  </script>
</body>
</html>`;
}

function handleLoginPage(req, res, message = '') {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '请先登录。' });
  html(res, 200, req.method === 'HEAD' ? '' : loginPage(message));
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

  const passphrase = String(payload.passphrase || '').trim();
  if (passphrase.length < LOGIN_MIN_PASSPHRASE_LENGTH) {
    recordLoginFailure(req);
    return json(res, 401, { ok: false, code: 'BAD_PASSPHRASE', message: '设备密钥不正确。' });
  }

  const device = findDeviceByPassphrase(passphrase, { includePending: true });
  if (!device) {
    recordLoginFailure(req);
    logMeta('login_failed', { ip: clientIp(req) });
    return json(res, 401, { ok: false, code: 'BAD_PASSPHRASE', message: '设备密钥不正确。' });
  }

  if (device.approved === false) {
    logMeta('login_pending_authorization', { deviceId: device.deviceId, ip: clientIp(req) });
    return json(res, 403, { ok: false, code: 'DEVICE_PENDING_AUTHORIZATION', message: '等待授权' });
  }

  recordLoginSuccess(req);
  const online = isDeviceOnline(device.deviceId);
  logMeta('login_ok', { deviceId: device.deviceId, online });
  return json(res, 200, {
    ok: true,
    deviceId: device.deviceId,
    name: device.name,
    online,
  }, {
    'set-cookie': sessionCookieHeader(device),
  });
}

function handleLogout(req, res) {
  return json(res, 200, { ok: true }, { 'set-cookie': clearSessionCookieHeader() });
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
