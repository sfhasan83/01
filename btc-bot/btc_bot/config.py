"""Settings, read from a .env file next to the project (or real environment variables)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
LOG_DIR = PROJECT_DIR / "logs"

try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_DIR / ".env")
except ImportError:  # python-dotenv is optional
    pass


def _get(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value if value else default


@dataclass
class Settings:
    cmc_api_key: str = ""
    symbol: str = "BTCUSDT"
    primary_exchange: str = "binance"
    history_candles: int = 3000
    confidence_threshold: float = 0.58
    refresh_seconds: int = 60
    webhook_port: int = 8080
    webhook_secret: str = "change-me"
    fee_rate: float = 0.001

    @classmethod
    def load(cls) -> "Settings":
        s = cls(
            cmc_api_key=_get("CMC_API_KEY", ""),
            symbol=_get("SYMBOL", "BTCUSDT").upper(),
            primary_exchange=_get("PRIMARY_EXCHANGE", "binance").lower(),
            history_candles=int(_get("HISTORY_CANDLES", "3000")),
            confidence_threshold=float(_get("CONFIDENCE_THRESHOLD", "0.58")),
            refresh_seconds=int(_get("REFRESH_SECONDS", "60")),
            webhook_port=int(_get("WEBHOOK_PORT", "8080")),
            webhook_secret=_get("WEBHOOK_SECRET", "change-me"),
            fee_rate=float(_get("FEE_RATE", "0.001")),
        )
        if s.primary_exchange not in ("binance", "mexc"):
            raise ValueError("PRIMARY_EXCHANGE must be 'binance' or 'mexc'")
        s.confidence_threshold = min(max(s.confidence_threshold, 0.5), 0.99)
        s.history_candles = max(s.history_candles, 500)
        s.refresh_seconds = max(s.refresh_seconds, 10)
        return s
