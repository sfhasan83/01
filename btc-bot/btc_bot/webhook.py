"""Tiny receiver for TradingView webhook alerts (standard library only).

In TradingView, create an alert and set its Webhook URL to http://<your-public-address>:8080/tradingview
and its message to JSON like:

    {"secret": "change-me", "symbol": "{{ticker}}", "timeframe": "{{interval}}", "action": "buy", "price": {{close}}, "note": "my strategy"}

TradingView can only reach your PC if it has a public address (port forwarding, or a tunnel such as
ngrok / Cloudflare Tunnel). The latest alert per timeframe is shown next to the bot's predictions.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .config import LOG_DIR, Settings
from .sources.tradingview import ALERTS_FILE, latest_alerts

# TradingView's {{interval}} gives minutes ("5", "15", "60") for intraday charts
INTERVAL_ALIASES = {"5": "5m", "15": "15m", "60": "1h", "1H": "1h", "5M": "5m", "15M": "15m"}


def normalise_timeframe(value: str) -> str:
    value = str(value).strip()
    return INTERVAL_ALIASES.get(value, INTERVAL_ALIASES.get(value.upper(), value.lower()))


def store_alert(payload: dict) -> dict:
    tf = normalise_timeframe(payload.get("timeframe", "unknown"))
    # TradingView's {{ticker}} is e.g. "BTCUSDT" (or "BINANCE:BTCUSDT"); no symbol means BTC
    symbol = str(payload.get("symbol") or "BTCUSDT").split(":")[-1].upper()
    key = f"{symbol}|{tf}"
    action = str(payload.get("action", "")).lower()
    record = {"action": action, "price": payload.get("price"), "note": payload.get("note"),
              "received": datetime.now(timezone.utc).isoformat(timespec="seconds")}
    alerts = latest_alerts()
    alerts[key] = record
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    ALERTS_FILE.write_text(json.dumps(alerts, indent=2), encoding="utf-8")
    return {key: record}


def make_handler(secret: str):
    class Handler(BaseHTTPRequestHandler):
        def _reply(self, code: int, body: dict):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):  # noqa: N802
            if self.path.rstrip("/") != "/tradingview":
                return self._reply(404, {"error": "not found"})
            length = min(int(self.headers.get("Content-Length", 0)), 10_000)
            try:
                payload = json.loads(self.rfile.read(length) or b"{}")
            except ValueError:
                return self._reply(400, {"error": "message must be JSON"})
            if not isinstance(payload, dict) or payload.get("secret") != secret:
                return self._reply(403, {"error": "wrong secret"})
            saved = store_alert(payload)
            print(f"[{datetime.now():%H:%M:%S}] TradingView alert: {saved}")
            return self._reply(200, {"ok": True})

        def do_GET(self):  # noqa: N802
            self._reply(200, {"status": "running", "latest": latest_alerts()})

        def log_message(self, *args):  # keep the console quiet
            pass

    return Handler


def serve(settings: Settings) -> None:
    if settings.webhook_secret in ("", "change-me"):
        print("WARNING: set WEBHOOK_SECRET in .env to something only you know.")
    server = ThreadingHTTPServer(("0.0.0.0", settings.webhook_port), make_handler(settings.webhook_secret))
    print(f"Listening for TradingView alerts on port {settings.webhook_port} (path /tradingview). Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
