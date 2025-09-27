# ShieldRTC – Monorepo (MVP scaffold)

Date: 2025-09-27

This is a minimal scaffold for the **app_shieldrtc_portal** MVP and related services.

## Folders
- `app_shieldrtc_portal/` – PHP (Apache) portal issuing JWTs and simple REST endpoints.
- `shieldrtc_signal/` – Node/TS WebSocket signaling with Redis presence.
- `nginx/` – Reverse proxy for `/` → portal and `/signal` → signaling.
- `sdk-js/demo/` – Browser demo to login, connect WS, and join LiveKit.
- `infra/` – Redis config (default), sample coturn/livekit notes.

## Quick start
1) Copy `.env.example` to `.env` and fill values.
2) `docker compose up -d --build`
3) Check health:
   - `curl -I http://localhost:8088/` (Nginx → Portal)
   - `curl -s http://localhost:8082/healthz` (Signal HTTP health)
   - `wscat -c ws://localhost:8088/signal` (after portal JWT logic is in place)
