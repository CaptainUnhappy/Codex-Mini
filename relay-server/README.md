# Codex Mini Relay

Self-hosted HTTP/WebSocket relay for short phone links.

## Server

Requirements:

- Ubuntu/Debian
- Node.js 20+
- TCP `8788` open to the phone and desktop

Install as a systemd service:

```bash
sudo bash relay-server/install-full.sh --server-ip <SERVER_IP> --device-id my-pc --device-name "My PC" --passphrase "your-password"
```

The full installer installs Node.js 20 when needed, copies files to `/opt/codex-mini-relay`, installs npm dependencies, creates `devices.json`, writes a systemd service, starts it, and writes:

```text
/opt/codex-mini-relay/desktop-env.ps1
/opt/codex-mini-relay/desktop-env.sh
```

Manual service install only:

```bash
sudo bash relay-server/install-systemd.sh
```

Create or update a device:

```bash
node relay-server/create-device.js --id my-laptop --name "My Laptop" --passphrase "your-password"
```

Copy the generated `devices.json` to `/opt/codex-mini-relay/relay-server/devices.json` if you generated it outside the install directory, then restart:

```bash
sudo systemctl restart codex-mini-relay
```

Status page:

```text
http://<SERVER_IP>:8788/admin/status?adminToken=<ADMIN_TOKEN>
```

`ADMIN_TOKEN` is stored in `/etc/codex-mini-relay.env` when using the install script.

## Desktop

Set the environment variables printed by `create-device.js`, replacing `<SERVER_IP>` with your server IP:

```bash
export CODEX_MINI_RELAY_URL="ws://<SERVER_IP>:8788/tunnel"
export CODEX_MINI_RELAY_PUBLIC_BASE="http://<SERVER_IP>:8788"
export CODEX_MINI_RELAY_DEVICE_ID="my-laptop"
export CODEX_MINI_RELAY_SECRET="..."
export CODEX_MINI_RELAY_PASSPHRASE="your-password"
npm start
```

The desktop terminal prints a QR code for:

```text
http://<SERVER_IP>:8788/#k=<device passphrase>
```

The phone URL is HTTP-only in this first version. Use it for personal testing only; upgrade to HTTPS/WSS before sending sensitive content over untrusted networks.

`MOBILE_TYPER_TOKEN` is optional for relay mode. If omitted, the desktop service generates a local random token at startup and the relay client injects it internally when forwarding requests to `127.0.0.1`.
