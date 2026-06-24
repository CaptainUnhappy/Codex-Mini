#!/usr/bin/env node
'use strict';

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { URL } = require('url');

const APP_NAME = process.env.CODEX_MINI_APP_NAME || 'Codex Mini';
const IS_MAC = process.platform === 'darwin';
const IS_WINDOWS = process.platform === 'win32';
const WINDOWS_CODEX_APP_ID = process.env.CODEX_MINI_WINDOWS_CODEX_APP_ID || 'OpenAI.Codex_2p2nqsd0c76g0!App';
const WINDOWS_CODEX_STARTUP_TIMEOUT_MS = Number(process.env.CODEX_MINI_WINDOWS_CODEX_STARTUP_TIMEOUT_MS || 18000);
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.MOBILE_TYPER_TOKEN || crypto.randomBytes(12).toString('base64url');
const RELAY_URL = process.env.CODEX_MINI_RELAY_URL || '';
const RELAY_PUBLIC_BASE = String(process.env.CODEX_MINI_RELAY_PUBLIC_BASE || '').replace(/\/+$/, '');
const RELAY_DEVICE_ID = process.env.CODEX_MINI_RELAY_DEVICE_ID || os.hostname();
const RELAY_SECRET = process.env.CODEX_MINI_RELAY_SECRET || '';
const RELAY_PASSPHRASE = process.env.CODEX_MINI_RELAY_PASSPHRASE || '';
const RELAY_REQUEST_TIMEOUT_MS = Number(process.env.CODEX_MINI_RELAY_REQUEST_TIMEOUT_MS || 70 * 1000);
const RELAY_RESPONSE_MAX_BYTES = Number(process.env.CODEX_MINI_RELAY_RESPONSE_MAX_BYTES || 32 * 1024 * 1024);
const RELAY_TERMINAL_QR = process.env.CODEX_MINI_TERMINAL_QR !== '0';
const RELAY_HEARTBEAT_INTERVAL_MS = Number(process.env.CODEX_MINI_RELAY_HEARTBEAT_INTERVAL_MS || 15000);
const RELAY_HEARTBEAT_TIMEOUT_MS = Number(process.env.CODEX_MINI_RELAY_HEARTBEAT_TIMEOUT_MS || 45000);
const RELAY_REQUIRE_CODEX_DESKTOP = process.env.CODEX_MINI_RELAY_REQUIRE_CODEX_DESKTOP !== '0';
const RELAY_CODEX_WATCH_INTERVAL_MS = Number(process.env.CODEX_MINI_RELAY_CODEX_WATCH_INTERVAL_MS || 5000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = Number(process.env.CODEX_MINI_MAX_BODY_BYTES || 28 * 1024 * 1024);
const MAX_TEXT_LENGTH = 8000;
const MAX_ATTACHMENTS = 6;
const MAX_ATTACHMENT_BYTES = Number(process.env.CODEX_MINI_MAX_ATTACHMENT_BYTES || 8 * 1024 * 1024);
const UPLOAD_DIR = path.join(os.tmpdir(), 'codex-mini-uploads');
const STATE_DIR = process.env.CODEX_MINI_STATE_DIR || path.join(os.homedir(), '.codex-mini');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const QR_OUTPUT_DIR = process.env.CODEX_MINI_QR_DIR || (IS_WINDOWS ? __dirname : STATE_DIR);

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const CODEX_SESSION_INDEX = path.join(os.homedir(), '.codex', 'session_index.jsonl');
const CODEX_DESKTOP_LOGS_DIR = path.join(os.homedir(), 'Library', 'Logs', 'com.openai.codex');
const CODEX_SESSION_TAIL_BYTES = 5 * 1024 * 1024;
const CODEX_ACTIVITY_TAIL_BYTES = 512 * 1024;
const CODEX_ACTIVITY_LOOKBACK_BYTES = CODEX_SESSION_TAIL_BYTES;
const CODEX_RUNTIME_STALE_MS = 2 * 60 * 60 * 1000;
const CODEX_HISTORY_TAIL_BYTES = 128 * 1024 * 1024;
const CODEX_TITLE_SCAN_BYTES = 12 * 1024 * 1024;
const MAX_HISTORY_MESSAGES = 120;
const GUI_FAILURE_REPORT_LIMIT = 80;
const GUI_FAILURE_LOG_SCAN_BYTES = 2 * 1024 * 1024;
const GUI_FAILURE_LOG_RECENT_MS = 15 * 60 * 1000;
const RECENT_SEND_TTL_MS = 5 * 60 * 1000;
const CODEX_SEND_CONFIRM_TIMEOUT_MS = Number(process.env.CODEX_MINI_SEND_CONFIRM_TIMEOUT_MS || 6000);
const CODEX_THREAD_SYNC_FRESH_MS = 5000;
const CODEX_DEEPLINK_SETTLE_MS = 560;
const CODEX_APP_FOCUS_SETTLE_MS = 100;
const CODEX_CLICK_SETTLE_MS = 60;
const TEXT_PASTE_SETTLE_MS = 260;
const ATTACHMENT_PASTE_SETTLE_MS = 220;
const CODEX_COMMAND_SETTLE_MS = 180;
const CODEX_MODEL_COMMAND_SETTLE_MS = 450;
const CODEX_REASONING_COMMAND_SETTLE_MS = 450;
const CODEX_SESSION_FILE_CACHE_MS = 1200;
const CODEX_THREAD_LIST_CACHE_MS = 1200;
const CODEX_HISTORY_INITIAL_TAIL_BYTES = 8 * 1024 * 1024;
const REASONING_MODE_TARGETS = {
  low: { key: 'low', value: 'low', label: '低', displayName: '低' },
  medium: { key: 'medium', value: 'medium', label: '中', displayName: '中' },
  high: { key: 'high', value: 'high', label: '高', displayName: '高' },
  xhigh: { key: 'xhigh', value: 'xhigh', label: '超高', displayName: '超高' },
};
const recentSendRequests = new Map();
let lastCodexThreadActivation = { threadId: '', at: 0 };
let codexSessionFilesCache = { at: 0, files: [] };
let threadIndexCache = { mtimeMs: 0, size: 0, byId: null };
const sessionMetaCache = new Map();
const firstUserMessageCache = new Map();
const runtimeSummaryCache = new Map();
const codexThreadListCache = new Map();
let modelCatalogCache = { mtimeMs: -1, path: '', models: null };
let keepAwakeProcess = null;
let keepAwakeStartedAt = '';

function fileCacheSignature(stat) {
  return stat ? `${stat.size}:${stat.mtimeMs}` : '';
}

function boundedSet(map, key, value, limit = 300) {
  if (map.size >= limit && !map.has(key)) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, value);
  return value;
}

function invalidateCodexThreadListCache() {
  codexThreadListCache.clear();
}

function isKeepAwakeActive() {
  return Boolean(keepAwakeProcess && keepAwakeProcess.exitCode === null && !keepAwakeProcess.killed);
}

function keepAwakeStatus() {
  return {
    enabled: isKeepAwakeActive(),
    startedAt: isKeepAwakeActive() ? keepAwakeStartedAt : '',
    command: 'caffeinate -dims',
  };
}

function startKeepAwake() {
  if (isKeepAwakeActive()) return keepAwakeStatus();
  const caffeinatePath = '/usr/bin/caffeinate';
  if (!fs.existsSync(caffeinatePath)) {
    const error = new Error('这台 Mac 没有找到 caffeinate，无法阻止休眠。');
    error.code = 'CAFFEINATE_NOT_FOUND';
    throw error;
  }
  const child = spawn(caffeinatePath, ['-dims'], { stdio: 'ignore' });
  keepAwakeProcess = child;
  keepAwakeStartedAt = new Date().toISOString();
  child.on('exit', () => {
    if (keepAwakeProcess === child) {
      keepAwakeProcess = null;
      keepAwakeStartedAt = '';
    }
  });
  child.on('error', () => {
    if (keepAwakeProcess === child) {
      keepAwakeProcess = null;
      keepAwakeStartedAt = '';
    }
  });
  return keepAwakeStatus();
}

function stopKeepAwake() {
  const child = keepAwakeProcess;
  keepAwakeProcess = null;
  keepAwakeStartedAt = '';
  if (child && child.exitCode === null && !child.killed) {
    try { child.kill('SIGTERM'); } catch {}
  }
  return keepAwakeStatus();
}

function cleanupKeepAwake() {
  stopKeepAwake();
}

function readCodexConfigText() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.codex', 'config.toml'), 'utf8');
  } catch {
    return '';
  }
}

function tomlStringValue(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`^\\s*${escaped}\\s*=\\s*"([^"]*)"\\s*$`, 'm'));
  return match ? match[1] : '';
}

function labelFromModelName(name = '') {
  const text = String(name || '').trim();
  if (!text) return '';
  return text
    .replace(/[（(].*?[）)]/g, '')
    .replace(/^GPT-/i, '')
    .replace(/^gpt-/i, '')
    .replace(/^codex-/i, '')
    .trim() || text;
}

function normalizeModelOption(row = {}) {
  const id = String(row.slug || row.id || row.model || '').trim();
  if (!id) return null;
  const displayName = String(row.display_name || row.name || row.label || id).trim();
  return {
    key: id,
    id,
    label: labelFromModelName(displayName || id),
    displayName: displayName || id,
    source: 'local',
  };
}

function readModelCatalogOptions() {
  const configText = readCodexConfigText();
  const catalogPath = tomlStringValue(configText, 'model_catalog_json');
  const resolvedPath = catalogPath.startsWith('~') ? path.join(os.homedir(), catalogPath.slice(1)) : catalogPath;
  const fallback = () => {
    const current = tomlStringValue(configText, 'model');
    return current ? [{ key: current, id: current, label: labelFromModelName(current), displayName: current, source: 'local' }] : [];
  };
  if (!resolvedPath) return fallback();
  let stat;
  try {
    stat = fs.statSync(resolvedPath);
  } catch {
    return fallback();
  }
  if (modelCatalogCache.models && modelCatalogCache.path === resolvedPath && modelCatalogCache.mtimeMs === stat.mtimeMs) {
    return modelCatalogCache.models;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    const models = (Array.isArray(parsed.models) ? parsed.models : [])
      .filter(row => row && row.visibility !== 'hide')
      .map(normalizeModelOption)
      .filter(Boolean);
    modelCatalogCache = { path: resolvedPath, mtimeMs: stat.mtimeMs, models };
    return models.length ? models : fallback();
  } catch {
    return fallback();
  }
}

function findModelOption(id = '') {
  const targetId = String(id || '').trim();
  if (!targetId) return null;
  return readModelCatalogOptions().find(item => item.id === targetId || item.key === targetId) || null;
}

function emptyCodexMiniState() {
  return {
    pinnedThreadIds: [],
    archivedThreadIds: [],
    titleOverrides: {},
    guiFailureReports: {},
  };
}

function readCodexMiniState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      pinnedThreadIds: Array.isArray(parsed.pinnedThreadIds) ? parsed.pinnedThreadIds.filter(isCodexThreadId) : [],
      archivedThreadIds: Array.isArray(parsed.archivedThreadIds) ? parsed.archivedThreadIds.filter(isCodexThreadId) : [],
      titleOverrides: parsed.titleOverrides && typeof parsed.titleOverrides === 'object' ? parsed.titleOverrides : {},
      guiFailureReports: normalizeGuiFailureReports(parsed.guiFailureReports),
    };
  } catch {
    return emptyCodexMiniState();
  }
}

function writeCodexMiniState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const normalized = {
    pinnedThreadIds: [...new Set((state.pinnedThreadIds || []).filter(isCodexThreadId))],
    archivedThreadIds: [...new Set((state.archivedThreadIds || []).filter(isCodexThreadId))],
    titleOverrides: state.titleOverrides && typeof state.titleOverrides === 'object' ? state.titleOverrides : {},
    guiFailureReports: normalizeGuiFailureReports(state.guiFailureReports),
  };
  fs.writeFileSync(STATE_FILE, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  invalidateCodexThreadListCache();
  return normalized;
}



function normalizeGuiFailureReports(value) {
  const out = {};
  if (!value || typeof value !== 'object') return out;
  for (const [threadId, rows] of Object.entries(value)) {
    if (!isCodexThreadId(threadId) || !Array.isArray(rows)) continue;
    const normalizedRows = rows
      .map(row => ({
        turnId: typeof row.turnId === 'string' ? row.turnId : '',
        text: truncateText(normalizeHistoryText(row.text || ''), 2000),
        capturedAt: typeof row.capturedAt === 'string' ? row.capturedAt : '',
        completedAt: typeof row.completedAt === 'string' ? row.completedAt : '',
        source: typeof row.source === 'string' ? row.source : 'unknown',
      }))
      .filter(row => row.text)
      .slice(-GUI_FAILURE_REPORT_LIMIT);
    if (normalizedRows.length) out[threadId] = normalizedRows;
  }
  return out;
}

function setThreadSetMembership(list, threadId, enabled) {
  const set = new Set((Array.isArray(list) ? list : []).filter(isCodexThreadId));
  if (enabled) set.add(threadId);
  else set.delete(threadId);
  return [...set];
}

function truncateText(value, max = 700) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(item => item && (item.text || item.message || '')).filter(Boolean).join('\n');
}

function normalizeHistoryText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function extractPlainTextDeep(value, seen = new Set()) {
  if (value == null) return [];
  if (typeof value === 'string') return [value];
  if (typeof value === 'number' || typeof value === 'boolean') return [String(value)];
  if (typeof value !== 'object') return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const out = [];
  if (Array.isArray(value)) {
    for (const item of value) out.push(...extractPlainTextDeep(item, seen));
    return out;
  }

  for (const key of ['message', 'detail', 'details', 'error', 'reason', 'description', 'status', 'code', 'title', 'text']) {
    if (Object.prototype.hasOwnProperty.call(value, key)) out.push(...extractPlainTextDeep(value[key], seen));
  }
  return out;
}

function isFailureLikePayload(payload = {}) {
  const type = String(payload.type || '').toLowerCase();
  const status = String(payload.status || '').toLowerCase();
  const code = String(payload.code || '').toLowerCase();
  return (
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(type) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(status) ||
    /(?:error|fail|failed|failure|timeout|rate_limit|unavailable|overload|abort|cancel|interrupt)/.test(code) ||
    payload.error != null ||
    payload.detail != null ||
    payload.details != null ||
    payload.reason != null
  );
}

function isTerminalFailurePayload(payload = {}) {
  if (!payload || typeof payload !== 'object') return false;
  const type = String(payload.type || '').toLowerCase();
  return (
    type === 'turn_aborted' ||
    /(?:^|_)(?:failed|failure|error|timeout|cancelled|canceled|aborted|interrupted)$/.test(type) ||
    (
      isFailureLikePayload(payload) &&
      /(?:abort|cancel|interrupt|fail|error|timeout|unavailable|overload)/.test(type)
    )
  );
}

function extractFailureTextFromPayload(payload = {}) {
  if (!payload || typeof payload !== 'object' || !isFailureLikePayload(payload)) return '';
  const text = extractPlainTextDeep(payload)
    .map(value => normalizeHistoryText(value))
    .filter(Boolean)
    .filter(value => !/^(true|false|null|undefined)$/i.test(value))
    .join('\n');
  return truncateText(text, 1600);
}

function emptyCodexFailureText() {
  return 'Codex GUI 这次没有返回可显示回复。会话日志也没有写入可读取的失败提示原文；请在电脑 Codex GUI 查看原始失败提示。';
}

function decodeLogQuotedValue(value) {
  const raw = String(value || '');
  if (!raw) return '';
  try {
    return JSON.parse(`"${raw.replace(/"/g, '\\"')}"`);
  } catch {
    return raw.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
}

function safeParseJsonText(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractJsonAssignment(line, key) {
  const marker = `${key}=`;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const open = line.indexOf('{', start + marker.length);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < line.length; i += 1) {
    const ch = line[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return line.slice(open, i + 1);
    }
  }
  return null;
}

function extractDesktopLogFailureText(line) {
  const raw = String(line || '');
  if (!/(?:\berror\b|failed|failure|Forbidden|unexpected status|channel affinity|AiMaMi|revoked|Unauthorized)/i.test(raw)) return '';
  if (/(?:git\.command\.complete|worker_rpc_response_error|Conversation state not found|Received turn\/(?:started|completed) for unknown conversation|Item not found in turn state)/i.test(raw)) return '';
  const candidates = [];
  for (const key of ['error', 'result']) {
    const jsonText = extractJsonAssignment(raw, key);
    const parsed = jsonText ? safeParseJsonText(jsonText) : null;
    const directText = parsed && typeof parsed === 'object'
      ? normalizeHistoryText(parsed.message || parsed.detail || parsed.error || parsed.reason || '')
      : '';
    const text = parsed ? (directText || extractFailureTextFromPayload(parsed) || truncateText(extractPlainTextDeep(parsed).map(value => normalizeHistoryText(value)).filter(Boolean).join('\n'), 2000)) : '';
    if (text) candidates.push(text);
  }
  for (const key of ['errorMessage', 'message', 'detail']) {
    const match = raw.match(new RegExp(`(?:^|\\s)${key}="((?:\\\\.|[^"])*)"`, 'i'));
    if (match) candidates.push(decodeLogQuotedValue(match[1]));
  }
  if (!candidates.length && /(?:unexpected status|Forbidden|channel affinity|AiMaMi)/i.test(raw)) {
    candidates.push(raw.replace(/^\S+\s+\w+\s+\[[^\]]+\]\s*/, '').trim());
  }
  const text = uniqueList(candidates
    .map(value => normalizeHistoryText(value))
    .filter(Boolean)
    .filter(value => !/^Request failed$/i.test(value)))
    .join('\n');
  return truncateText(text, 2000);
}

function scoreDesktopFailureLine(line, text, options = {}) {
  const raw = String(line || '');
  const failure = String(text || '');
  if (!failure) return 0;
  let score = 1;
  const threadId = isCodexThreadId(options.threadId) ? options.threadId : '';
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  if (threadId && raw.includes(threadId)) score += 80;
  if (turnId && raw.includes(turnId)) score += 80;
  if (/Structured turn failed/i.test(failure)) score += 55;
  if (/unexpected status|Forbidden|channel affinity|AiMaMi/i.test(failure)) score += 45;
  if (/refresh token was revoked|log out and sign in again|access token could not be refreshed/i.test(failure)) score += 45;
  if (/Failed to generate thread title/i.test(raw) && /Structured turn failed/i.test(failure)) score += 25;
  if (/Conversation state not found|unknown conversation|Failed to write temporary index tree snapshot|remote\.upstream\.url/i.test(failure)) score -= 80;
  return score;
}

function recentCodexDesktopLogFiles(referenceMs = Date.now()) {
  return walkFiles(CODEX_DESKTOP_LOGS_DIR, file => file.endsWith('.log'))
    .map(file => {
      try {
        const stat = fs.statSync(file);
        return { file, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter(item => item.mtimeMs >= referenceMs - GUI_FAILURE_LOG_RECENT_MS)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, 40)
    .map(item => item.file);
}

function findCodexDesktopFailureText(options = {}) {
  const threadId = isCodexThreadId(options.threadId) ? options.threadId : '';
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  const startedMs = Date.parse(options.startedAt || '') || 0;
  const completedMs = Date.parse(options.completedAt || '') || Date.now();
  const minMs = startedMs ? startedMs - 60 * 1000 : completedMs - GUI_FAILURE_LOG_RECENT_MS;
  const maxMs = completedMs + 2 * 60 * 1000;
  const matches = [];
  for (const file of recentCodexDesktopLogFiles(completedMs)) {
    let lines;
    try {
      lines = readTailLinesWithLimit(file, GUI_FAILURE_LOG_SCAN_BYTES);
    } catch {
      continue;
    }
    for (const line of lines) {
      const lineMs = Date.parse(line.slice(0, 24));
      if (Number.isFinite(lineMs) && (lineMs < minMs || lineMs > maxMs)) continue;
      const text = extractDesktopLogFailureText(line);
      const score = scoreDesktopFailureLine(line, text, options);
      if (score >= 50) matches.push({ text, lineMs: Number.isFinite(lineMs) ? lineMs : 0, score });
    }
  }
  matches.sort((a, b) => b.score - a.score || b.lineMs - a.lineMs);
  return matches[0] ? matches[0].text : '';
}

function findStoredGuiFailureText(threadId, options = {}) {
  if (!isCodexThreadId(threadId)) return '';
  const rows = readCodexMiniState().guiFailureReports[threadId] || [];
  const turnId = typeof options.turnId === 'string' ? options.turnId : '';
  if (turnId) {
    const exact = [...rows].reverse().find(row => row.turnId === turnId && row.text);
    if (exact) return exact.text;
  }
  const completedMs = Date.parse(options.completedAt || '') || 0;
  if (completedMs) {
    const close = [...rows].reverse().find(row => {
      const rowMs = Date.parse(row.completedAt || row.capturedAt || '') || 0;
      return row.text && rowMs && Math.abs(rowMs - completedMs) <= GUI_FAILURE_LOG_RECENT_MS;
    });
    if (close) return close.text;
  }
  const latest = rows[rows.length - 1];
  return latest && latest.text ? latest.text : '';
}

function storeGuiFailureText(threadId, report = {}) {
  if (!isCodexThreadId(threadId)) return '';
  const text = truncateText(normalizeHistoryText(report.text || ''), 2000);
  if (!text || text === emptyCodexFailureText()) return '';
  const state = readCodexMiniState();
  const rows = state.guiFailureReports[threadId] || [];
  const turnId = typeof report.turnId === 'string' ? report.turnId : '';
  const completedAt = typeof report.completedAt === 'string' ? report.completedAt : '';
  const existingIndex = rows.findIndex(row => (turnId && row.turnId === turnId) || (completedAt && row.completedAt === completedAt && row.text === text));
  const row = {
    turnId,
    text,
    capturedAt: new Date().toISOString(),
    completedAt,
    source: typeof report.source === 'string' ? report.source : 'codex_desktop',
  };
  if (existingIndex >= 0) rows[existingIndex] = { ...rows[existingIndex], ...row };
  else rows.push(row);
  state.guiFailureReports[threadId] = rows.slice(-GUI_FAILURE_REPORT_LIMIT);
  writeCodexMiniState(state);
  return text;
}

function resolveFailureTextForTurn(threadId, options = {}) {
  const sessionText = normalizeHistoryText(options.failureText || '');
  if (sessionText) {
    storeGuiFailureText(threadId, { ...options, text: sessionText, source: 'codex_session' });
    return sessionText;
  }
  const storedText = findStoredGuiFailureText(threadId, options);
  if (storedText) return storedText;
  const desktopText = findCodexDesktopFailureText({ ...options, threadId });
  if (desktopText) return storeGuiFailureText(threadId, { ...options, text: desktopText, source: 'codex_desktop_log' }) || desktopText;
  return '';
}

function isCodexInternalUserMessage(value) {
  const text = normalizeHistoryText(value).replace(/\s+/g, ' ');
  return /^The following is the Codex agent history\b/i.test(text) ||
    /^The following is the Codex agent\b.{0,600}\b(?:request action you are assessing|approval assessment|untrusted evidence)\b/i.test(text);
}

function isCodexInternalSessionMeta(meta = {}) {
  const source = meta && typeof meta === 'object' ? meta.source : null;
  const subagent = source && typeof source === 'object' ? source.subagent : null;
  const subagentName = subagent && typeof subagent === 'object'
    ? String(subagent.other || subagent.name || subagent.kind || '')
    : '';
  const baseInstructions = normalizeHistoryText(meta && meta.base_instructions && meta.base_instructions.text || '');
  return (
    String(meta && meta.thread_source || '').toLowerCase() === 'subagent' &&
    /^(?:guardian|approval|approvals?[-_\s]?reviewer)$/i.test(subagentName)
  ) || /judging one planned coding-agent action|request action you are assessing|approval assessment/i.test(baseInstructions);
}

function cleanUserHistoryText(value) {
  const text = normalizeHistoryText(value);
  if (isCodexInternalUserMessage(text)) return '';
  const marker = '## My request for Codex:';
  const index = text.indexOf(marker);
  if (index >= 0) return normalizeHistoryText(text.slice(index + marker.length));
  return text;
}

function isPlaceholderThreadName(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return [
    '未命名线程',
    '未命名',
    'untitled',
    'untitled thread',
    'new thread',
  ].includes(text);
}

function summarizeThreadTitle(value, maxLength = 34) {
  let text = cleanUserHistoryText(value)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\bsk-[a-zA-Z0-9_-]{12,}\b/g, '[key]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[token]')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/[#>*_[\]()~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}…`;
}

function walkFiles(dir, predicate, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function listCodexSessionFiles(options = {}) {
  const now = Date.now();
  if (!options.force && codexSessionFilesCache.files.length && now - codexSessionFilesCache.at <= CODEX_SESSION_FILE_CACHE_MS) {
    return codexSessionFilesCache.files;
  }
  const files = walkFiles(CODEX_SESSIONS_DIR, file => file.endsWith('.jsonl'));
  codexSessionFilesCache = { at: now, files };
  return files;
}

function threadIdFromSessionFile(file) {
  return (path.basename(file || '').match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i) || [])[1] || '';
}

function normalizeComparableMessage(value) {
  return cleanUserHistoryText(value).replace(/\s+/g, ' ').trim();
}

function findLatestCodexSessionFile(options = {}) {
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const afterMs = Number(options.afterMs) || 0;
  const expectedCwd = validLocalDirectory(options.cwd || '');
  const files = listCodexSessionFiles(afterMs ? { force: true } : {});
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromSessionFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (afterMs && stat.mtimeMs < afterMs - 2500) continue;
      if (expectedCwd) {
        const metaCwd = validLocalDirectory(readSessionMeta(file).cwd || '');
        if (metaCwd !== expectedCwd) continue;
      }
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {
      // ignore disappearing files
    }
  }
  return best && best.file;
}

function findCodexSessionFileByName(name) {
  if (!name || name.includes('/') || name.includes('..')) return null;
  const files = listCodexSessionFiles();
  return files.find(file => path.basename(file) === name) || null;
}

function findCodexSessionFileByThreadId(threadId) {
  if (!isCodexThreadId(threadId)) return null;
  const files = listCodexSessionFiles();
  let best = null;
  for (const file of files) {
    if (!path.basename(file).includes(threadId)) continue;
    try {
      const stat = fs.statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    } catch {}
  }
  return best && best.file;
}

function isCodexThreadId(value) {
  return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9-]{27,}$/i.test(value);
}

function codexThreadDeepLink(threadId) {
  if (!isCodexThreadId(threadId)) return null;
  // Codex desktop's own “Copy app link” action uses codex://threads/<id>.
  // The previous codex://local/<id> only brought the app forward on this build,
  // but did not navigate the visible UI, so paste could still hit the wrong thread.
  return `codex://threads/${threadId}`;
}

function codexNewThreadDeepLink(cwd = '') {
  const url = new URL('codex://threads/new');
  if (cwd) url.searchParams.set('path', cwd);
  return url.toString();
}

function readThreadIndex() {
  let stat = null;
  try { stat = fs.statSync(CODEX_SESSION_INDEX); } catch {}
  if (
    stat &&
    threadIndexCache.byId &&
    threadIndexCache.mtimeMs === stat.mtimeMs &&
    threadIndexCache.size === stat.size
  ) {
    return new Map(threadIndexCache.byId);
  }
  const byId = new Map();
  try {
    const lines = fs.readFileSync(CODEX_SESSION_INDEX, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (!item.id) continue;
        byId.set(item.id, {
          id: item.id,
          name: item.thread_name || '',
          updatedAt: item.updated_at || '',
        });
      } catch {}
    }
  } catch {}
  if (stat) threadIndexCache = { mtimeMs: stat.mtimeMs, size: stat.size, byId: new Map(byId) };
  return byId;
}

function findFirstCodexUserMessage(file, maxBytes = CODEX_TITLE_SCAN_BYTES) {
  let stat;
  try { stat = fs.statSync(file); } catch { return ''; }
  const cacheKey = `${file}:${fileCacheSignature(stat)}:${maxBytes}`;
  if (firstUserMessageCache.has(cacheKey)) return firstUserMessageCache.get(cacheKey);
  const limit = Math.min(stat.size, maxBytes);
  const chunkSize = 64 * 1024;
  const maxLineBytes = 2 * 1024 * 1024;
  let fd;
  let carry = '';
  let skippingLongLine = false;

  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(chunkSize);
    let offset = 0;
    while (offset < limit) {
      const bytes = fs.readSync(fd, buffer, 0, Math.min(chunkSize, limit - offset), offset);
      if (!bytes) break;
      offset += bytes;
      let text = buffer.toString('utf8', 0, bytes);

      if (skippingLongLine) {
        const newline = text.indexOf('\n');
        if (newline < 0) continue;
        text = text.slice(newline + 1);
        skippingLongLine = false;
      }

      carry += text;
      if (carry.length > maxLineBytes) {
        const newline = carry.indexOf('\n');
        if (newline < 0) {
          carry = '';
          skippingLongLine = true;
          continue;
        }
      }

      let newlineIndex;
      while ((newlineIndex = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, newlineIndex);
        carry = carry.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        const payload = item.payload || {};
        if (item.type === 'event_msg' && payload.type === 'user_message') {
          const title = summarizeThreadTitle(payload.message || '');
          if (title) return boundedSet(firstUserMessageCache, cacheKey, title);
        }
      }
    }

    if (carry.trim() && carry.length <= maxLineBytes) {
      try {
        const item = JSON.parse(carry);
        const payload = item.payload || {};
        if (item.type === 'event_msg' && payload.type === 'user_message') {
          return boundedSet(firstUserMessageCache, cacheKey, summarizeThreadTitle(payload.message || ''));
        }
      } catch {}
    }
  } catch {
    return '';
  } finally {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return boundedSet(firstUserMessageCache, cacheKey, '');
}

function readSessionMeta(file) {
  let stat = null;
  try { stat = fs.statSync(file); } catch {}
  const cacheKey = stat ? `${file}:${fileCacheSignature(stat)}` : '';
  if (cacheKey && sessionMetaCache.has(cacheKey)) return sessionMetaCache.get(cacheKey);
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(64 * 1024);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const lines = buffer.toString('utf8', 0, bytes).split('\n').filter(Boolean).slice(0, 80);
      for (const line of lines) {
        let item;
        try { item = JSON.parse(line); } catch { continue; }
        if (item.type === 'session_meta' && item.payload) return cacheKey ? boundedSet(sessionMetaCache, cacheKey, item.payload) : item.payload;
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return cacheKey ? boundedSet(sessionMetaCache, cacheKey, {}) : {};
}

function userMessageMatchScore(file, sinceMs = 0, text = '') {
  const expected = normalizeComparableMessage(text);
  const items = readJsonlTailObjects(file, CODEX_TITLE_SCAN_BYTES);
  let score = 0;
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type !== 'event_msg' || payload.type !== 'user_message') continue;
    const t = Date.parse(item.timestamp || '');
    if (sinceMs && Number.isFinite(t) && t < sinceMs - 2500) continue;
    const actual = normalizeComparableMessage(payload.message || '');
    if (!actual && expected) continue;
    score = Math.max(score, 10);
    if (Number.isFinite(t)) score += Math.max(0, Math.min(25, Math.round((t - sinceMs) / 1000) + 20));
    if (expected && actual) {
      if (actual === expected) score += 100;
      else if (actual.includes(expected) || expected.includes(actual)) score += 70;
    }
  }
  return score;
}

function findCodexSessionFileForNewSend(options = {}) {
  const sinceMs = Number(options.sinceMs) || 0;
  const text = typeof options.text === 'string' ? options.text : '';
  const expectedCwd = validLocalDirectory(options.cwd || '');
  const excludeThreadId = isCodexThreadId(options.excludeThreadId) ? options.excludeThreadId : '';
  const files = listCodexSessionFiles({ force: true });
  let best = null;
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      const threadId = threadIdFromSessionFile(file);
      if (excludeThreadId && threadId === excludeThreadId) continue;
      if (sinceMs && stat.mtimeMs < sinceMs - 2500) continue;
      let score = userMessageMatchScore(file, sinceMs, text);
      if (score <= 0 && text.trim()) continue;
      const metaCwd = validLocalDirectory(readSessionMeta(file).cwd || '');
      if (expectedCwd) {
        if (metaCwd !== expectedCwd) continue;
        score += 35;
      }
      score += Math.max(0, Math.min(20, Math.round((stat.mtimeMs - sinceMs) / 1000) + 10));
      if (!best || score > best.score || (score === best.score && stat.mtimeMs > best.mtimeMs)) {
        best = { file, score, mtimeMs: stat.mtimeMs };
      }
    } catch {
      // ignore disappearing files
    }
  }
  return best && best.file;
}

async function waitForCodexSessionFileForNewSend(options = {}, timeoutMs = 2600) {
  const deadline = Date.now() + timeoutMs;
  let file = null;
  while (Date.now() <= deadline) {
    file = findCodexSessionFileForNewSend(options);
    if (file) return file;
    await delay(220);
  }
  return findCodexSessionFileForNewSend(options);
}

async function waitForCodexUserMessageInFile(file, options = {}, timeoutMs = 2600) {
  const sinceMs = Number(options.sinceMs) || 0;
  const text = typeof options.text === 'string' ? options.text : '';
  if (!file || !text.trim()) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if (userMessageMatchScore(file, sinceMs, text) > 0) return file;
    } catch {
      // File may rotate while Codex writes; retry until timeout.
    }
    await delay(220);
  }
  try {
    return userMessageMatchScore(file, sinceMs, text) > 0 ? file : null;
  } catch {
    return null;
  }
}

function readJsonlTailObjects(file, maxBytes) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const start = Math.max(0, stat.size - maxBytes);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  } finally {
    if (typeof fd === 'number') {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

function summarizeCodexRuntimeItems(items, stat = null) {
  let status = 'idle';
  let active = false;
  let startedAt = '';
  let completedAt = '';
  let updatedAt = stat ? new Date(stat.mtimeMs).toISOString() : '';
  let turnId = '';
  let sawRuntimeActivity = false;
  let sawTaskMarker = false;

  for (const item of items) {
    const payload = item.payload || {};
    if (item.timestamp) updatedAt = item.timestamp;
    if (item.type === 'response_item' || (item.type === 'event_msg' && payload.type && !String(payload.type).startsWith('task_'))) {
      sawRuntimeActivity = true;
    }
    if (item.type === 'turn_context' && payload.turn_id) turnId = payload.turn_id;
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      sawTaskMarker = true;
      status = 'running';
      active = true;
      startedAt = item.timestamp || startedAt;
      completedAt = '';
      turnId = payload.turn_id || turnId;
      updatedAt = item.timestamp || updatedAt;
    }
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      sawTaskMarker = true;
      status = 'complete';
      active = false;
      completedAt = item.timestamp || completedAt;
      updatedAt = item.timestamp || updatedAt;
    }
    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      sawTaskMarker = true;
      status = 'error';
      active = false;
      completedAt = item.timestamp || completedAt;
      turnId = payload.turn_id || turnId;
      updatedAt = item.timestamp || updatedAt;
    }
  }

  return { status, active, startedAt, completedAt, updatedAt, turnId, sawRuntimeActivity, sawTaskMarker };
}

function quickCodexRuntimeFromFile(file, stat = null) {
  let fileStat = stat;
  if (!fileStat) {
    try { fileStat = fs.statSync(file); } catch { fileStat = null; }
  }
  const cacheKey = fileStat ? `${file}:${fileCacheSignature(fileStat)}` : '';
  if (cacheKey && runtimeSummaryCache.has(cacheKey)) return runtimeSummaryCache.get(cacheKey);
  const isFresh = fileStat ? Date.now() - fileStat.mtimeMs <= CODEX_RUNTIME_STALE_MS : false;
  let runtime = summarizeCodexRuntimeItems(readJsonlTailObjects(file, CODEX_ACTIVITY_TAIL_BYTES), fileStat);

  if (
    runtime.status === 'idle' &&
    runtime.sawRuntimeActivity &&
    !runtime.sawTaskMarker &&
    isFresh &&
    fileStat &&
    fileStat.size > CODEX_ACTIVITY_TAIL_BYTES
  ) {
    runtime = summarizeCodexRuntimeItems(readJsonlTailObjects(file, CODEX_ACTIVITY_LOOKBACK_BYTES), fileStat);
  }

  if (runtime.status === 'idle' && runtime.sawRuntimeActivity && !runtime.sawTaskMarker && isFresh) {
    runtime.status = 'running';
    runtime.active = true;
  }
  if (runtime.status === 'running' && fileStat && !isFresh) {
    runtime.status = 'idle';
    runtime.active = false;
  }

  const { status, active, startedAt, completedAt, updatedAt, turnId } = runtime;
  return cacheKey
    ? boundedSet(runtimeSummaryCache, cacheKey, { status, active, startedAt, completedAt, updatedAt, turnId }, 600)
    : { status, active, startedAt, completedAt, updatedAt, turnId };
}

function displayPathName(cwd) {
  if (!cwd) return '对话';
  const normalized = path.normalize(cwd);
  if (normalized === os.homedir()) return '~';
  if (normalized === path.parse(normalized).root) return normalized;
  return path.basename(normalized) || normalized;
}

function classifyThreadProject(cwd) {
  const normalized = cwd ? path.normalize(cwd) : '';
  const codexScratchRoot = path.join(os.homedir(), 'Documents', 'Codex');
  const relativeToScratch = normalized ? path.relative(codexScratchRoot, normalized) : '';
  const isGeneratedProjectless = Boolean(
    normalized &&
    relativeToScratch &&
    !relativeToScratch.startsWith('..') &&
    !path.isAbsolute(relativeToScratch) &&
    /^\d{4}-\d{2}-\d{2}(?:$|[\/])/.test(relativeToScratch)
  );

  if (!normalized || isGeneratedProjectless) {
    return {
      isProjectThread: false,
      projectKey: 'conversation',
      projectName: '对话',
      projectPath: '',
    };
  }

  return {
    isProjectThread: true,
    projectKey: normalized,
    projectName: displayPathName(normalized),
    projectPath: normalized,
  };
}

function listCodexThreads(limit = 80) {
  const normalizedLimit = Math.max(1, Math.min(160, Number(limit) || 80));
  const cacheKey = String(normalizedLimit);
  const cached = codexThreadListCache.get(cacheKey);
  if (cached && Date.now() - cached.at <= CODEX_THREAD_LIST_CACHE_MS) return cached.threads;
  const miniState = readCodexMiniState();
  const pinnedThreadIds = new Set(miniState.pinnedThreadIds || []);
  const archivedThreadIds = new Set(miniState.archivedThreadIds || []);
  const titleOverrides = miniState.titleOverrides || {};
  const byId = readThreadIndex();
  for (const file of listCodexSessionFiles()) {
    const match = path.basename(file).match(/([a-f0-9]{8}-[a-f0-9-]{27,})\.jsonl$/i);
    if (!match) continue;
    const id = match[1];
    try {
      const stat = fs.statSync(file);
      const meta = readSessionMeta(file);
      if (isCodexInternalSessionMeta(meta)) continue;
      const runtime = quickCodexRuntimeFromFile(file, stat);
      const project = classifyThreadProject(meta.cwd || '');
      const existing = byId.get(id) || { id, name: '', updatedAt: '' };
      const fallbackName = isPlaceholderThreadName(existing.name) ? findFirstCodexUserMessage(file) : '';
      existing.name = isPlaceholderThreadName(existing.name) ? (fallbackName || '未命名线程') : existing.name;
      existing.nameSource = fallbackName && existing.name === fallbackName ? 'first_user_message' : 'index';
      const override = titleOverrides[id];
      if (override && typeof override.name === 'string' && override.name.trim()) {
        const overrideTime = Date.parse(override.renamedAt || '') || 0;
        const indexTime = Date.parse(existing.updatedAt || '') || 0;
        if (!indexTime || !overrideTime || indexTime <= overrideTime + 2000 || existing.name === override.name || isPlaceholderThreadName(existing.name)) {
          existing.name = override.name.trim();
          existing.nameSource = 'codex_mini_override';
        }
      }
      existing.sessionFile = path.basename(file);
      existing.mtimeMs = stat.mtimeMs;
      existing.updatedAt = existing.updatedAt || meta.timestamp || new Date(stat.mtimeMs).toISOString();
      existing.effectiveUpdatedMs = Math.max(Date.parse(existing.updatedAt) || 0, stat.mtimeMs || 0);
      existing.cwd = meta.cwd || '';
      existing.source = meta.source || '';
      existing.threadSource = meta.thread_source || '';
      existing.runtimeStatus = runtime.status;
      existing.runtimeActive = runtime.active;
      existing.runtimeStartedAt = runtime.startedAt;
      existing.runtimeCompletedAt = runtime.completedAt;
      existing.runtimeUpdatedAt = runtime.updatedAt;
      existing.runtimeTurnId = runtime.turnId;
      existing.pinned = pinnedThreadIds.has(id);
      Object.assign(existing, project);
      byId.set(id, existing);
    } catch {}
  }
  const threads = [...byId.values()]
    .filter(item => item.sessionFile && !archivedThreadIds.has(item.id))
    .map(item => {
      const effectiveUpdatedMs = item.effectiveUpdatedMs || Math.max(Date.parse(item.updatedAt) || 0, item.mtimeMs || 0);
      return { ...item, effectiveUpdatedMs, effectiveUpdatedAt: new Date(effectiveUpdatedMs).toISOString() };
    })
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.effectiveUpdatedMs - a.effectiveUpdatedMs)
    .slice(0, normalizedLimit);
  boundedSet(codexThreadListCache, cacheKey, { at: Date.now(), threads }, 20);
  return threads;
}

function handleThreads(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const limit = Math.max(1, Math.min(160, Number(url.searchParams.get('limit')) || 80));
  return json(res, 200, { ok: true, threads: listCodexThreads(limit) });
}

function readTailLines(file) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - CODEX_SESSION_TAIL_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    return text.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function readTailLinesWithLimit(file, maxBytes) {
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split('\n').filter(Boolean);
  } finally {
    fs.closeSync(fd);
  }
}

function countCodexHistoryMessages(lines, maxNeeded = MAX_HISTORY_MESSAGES) {
  let count = 0;
  let currentTurn = null;
  const need = Math.max(1, Math.min(Number(maxNeeded) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurn = { hasAssistant: false };
      continue;
    }
    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const text = cleanUserHistoryText(payload.message);
      const attachments = extractUserAttachments(payload);
      if (text || attachments.length) count += 1;
    } else if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && payload.phase === 'final_answer') {
      const text = normalizeHistoryText(extractMessageText(payload.content));
      if (text) {
        count += 1;
        if (currentTurn) currentTurn.hasAssistant = true;
      }
    } else if (item.type === 'event_msg' && payload.type === 'task_complete') {
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      if (currentTurn && !currentTurn.hasAssistant) count += lastMessage ? 1 : 1;
      currentTurn = null;
    } else if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      if (currentTurn && !currentTurn.hasAssistant) count += 1;
      currentTurn = null;
    }
    if (count >= need) return count;
  }
  return count;
}

function readHistoryLinesAdaptive(file, desiredMessages = MAX_HISTORY_MESSAGES) {
  const stat = fs.statSync(file);
  const maxBytes = Math.min(stat.size, CODEX_HISTORY_TAIL_BYTES);
  const desired = Math.max(1, Math.min(Number(desiredMessages) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES));

  if (maxBytes <= CODEX_HISTORY_INITIAL_TAIL_BYTES * 6) {
    return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
  }

  const initialBytes = Math.min(CODEX_HISTORY_INITIAL_TAIL_BYTES, maxBytes);
  const initialLines = readTailLinesWithLimit(file, initialBytes);
  if (countCodexHistoryMessages(initialLines, desired) >= desired) {
    return { lines: initialLines, stat, scannedBytes: initialBytes };
  }

  return { lines: readTailLinesWithLimit(file, maxBytes), stat, scannedBytes: maxBytes };
}

function extractUserAttachments(payload) {
  const paths = [];
  for (const key of ['local_images', 'images']) {
    if (!Array.isArray(payload[key])) continue;
    for (const item of payload[key]) {
      if (typeof item === 'string') paths.push(item);
      else if (item && typeof item.path === 'string') paths.push(item.path);
      else if (item && typeof item.filePath === 'string') paths.push(item.filePath);
    }
  }
  return paths;
}

function parseCodexThreadHistory(threadId, limit = MAX_HISTORY_MESSAGES) {
  const file = findCodexSessionFileByThreadId(threadId);
  if (!file) {
    return {
      ok: true,
      available: false,
      threadId,
      sessionFile: '',
      messages: [],
      message: '没有找到所选线程的 Codex 会话文件。',
    };
  }

  const messages = [];
  let currentTurn = null;
  function historyDurationText(startedAt = '', completedAt = '') {
    const startMs = Date.parse(startedAt || '');
    const endMs = Date.parse(completedAt || '');
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '';
    const total = Math.max(0, Math.floor((endMs - startMs) / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }
  function historyCompleteLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 已处理 ${duration}` : 'Codex';
  }
  function historyFailureLabel(startedAt = '', completedAt = '') {
    const duration = historyDurationText(startedAt, completedAt);
    return duration ? `Codex · 失败 ${duration}` : 'Codex';
  }
  const historyTail = readHistoryLinesAdaptive(file, limit);
  for (const line of historyTail.lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const payload = item.payload || {};

    if (item.type === 'event_msg' && payload.type === 'task_started') {
      currentTurn = { hasAssistant: false, assistantIndex: -1, failureText: '', startedAt: item.timestamp || '', turnId: payload.turn_id || '' };
      continue;
    }

    if (currentTurn && item.type === 'event_msg') {
      currentTurn.failureText = currentTurn.failureText || extractFailureTextFromPayload(payload);
    }

    if (currentTurn && item.type === 'turn_context') {
      currentTurn.turnId = payload.turn_id || currentTurn.turnId;
    }

    if (item.type === 'event_msg' && payload.type === 'user_message') {
      const text = cleanUserHistoryText(payload.message);
      const attachments = extractUserAttachments(payload);
      if (text || attachments.length) {
        messages.push({
          role: 'user',
          label: attachments.length ? `你 · ${attachments.length} 张图片` : '你',
          text: text || (attachments.length ? ' ' : ''),
          attachments: attachments.map(filePath => ({ filePath, name: path.basename(filePath) })),
          timestamp: item.timestamp || '',
        });
      }
      continue;
    }

    if (item.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant') {
      const isFinal = payload.phase === 'final_answer';
      if (!isFinal) continue;
      const text = normalizeHistoryText(extractMessageText(payload.content));
      if (text) {
        const assistantIndex = messages.length;
        messages.push({
          role: 'assistant',
          label: 'Codex',
          text,
          timestamp: item.timestamp || '',
        });
        if (currentTurn) {
          currentTurn.hasAssistant = true;
          currentTurn.assistantIndex = assistantIndex;
        }
      }
      continue;
    }

    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      const completedAt = item.timestamp || '';
      if (currentTurn && !currentTurn.hasAssistant) {
        const failureText = resolveFailureTextForTurn(threadId, {
          turnId: currentTurn.turnId || '',
          startedAt: currentTurn.startedAt || '',
          completedAt,
          failureText: currentTurn.failureText || '',
        });
        messages.push({
          role: 'assistant',
          label: failureText ? historyFailureLabel(currentTurn.startedAt, completedAt) : historyCompleteLabel(currentTurn.startedAt, completedAt),
          text: lastMessage || failureText || emptyCodexFailureText(),
          timestamp: completedAt || currentTurn.startedAt || '',
        });
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyCompleteLabel(currentTurn.startedAt, completedAt);
      }
      currentTurn = null;
    }

    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      const failureText = normalizeHistoryText(extractFailureTextFromPayload(payload) || currentTurn?.failureText || '');
      if (currentTurn && !currentTurn.hasAssistant) {
        messages.push({
          role: 'assistant',
          label: historyFailureLabel(currentTurn.startedAt, item.timestamp || ''),
          text: failureText || emptyCodexFailureText(),
          timestamp: item.timestamp || currentTurn.startedAt || '',
        });
      } else if (currentTurn && currentTurn.hasAssistant && currentTurn.assistantIndex >= 0 && messages[currentTurn.assistantIndex]) {
        messages[currentTurn.assistantIndex].label = historyFailureLabel(currentTurn.startedAt, item.timestamp || '');
      }
      currentTurn = null;
    }
  }

  return {
    ok: true,
    available: true,
    threadId,
    sessionFile: path.basename(file),
    truncated: historyTail.stat.size > CODEX_HISTORY_TAIL_BYTES,
    messages: messages.slice(-Math.max(1, Math.min(Number(limit) || MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES))),
  };
}

function handleThreadHistory(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const threadId = url.searchParams.get('thread') || '';
    if (!isCodexThreadId(threadId)) {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
    }
    return json(res, 200, parseCodexThreadHistory(threadId, url.searchParams.get('limit') || MAX_HISTORY_MESSAGES));
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_HISTORY_FAILED', message: '读取 Codex 聊天记录失败。', detail: String(error && error.message || error) });
  }
}

function extractReasoningText(payload) {
  const parts = [];
  if (Array.isArray(payload.summary)) {
    for (const item of payload.summary) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.text === 'string') parts.push(item.text);
      else if (item && typeof item.summary === 'string') parts.push(item.summary);
    }
  }
  if (Array.isArray(payload.content)) {
    for (const item of payload.content) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item.text === 'string') parts.push(item.text);
    }
  }
  if (typeof payload.text === 'string') parts.push(payload.text);
  const visible = parts.map(x => String(x).trim()).filter(Boolean).join('\n');
  return visible;
}

function parseToolArguments(payload) {
  const raw = payload.arguments || payload.input || '';
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { raw: String(raw) }; }
}

function shellQuotePattern() {
  return String.raw`(?:(?:"[^"]+")|(?:'[^']+')|(?:\\\S|\S)+)`;
}

function stripShellQuotes(value) {
  let text = String(value || '').trim();
  while ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\([\s"'])/g, '$1');
}

function shortPath(value) {
  const text = stripShellQuotes(value).replace(/^~\//, '~/');
  if (!text) return '';
  const home = os.homedir();
  const normalized = text.startsWith(home) ? `~${text.slice(home.length)}` : text;
  if (/^[./~\w-].*\.(?:js|ts|tsx|jsx|html|css|json|jsonl|md|txt|sh|swift|py|yml|yaml|webmanifest|png|jpg|jpeg|gif|svg)$/i.test(normalized)) {
    return normalized.replace(/^\.\//, '');
  }
  return normalized.replace(/^\.\//, '');
}


function isLikelyToolFile(value) {
  const text = stripShellQuotes(value);
  if (!text || text.startsWith('-') || text.startsWith('<') || /^\d+$/.test(text)) return false;
  if (/^[A-Z_]+$/.test(text)) return false;
  return /[./~]/.test(text) || /\.[A-Za-z0-9]{1,12}$/.test(text);
}

function uniqueList(values, limit = 3) {
  const out = [];
  for (const value of values) {
    const text = shortPath(value);
    if (text && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function joinToolTargets(values) {
  const list = uniqueList(values, 4);
  if (!list.length) return '';
  return list.join(', ');
}

function extractCommandFiles(cmd) {
  const files = [];
  const token = shellQuotePattern();
  const commandPatterns = [
    new RegExp(String.raw`\bsed\s+(?:-[A-Za-z]+\s+)?${token}\s+(${token})`, 'g'),
    new RegExp(String.raw`\bnl\s+(?:-[A-Za-z]+\s+)*(${token})`, 'g'),
    new RegExp(String.raw`\b(?:cat|head|tail)\s+(?:-[A-Za-z0-9]+\s+)*(?:-n\s+\d+\s+)?(${token})`, 'g'),
  ];
  for (const re of commandPatterns) {
    let match;
    while ((match = re.exec(cmd))) files.push(match[1]);
  }
  const redirectMatch = cmd.match(/<\s*([^\s|;&]+)/);
  if (redirectMatch && !/<<\s*$/.test(cmd.slice(Math.max(0, redirectMatch.index - 3), redirectMatch.index + 1))) files.push(redirectMatch[1]);
  return uniqueList(files.filter(isLikelyToolFile), 4);
}

function extractSearchTargets(cmd) {
  const afterGlob = cmd.replace(/--glob\s+(?:"[^"]+"|'[^']+'|\S+)/g, '');
  const matches = [...afterGlob.matchAll(/(?:^|\s)([./~\w-][^\s|;&]*\.(?:js|ts|tsx|jsx|html|css|json|jsonl|md|txt|sh|swift|py|yml|yaml|webmanifest))(?:\s|$)/gi)];
  return uniqueList(matches.map(match => match[1]), 4);
}

function truncateCommand(cmd, max = 120) {
  const oneLine = String(cmd || '').split('\n')[0].replace(/\s+/g, ' ').trim();
  const home = os.homedir();
  const text = oneLine.startsWith(home) ? `~${oneLine.slice(home.length)}` : oneLine.replace(new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function patchStats(patch) {
  const files = [];
  let added = 0;
  let removed = 0;
  for (const line of String(patch || '').split('\n')) {
    const fileMatch = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/) || line.match(/^@@\s+(.+?)\s*$/);
    if (fileMatch && !fileMatch[1].startsWith('@@')) files.push(fileMatch[1].trim());
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('***')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { files: uniqueList(files, 3), added, removed };
}

function formatToolCall(payload, options = {}) {
  const rawName = String(payload.name || 'tool');
  const name = rawName.split('.').pop();
  const args = parseToolArguments(payload);

  if (name === 'exec_command') {
    const cmd = String(args.cmd || args.raw || '').trim();
    const files = extractCommandFiles(cmd);
    if (files.length) return `Read ${files.join(', ')}`;

    if (/\b(?:rg|grep)\b/.test(cmd)) {
      const targets = joinToolTargets(extractSearchTargets(cmd));
      return targets ? `Search ${targets}` : 'Search project files';
    }
    if (/\bfind\b/.test(cmd)) return 'Find files';
    if (/\bls\b/.test(cmd)) return 'List files';
    if (/\bgit\s+diff\b/.test(cmd)) return `Review diff${joinToolTargets(extractSearchTargets(cmd)) ? ` in ${joinToolTargets(extractSearchTargets(cmd))}` : ''}`;
    if (/\bgit\s+status\b/.test(cmd)) return 'Check git status';
    if (/\bgit\b/.test(cmd)) return `Run git: ${truncateCommand(cmd, 90)}`;
    if (/\b(?:node --check|npm run check)\b/.test(cmd)) return 'Run checks';
    if (/\bcurl\b/.test(cmd)) return `Check endpoint: ${truncateCommand(cmd, 100)}`;
    if (/\b(?:npm start|node\s+server\.js)\b/.test(cmd)) return 'Start local service';
    if (/\b(?:osascript|cliclick|open -b com\.openai\.codex)\b/.test(cmd)) return 'Control Codex desktop';
    if (/\.codex\/sessions|session_index\.jsonl|Codex session/.test(cmd)) return 'Inspect Codex session log';
    if (/\b(?:python3|node\s+-)\b/.test(cmd)) return `Run script: ${truncateCommand(cmd, 90)}`;
    return `Run: ${truncateCommand(cmd) || 'local command'}`;
  }

  if (name === 'apply_patch') {
    const patch = typeof args.raw === 'string' ? args.raw : String(payload.arguments || '');
    const stats = patchStats(patch);
    const target = stats.files.length ? stats.files.join(', ') : 'files';
    const delta = stats.added || stats.removed ? ` +${stats.added} -${stats.removed}` : '';
    return `${options.complete ? '已编辑' : '正在编辑'} ${target}${delta}`;
  }

  if (name === 'write_stdin') return 'Read command output';
  if (name === 'view_image') return `View image${args.path ? ` ${shortPath(args.path)}` : ''}`;
  if (name === 'read_mcp_resource') return `Read resource${args.uri ? ` ${shortPath(args.uri)}` : ''}`;
  if (name.includes('browser') || name.includes('chrome')) return 'Check browser page';
  return `${rawName}${Object.keys(args).length ? ` ${truncateText(JSON.stringify(args), 120)}` : ''}`;
}


function contextUsageFromItems(items) {
  let windowTokens = 0;
  let latestUsage = null;
  let updatedAt = '';

  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      const value = Number(payload.model_context_window || 0);
      if (Number.isFinite(value) && value > 0) windowTokens = value;
    }
    if (item.type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = payload.info || {};
    const value = Number(info.model_context_window || 0);
    if (Number.isFinite(value) && value > 0) windowTokens = value;
    const usage = info.last_token_usage || info.current_token_usage || null;
    if (usage && typeof usage === 'object') {
      latestUsage = usage;
      updatedAt = item.timestamp || updatedAt;
    }
  }

  if (!latestUsage || !windowTokens) {
    return {
      available: false,
      usedTokens: 0,
      windowTokens: windowTokens || 0,
      remainingTokens: windowTokens || 0,
      percent: null,
      updatedAt,
    };
  }

  const inputTokens = Number(latestUsage.input_tokens || 0) || 0;
  const outputTokens = Number(latestUsage.output_tokens || 0) || 0;
  const totalTokens = Number(latestUsage.total_tokens || 0) || 0;
  let usedTokens = totalTokens || (inputTokens + outputTokens) || inputTokens;
  if (usedTokens > windowTokens * 1.15 && inputTokens > 0 && inputTokens <= windowTokens * 1.15) {
    usedTokens = inputTokens + outputTokens;
  }
  usedTokens = Math.max(0, Math.round(usedTokens));
  const percent = Math.max(0, Math.min(100, (usedTokens / windowTokens) * 100));

  return {
    available: true,
    usedTokens,
    windowTokens,
    remainingTokens: Math.max(0, Math.round(windowTokens - usedTokens)),
    percent,
    updatedAt,
  };
}

function modelInfoFromId(modelId = '', updatedAt = '') {
  const id = String(modelId || '').trim();
  const option = findModelOption(id);
  if (option) return { available: true, id, version: '', source: 'local', label: option.label, displayName: option.displayName, updatedAt };

  if (id === 'gpt-5.5') return { available: true, id, version: '5.5', source: 'official', label: '5.5', displayName: 'GPT-5.5', updatedAt };
  if (id === 'gpt-5.4') return { available: true, id, version: '5.4', source: 'official', label: '5.4', displayName: 'GPT-5.4', updatedAt };
  if (id === 'gpt-5.4-mini') return { available: true, id, version: 'mini', source: 'official', label: 'mini', displayName: 'GPT-5.4 Mini', updatedAt };
  if (id === 'gpt-5.3-codex') return { available: true, id, version: '5.3', source: 'official', label: '5.3', displayName: 'GPT-5.3 Codex', updatedAt };
  if (id === 'gpt-5.2') return { available: true, id, version: '5.2', source: 'official', label: '5.2', displayName: 'GPT-5.2', updatedAt };

  return {
    available: Boolean(id),
    id,
    version: '',
    source: id.startsWith('gpt-') ? 'official' : id ? 'unknown' : '',
    label: '',
    displayName: id,
    updatedAt,
  };
}

function currentModelFromItems(items) {
  let modelId = '';
  let updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    if (item.type === 'session_meta' && payload.model) {
      modelId = payload.model;
      updatedAt = item.timestamp || payload.timestamp || updatedAt;
    }
    if (item.type === 'turn_context' && payload.model) {
      modelId = payload.model;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return modelInfoFromId(modelId, updatedAt);
}

function reasoningModeFromValue(value = '', updatedAt = '') {
  const raw = String(value || '').trim().toLowerCase();
  const aliases = {
    low: 'low',
    '低': 'low',
    medium: 'medium',
    med: 'medium',
    middle: 'medium',
    '中': 'medium',
    high: 'high',
    '高': 'high',
    xhigh: 'xhigh',
    'x-high': 'xhigh',
    'extra-high': 'xhigh',
    extreme: 'xhigh',
    max: 'xhigh',
    '超高': 'xhigh',
    '极高': 'xhigh',
  };
  const key = aliases[raw] || '';
  const target = key ? REASONING_MODE_TARGETS[key] : null;
  return {
    available: Boolean(target || raw),
    key: target?.key || '',
    value: target?.value || raw,
    label: target?.label || '',
    displayName: target?.displayName || value || '',
    updatedAt,
  };
}

function currentReasoningModeFromItems(items) {
  let value = '';
  let updatedAt = '';
  for (const item of items) {
    const payload = item.payload || {};
    const settings = payload.collaboration_mode && typeof payload.collaboration_mode === 'object'
      ? payload.collaboration_mode.settings || {}
      : {};
    const reasoning = payload.reasoning && typeof payload.reasoning === 'object' ? payload.reasoning : {};
    const next = payload.reasoning_effort || payload.reasoningMode || payload.reasoning_mode || settings.reasoning_effort || reasoning.effort || '';
    if (item.type === 'turn_context' && next) {
      value = next;
      updatedAt = item.timestamp || updatedAt;
    }
  }
  return reasoningModeFromValue(value, updatedAt);
}

function stepFromEvent(item) {
  const payload = item.payload || {};
  if (item.type === 'event_msg') {
    const failureText = extractFailureTextFromPayload(payload);
    if (failureText) return { kind: 'error', label: '失败', text: failureText, time: item.timestamp };
    if (payload.type === 'task_started') return { kind: 'start', label: '开始', text: '开始处理这条消息', time: item.timestamp };
    if (payload.type === 'task_complete') return { kind: 'complete', label: '完成', text: '回复完成', time: item.timestamp };
    if (payload.type === 'agent_message' && payload.message) {
      return { kind: 'thinking', label: '思考', text: String(payload.message).trim(), time: item.timestamp };
    }
    return null;
  }

  if (item.type === 'response_item') {
    if (payload.type === 'reasoning') {
      const text = extractReasoningText(payload);
      return text ? { kind: 'thinking', label: '思考', text, time: item.timestamp } : null;
    }
    if (payload.type === 'function_call') {
      const toolName = payload.name || 'tool';
      return { kind: 'tool', label: '工具', text: formatToolCall(payload), callId: payload.call_id || '', time: item.timestamp };
    }
    if (payload.type === 'message') {
      const text = extractMessageText(payload.content);
      if (text && payload.role === 'assistant' && payload.phase === 'commentary') return { kind: 'thinking', label: '思考', text: truncateText(text, 1200), time: item.timestamp };
      if (text && payload.role === 'assistant') return { kind: payload.phase === 'final_answer' ? 'final' : 'assistant', label: '回复', text: truncateText(text, 1200), time: item.timestamp };
    }
  }
  return null;
}

function parseCodexStatus(options = {}) {
  const sinceMs = options.since ? Date.parse(options.since) : 0;
  const wantsExactSession = Boolean(options.threadId || options.sessionFile);
  const requestedFile = options.threadId ? findCodexSessionFileByThreadId(options.threadId) : options.sessionFile ? findCodexSessionFileByName(options.sessionFile) : null;
  const file = requestedFile || (wantsExactSession ? null : findLatestCodexSessionFile({
    afterMs: options.expectNewThread ? sinceMs : 0,
    excludeThreadId: options.excludeThreadId || '',
    cwd: options.cwd || '',
  }));
  if (!file) {
    return {
      ok: true,
      available: false,
      active: Boolean(options.expectNewThread && sinceMs),
      status: wantsExactSession ? 'missing' : options.expectNewThread && sinceMs ? 'waiting' : 'idle',
      threadId: options.threadId || '',
      sessionFile: options.sessionFile || '',
      message: wantsExactSession ? '没有找到所选线程的 Codex 会话文件。' : '还没有找到 Codex 会话文件。',
      steps: [],
      preview: options.expectNewThread && sinceMs ? '已发送，等待 Codex 创建新线程记录…' : '还没有找到这个线程的回复记录。',
      final: '',
      durationMs: 0,
    };
  }

  const rawItems = [];
  for (const line of readTailLines(file)) {
    try { rawItems.push(JSON.parse(line)); } catch { /* ignore partial/corrupt lines */ }
  }

  let startIndex = -1;
  if (sinceMs) {
    for (let i = 0; i < rawItems.length; i += 1) {
      const t = Date.parse(rawItems[i].timestamp || '');
      if (Number.isFinite(t) && t >= sinceMs) {
        startIndex = i;
        break;
      }
    }
  }

  if (startIndex < 0) {
    for (let i = rawItems.length - 1; i >= 0; i -= 1) {
      if (rawItems[i].type === 'event_msg' && rawItems[i].payload && rawItems[i].payload.type === 'task_started') {
        startIndex = i;
        break;
      }
    }
  }
  if (startIndex < 0) startIndex = Math.max(0, rawItems.length - 80);

  // If watching a specific send, begin at the first task_started after that send when possible.
  if (sinceMs) {
    for (let i = startIndex; i < rawItems.length; i += 1) {
      const item = rawItems[i];
      const t = Date.parse(item.timestamp || '');
      if (Number.isFinite(t) && t >= sinceMs && item.type === 'event_msg' && item.payload && item.payload.type === 'task_started') {
        startIndex = i;
        break;
      }
    }
  }

  const turnItems = rawItems.slice(startIndex).filter(item => {
    if (!sinceMs) return true;
    const t = Date.parse(item.timestamp || '');
    return !Number.isFinite(t) || t >= sinceMs;
  });

  let active = Boolean(sinceMs);
  let completed = false;
  let turnId = null;
  let final = '';
  let preview = '';
  let startedAt = '';
  let completedAt = '';
  let sawTaskStarted = false;
  let failureText = '';
  let emptyComplete = false;
  const steps = [];
  const seenThinking = new Set();
  const toolCallsById = new Map();
  const toolStepIndexById = new Map();

  for (const item of turnItems) {
    const payload = item.payload || {};
    failureText = failureText || extractFailureTextFromPayload(payload);
    if (item.type === 'event_msg' && payload.type === 'task_started') {
      active = true;
      sawTaskStarted = true;
      turnId = payload.turn_id || turnId;
      startedAt = startedAt || item.timestamp || '';
    }
    if (item.type === 'turn_context') turnId = payload.turn_id || turnId;
    if (item.type === 'event_msg' && payload.type === 'task_complete') {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      const lastMessage = normalizeHistoryText(payload.last_agent_message || '');
      final = lastMessage || final;
      if (!lastMessage && !final && !preview && sawTaskStarted) emptyComplete = true;
    }
    if (item.type === 'event_msg' && isTerminalFailurePayload(payload)) {
      active = false;
      completed = true;
      completedAt = item.timestamp || completedAt;
      turnId = payload.turn_id || turnId;
    }

    if (item.type === 'response_item' && payload.type === 'function_call_output' && payload.call_id && toolStepIndexById.has(payload.call_id)) {
      const callPayload = toolCallsById.get(payload.call_id);
      if (callPayload && String(callPayload.name || '').split('.').pop() === 'apply_patch') {
        const stepIndex = toolStepIndexById.get(payload.call_id);
        if (steps[stepIndex]) steps[stepIndex].text = formatToolCall(callPayload, { complete: true });
      }
    }

    const step = stepFromEvent(item);
    if (!step) continue;
    if (step.kind === 'thinking') {
      const key = step.text || 'thinking';
      if (seenThinking.has(key)) continue;
      seenThinking.add(key);
    }
    if ((step.kind === 'assistant' || step.kind === 'final') && step.text) preview = step.text;
    if (step.kind === 'final' && step.text) final = step.text;
    if (['start', 'thinking', 'tool', 'complete', 'error'].includes(step.kind)) {
      if (step.kind === 'tool' && step.callId) {
        toolCallsById.set(step.callId, payload);
        toolStepIndexById.set(step.callId, steps.length);
      }
      steps.push(step);
    }
  }

  const context = contextUsageFromItems(rawItems);
  const model = currentModelFromItems(rawItems);
  const reasoningMode = currentReasoningModeFromItems(rawItems);
  const threadId = threadIdFromSessionFile(file);
  const failed = completed && !final && (emptyComplete || Boolean(failureText));
  const finalFailureText = failed
    ? (resolveFailureTextForTurn(threadId, { turnId, startedAt, completedAt, failureText }) || emptyCodexFailureText())
    : '';
  const statusSteps = steps.slice(-30);
  if (failed && finalFailureText && !statusSteps.some(step => step.kind === 'error' && step.text === finalFailureText)) {
    statusSteps.push({ kind: 'error', label: '失败', text: finalFailureText, time: completedAt || new Date(fs.statSync(file).mtimeMs).toISOString() });
  }
  const lastStep = statusSteps[statusSteps.length - 1] || steps[steps.length - 1];
  const status = failed ? 'error' : completed ? 'complete' : active ? 'running' : 'idle';
  const waiting = sinceMs && !steps.length;
  const startMs = Date.parse(startedAt || '') || sinceMs || 0;
  const endMs = completedAt ? Date.parse(completedAt) : Date.now();
  const durationMs = startMs ? Math.max(0, endMs - startMs) : 0;
  return {
    ok: true,
    available: true,
    active: waiting ? true : active,
    status: waiting ? 'waiting' : status,
    turnId,
    sessionFile: path.basename(file),
    threadId,
    updatedAt: lastStep ? lastStep.time : new Date(fs.statSync(file).mtimeMs).toISOString(),
    startedAt,
    completedAt,
    durationMs,
    context,
    model,
    reasoningMode,
    processText: statusSteps.map(step => `${step.label || '事件'}：${step.text || ''}`).join('\\n'),
    preview: final || preview || finalFailureText || (waiting ? '已发送，等待 Codex 开始回复…' : active ? 'Codex 正在回复…' : '暂无可显示回复。'),
    final: final || '',
    error: finalFailureText,
    steps: statusSteps,
  };
}

function handleCodexStatus(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return json(res, 200, parseCodexStatus({
      since: url.searchParams.get('since') || '',
      sessionFile: url.searchParams.get('session') || '',
      threadId: url.searchParams.get('thread') || '',
      expectNewThread: url.searchParams.get('expectNewThread') === '1',
      excludeThreadId: url.searchParams.get('excludeThread') || '',
      cwd: url.searchParams.get('cwd') || '',
    }));
  } catch (error) {
    return json(res, 500, { ok: false, code: 'CODEX_STATUS_FAILED', message: '读取 Codex 回复状态失败。', detail: String(error && error.message || error) });
  }
}

async function handleSelectThread(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  if (!isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
  }

  try {
    await activateCodexThread(threadId);
    return json(res, 200, { ok: true, threadId, message: '已切换到所选 Codex 线程。' });
  } catch (error) {
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}


const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,x-mobile-typer-token',
    'access-control-allow-private-network': 'true',
  };
}

function options(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('输入太长了，请分段发送。'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isAuthorized(req) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const fromHeader = req.headers['x-mobile-typer-token'];
  const fromQuery = url.searchParams.get('token');
  const fromCookie = parseCookies(req.headers.cookie || '').codexMiniToken;
  return fromHeader === TOKEN || fromQuery === TOKEN || fromCookie === TOKEN;
}

function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    const value = part.slice(index + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

const RELAY_HOP_BY_HOP_HEADERS = new Set([
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
let relayReconnectTimer = null;
let relayReconnectDelayMs = 1000;
let relayApprovalNoticeShown = false;
let relayHeartbeatTimer = null;
let relayCodexWatchTimer = null;
let relayCodexWatchInFlight = false;
let relayCurrentWs = null;
let relayPausedForCodexDesktop = false;
let relayCodexDesktopRunning = !IS_WINDOWS || !RELAY_REQUIRE_CODEX_DESKTOP ? true : null;
let relayStatus = {
  configured: Boolean(RELAY_URL && RELAY_SECRET && RELAY_DEVICE_ID),
  deviceId: RELAY_DEVICE_ID,
  relayUrl: RELAY_URL,
  publicBase: RELAY_PUBLIC_BASE,
  connected: false,
  state: RELAY_URL && RELAY_SECRET && RELAY_DEVICE_ID ? 'starting' : 'disabled',
  codexWatchEnabled: Boolean(IS_WINDOWS && RELAY_REQUIRE_CODEX_DESKTOP),
  codexDesktopRunning: relayCodexDesktopRunning,
  codexLastCheckedAt: '',
  lastConnectedAt: '',
  lastDisconnectedAt: '',
  lastError: '',
  reconnectDelayMs: relayReconnectDelayMs,
  heartbeatIntervalMs: RELAY_HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: RELAY_HEARTBEAT_TIMEOUT_MS,
  codexWatchIntervalMs: RELAY_CODEX_WATCH_INTERVAL_MS,
};

function updateRelayStatus(patch) {
  relayStatus = {
    ...relayStatus,
    ...patch,
    reconnectDelayMs: relayReconnectDelayMs,
  };
}

function relayStatusPayload() {
  return {
    ok: true,
    ...relayStatus,
    reconnectDelayMs: relayReconnectDelayMs,
    now: new Date().toISOString(),
  };
}

async function handleRelayStatus(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (IS_WINDOWS) {
    try {
      const running = await isCodexDesktopRunning();
      relayCodexDesktopRunning = running;
      updateRelayStatus({
        codexDesktopRunning: running,
        codexLastCheckedAt: new Date().toISOString(),
        lastError: running ? relayStatus.lastError : 'Codex desktop is not running',
      });
    } catch (error) {
      updateRelayStatus({
        codexLastCheckedAt: new Date().toISOString(),
        lastError: error && error.message || 'Codex desktop check failed',
      });
    }
  }
  return json(res, 200, relayStatusPayload());
}

function clearRelayHeartbeat() {
  if (relayHeartbeatTimer) clearInterval(relayHeartbeatTimer);
  relayHeartbeatTimer = null;
}

function clearRelayReconnectTimer() {
  if (relayReconnectTimer) clearTimeout(relayReconnectTimer);
  relayReconnectTimer = null;
}

function shouldGateRelayOnCodexDesktop() {
  return Boolean(IS_WINDOWS && RELAY_REQUIRE_CODEX_DESKTOP);
}

function relayShouldPauseForCodexDesktop() {
  return shouldGateRelayOnCodexDesktop() && relayCodexDesktopRunning !== true;
}

function closeRelayWebSocketForCodexDesktop() {
  relayPausedForCodexDesktop = true;
  clearRelayReconnectTimer();
  clearRelayHeartbeat();
  const ws = relayCurrentWs;
  relayCurrentWs = null;
  if (ws) {
    try {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close(4001, 'codex-desktop-stopped');
      else if (ws.readyState !== 3) ws.terminate();
    } catch {
      try { ws.terminate(); } catch {}
    }
  }
  updateRelayStatus({
    connected: false,
    state: 'codex-stopped',
    lastDisconnectedAt: new Date().toISOString(),
    lastError: 'Codex desktop is not running',
  });
}

async function isCodexDesktopRunning() {
  if (!IS_WINDOWS) return true;
  const { stdout } = await runWindowsPowerShell(`
$proc = Get-Process -Name Codex -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if ($proc) { '1' } else { '0' }
`);
  return stdout.trim().split(/\s+/).includes('1');
}

function startRelayCodexDesktopWatch(connect) {
  if (!shouldGateRelayOnCodexDesktop() || relayCodexWatchTimer) return;

  const check = async () => {
    if (relayCodexWatchInFlight) return;
    relayCodexWatchInFlight = true;
    let running = false;
    let errorText = '';
    try {
      running = await isCodexDesktopRunning();
    } catch (error) {
      errorText = error.message || 'Codex desktop check failed';
    } finally {
      relayCodexWatchInFlight = false;
    }

    const changed = relayCodexDesktopRunning !== running;
    relayCodexDesktopRunning = running;
    updateRelayStatus({
      codexDesktopRunning: running,
      codexLastCheckedAt: new Date().toISOString(),
      lastError: running ? relayStatus.lastError : (errorText || 'Codex desktop is not running'),
    });

    if (!running) {
      if (changed) console.log('Codex desktop stopped; closing public relay tunnel.');
      closeRelayWebSocketForCodexDesktop();
      return;
    }

    if (changed) console.log('Codex desktop is running; restoring public relay tunnel.');
    if (relayPausedForCodexDesktop || relayStatus.state === 'codex-checking' || relayStatus.state === 'codex-stopped') {
      relayPausedForCodexDesktop = false;
      relayReconnectDelayMs = 1000;
      clearRelayReconnectTimer();
      connect();
    }
  };

  updateRelayStatus({ state: 'codex-checking', codexWatchEnabled: true });
  check();
  relayCodexWatchTimer = setInterval(check, Math.max(1000, RELAY_CODEX_WATCH_INTERVAL_MS));
}

function clearRelayCodexDesktopWatch() {
  if (relayCodexWatchTimer) clearInterval(relayCodexWatchTimer);
  relayCodexWatchTimer = null;
}

function relayHmac(value) {
  return crypto.createHmac('sha256', RELAY_SECRET).update(String(value || '')).digest('base64url');
}

function relayTunnelUrl() {
  const timestamp = Date.now();
  const nonce = crypto.randomBytes(12).toString('base64url');
  const signature = relayHmac(`${RELAY_DEVICE_ID}.${timestamp}.${nonce}`);
  const url = new URL(RELAY_URL);
  url.searchParams.set('deviceId', RELAY_DEVICE_ID);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('signature', signature);
  return url.toString();
}

function relayLoginUrl() {
  if (!RELAY_PUBLIC_BASE) return '';
  const base = RELAY_PUBLIC_BASE.replace(/\/+$/, '');
  if (!RELAY_PASSPHRASE) return `${base}/`;
  return `${base}/#k=${encodeURIComponent(RELAY_PASSPHRASE)}`;
}

function printRelayQr() {
  const url = relayLoginUrl();
  if (!url) return;
  console.log('Relay phone URL:');
  console.log(`  ${url}`);
  if (!RELAY_PASSPHRASE) return;
  if (RELAY_TERMINAL_QR) {
    try {
      const qrcode = require('qrcode-terminal');
      qrcode.generate(url, { small: true });
    } catch {
      console.log('Install qrcode-terminal to print a terminal QR code.');
    }
  }
  try {
    fs.mkdirSync(QR_OUTPUT_DIR, { recursive: true });
    const urlPath = path.join(QR_OUTPUT_DIR, '登录链接.txt');
    const pngPath = path.join(QR_OUTPUT_DIR, '登录二维码.png');
    fs.writeFileSync(urlPath, `${url}\n`, 'utf8');
    const QRCode = require('qrcode');
    QRCode.toFile(pngPath, url, { errorCorrectionLevel: 'M', margin: 2, width: 512 }, error => {
      if (error) {
        console.log(`Could not write relay QR image: ${error.message}`);
        return;
      }
      console.log(`QR image saved: ${pngPath}`);
      console.log(`Login URL file: ${urlPath}`);
    });
  } catch (error) {
    console.log(`Could not write relay QR files: ${error.message}`);
  }
}

function relayRequestPath(value) {
  const raw = String(value || '/');
  try {
    const parsed = new URL(raw, 'http://relay.local');
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return raw.startsWith('/') ? raw : '/';
  }
}

function relayRequestHeaders(headers, bodyLength) {
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (RELAY_HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'cookie') continue;
    out[lower] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  out['x-mobile-typer-token'] = TOKEN;
  if (bodyLength > 0) out['content-length'] = String(bodyLength);
  return out;
}

function forwardRelayRequest(message) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(String(message.bodyBase64 || ''), 'base64');
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      method: String(message.method || 'GET').toUpperCase(),
      path: relayRequestPath(message.path),
      headers: relayRequestHeaders(message.headers, body.length),
      timeout: RELAY_REQUEST_TIMEOUT_MS,
    }, response => {
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > RELAY_RESPONSE_MAX_BYTES) {
          req.destroy(Object.assign(new Error('relay response too large'), { code: 'RELAY_RESPONSE_TOO_LARGE' }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        resolve({
          status: response.statusCode || 502,
          headers: response.headers || {},
          bodyBase64: responseBody.toString('base64'),
        });
      });
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('relay local request timed out'), { code: 'LOCAL_TIMEOUT' })));
    req.on('error', reject);
    if (body.length) req.write(body);
    req.end();
  });
}

async function handleRelayTunnelMessage(ws, raw) {
  let message = null;
  try {
    message = JSON.parse(String(raw || ''));
  } catch {
    return;
  }
  if (!message || message.type !== 'request' || !message.id) return;
  try {
    const response = await forwardRelayRequest(message);
    ws.send(JSON.stringify({
      type: 'response',
      id: message.id,
      status: response.status,
      headers: response.headers,
      bodyBase64: response.bodyBase64,
    }));
  } catch (error) {
    ws.send(JSON.stringify({
      type: 'error',
      id: message.id,
      code: error.code || 'LOCAL_REQUEST_FAILED',
      message: error.message || 'Local request failed.',
    }));
  }
}

function startRelayClient() {
  if (!RELAY_URL || !RELAY_SECRET || !RELAY_DEVICE_ID) {
    updateRelayStatus({ connected: false, state: 'disabled', lastError: 'relay is not configured' });
    return;
  }
  let WebSocket = null;
  try {
    WebSocket = require('ws');
  } catch (error) {
    updateRelayStatus({ connected: false, state: 'disabled', lastError: error.message || 'ws dependency missing' });
    console.warn(`Relay disabled: install dependencies first (${error.message}).`);
    return;
  }

  const connect = () => {
    if (relayShouldPauseForCodexDesktop()) {
      closeRelayWebSocketForCodexDesktop();
      return;
    }
    relayPausedForCodexDesktop = false;
    updateRelayStatus({ connected: false, state: 'connecting' });
    const ws = new WebSocket(relayTunnelUrl(), { handshakeTimeout: 10000 });
    relayCurrentWs = ws;
    ws.isAlive = true;
    ws.on('open', () => {
      if (relayShouldPauseForCodexDesktop()) {
        closeRelayWebSocketForCodexDesktop();
        return;
      }
      relayReconnectDelayMs = 1000;
      relayApprovalNoticeShown = false;
      clearRelayHeartbeat();
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
      updateRelayStatus({
        connected: true,
        state: 'connected',
        lastConnectedAt: new Date().toISOString(),
        lastError: '',
      });
      relayHeartbeatTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const lastPongAt = ws.lastPongAt || Date.now();
        if (!ws.isAlive && Date.now() - lastPongAt > RELAY_HEARTBEAT_TIMEOUT_MS) {
          updateRelayStatus({
            connected: false,
            state: 'heartbeat-timeout',
            lastError: 'relay heartbeat timed out',
          });
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch (error) {
          updateRelayStatus({
            connected: false,
            state: 'heartbeat-error',
            lastError: error.message || 'relay heartbeat failed',
          });
          ws.terminate();
        }
      }, RELAY_HEARTBEAT_INTERVAL_MS);
      console.log(`Relay connected as ${RELAY_DEVICE_ID}.`);
    });
    ws.on('pong', () => {
      ws.isAlive = true;
      ws.lastPongAt = Date.now();
      if (relayStatus.state !== 'connected') {
        updateRelayStatus({ connected: true, state: 'connected', lastError: '' });
      }
    });
    ws.on('message', raw => handleRelayTunnelMessage(ws, raw));
    ws.on('close', () => {
      if (relayCurrentWs === ws) relayCurrentWs = null;
      clearRelayHeartbeat();
      if (relayPausedForCodexDesktop || relayShouldPauseForCodexDesktop()) {
        updateRelayStatus({
          connected: false,
          state: 'codex-stopped',
          lastDisconnectedAt: new Date().toISOString(),
          lastError: 'Codex desktop is not running',
        });
        return;
      }
      updateRelayStatus({
        connected: false,
        state: 'reconnecting',
        lastDisconnectedAt: new Date().toISOString(),
      });
      if (relayReconnectTimer) return;
      const delay = relayReconnectDelayMs;
      relayReconnectDelayMs = Math.min(relayReconnectDelayMs * 2, 30000);
      updateRelayStatus({ reconnectDelayMs: relayReconnectDelayMs });
      relayReconnectTimer = setTimeout(() => {
        relayReconnectTimer = null;
        connect();
      }, delay);
    });
    ws.on('error', error => {
      const message = String(error && error.message || '');
      updateRelayStatus({ connected: false, state: 'error', lastError: message || 'relay connection error' });
      if (/Unexpected server response:\s*401/i.test(message)) {
        if (!relayApprovalNoticeShown) {
          relayApprovalNoticeShown = true;
          console.warn('Waiting for relay authorization.');
        }
        return;
      }
      console.warn(`Relay connection error: ${message}`);
    });
  };

  if (shouldGateRelayOnCodexDesktop()) startRelayCodexDesktopWatch(connect);
  else connect();
}

function cleanupRecentSendRequests() {
  const cutoff = Date.now() - RECENT_SEND_TTL_MS;
  for (const [id, entry] of recentSendRequests) {
    if (!entry || entry.createdAt < cutoff) recentSendRequests.delete(id);
  }
}

function updateSendProgress(clientRequestId, patch = {}) {
  if (!clientRequestId) return null;
  const existing = recentSendRequests.get(clientRequestId) || { createdAt: Date.now() };
  const progress = {
    ...(existing.progress || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  const next = {
    ...existing,
    createdAt: existing.createdAt || Date.now(),
    progress,
  };
  recentSendRequests.set(clientRequestId, next);
  return progress;
}

function sendProgressMessageForPhase(phase, fallback = '') {
  const messages = {
    accepted: '已收到消息，准备发送到 Codex',
    checkingCodex: '正在检查 Codex 是否已启动',
    startingCodex: '已检测到 Codex 未启动，正在启动 Codex',
    activatingCodex: '正在切换到 Codex',
    waitingCodex: '等待 Codex App 加载',
    waitingComposer: '等待 Codex 输入框加载',
    pasting: '正在粘贴并发送到 Codex',
    confirming: '正在确认 Codex 已记录这条消息',
    retryingFocus: '正在重新聚焦 Codex 输入框',
    retryingSend: '正在点击 Codex 发送按钮',
    sent: '已发送到 Codex',
    queued: '这条发送请求已经被接收，正在继续等待 Codex 回复',
    failed: '发送失败',
  };
  return fallback || messages[phase] || '';
}

function setSendProgress(clientRequestId, phase, message = '') {
  return updateSendProgress(clientRequestId, {
    phase,
    message: sendProgressMessageForPhase(phase, message),
  });
}

function handleSendStatus(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  cleanupRecentSendRequests();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const clientRequestId = normalizeClientRequestId(url.searchParams.get('id'));
  if (!clientRequestId) return json(res, 400, { ok: false, code: 'BAD_REQUEST_ID', message: '请求 ID 不正确。' });
  const entry = recentSendRequests.get(clientRequestId);
  if (!entry) return json(res, 200, { ok: true, found: false });
  return json(res, 200, {
    ok: true,
    found: true,
    progress: entry.progress || null,
    duplicate: Boolean(entry.result),
    failed: Boolean(entry.failed),
    done: Boolean(entry.result || entry.failed),
    watch: entry.watch || null,
  });
}

function normalizeClientRequestId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9._:-]{8,120}$/.test(id) ? id : '';
}

function runProcess(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr.trim() || `${command} exited with code ${code}`), { code, stdout, stderr }));
    });
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function powerShellSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function windowsPowerShellPath() {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function runWindowsPowerShell(script) {
  const filePath = path.join(os.tmpdir(), `codex-mini-win-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.ps1`);
  fs.writeFileSync(filePath, String(script || ''), 'utf8');
  try {
    return await runProcess(windowsPowerShellPath(), ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File', filePath]);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

async function windowsAssertInteractiveDesktop() {
  const { stdout } = await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class CodexMiniDesktopProbe {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
$handle = [CodexMiniDesktopProbe]::GetForegroundWindow()
$className = New-Object System.Text.StringBuilder 256
$title = New-Object System.Text.StringBuilder 256
[void][CodexMiniDesktopProbe]::GetClassName($handle, $className, 256)
[void][CodexMiniDesktopProbe]::GetWindowText($handle, $title, 256)
Write-Output ("class=" + $className.ToString() + ";title=" + $title.ToString())
`);
  const info = stdout.trim();
  if (/LockScreenBackstopFrame|Windows\.UI\.Core\.CoreWindow/i.test(info) && /锁屏|lock/i.test(info)) {
    const error = new Error(`Windows desktop is locked or showing a secure screen (${info}).`);
    error.code = 'CODEX_DESKTOP_LOCKED';
    error.status = 409;
    throw error;
  }
}

async function windowsActivateCodexWindow({ startIfNeeded = true } = {}) {
  await windowsAssertInteractiveDesktop();
  const appId = powerShellSingleQuote(`shell:AppsFolder\\${WINDOWS_CODEX_APP_ID}`);
  await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexMiniActivateWin32 {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
$shell = New-Object -ComObject WScript.Shell
$started = $false
if (-not $shell.AppActivate('Codex')) {
  if (${startIfNeeded ? '$true' : '$false'}) {
    Start-Process ${appId}
    $started = $true
  }
}
$activated = $false
$deadline = (Get-Date).AddMilliseconds(${WINDOWS_CODEX_STARTUP_TIMEOUT_MS})
do {
  $proc = Get-Process -Name Codex -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
  if ($proc) {
    [void][CodexMiniActivateWin32]::ShowWindow($proc.MainWindowHandle, 9)
    [void][CodexMiniActivateWin32]::SetForegroundWindow($proc.MainWindowHandle)
  }
  if ($shell.AppActivate('Codex')) {
    $activated = $true
    break
  }
  Start-Sleep -Milliseconds $(if ($started) { 350 } else { 180 })
} while ((Get-Date) -lt $deadline)
if (-not $activated) {
  throw 'Codex window could not be activated. Open Codex once, then retry.'
}
if ($started) {
  Start-Sleep -Milliseconds 700
}
`);
  await delay(CODEX_APP_FOCUS_SETTLE_MS);
}

async function windowsClickCodexComposer() {
  await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexMiniWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
}
"@
function Click-CodexMiniPoint([int]$x, [int]$y) {
  [void][CodexMiniWin32]::SetCursorPos($x, $y)
  [CodexMiniWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [CodexMiniWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
function Assert-CodexMiniPointIsInteractive([int]$x, [int]$y) {
  $pt = New-Object CodexMiniWin32+POINT
  $pt.X = $x
  $pt.Y = $y
  $target = [CodexMiniWin32]::WindowFromPoint($pt)
  $className = New-Object System.Text.StringBuilder 256
  $title = New-Object System.Text.StringBuilder 256
  [void][CodexMiniWin32]::GetClassName($target, $className, 256)
  [void][CodexMiniWin32]::GetWindowText($target, $title, 256)
  $info = "class=" + $className.ToString() + ";title=" + $title.ToString()
  if ($info -match '(?i)LockScreenBackstopFrame|Windows\\.UI\\.Core\\.CoreWindow|锁屏|lock screen') {
    throw ("CODEX_DESKTOP_LOCKED: Windows lock screen or secure desktop is covering Codex at input point (" + $info + ").")
  }
}
function Dismiss-CodexMiniBottomObstructions([IntPtr]$handle) {
  try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $window) { return }
    $windowBounds = $window.Current.BoundingRectangle
    $bottomCutoff = $windowBounds.Bottom - 240
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $all.Count; $i++) {
      $item = $all.Item($i)
      if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
      if (-not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
      $name = [string]$item.Current.Name
      if ($name -notmatch '(?i)关闭|close|dismiss') { continue }
      $rect = $item.Current.BoundingRectangle
      if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      if ($rect.Y -lt $bottomCutoff) { continue }
      try {
        $pattern = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
      } catch {
        Click-CodexMiniPoint ([int]($rect.X + ($rect.Width / 2))) ([int]($rect.Y + ($rect.Height / 2)))
      }
      Start-Sleep -Milliseconds 180
      return
    }
  } catch {
  }
}
function New-CodexMiniPoint([int]$x, [int]$y) {
  return [pscustomobject]@{ X = $x; Y = $y }
}
function Get-CodexMiniComposerPoint([IntPtr]$handle) {
  $fallbackRect = New-Object CodexMiniWin32+RECT
  if (-not [CodexMiniWin32]::GetWindowRect($handle, [ref]$fallbackRect)) { throw 'Could not read Codex window bounds.' }
  $fallbackWidth = [Math]::Max(1, $fallbackRect.Right - $fallbackRect.Left)
  $fallbackHeight = [Math]::Max(1, $fallbackRect.Bottom - $fallbackRect.Top)
  $fallbackX = [int]($fallbackRect.Left + ($fallbackWidth / 2))
  $fallbackBottomOffset = [Math]::Max(72, [Math]::Min(150, [int]($fallbackHeight * 0.11)))
  $fallbackY = [int]($fallbackRect.Bottom - $fallbackBottomOffset)
  try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $window) { return New-CodexMiniPoint $fallbackX $fallbackY }
    $bounds = $window.Current.BoundingRectangle
    $sidebarCutoff = $bounds.Left + [Math]::Min(340, [Math]::Max(280, [int]($bounds.Width * 0.2)))
    $topCutoff = $bounds.Top + 180
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $namedCandidates = @()
    $groupCandidates = @()
    for ($i = 0; $i -lt $all.Count; $i++) {
      $item = $all.Item($i)
      if ($item.Current.IsOffscreen) { continue }
      $rect = $item.Current.BoundingRectangle
      if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      if ($rect.X -lt $sidebarCutoff -or $rect.Y -lt $topCutoff) { continue }
      $name = [string]$item.Current.Name
      $typeName = $item.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if ($name -match '(?i)(?:\\u968f\\u5fc3\\u8f93\\u5165|\\u8f93\\u5165|\\u6d88\\u606f|ask|message|prompt)') {
        $namedCandidates += [pscustomobject]@{
          X = [int]($rect.X + [Math]::Min(80, [Math]::Max(24, $rect.Width / 2)))
          Y = [int]($rect.Y + ($rect.Height / 2))
          Score = [double]$rect.Y
          Element = $item
          CanInvoke = (($item.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',') -match 'InvokePattern'
        }
      } elseif ($typeName -eq 'Group' -and $rect.Width -ge 360 -and $rect.Height -ge 32 -and $rect.Height -le 140) {
        $groupCandidates += [pscustomobject]@{
          X = [int]($rect.X + [Math]::Min(90, [Math]::Max(32, $rect.Width * 0.16)))
          Y = [int]($rect.Y + [Math]::Min(28, [Math]::Max(18, $rect.Height / 2)))
          Score = [double]$rect.Y
          Element = $item
          CanInvoke = (($item.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',') -match 'InvokePattern'
        }
      }
    }
    if ($groupCandidates.Count) {
      $best = $groupCandidates | Sort-Object @{ Expression = 'CanInvoke'; Descending = $true }, @{ Expression = 'Score'; Descending = $true } | Select-Object -First 1
      if ($best.CanInvoke) {
        try {
          $pattern = $best.Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          Start-Sleep -Milliseconds 160
        } catch {
        }
      }
      return New-CodexMiniPoint $best.X $best.Y
    }
    if ($namedCandidates.Count) {
      $best = $namedCandidates | Sort-Object @{ Expression = 'CanInvoke'; Descending = $true }, @{ Expression = 'Score'; Descending = $true } | Select-Object -First 1
      if ($best.CanInvoke) {
        try {
          $pattern = $best.Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          Start-Sleep -Milliseconds 160
        } catch {
        }
      }
      return New-CodexMiniPoint $best.X $best.Y
    }
  } catch {
  }
  return New-CodexMiniPoint $fallbackX $fallbackY
}
function Test-CodexMiniComposerReady([IntPtr]$handle) {
  try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $window) { return $false }
    $bounds = $window.Current.BoundingRectangle
    $sidebarCutoff = $bounds.Left + [Math]::Min(340, [Math]::Max(280, [int]($bounds.Width * 0.2)))
    $topCutoff = $bounds.Top + 180
    $bottomReadyCutoff = $bounds.Bottom - [Math]::Max(260, [int]($bounds.Height * 0.35))
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $all.Count; $i++) {
      $item = $all.Item($i)
      if ($item.Current.IsOffscreen) { continue }
      $rect = $item.Current.BoundingRectangle
      if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      if ($rect.X -lt $sidebarCutoff -or $rect.Y -lt $topCutoff) { continue }
      if ($rect.Y -lt $bottomReadyCutoff) { continue }
      $name = [string]$item.Current.Name
      $typeName = $item.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if ($name -match '(?i)(?:\\u968f\\u5fc3\\u8f93\\u5165|\\u8f93\\u5165|\\u6d88\\u606f|ask|message|prompt)') { return $true }
      if ($typeName -eq 'Group' -and $rect.Width -ge 360 -and $rect.Height -ge 32 -and $rect.Height -le 160) { return $true }
    }
  } catch {
  }
  return $false
}
function Wait-CodexMiniComposerReady([IntPtr]$handle) {
  $deadline = (Get-Date).AddMilliseconds(${WINDOWS_CODEX_STARTUP_TIMEOUT_MS})
  do {
    if (Test-CodexMiniComposerReady $handle) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'Codex composer was not ready after startup.'
}
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate('Codex')
Start-Sleep -Milliseconds 120
$proc = Get-Process -Name Codex -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1
if (-not $proc) { throw 'Codex window handle not found after activation.' }
[void][CodexMiniWin32]::ShowWindow($proc.MainWindowHandle, 9)
[void][CodexMiniWin32]::SetForegroundWindow($proc.MainWindowHandle)
Start-Sleep -Milliseconds 120
Start-Sleep -Milliseconds 220
Dismiss-CodexMiniBottomObstructions $proc.MainWindowHandle
Wait-CodexMiniComposerReady $proc.MainWindowHandle
$point = Get-CodexMiniComposerPoint $proc.MainWindowHandle
Assert-CodexMiniPointIsInteractive ([int]$point.X) ([int]$point.Y)
Click-CodexMiniPoint ([int]$point.X) ([int]$point.Y)
`);
  await delay(CODEX_CLICK_SETTLE_MS);
}

async function windowsSendKeys(keys) {
  await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate('Codex')
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait(${powerShellSingleQuote(keys)})
`);
}

async function windowsDismissCodexBottomObstructions() {
  const result = await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexMiniDismissWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, UIntPtr extra);
}
"@
function Click-CodexMiniPoint([int]$x, [int]$y) {
  [void][CodexMiniDismissWin32]::SetCursorPos($x, $y)
  [CodexMiniDismissWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [CodexMiniDismissWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate('Codex')
Start-Sleep -Milliseconds 260
$proc = Get-Process -Name Codex -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1
if (-not $proc) { return }
$window = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $window) { return }
$windowBounds = $window.Current.BoundingRectangle
$bottomCutoff = $windowBounds.Bottom - 240
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
for ($i = 0; $i -lt $all.Count; $i++) {
  $item = $all.Item($i)
  if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
  if (-not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
  $name = [string]$item.Current.Name
  if ($name -notmatch '(?i)关闭|close|dismiss') { continue }
  $rect = $item.Current.BoundingRectangle
  if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
  if ($rect.Y -lt $bottomCutoff) { continue }
  try {
    $pattern = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
  } catch {
    Click-CodexMiniPoint ([int]($rect.X + ($rect.Width / 2))) ([int]($rect.Y + ($rect.Height / 2)))
  }
  Start-Sleep -Milliseconds 220
  Write-Output 'DISMISSED'
  return
}
`);
  return /\bDISMISSED\b/.test(result.stdout || '');
}

async function windowsPasteTextAndEnter(text, threadId = '', options = {}) {
  const filePath = path.join(os.tmpdir(), `codex-mini-submit-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(filePath, String(text || ''), 'utf8');
  try {
    await activateCodexThread(threadId, { allowCached: Boolean(options.assumeThreadSynced) });
    await windowsDismissCodexBottomObstructions().catch(() => false);
    await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexMiniSubmitWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public UInt32 type; public InputUnion U; }
  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public UInt16 wVk;
    public UInt16 wScan;
    public UInt32 dwFlags;
    public UInt32 time;
    public UIntPtr dwExtraInfo;
  }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, int dwFlags, UIntPtr extra);
  [DllImport("user32.dll", SetLastError=true)] public static extern UInt32 SendInput(UInt32 nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder lpClassName, int nMaxCount);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
}
"@
function Activate-CodexMiniWindow {
  $shell = New-Object -ComObject WScript.Shell
  [void]$shell.AppActivate('Codex')
  Start-Sleep -Milliseconds 90
  $proc = Get-Process -Name Codex -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
  if (-not $proc) { throw 'Codex window handle not found.' }
  [void][CodexMiniSubmitWin32]::ShowWindow($proc.MainWindowHandle, 9)
  [void][CodexMiniSubmitWin32]::SetForegroundWindow($proc.MainWindowHandle)
  [void]$shell.AppActivate('Codex')
  Start-Sleep -Milliseconds 120
  return $proc.MainWindowHandle
}
function Click-CodexMiniComposer([IntPtr]$handle) {
  $rect = New-Object CodexMiniSubmitWin32+RECT
  if (-not [CodexMiniSubmitWin32]::GetWindowRect($handle, [ref]$rect)) { throw 'Could not read Codex window bounds.' }
  $width = [Math]::Max(1, $rect.Right - $rect.Left)
  $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  $x = [int]($rect.Left + ($width / 2))
  $bottomOffset = [Math]::Max(72, [Math]::Min(150, [int]($height * 0.11)))
  $y = [int]($rect.Bottom - $bottomOffset)
  [void][CodexMiniSubmitWin32]::SetCursorPos($x, $y)
  [CodexMiniSubmitWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [CodexMiniSubmitWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 140
}
function Send-KeyDown([byte]$vk) {
  [CodexMiniSubmitWin32]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
}
function Send-KeyUp([byte]$vk) {
  [CodexMiniSubmitWin32]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}
function Send-KeyTap([byte]$vk) {
  Send-KeyDown $vk
  Start-Sleep -Milliseconds 45
  Send-KeyUp $vk
}
function Send-CtrlV {
  Send-KeyDown 0x11
  Start-Sleep -Milliseconds 35
  Send-KeyTap 0x56
  Start-Sleep -Milliseconds 35
  Send-KeyUp 0x11
}
function Send-ShiftEnter {
  Send-KeyDown 0x10
  Start-Sleep -Milliseconds 20
  Send-KeyTap 0x0D
  Start-Sleep -Milliseconds 20
  Send-KeyUp 0x10
}
function Send-UnicodeChar([char]$ch) {
  $inputs = New-Object 'CodexMiniSubmitWin32+INPUT[]' 2
  $inputs[0].type = 1
  $inputs[0].U.ki.wVk = 0
  $inputs[0].U.ki.wScan = [UInt16][char]$ch
  $inputs[0].U.ki.dwFlags = 0x0004
  $inputs[0].U.ki.time = 0
  $inputs[0].U.ki.dwExtraInfo = [UIntPtr]::Zero
  $inputs[1].type = 1
  $inputs[1].U.ki.wVk = 0
  $inputs[1].U.ki.wScan = [UInt16][char]$ch
  $inputs[1].U.ki.dwFlags = 0x0004 -bor 0x0002
  $inputs[1].U.ki.time = 0
  $inputs[1].U.ki.dwExtraInfo = [UIntPtr]::Zero
  [void][CodexMiniSubmitWin32]::SendInput(2, $inputs, [Runtime.InteropServices.Marshal]::SizeOf([type][CodexMiniSubmitWin32+INPUT]))
}
function Send-UnicodeText([string]$value) {
  foreach ($ch in $value.ToCharArray()) {
    if ($ch -eq [char]13) { continue }
    if ($ch -eq [char]10) {
      Send-ShiftEnter
      Start-Sleep -Milliseconds 6
      continue
    }
    Send-UnicodeChar $ch
    Start-Sleep -Milliseconds 2
  }
}
function Click-CodexMiniPoint([int]$x, [int]$y) {
  [void][CodexMiniSubmitWin32]::SetCursorPos($x, $y)
  [CodexMiniSubmitWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [CodexMiniSubmitWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
function Assert-CodexMiniPointIsInteractive([int]$x, [int]$y) {
  $pt = New-Object CodexMiniSubmitWin32+POINT
  $pt.X = $x
  $pt.Y = $y
  $target = [CodexMiniSubmitWin32]::WindowFromPoint($pt)
  $className = New-Object System.Text.StringBuilder 256
  $title = New-Object System.Text.StringBuilder 256
  [void][CodexMiniSubmitWin32]::GetClassName($target, $className, 256)
  [void][CodexMiniSubmitWin32]::GetWindowText($target, $title, 256)
  $info = "class=" + $className.ToString() + ";title=" + $title.ToString()
  if ($info -match '(?i)LockScreenBackstopFrame|Windows\\.UI\\.Core\\.CoreWindow|锁屏|lock screen') {
    throw ("CODEX_DESKTOP_LOCKED: Windows lock screen or secure desktop is covering Codex at input point (" + $info + ").")
  }
}
function Dismiss-CodexMiniBottomObstructions([IntPtr]$handle) {
  try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $window) { return }
    $windowBounds = $window.Current.BoundingRectangle
    $bottomCutoff = $windowBounds.Bottom - 240
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $all.Count; $i++) {
      $item = $all.Item($i)
      if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
      if (-not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
      $name = [string]$item.Current.Name
      if ($name -notmatch '(?i)关闭|close|dismiss') { continue }
      $rect = $item.Current.BoundingRectangle
      if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      if ($rect.Y -lt $bottomCutoff) { continue }
      try {
        $pattern = $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $pattern.Invoke()
      } catch {
        Click-CodexMiniPoint ([int]($rect.X + ($rect.Width / 2))) ([int]($rect.Y + ($rect.Height / 2)))
      }
      Start-Sleep -Milliseconds 180
      return
    }
  } catch {
  }
}
function New-CodexMiniPoint([int]$x, [int]$y) {
  return [pscustomobject]@{ X = $x; Y = $y }
}
function Get-CodexMiniComposerPoint([IntPtr]$handle) {
  $fallbackRect = New-Object CodexMiniSubmitWin32+RECT
  if (-not [CodexMiniSubmitWin32]::GetWindowRect($handle, [ref]$fallbackRect)) { throw 'Could not read Codex window bounds.' }
  $fallbackWidth = [Math]::Max(1, $fallbackRect.Right - $fallbackRect.Left)
  $fallbackHeight = [Math]::Max(1, $fallbackRect.Bottom - $fallbackRect.Top)
  $fallbackX = [int]($fallbackRect.Left + ($fallbackWidth / 2))
  $fallbackBottomOffset = [Math]::Max(72, [Math]::Min(150, [int]($fallbackHeight * 0.11)))
  $fallbackY = [int]($fallbackRect.Bottom - $fallbackBottomOffset)
  try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $window) { return New-CodexMiniPoint $fallbackX $fallbackY }
    $bounds = $window.Current.BoundingRectangle
    $sidebarCutoff = $bounds.Left + [Math]::Min(340, [Math]::Max(280, [int]($bounds.Width * 0.2)))
    $topCutoff = $bounds.Top + 180
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $namedCandidates = @()
    $groupCandidates = @()
    for ($i = 0; $i -lt $all.Count; $i++) {
      $item = $all.Item($i)
      if ($item.Current.IsOffscreen) { continue }
      $rect = $item.Current.BoundingRectangle
      if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      if ($rect.X -lt $sidebarCutoff -or $rect.Y -lt $topCutoff) { continue }
      $name = [string]$item.Current.Name
      $typeName = $item.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if ($name -match '(?i)(?:\\u968f\\u5fc3\\u8f93\\u5165|\\u8f93\\u5165|\\u6d88\\u606f|ask|message|prompt)') {
        $namedCandidates += [pscustomobject]@{
          X = [int]($rect.X + [Math]::Min(80, [Math]::Max(24, $rect.Width / 2)))
          Y = [int]($rect.Y + ($rect.Height / 2))
          Score = [double]$rect.Y
          Element = $item
          CanInvoke = (($item.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',') -match 'InvokePattern'
        }
      } elseif ($typeName -eq 'Group' -and $rect.Width -ge 360 -and $rect.Height -ge 32 -and $rect.Height -le 140) {
        $groupCandidates += [pscustomobject]@{
          X = [int]($rect.X + [Math]::Min(90, [Math]::Max(32, $rect.Width * 0.16)))
          Y = [int]($rect.Y + [Math]::Min(28, [Math]::Max(18, $rect.Height / 2)))
          Score = [double]$rect.Y
          Element = $item
          CanInvoke = (($item.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',') -match 'InvokePattern'
        }
      }
    }
    if ($groupCandidates.Count) {
      $best = $groupCandidates | Sort-Object @{ Expression = 'CanInvoke'; Descending = $true }, @{ Expression = 'Score'; Descending = $true } | Select-Object -First 1
      if ($best.CanInvoke) {
        try {
          $pattern = $best.Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          Start-Sleep -Milliseconds 160
        } catch {
        }
      }
      return New-CodexMiniPoint $best.X $best.Y
    }
    if ($namedCandidates.Count) {
      $best = $namedCandidates | Sort-Object @{ Expression = 'CanInvoke'; Descending = $true }, @{ Expression = 'Score'; Descending = $true } | Select-Object -First 1
      if ($best.CanInvoke) {
        try {
          $pattern = $best.Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $pattern.Invoke()
          Start-Sleep -Milliseconds 160
        } catch {
        }
      }
      return New-CodexMiniPoint $best.X $best.Y
    }
  } catch {
  }
  return New-CodexMiniPoint $fallbackX $fallbackY
}
function Test-CodexMiniComposerReady([IntPtr]$handle) {
  try {
    $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
    if (-not $window) { return $false }
    $bounds = $window.Current.BoundingRectangle
    $sidebarCutoff = $bounds.Left + [Math]::Min(340, [Math]::Max(280, [int]($bounds.Width * 0.2)))
    $topCutoff = $bounds.Top + 180
    $bottomReadyCutoff = $bounds.Bottom - [Math]::Max(260, [int]($bounds.Height * 0.35))
    $all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    for ($i = 0; $i -lt $all.Count; $i++) {
      $item = $all.Item($i)
      if ($item.Current.IsOffscreen) { continue }
      $rect = $item.Current.BoundingRectangle
      if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      if ($rect.X -lt $sidebarCutoff -or $rect.Y -lt $topCutoff) { continue }
      if ($rect.Y -lt $bottomReadyCutoff) { continue }
      $name = [string]$item.Current.Name
      $typeName = $item.Current.ControlType.ProgrammaticName -replace '^ControlType\.', ''
      if ($name -match '(?i)(?:\\u968f\\u5fc3\\u8f93\\u5165|\\u8f93\\u5165|\\u6d88\\u606f|ask|message|prompt)') { return $true }
      if ($typeName -eq 'Group' -and $rect.Width -ge 360 -and $rect.Height -ge 32 -and $rect.Height -le 160) { return $true }
    }
  } catch {
  }
  return $false
}
function Wait-CodexMiniComposerReady([IntPtr]$handle) {
  $deadline = (Get-Date).AddMilliseconds(${WINDOWS_CODEX_STARTUP_TIMEOUT_MS})
  do {
    if (Test-CodexMiniComposerReady $handle) { return }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'Codex composer was not ready after startup.'
}
$handle = Activate-CodexMiniWindow
Start-Sleep -Milliseconds 220
Dismiss-CodexMiniBottomObstructions $handle
Wait-CodexMiniComposerReady $handle
$point = Get-CodexMiniComposerPoint $handle
Assert-CodexMiniPointIsInteractive ([int]$point.X) ([int]$point.Y)
Click-CodexMiniPoint ([int]$point.X) ([int]$point.Y)
Start-Sleep -Milliseconds 260
$text = [System.IO.File]::ReadAllText(${powerShellSingleQuote(filePath)}, [System.Text.Encoding]::UTF8)
$clipboardSet = $false
$lastClipboardError = $null
for ($i = 0; $i -lt 10; $i++) {
  try {
    [System.Windows.Forms.Clipboard]::SetText($text, [System.Windows.Forms.TextDataFormat]::UnicodeText)
    $clipboardSet = $true
    break
  } catch {
    $lastClipboardError = $_
    Start-Sleep -Milliseconds (80 + ($i * 45))
  }
}
if (-not $clipboardSet) {
  try {
    Set-Clipboard -Value $text
    $clipboardSet = $true
  } catch {
    $clipboardSet = $false
  }
}
Start-Sleep -Milliseconds 120
$handle = Activate-CodexMiniWindow
Start-Sleep -Milliseconds 220
Dismiss-CodexMiniBottomObstructions $handle
Wait-CodexMiniComposerReady $handle
$point = Get-CodexMiniComposerPoint $handle
Assert-CodexMiniPointIsInteractive ([int]$point.X) ([int]$point.Y)
Click-CodexMiniPoint ([int]$point.X) ([int]$point.Y)
Start-Sleep -Milliseconds 260
if ($clipboardSet) {
  Send-CtrlV
} else {
  Send-UnicodeText $text
}
Start-Sleep -Milliseconds ${TEXT_PASTE_SETTLE_MS}
Send-KeyTap 0x0D
Start-Sleep -Milliseconds 160
`);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

async function windowsClickCodexSendButton() {
  await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class CodexMiniSendButtonWin32 {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, UIntPtr extra);
}
"@
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate('Codex')
Start-Sleep -Milliseconds 160
$proc = Get-Process -Name Codex -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 } |
  Sort-Object StartTime -Descending |
  Select-Object -First 1
if (-not $proc) { throw 'Codex window handle not found.' }
$window = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
if (-not $window) { throw 'Codex UI Automation window not found.' }
$windowBounds = $window.Current.BoundingRectangle
$bottomCutoff = $windowBounds.Bottom - 180
$all = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
$button = $null
for ($i = 0; $i -lt $all.Count; $i++) {
  $item = $all.Item($i)
  if ($item.Current.ControlType -ne [System.Windows.Automation.ControlType]::Button) { continue }
  if (-not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
  $name = [string]$item.Current.Name
  if ($name -notmatch '(?i)发送|send') { continue }
  $rect = $item.Current.BoundingRectangle
  if ([double]::IsInfinity($rect.X) -or [double]::IsInfinity($rect.Y) -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
  if ($rect.Y -lt $bottomCutoff) { continue }
  if (-not $button -or $rect.X -gt $button.Current.BoundingRectangle.X) { $button = $item }
}
if ($button) {
  try {
    $pattern = $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
  } catch {
    $rect = $button.Current.BoundingRectangle
    [void][CodexMiniSendButtonWin32]::SetCursorPos([int]($rect.X + ($rect.Width / 2)), [int]($rect.Y + ($rect.Height / 2)))
    [CodexMiniSendButtonWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 45
    [CodexMiniSendButtonWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
} else {
  $x = [int]($windowBounds.Right - [Math]::Max(34, [Math]::Min(72, $windowBounds.Width * 0.045)))
  $y = [int]($windowBounds.Bottom - [Math]::Max(34, [Math]::Min(78, $windowBounds.Height * 0.065)))
  [void][CodexMiniSendButtonWin32]::SetCursorPos($x, $y)
  [CodexMiniSendButtonWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 45
  [CodexMiniSendButtonWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}
Start-Sleep -Milliseconds 320
`);
}

function windowsShortcutKeys(key, modifiers = []) {
  const prefix = modifiers.map(modifier => {
    const item = String(modifier || '').toLowerCase();
    if (item === 'command' || item === 'cmd' || item === 'control' || item === 'ctrl') return '^';
    if (item === 'shift') return '+';
    if (item === 'option' || item === 'alt') return '%';
    return '';
  }).join('');
  return `${prefix}${String(key || '')}`;
}

function explainAutomationError(error) {
  const raw = String(error && (error.stderr || error.message) || '');
  if (IS_WINDOWS) {
    return {
      code: 'WINDOWS_AUTOMATION_FAILED',
      message: 'Windows 自动粘贴失败。请确认 Codex 窗口已打开，且 Codex Mini 服务和 Codex 没有一个以管理员身份运行、另一个不是管理员身份运行。',
      detail: raw,
    };
  }
  const lower = raw.toLowerCase();
  if (lower.includes('assistive') || lower.includes('accessibility') || lower.includes('-25211') || lower.includes('not allowed') || lower.includes('not authorized')) {
    return {
      code: 'ACCESSIBILITY_PERMISSION_REQUIRED',
      message: 'Mac 还没有允许这个终端控制键盘。请到 系统设置 → 隐私与安全性 → 辅助功能，允许 Terminal / Ghostty / Codex 正在使用的终端，然后重启服务再试。',
      detail: raw,
    };
  }
  return {
    code: 'MAC_AUTOMATION_FAILED',
    message: 'Mac 自动粘贴失败。请确认当前有可输入的前台应用，并检查辅助功能权限。',
    detail: raw,
  };
}

function explainTargetError(error, target) {
  const raw = String(error && (error.stderr || error.message) || '');
  if (target === 'codex') {
    if ((error && error.code === 'CODEX_DESKTOP_LOCKED') || /CODEX_DESKTOP_LOCKED|LockScreenBackstopFrame|Windows\.UI\.Core\.CoreWindow|锁屏|lock screen/i.test(raw)) {
      return {
        code: 'CODEX_DESKTOP_LOCKED',
        message: 'Windows 当前处于锁屏或安全桌面，Codex Mini 不能把文字输入到 Codex。请解锁电脑，并保持运行 start-codex-mini-relay.bat 的桌面会话处于已登录未锁屏状态后再发送。',
        detail: raw,
      };
    }
    if (IS_WINDOWS) {
      return {
        code: 'CODEX_FOCUS_FAILED',
        message: '已经收到文字，但没能自动聚焦 Codex 输入框。请确认 Codex 窗口已打开；如果 Codex 或启动 bat 是管理员权限，请让两者使用相同权限后重启再试。',
        detail: raw,
      };
    }
    return {
      code: 'CODEX_FOCUS_FAILED',
      message: '已经收到文字，但没能自动聚焦 Codex 输入框。请确认 Codex 正在运行，且当前终端已开启辅助功能权限。',
      detail: raw,
    };
  }
  return explainAutomationError(error);
}

async function copyTextToClipboard(text) {
  if (IS_WINDOWS) {
    const filePath = path.join(os.tmpdir(), `codex-mini-clipboard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
    fs.writeFileSync(filePath, String(text || ''), 'utf8');
    try {
      await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
$text = [System.IO.File]::ReadAllText(${powerShellSingleQuote(filePath)}, [System.Text.Encoding]::UTF8)
Set-Clipboard -Value $text
`);
    } finally {
      fs.rmSync(filePath, { force: true });
    }
    return;
  }
  if (!IS_MAC) throw new Error(`Clipboard automation is not supported on ${process.platform}.`);
  // pbcopy can silently write to no visible pasteboard when this service runs
  // as a LaunchAgent. AppleScript targets the logged-in user's desktop
  // pasteboard, matching the existing image clipboard path. Use a temp UTF-8
  // file instead of embedding text in the AppleScript command, so Chinese,
  // newlines, quotes and longer messages survive unchanged.
  const filePath = path.join(os.tmpdir(), `codex-mini-clipboard-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.txt`);
  fs.writeFileSync(filePath, String(text || ''), 'utf8');
  try {
    await runProcess('/usr/bin/osascript', ['-e', `set the clipboard to (read (POSIX file "${appleScriptString(filePath)}") as «class utf8»)`]);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
}

function getClickTool() {
  for (const candidate of ['/opt/homebrew/bin/cliclick', '/usr/local/bin/cliclick']) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function toCliclickAbsolutePoint(point) {
  // cliclick treats leading +/- as relative movement. Prefix negative absolute
  // coordinates with '=' for multi-display layouts above/left of the main screen.
  return point.split(',').map(part => part.startsWith('-') ? `=${part}` : part).join(',');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function hasFreshCodexThreadActivation(threadId) {
  return Boolean(
    isCodexThreadId(threadId) &&
    lastCodexThreadActivation.threadId === threadId &&
    Date.now() - lastCodexThreadActivation.at <= CODEX_THREAD_SYNC_FRESH_MS
  );
}

async function focusTarget(target, threadId = '', options = {}) {
  if (target !== 'codex') return;

  if (IS_WINDOWS) {
    await activateCodexThread(threadId, { allowCached: Boolean(options.assumeThreadSynced) });
    if (!options.skipComposerClick) await windowsClickCodexComposer();
    return;
  }
  if (!IS_MAC) throw new Error(`Codex focus automation is not supported on ${process.platform}.`);

  await activateCodexThread(threadId, { allowCached: Boolean(options.assumeThreadSynced) });
  if (options.skipComposerClick) return;

  const pointTool = path.join(__dirname, 'bin', 'codex-window-point');
  if (!fs.existsSync(pointTool)) throw new Error(`Codex window point helper not found: ${pointTool}`);
  const { stdout } = await runProcess(pointTool, []);
  const point = stdout.trim();
  if (!/^-?\d+,-?\d+$/.test(point)) throw new Error(`Invalid Codex click point: ${point}`);

  const clickTool = getClickTool();
  if (clickTool) {
    await runProcess(clickTool, [`c:${toCliclickAbsolutePoint(point)}`]);
  } else {
    const fallbackClick = `tell application "System Events" to click at {${point}}`;
    await runProcess('osascript', ['-e', fallbackClick]);
  }
  await delay(CODEX_CLICK_SETTLE_MS);
}

async function activateCodexThread(threadId = '', options = {}) {
  if (IS_WINDOWS) {
    if (options.allowCached && hasFreshCodexThreadActivation(threadId)) {
      await windowsActivateCodexWindow();
      return;
    }
    const deepLink = codexThreadDeepLink(threadId);
    if (deepLink) {
      await runWindowsPowerShell(`Start-Process ${powerShellSingleQuote(deepLink)}`);
      await delay(CODEX_DEEPLINK_SETTLE_MS);
    } else {
      await runWindowsPowerShell(`Start-Process ${powerShellSingleQuote(`shell:AppsFolder\\${WINDOWS_CODEX_APP_ID}`)}`);
      await delay(CODEX_APP_FOCUS_SETTLE_MS + 450);
    }
    await windowsActivateCodexWindow();
    if (isCodexThreadId(threadId)) lastCodexThreadActivation = { threadId, at: Date.now() };
    return;
  }
  if (!IS_MAC) throw new Error(`Codex activation is not supported on ${process.platform}.`);

  if (options.allowCached && hasFreshCodexThreadActivation(threadId)) {
    await runProcess('open', ['-b', 'com.openai.codex']);
    await delay(CODEX_APP_FOCUS_SETTLE_MS);
    return;
  }

  const deepLink = codexThreadDeepLink(threadId);
  if (deepLink) {
    await runProcess('open', [deepLink]);
    // Give the Electron router time to replace the visible conversation before
    // we click the composer or paste.
    await delay(CODEX_DEEPLINK_SETTLE_MS);
  }
  await runProcess('open', ['-b', 'com.openai.codex']);
  await delay(CODEX_APP_FOCUS_SETTLE_MS);
  if (isCodexThreadId(threadId)) lastCodexThreadActivation = { threadId, at: Date.now() };
}

async function activateNewCodexThread(cwd = '') {
  const deepLink = codexNewThreadDeepLink(cwd);
  if (IS_WINDOWS) {
    await runWindowsPowerShell(`Start-Process ${powerShellSingleQuote(deepLink)}`);
    await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
    await windowsActivateCodexWindow();
    lastCodexThreadActivation = { threadId: '', at: 0 };
    return;
  }
  if (!IS_MAC) throw new Error(`Codex activation is not supported on ${process.platform}.`);
  await runProcess('open', [deepLink]);
  await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
  await runProcess('open', ['-b', 'com.openai.codex']);
  await delay(CODEX_APP_FOCUS_SETTLE_MS);
  lastCodexThreadActivation = { threadId: '', at: 0 };
}

async function activateNewProjectlessCodexThread(anchorThreadId = '') {
  // `codex://threads/new` without a path can inherit Codex Desktop's last
  // active project. To create a real “Chats/对话” thread, first navigate to an
  // existing projectless thread and then invoke Codex's own New Chat command;
  // Codex checks the current thread's project kind and starts with
  // `activeProject: null` for projectless chats.
  if (isCodexThreadId(anchorThreadId)) {
    await activateCodexThread(anchorThreadId);
    await pressCodexShortcut('n', ['command']);
    await delay(CODEX_DEEPLINK_SETTLE_MS + 180);
  } else {
    await activateNewCodexThread('');
  }
  if (IS_WINDOWS) {
    await windowsActivateCodexWindow();
    lastCodexThreadActivation = { threadId: '', at: 0 };
    return;
  }
  await runProcess('open', ['-b', 'com.openai.codex']);
  await delay(CODEX_APP_FOCUS_SETTLE_MS);
  lastCodexThreadActivation = { threadId: '', at: 0 };
}

function validLocalDirectory(value) {
  const normalized = value ? path.normalize(value) : '';
  if (!normalized || !path.isAbsolute(normalized)) return '';
  try {
    return fs.statSync(normalized).isDirectory() ? normalized : '';
  } catch {
    return '';
  }
}

function normalizeNewThreadScope(payload = {}) {
  const raw = typeof payload.scope === 'string' ? payload.scope.trim().toLowerCase() : '';
  if (raw === 'conversation' || raw === 'project') return raw;
  if (payload.isProjectThread === false) return 'conversation';
  if (payload.isProjectThread === true) return 'project';
  return '';
}

function projectCwdOrEmpty(value) {
  const cwd = validLocalDirectory(value);
  if (!cwd) return '';
  return classifyThreadProject(cwd).isProjectThread ? cwd : '';
}

function resolveNewThreadTarget(payload = {}) {
  const scope = normalizeNewThreadScope(payload);
  const projectPath = projectCwdOrEmpty(typeof payload.projectPath === 'string' ? payload.projectPath : '');
  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';

  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }

  if (scope === 'conversation') {
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (scope === 'project' && projectPath) {
    return { scope: 'project', cwd: projectPath, anchorThreadId: threadId };
  }

  if (threadId) {
    const file = findCodexSessionFileByThreadId(threadId);
    const metaCwd = file ? readSessionMeta(file).cwd || '' : '';
    const metaProject = classifyThreadProject(validLocalDirectory(metaCwd) || '');
    if (metaProject.isProjectThread) {
      return { scope: 'project', cwd: metaProject.projectPath, anchorThreadId: threadId };
    }
    return { scope: 'conversation', cwd: '', anchorThreadId: threadId };
  }

  if (projectPath) return { scope: 'project', cwd: projectPath, anchorThreadId: '' };
  return { scope: 'conversation', cwd: '', anchorThreadId: '' };
}

async function handleNewCodexThread(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const target = resolveNewThreadTarget(payload);
    const project = classifyThreadProject(target.cwd);
    if (project.isProjectThread) {
      await activateNewCodexThread(target.cwd);
    } else {
      await activateNewProjectlessCodexThread(target.anchorThreadId);
    }
    return json(res, 200, {
      ok: true,
      pending: true,
      cwd: project.isProjectThread ? target.cwd : '',
      projectName: project.projectName,
      projectPath: project.projectPath,
      projectKey: project.projectKey,
      scope: project.isProjectThread ? 'project' : 'conversation',
      message: project.isProjectThread
        ? `已在 Codex 打开“${project.projectName}”的新线程。`
        : '已在 Codex 打开一个新的对话线程。',
    });
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '新建线程失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

function sanitizeFileName(name, fallback = 'image') {
  const base = path.basename(String(name || fallback)).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
  return base || fallback;
}

function extensionForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/heic') return '.heic';
  return '.img';
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024) return `${Math.round(value / 1024 / 1024)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function decodeAttachment(attachment, index) {
  const mime = String(attachment && attachment.type || '').toLowerCase();
  if (!mime.startsWith('image/')) throw new Error('目前只支持图片附件。');
  const dataUrl = String(attachment.dataUrl || '');
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error('图片数据格式不正确。');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > MAX_ATTACHMENT_BYTES) throw new Error(`单张图片太大，请控制在 ${formatBytes(MAX_ATTACHMENT_BYTES)} 以内。`);
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const ext = path.extname(attachment.name || '') || extensionForMime(mime);
  const fileName = `${Date.now()}-${index}-${sanitizeFileName(attachment.name || `image${ext}`)}`;
  const filePath = path.join(UPLOAD_DIR, fileName.endsWith(ext) ? fileName : `${fileName}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return { filePath, mime, name: attachment.name || path.basename(filePath), size: buffer.length };
}

function decodeAttachments(input) {
  if (!Array.isArray(input)) return [];
  if (input.length > MAX_ATTACHMENTS) throw new Error(`图片最多一次发送 ${MAX_ATTACHMENTS} 张。`);
  return input.map(decodeAttachment);
}

function appleScriptString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function copyImageToClipboard(file) {
  if (IS_WINDOWS) {
    await runWindowsPowerShell(`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$files = New-Object System.Collections.Specialized.StringCollection
[void]$files.Add(${powerShellSingleQuote(file.filePath)})
[System.Windows.Forms.Clipboard]::SetFileDropList($files)
`);
    return;
  }
  if (!IS_MAC) throw new Error(`Image clipboard automation is not supported on ${process.platform}.`);
  const quoted = appleScriptString(file.filePath);
  let typeExpr = '«class PNGf»';
  if (file.mime === 'image/jpeg') typeExpr = 'JPEG picture';
  else if (file.mime === 'image/gif') typeExpr = 'GIF picture';
  else if (file.mime !== 'image/png') {
    // For less common formats, paste the file reference; many Electron inputs accept it as an attachment.
    await runProcess('osascript', ['-e', `set the clipboard to (POSIX file "${quoted}")`]);
    return;
  }
  await runProcess('osascript', ['-e', `set the clipboard to (read (POSIX file "${quoted}") as ${typeExpr})`]);
}

async function pressPaste() {
  if (IS_WINDOWS) {
    await windowsSendKeys('^v');
    return;
  }
  if (!IS_MAC) throw new Error(`Paste automation is not supported on ${process.platform}.`);
  const script = `
    tell application "System Events"
      keystroke "v" using command down
    end tell
  `;
  await runProcess('osascript', ['-e', script]);
}

async function pressPasteAndEnter() {
  // Keep paste and return as separate automation events. Electron/Codex can
  // accept the pasted text asynchronously; if Return is posted too quickly
  // (especially after iOS dictation commits), the text appears in the composer
  // but the submit key can be swallowed. A short explicit settle plus a fresh
  // System Events command makes the submit step reliable without changing the
  // rest of the send flow.
  await pressPaste();
  await delay(TEXT_PASTE_SETTLE_MS);
  await pressEnter();
}

async function pressEnter() {
  if (IS_WINDOWS) {
    await windowsSendKeys('{ENTER}');
    return;
  }
  if (!IS_MAC) throw new Error(`Keyboard automation is not supported on ${process.platform}.`);
  await runProcess('osascript', ['-e', 'tell application "System Events" to key code 36']);
}

async function pressCodexShortcut(key, modifiers = []) {
  if (IS_WINDOWS) {
    await windowsActivateCodexWindow();
    await windowsSendKeys(windowsShortcutKeys(key, modifiers));
    return;
  }
  if (!IS_MAC) throw new Error(`Keyboard automation is not supported on ${process.platform}.`);
  const modifierExpr = modifiers.length ? ` using {${modifiers.map(item => `${item} down`).join(', ')}}` : '';
  const script = `
    tell application "System Events"
      keystroke "${appleScriptString(key)}"${modifierExpr}
    end tell
  `;
  await runProcess('osascript', ['-e', script]);
}

async function pressCancelCodexResponse() {
  if (IS_WINDOWS) {
    await windowsActivateCodexWindow();
    await windowsSendKeys('{ESC}');
    await delay(80);
    await windowsSendKeys('^.');
    return;
  }
  if (!IS_MAC) throw new Error(`Keyboard automation is not supported on ${process.platform}.`);
  const script = `
    tell application "System Events"
      key code 53
      delay 0.08
      keystroke "." using command down
    end tell
  `;
  await runProcess('osascript', ['-e', script]);
}


async function pasteAndEnter(text, target = 'frontmost', attachments = [], threadId = '', options = {}) {
  if (IS_WINDOWS && target === 'codex' && text && !attachments.length) {
    await windowsPasteTextAndEnter(text, threadId, options);
    return;
  }

  await focusTarget(target, threadId, options);

  for (const attachment of attachments) {
    await copyImageToClipboard(attachment);
    if (IS_WINDOWS && target === 'codex') await focusTarget(target, threadId, options);
    await pressPaste();
    await delay(ATTACHMENT_PASTE_SETTLE_MS);
  }

  if (text) {
    if (IS_WINDOWS && target === 'codex') {
      await windowsPasteTextAndEnter(text, threadId, { ...options, assumeThreadSynced: true });
      return;
    }
    await copyTextToClipboard(text);
    if (IS_WINDOWS && target === 'codex') await focusTarget(target, threadId, options);
    await pressPasteAndEnter();
    return;
  }

  await pressEnter();
}

async function pasteAndEnterWithCodexStartupRetry(text, target, attachments, threadId, options = {}, clientRequestId = '') {
  try {
    await pasteAndEnter(text, target, attachments, threadId, options);
    return;
  } catch (error) {
    if (!(target === 'codex' && IS_WINDOWS && text && !attachments.length && isWindowsCodexStartupFocusError(error))) {
      throw error;
    }
    setSendProgress(clientRequestId, 'waitingCodex', 'Codex 已启动，继续等待窗口和输入框加载');
    await delay(1200);
    await windowsActivateCodexWindow({ startIfNeeded: true });
    setSendProgress(clientRequestId, 'waitingComposer');
    await delay(800);
    setSendProgress(clientRequestId, 'retryingFocus');
    await pasteAndEnter(text, target, attachments, threadId, {
      ...options,
      assumeThreadSynced: false,
      skipComposerClick: false,
    });
  }
}

function modelSwitchTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  const catalogTarget = findModelOption(explicit);
  if (catalogTarget) return catalogTarget;
  if (!explicit) {
    const options = readModelCatalogOptions();
    if (options.length) return options[0];
  }
  const error = new Error(explicit ? '未找到这个模型。' : '没有读取到可切换的模型。');
  error.status = 400;
  error.code = 'MODEL_TARGET_NOT_FOUND';
  throw error;
}

async function switchCodexGuiModel(threadId = '', targetKey = '') {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const current = file ? currentModelFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : modelInfoFromId('');
  const target = modelSwitchTargetForCurrent(current, targetKey);

  await focusTarget('codex', threadId);
  await copyTextToClipboard('/模型');
  await pressPasteAndEnter();
  await delay(CODEX_MODEL_COMMAND_SETTLE_MS);
  await copyTextToClipboard(target.displayName);
  await pressPasteAndEnter();
  await delay(CODEX_COMMAND_SETTLE_MS);

  return {
    ok: true,
    threadId,
    currentModel: current,
    targetModel: { ...target, available: true, updatedAt: new Date().toISOString() },
    message: `已切换到 ${target.displayName}`,
  };
}

function reasoningModeTargetForCurrent(current = {}, requestedTarget = '') {
  const explicit = String(requestedTarget || '').trim();
  if (REASONING_MODE_TARGETS[explicit]) return REASONING_MODE_TARGETS[explicit];
  const order = ['low', 'medium', 'high', 'xhigh'];
  const currentIndex = order.indexOf(current.key);
  const nextKey = order[(currentIndex + 1 + order.length) % order.length] || 'medium';
  return REASONING_MODE_TARGETS[nextKey] || REASONING_MODE_TARGETS.medium;
}

async function switchCodexReasoningMode(threadId = '', targetKey = '') {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  const file = threadId ? findCodexSessionFileByThreadId(threadId) : findLatestCodexSessionFile();
  const current = file ? currentReasoningModeFromItems(readJsonlTailObjects(file, CODEX_SESSION_TAIL_BYTES)) : reasoningModeFromValue('');
  const target = reasoningModeTargetForCurrent(current, targetKey);

  await focusTarget('codex', threadId);
  await copyTextToClipboard('/推理模式');
  await pressPasteAndEnter();
  await delay(CODEX_REASONING_COMMAND_SETTLE_MS);
  await copyTextToClipboard(target.displayName);
  await pressPasteAndEnter();
  await delay(CODEX_COMMAND_SETTLE_MS);

  return {
    ok: true,
    threadId,
    currentReasoningMode: current,
    targetReasoningMode: { ...target, available: true, updatedAt: new Date().toISOString() },
    message: `已切换推理模式为 ${target.displayName}`,
  };
}

async function stopCodexResponse(threadId = '') {
  await focusTarget('codex', threadId);
  await pressCancelCodexResponse();
}

async function runCodexThreadCommand(threadId, command, options = {}) {
  if (threadId && !isCodexThreadId(threadId)) {
    const error = new Error('线程 ID 不正确。');
    error.status = 400;
    error.code = 'BAD_THREAD_ID';
    throw error;
  }
  await activateCodexThread(threadId);

  if (command === 'archive') {
    await pressCodexShortcut('a', ['command', 'shift']);
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { message: '已归档当前 Codex 线程。' };
  }

  if (command === 'pin') {
    await pressCodexShortcut('p', ['command', 'option']);
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { message: options.pinned ? '已置顶当前 Codex 线程。' : '已取消置顶当前 Codex 线程。' };
  }

  if (command === 'rename') {
    const name = String(options.name || '').replace(/\s+/g, ' ').trim();
    if (!name) {
      const error = new Error('新名称不能为空。');
      error.status = 400;
      error.code = 'EMPTY_THREAD_NAME';
      throw error;
    }
    if (name.length > 120) {
      const error = new Error('新名称太长，请控制在 120 个字符以内。');
      error.status = 400;
      error.code = 'THREAD_NAME_TOO_LONG';
      throw error;
    }
    await pressCodexShortcut('r', ['command', 'option']);
    await delay(CODEX_COMMAND_SETTLE_MS);
    await copyTextToClipboard(name);
    await pressPaste();
    await delay(80);
    await pressEnter();
    await delay(CODEX_COMMAND_SETTLE_MS);
    return { message: '已重命名当前 Codex 线程。', name };
  }

  const error = new Error('不支持的线程操作。');
  error.status = 400;
  error.code = 'BAD_THREAD_ACTION';
  throw error;
}

async function handleThreadAction(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const action = String(payload.action || '').trim();
  if (!isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
  }

  try {
    const state = readCodexMiniState();
    let result;
    if (action === 'archive') {
      result = await runCodexThreadCommand(threadId, 'archive');
      state.archivedThreadIds = setThreadSetMembership(state.archivedThreadIds, threadId, true);
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, false);
    } else if (action === 'pin' || action === 'unpin') {
      const pinned = action === 'pin';
      result = await runCodexThreadCommand(threadId, 'pin', { pinned });
      state.pinnedThreadIds = setThreadSetMembership(state.pinnedThreadIds, threadId, pinned);
    } else if (action === 'rename') {
      result = await runCodexThreadCommand(threadId, 'rename', { name: payload.name });
      state.titleOverrides = state.titleOverrides || {};
      state.titleOverrides[threadId] = { name: result.name, renamedAt: new Date().toISOString() };
    } else {
      return json(res, 400, { ok: false, code: 'BAD_THREAD_ACTION', message: '不支持的线程操作。' });
    }
    writeCodexMiniState(state);
    const nextThreadId = action === 'archive' ? (listCodexThreads(120)[0]?.id || '') : threadId;
    return json(res, 200, { ok: true, action, threadId, nextThreadId, ...result });
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '线程操作失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleStopCodex(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  if (threadId && !isCodexThreadId(threadId)) {
    return json(res, 400, { ok: false, code: 'BAD_THREAD_ID', message: '线程 ID 不正确。' });
  }

  try {
    await stopCodexResponse(threadId);
    return json(res, 200, { ok: true, threadId, message: '已向 Codex 发送终止指令。' });
  } catch (error) {
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained });
  }
}

async function handleModelSwitch(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  try {
    const result = await switchCodexGuiModel(threadId, target);
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换模型失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换模型。请确认 Codex 正在运行，且辅助功能权限正常。' });
  }
}

async function handleReasoningMode(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const target = typeof payload.target === 'string' ? payload.target : '';
  try {
    const result = await switchCodexReasoningMode(threadId, target);
    return json(res, 200, result);
  } catch (error) {
    if (error && error.status) {
      return json(res, error.status, { ok: false, code: error.code || 'BAD_REQUEST', message: error.message || '切换推理模式失败。' });
    }
    const explained = explainTargetError(error, 'codex');
    return json(res, 500, { ok: false, ...explained, message: '没能通过 Codex GUI 切换推理模式。请确认 Codex 正在运行，且辅助功能权限正常。' });
  }
}

async function handleSend(req, res) {
  if (!isAuthorized(req)) {
    return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。请使用启动服务时打印出来的完整手机链接。' });
  }

  let payload;
  try {
    const body = await readBody(req);
    payload = JSON.parse(body || '{}');
  } catch (error) {
    return json(res, error.status || 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  const text = typeof payload.text === 'string' ? payload.text : '';
  const target = payload.target === 'codex' ? 'codex' : 'frontmost';
  const selectedThreadId = typeof payload.threadId === 'string' ? payload.threadId : '';
  const assumeThreadSynced = payload.assumeThreadSynced === true;
  const expectNewThread = payload.expectNewThread === true && target === 'codex' && !selectedThreadId;
  const directPasteWithoutClick = payload.directPasteWithoutClick === true && expectNewThread;
  const previousThreadId = isCodexThreadId(payload.previousThreadId) ? payload.previousThreadId : '';
  const expectedNewThreadCwd = validLocalDirectory(typeof payload.expectedCwd === 'string' ? payload.expectedCwd : '');
  const clientRequestId = normalizeClientRequestId(payload.clientRequestId);
  cleanupRecentSendRequests();
  if (clientRequestId) {
    const existing = recentSendRequests.get(clientRequestId);
    if (existing?.result) return json(res, 200, { ...existing.result, duplicate: true, progress: existing.progress || null });
    if (existing?.watch) {
      setSendProgress(clientRequestId, 'queued');
      return json(res, 200, {
        ok: true,
        duplicate: true,
        message: '这条发送请求已经被接收，正在继续等待 Codex 回复。',
        target,
        sentAt: existing.sentAt,
        watch: existing.watch,
        progress: existing.progress || null,
      });
    }
  }
  let attachments = [];
  try {
    attachments = decodeAttachments(payload.attachments);
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_ATTACHMENT', message: error.message || '图片附件不正确。' });
  }
  if (!text.trim() && !attachments.length) {
    return json(res, 400, { ok: false, code: 'EMPTY_TEXT', message: '请输入文字或添加图片。' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return json(res, 413, { ok: false, code: 'TEXT_TOO_LONG', message: `文字太长了，请控制在 ${MAX_TEXT_LENGTH} 字以内。` });
  }

  setSendProgress(clientRequestId, 'accepted');

  try {
    const watchSince = new Date(Date.now() - 750).toISOString();
    const watchSinceMs = Date.parse(watchSince) || Date.now();
    const watchFile = expectNewThread ? null : selectedThreadId ? findCodexSessionFileByThreadId(selectedThreadId) : findLatestCodexSessionFile();
    let watch = target === 'codex' ? {
      since: watchSince,
      threadId: selectedThreadId,
      sessionFile: watchFile ? path.basename(watchFile) : '',
      expectNewThread,
      excludeThreadId: expectNewThread ? previousThreadId : '',
      cwd: expectNewThread ? expectedNewThreadCwd : '',
    } : null;
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: new Date().toISOString(),
        watch,
        progress: recentSendRequests.get(clientRequestId)?.progress || setSendProgress(clientRequestId, 'accepted'),
      });
    }
    if (target === 'codex') {
      if (IS_WINDOWS) {
        setSendProgress(clientRequestId, 'checkingCodex');
        const codexRunning = await isCodexDesktopRunning().catch(() => true);
        if (codexRunning) {
          setSendProgress(clientRequestId, 'activatingCodex');
          setSendProgress(clientRequestId, 'waitingComposer');
        } else {
          setSendProgress(clientRequestId, 'startingCodex');
          setSendProgress(clientRequestId, 'waitingCodex');
        }
      } else {
        setSendProgress(clientRequestId, 'activatingCodex');
      }
    }
    await pasteAndEnterWithCodexStartupRetry(text, target, attachments, selectedThreadId, { assumeThreadSynced, skipComposerClick: directPasteWithoutClick }, clientRequestId);
    setSendProgress(clientRequestId, 'confirming');
    let confirmedSendFile = null;
    if (expectNewThread && watch) {
      const newSessionFile = await waitForCodexSessionFileForNewSend({
        sinceMs: watchSinceMs,
        text,
        cwd: expectedNewThreadCwd,
        excludeThreadId: previousThreadId,
      }, CODEX_SEND_CONFIRM_TIMEOUT_MS);
      if (newSessionFile) {
        confirmedSendFile = newSessionFile;
        watch = {
          ...watch,
          threadId: threadIdFromSessionFile(newSessionFile),
          sessionFile: path.basename(newSessionFile),
          expectNewThread: false,
          excludeThreadId: '',
        };
      }
    } else if (target === 'codex' && text.trim() && watchFile) {
      confirmedSendFile = await waitForCodexUserMessageInFile(watchFile, { sinceMs: watchSinceMs, text }, CODEX_SEND_CONFIRM_TIMEOUT_MS);
    }
    if (target === 'codex' && text.trim() && !confirmedSendFile && IS_WINDOWS) {
      const dismissedObstruction = await windowsDismissCodexBottomObstructions().catch(() => false);
      if (dismissedObstruction) {
        setSendProgress(clientRequestId, 'retryingFocus');
        await windowsPasteTextAndEnter(text, selectedThreadId, { assumeThreadSynced: true });
        setSendProgress(clientRequestId, 'confirming');
        if (expectNewThread && watch) {
          const newSessionFile = await waitForCodexSessionFileForNewSend({
            sinceMs: watchSinceMs,
            text,
            cwd: expectedNewThreadCwd,
            excludeThreadId: previousThreadId,
          }, CODEX_SEND_CONFIRM_TIMEOUT_MS);
          if (newSessionFile) {
            confirmedSendFile = newSessionFile;
            watch = {
              ...watch,
              threadId: threadIdFromSessionFile(newSessionFile),
              sessionFile: path.basename(newSessionFile),
              expectNewThread: false,
              excludeThreadId: '',
            };
          }
        } else if (watchFile) {
          confirmedSendFile = await waitForCodexUserMessageInFile(watchFile, { sinceMs: watchSinceMs, text }, CODEX_SEND_CONFIRM_TIMEOUT_MS);
        }
      }
    }
    if (target === 'codex' && text.trim() && !confirmedSendFile && IS_WINDOWS) {
      try {
        setSendProgress(clientRequestId, 'retryingSend');
        await windowsClickCodexSendButton();
      } catch {
        // If UI Automation cannot see an enabled send button, keep the clearer
        // confirmation failure below instead of masking it with a click error.
      }
      if (expectNewThread && watch) {
        const newSessionFile = await waitForCodexSessionFileForNewSend({
          sinceMs: watchSinceMs,
          text,
          cwd: expectedNewThreadCwd,
          excludeThreadId: previousThreadId,
        }, CODEX_SEND_CONFIRM_TIMEOUT_MS);
        if (newSessionFile) {
          confirmedSendFile = newSessionFile;
          watch = {
            ...watch,
            threadId: threadIdFromSessionFile(newSessionFile),
            sessionFile: path.basename(newSessionFile),
            expectNewThread: false,
            excludeThreadId: '',
          };
        }
      } else if (watchFile) {
        confirmedSendFile = await waitForCodexUserMessageInFile(watchFile, { sinceMs: watchSinceMs, text }, CODEX_SEND_CONFIRM_TIMEOUT_MS);
      }
    }
    if (target === 'codex' && text.trim() && !confirmedSendFile) {
      const error = new Error('Codex did not record the sent message. The text may have been pasted into the composer without being submitted.');
      error.code = 'CODEX_SEND_NOT_CONFIRMED';
      error.status = 502;
      throw error;
    }
    const result = {
      ok: true,
      message: target === 'codex' ? '已切到 Codex，粘贴并按下回车。' : '已粘贴并按下回车。',
      target,
      sentAt: new Date().toISOString(),
      attachments: attachments.map(item => ({ name: item.name, size: item.size, type: item.mime })),
      watch,
    };
    setSendProgress(clientRequestId, 'sent');
    if (clientRequestId) {
      recentSendRequests.set(clientRequestId, {
        createdAt: Date.now(),
        sentAt: result.sentAt,
        watch,
        progress: recentSendRequests.get(clientRequestId)?.progress || null,
        result,
      });
    }
    return json(res, 200, result);
  } catch (error) {
    const failureProgress = setSendProgress(clientRequestId, 'failed', error && error.message || '');
    if (clientRequestId) {
      const existing = recentSendRequests.get(clientRequestId) || { createdAt: Date.now() };
      recentSendRequests.set(clientRequestId, {
        ...existing,
        createdAt: existing.createdAt || Date.now(),
        sentAt: existing.sentAt || new Date().toISOString(),
        progress: failureProgress || existing.progress || null,
        failed: true,
        error: {
          message: error && error.message || '',
          detail: automationErrorText(error),
          code: error && error.code || '',
        },
      });
    }
    if (error && error.code === 'CODEX_SEND_NOT_CONFIRMED') {
      return json(res, error.status || 502, {
        ok: false,
        code: error.code,
        message: '已经把文字交给 Windows 自动化，但 Codex 没有记录这条消息。请确认 Codex 输入框里没有残留文字；如果有，手动按一次 Enter 后再试。',
        detail: error.message,
      });
    }
    const explained = explainTargetError(error, target);
    const status = explained.code === 'CODEX_DESKTOP_LOCKED' ? 409 : error.status || 500;
    return json(res, status, { ok: false, ...explained });
  }
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = decodeURIComponent(url.pathname);
  pathname = stripStaticBasePath(pathname);
  if (pathname === '/') pathname = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  const relative = path.relative(PUBLIC_DIR, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    const headers = {
      'content-type': mimeTypes[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      'content-length': data.length,
    };
    if (ext === '.html' && url.searchParams.get('token') === TOKEN) {
      headers['set-cookie'] = `codexMiniToken=${encodeURIComponent(TOKEN)}; Path=/; SameSite=Lax; Max-Age=31536000`;
    }
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

function automationErrorText(error) {
  return String(error && (error.stderr || error.message) || '');
}

function isWindowsCodexStartupFocusError(error) {
  if (!IS_WINDOWS) return false;
  const raw = automationErrorText(error);
  return /Codex window handle not found|Codex window could not be activated|Codex composer was not ready after startup|Could not read Codex window bounds|CODEX_FOCUS_FAILED/i.test(raw);
}

function stripStaticBasePath(pathname) {
  for (const prefix of ['/codex', '/codex-mini', '/mini']) {
    if (pathname === prefix) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || '/';
  }
  const relayMatch = pathname.match(/^\/r\/[^/]+(\/.*)?$/);
  if (relayMatch) return relayMatch[1] || '/';
  return pathname;
}

function getLanApiBases() {
  const nets = os.networkInterfaces();
  const bases = new Set();
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) bases.add(`http://${net.address}:${PORT}`);
    }
  }
  return [...bases];
}

function handleClientConfig(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  const relayApiBases = RELAY_PUBLIC_BASE ? [RELAY_PUBLIC_BASE] : [];
  return json(res, 200, {
    ok: true,
    service: 'codex-mini',
    appName: APP_NAME,
    localOnly: relayApiBases.length === 0,
    localApiBases: getLanApiBases(),
    relayApiBases,
    modelOptions: readModelCatalogOptions(),
  });
}

function handleHealth(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  return json(res, 200, {
    ok: true,
    service: 'codex-mini',
    host: os.hostname(),
    now: new Date().toISOString(),
  });
}

async function handleKeepAwake(req, res) {
  if (!isAuthorized(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED', message: '访问令牌不正确。' });
  if (req.method === 'GET') {
    return json(res, 200, { ok: true, ...keepAwakeStatus() });
  }

  let payload = {};
  try {
    payload = JSON.parse(await readBody(req) || '{}');
  } catch (error) {
    return json(res, 400, { ok: false, code: 'BAD_REQUEST', message: error.message || '请求格式不正确。' });
  }

  try {
    const enabled = payload.enabled === true;
    const status = enabled ? startKeepAwake() : stopKeepAwake();
    return json(res, 200, {
      ok: true,
      ...status,
      message: status.enabled ? '已开启保持亮屏，Mac 不会自动休眠' : '已关闭保持亮屏',
    });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      code: error.code || 'KEEP_AWAKE_FAILED',
      message: error.message || '切换保持亮屏失败。',
    });
  }
}

function getLanUrls() {
  const nets = os.networkInterfaces();
  const urls = new Set([`http://localhost:${PORT}/?token=${TOKEN}`]);
  for (const entries of Object.values(nets)) {
    for (const net of entries || []) {
      if (net.family === 'IPv4' && !net.internal) {
        urls.add(`http://${net.address}:${PORT}/?token=${TOKEN}`);
      }
    }
  }
  return [...urls];
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return options(res);
  if (req.method === 'GET' && req.url.startsWith('/codex/health')) return handleHealth(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/config')) return handleClientConfig(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/relay-status')) return handleRelayStatus(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/send-status')) return handleSendStatus(req, res);
  if (req.method === 'POST' && req.url.startsWith('/send')) return handleSend(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/threads')) return handleThreads(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/history')) return handleThreadHistory(req, res);
  if (req.method === 'GET' && req.url.startsWith('/codex/status')) return handleCodexStatus(req, res);
  if ((req.method === 'GET' || req.method === 'POST') && req.url.startsWith('/codex/keep-awake')) return handleKeepAwake(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/select')) return handleSelectThread(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/new-thread')) return handleNewCodexThread(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/thread-action')) return handleThreadAction(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/model-switch')) return handleModelSwitch(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/reasoning-mode')) return handleReasoningMode(req, res);
  if (req.method === 'POST' && req.url.startsWith('/codex/stop')) return handleStopCodex(req, res);
  if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res);
  json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed' });
});

server.listen(PORT, HOST, () => {
  const urls = getLanUrls();
  console.log('\nCodex mini is running.');
  console.log('Keep this terminal open while using Codex Mini.');
  for (const url of urls) console.log(`  ${url}`);
  if (RELAY_PUBLIC_BASE) printRelayQr();
  console.log('\nPress Ctrl+C to stop.\n');
  startRelayClient();
});

process.on('exit', () => {
  clearRelayHeartbeat();
  clearRelayReconnectTimer();
  clearRelayCodexDesktopWatch();
  cleanupKeepAwake();
});
process.on('SIGINT', () => {
  clearRelayHeartbeat();
  clearRelayReconnectTimer();
  clearRelayCodexDesktopWatch();
  cleanupKeepAwake();
  process.exit(130);
});
process.on('SIGTERM', () => {
  clearRelayHeartbeat();
  clearRelayReconnectTimer();
  clearRelayCodexDesktopWatch();
  cleanupKeepAwake();
  process.exit(143);
});
