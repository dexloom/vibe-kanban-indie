# Testing on Mobile Devices

This guide explains how to access the self-hosted local web UI from a phone (iPhone/Android) for UI testing. It uses [Tailscale](https://tailscale.com) for stable networking so the phone can reach your Mac from any network — no port forwarding, no public IP.

The app is local-only: the binary serves the embedded frontend (`packages/local-web` + `packages/web-core`) on a single port, so no Docker, no remote server, no relay, and no GitHub OAuth are involved.

**Time to set up**: ~10 minutes (one-time). After that it's two commands.

---

## Prerequisites

### 1. Install Tailscale on your Mac

Download the standalone app from https://tailscale.com/download/mac (recommended). Alternatively, install from the [Mac App Store](https://apps.apple.com/app/tailscale/id1470499037).

1. Open the Tailscale app
2. Click the Tailscale icon in your menu bar (top-right of screen)
3. Click **Log in** — this opens a browser window to sign in
4. Once signed in, the icon turns active — you're connected

> If you already have Tailscale installed, skip this step.

### 2. Install Tailscale on your phone

- **iPhone**: [App Store — Tailscale](https://apps.apple.com/app/tailscale/id1470499037)
- **Android**: [Play Store — Tailscale](https://play.google.com/store/apps/details?id=com.tailscale.ipn)

Sign in with the **same account** you used on your Mac.

### 3. Verify both devices are connected

```bash
tailscale status
```

Both your Mac and phone should appear:

```
100.x.x.x   johns-macbook     user@   macOS   -
100.x.x.x   iphone-john      user@   iOS     -
```

> If your phone shows "offline", open the Tailscale app on your phone and make sure the toggle is ON.

---

## Running

### Step 1 — Stop the normal local instance (optional)

If `kanban.sh` is running it binds to `127.0.0.1`. To test from a phone you want a fixed port and all interfaces instead:

```bash
~/yt/kanban.sh stop
```

### Step 2 — Start the server on all interfaces with a fixed port

```bash
HOST=0.0.0.0 BACKEND_PORT=55763 ~/.vibe-kanban/bin/v0.2.23/macos-arm64/vibe-kanban
```

- `HOST=0.0.0.0` makes the server listen on all interfaces (default is `127.0.0.1`).
- `BACKEND_PORT` (or `PORT`) pins the port instead of auto-assigning one.
- The same port serves both the API and the embedded frontend.

### Step 3 — Get your tailnet hostname

```bash
tailscale status --json | python3 -c "import sys,json; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))"
```

### Step 4 — Open the UI from your phone

On the phone, open Safari (or Chrome) and go to:

```
http://<hostname>:55763
```

Replace `<hostname>` with the value from Step 3 (e.g. `johns-macbook.tail99xyz.ts.net`).

> The phone and Mac must be on the same Tailscale account. If it doesn't load, verify both devices are connected with `tailscale status`.

---

## Optional — HTTPS instead of plain HTTP

Plain `http://` over Tailscale works for most testing. If you need a trusted HTTPS certificate (e.g. for testing clipboard APIs or WebSockets that the browser restricts on insecure origins):

1. Enable MagicDNS and HTTPS certificates in the Tailscale admin: https://login.tailscale.com/admin/dns
2. Generate a cert for your hostname:
   ```bash
   TS_HOSTNAME=$(tailscale status --json | python3 -c "import sys,json; print(json.load(sys.stdin)['Self']['DNSName'].rstrip('.'))")
   tailscale cert $TS_HOSTNAME
   ```
3. Reverse-proxy with Caddy:
   ```bash
   brew install caddy
   cat > Caddyfile << EOF
   ${TS_HOSTNAME}:55763 {
       tls ${TS_HOSTNAME}.crt ${TS_HOSTNAME}.key
       reverse_proxy 127.0.0.1:55763
   }
   EOF
   caddy run --config Caddyfile
   ```
4. Phone: `https://<hostname>:55763`

> Certs expire after 90 days. Re-run `tailscale cert $TS_HOSTNAME` to renew.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| Phone can't reach the URL | Open Tailscale app on phone → toggle ON. Run `tailscale status` on Mac to verify both devices are connected |
| Phone shows certificate warning | Re-run `tailscale cert $TS_HOSTNAME` — certs may have expired (90-day lifetime) |
| Server says port already in use | Another instance is running. `pkill -f vibe-kanban`, then retry Step 2 |
| `ping <hostname>` doesn't resolve | Enable MagicDNS in Tailscale admin: https://login.tailscale.com/admin/dns |
| Back to local dev | Stop the manual server (`Ctrl+C`), then `~/yt/kanban.sh start` |
