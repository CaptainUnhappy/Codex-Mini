#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hashPassphrase, randomToken } = require('./lib/crypto');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = 'true';
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node relay-server/create-device.js --id my-laptop --name "My Laptop" --passphrase "your password"

Options:
  --devices <path>       devices.json path, default: relay-server/devices.json
  --id <deviceId>        stable device id, default: current hostname
  --name <name>          display name, default: deviceId
  --passphrase <value>   login passphrase, minimum 8 characters
  --server-ip <ip>       server IP/domain for generated desktop env, default: <SERVER_IP>
  --port <port>          relay public port, default: 8788
  --env-dir <path>       write desktop-env.ps1 and desktop-env.sh to this directory
  --rotate-secret        replace relaySecret when updating an existing device
`);
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return { devices: [] };
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (Array.isArray(parsed)) return { devices: parsed };
  if (!Array.isArray(parsed.devices)) parsed.devices = [];
  return parsed;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  usage();
  process.exit(0);
}

const devicesPath = path.resolve(args.devices || path.join(__dirname, 'devices.json'));
const deviceId = String(args.id || os.hostname()).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
const name = String(args.name || deviceId).trim() || deviceId;
const passphrase = String(args.passphrase || '').trim();
const serverIp = String(args['server-ip'] || '<SERVER_IP>').trim() || '<SERVER_IP>';
const port = Number(args.port || 8788) || 8788;
const publicBase = `http://${serverIp}:${port}`;
const relayUrl = `ws://${serverIp}:${port}/tunnel`;

if (!deviceId) {
  console.error('Missing --id.');
  process.exit(1);
}
if (passphrase.length < 8) {
  console.error('Missing or weak --passphrase. Use at least 8 characters.');
  process.exit(1);
}

const data = readJson(devicesPath);
const existingIndex = data.devices.findIndex(device => String(device.deviceId || '') === deviceId);
const existing = existingIndex >= 0 ? data.devices[existingIndex] : null;
const relaySecret = existing && args['rotate-secret'] !== 'true' ? existing.relaySecret : randomToken(32);
const sessionVersion = Number(existing && existing.sessionVersion || 0) + 1;

const device = {
  deviceId,
  name,
  relaySecret,
  passphraseHash: hashPassphrase(passphrase),
  sessionVersion,
};

if (existingIndex >= 0) data.devices[existingIndex] = device;
else data.devices.push(device);

writeJson(devicesPath, data);

if (args['env-dir']) {
  const envDir = path.resolve(args['env-dir']);
  fs.mkdirSync(envDir, { recursive: true });
  const ps1 = [
    `$env:CODEX_MINI_RELAY_URL="${relayUrl}"`,
    `$env:CODEX_MINI_RELAY_PUBLIC_BASE="${publicBase}"`,
    `$env:CODEX_MINI_RELAY_DEVICE_ID="${deviceId}"`,
    `$env:CODEX_MINI_RELAY_SECRET="${relaySecret}"`,
    `$env:CODEX_MINI_RELAY_PASSPHRASE="${passphrase}"`,
    'npm start',
    '',
  ].join('\n');
  const sh = [
    `export CODEX_MINI_RELAY_URL='${relayUrl}'`,
    `export CODEX_MINI_RELAY_PUBLIC_BASE='${publicBase}'`,
    `export CODEX_MINI_RELAY_DEVICE_ID='${deviceId.replace(/'/g, "'\\''")}'`,
    `export CODEX_MINI_RELAY_SECRET='${relaySecret}'`,
    `export CODEX_MINI_RELAY_PASSPHRASE='${passphrase.replace(/'/g, "'\\''")}'`,
    'npm start',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(envDir, 'desktop-env.ps1'), ps1);
  fs.writeFileSync(path.join(envDir, 'desktop-env.sh'), sh);
}

console.log(`Updated ${devicesPath}`);
console.log('');
console.log('Desktop environment:');
console.log(`  CODEX_MINI_RELAY_URL=${relayUrl}`);
console.log(`  CODEX_MINI_RELAY_PUBLIC_BASE=${publicBase}`);
console.log(`  CODEX_MINI_RELAY_DEVICE_ID=${deviceId}`);
console.log(`  CODEX_MINI_RELAY_SECRET=${relaySecret}`);
console.log(`  CODEX_MINI_RELAY_PASSPHRASE=${passphrase}`);
console.log('');
console.log('Phone URL:');
console.log(`  ${publicBase}/#k=${encodeURIComponent(passphrase)}`);
if (args['env-dir']) console.log(`Desktop env files: ${path.resolve(args['env-dir'])}`);
