"""Settings, read from a .env file next to the project (or real environment variables)."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

PROJECT_DIR = Path(__file__).resolve().parent.parent
# PSX_BOT_HOME moves data/ and logs/ elsewhere (the tests use it)
_HOME = Path(os.environ["PSX_BOT_HOME"]) if os.environ.get("PSX_BOT_HOME") else PROJECT_DIR
LOG_DIR = _HOME / "logs"
DATA_DIR = _HOME / "data"

try:
    from dotenv import load_dotenv

    load_dotenv(PROJECT_DIR / ".env")
except ImportError:  # python-dotenv is optional
    pass


def _get(name: str, default: str) -> str:
    value = os.environ.get(name, "").strip()
    return value if value else default


def _flag(name: str, default: bool) -> bool:
    return _get(name, "1" if default else "0").lower() in ("1", "true", "yes", "on")


def rs(x: float | None) -> str:
    """Rupee price: Rs 1,234.56"""
    if x is None or x != x:
        return "n/a"
    return f"Rs {x:,.2f}"


def pct(x: float | None, sign: bool = True) -> str:
    if x is None or x != x:
        return "n/a"
    return f"{x:+.2f}%" if sign else f"{x:.1f}%"


@dataclass
class Settings:
    years: int = 5                     # years of daily history to keep and learn from
    symbols: tuple[str, ...] = ()      # empty = every listed stock
    include_etfs: bool = False
    include_gem: bool = True           # Growth Enterprise Market (small companies)
    min_turnover: float = 2_000_000    # PKR per day (20-day average); below this a stock is marked illiquid
    confidence_threshold: float = 0.55
    fee_rate: float = 0.0025           # per side: commission, CVT, SECP/CDC fees, roughly 0.25%
    sl_atr_mult: float = 1.5
    tp_atr_mult: float = 2.5
    use_yahoo_fallback: bool = True
    auto_update: bool = True           # update data and signals when the window opens
    workers: int = 4
    requests_per_second: float = 2.0

    @classmethod
    def load(cls) -> "Settings":
        syms = tuple(x.strip().upper() for x in _get("SYMBOLS", "").split(",") if x.strip())
        s = cls(
            years=int(_get("YEARS", "5")),
            symbols=syms,
            include_etfs=_flag("INCLUDE_ETFS", False),
            include_gem=_flag("INCLUDE_GEM", True),
            min_turnover=float(_get("MIN_TURNOVER", "2000000")),
            confidence_threshold=float(_get("CONFIDENCE_THRESHOLD", "0.55")),
            fee_rate=float(_get("FEE_RATE", "0.0025")),
            sl_atr_mult=float(_get("SL_ATR_MULT", "1.5")),
            tp_atr_mult=float(_get("TP_ATR_MULT", "2.5")),
            use_yahoo_fallback=_flag("USE_YAHOO_FALLBACK", True),
            auto_update=_flag("AUTO_UPDATE", True),
            workers=int(_get("WORKERS", "4")),
            requests_per_second=float(_get("REQUESTS_PER_SECOND", "2")),
        )
        s.years = min(max(s.years, 2), 20)
        s.confidence_threshold = min(max(s.confidence_threshold, 0.5), 0.95)
        s.workers = min(max(s.workers, 1), 8)
        s.requests_per_second = min(max(s.requests_per_second, 0.2), 5.0)
        s.sl_atr_mult = max(s.sl_atr_mult, 0.1)
        s.tp_atr_mult = max(s.tp_atr_mult, 0.1)
        return s
