"""Which coins to follow: the current top N by CoinMarketCap market cap.

The list comes from CoinMarketCap's listings (1 API credit) and is saved to logs/top_coins.json.
It is refreshed every 12 hours, so the free plan's daily limit is not a concern.

Coins are skipped when they are stablecoins or wrapped/staked copies of another coin (their price
barely moves, so there is nothing to predict), or when neither Binance nor MEXC has a USDT pair.
For each coin the bot remembers which exchange lists it, so it never asks an exchange for a pair
it does not have.
"""
from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone

from .config import LOG_DIR, Settings

TOP_FILE = LOG_DIR / "top_coins.json"
REFRESH_HOURS = 12
RETRY_SECONDS = 1800       # after a failed refresh, wait 30 minutes before asking CoinMarketCap again
LISTING_LIMIT = 60         # look this far down the ranking to find N coins worth following
CMC_URL = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest"
# 24h tickers, not plain prices: a pair an exchange stopped trading (e.g. XMR on Binance) still has a
# price, but no volume in the last 24 hours
EXCHANGE_TICKERS = {"binance": "https://api.binance.com/api/v3/ticker/24hr",
                    "mexc": "https://api.mexc.com/api/v3/ticker/24hr"}
FORMAT_VERSION = 2   # saved lists from older versions (which didn't check for live trading) are renewed
DEAD_DAYS = 7        # a coin found with no live market is left out this long before being checked again

# Stablecoins, wrapped and staked tokens: CoinMarketCap tags catch most, this list catches the rest
SKIP_TAGS = {"stablecoin", "fiat-stablecoin", "usd-stablecoin", "asset-backed-stablecoin",
             "algorithmic-stablecoin", "wrapped-tokens", "liquid-staking-derivatives", "tokenized-gold"}
SKIP_COINS = {"USDT", "USDC", "DAI", "FDUSD", "TUSD", "USDE", "USDS", "PYUSD", "BUSD", "USDD", "USD1",
              "USDTB", "USDF", "RLUSD", "BSC-USD", "SUSDE", "WBTC", "WETH", "STETH", "WSTETH", "WEETH",
              "CBBTC", "WBETH", "RETH", "BTCB", "XAUT", "PAXG"}


@dataclass
class TopCoin:
    symbol: str          # pair name, e.g. BTCUSDT
    coin: str            # BTC
    name: str = ""       # Bitcoin
    rank: int = 0        # CoinMarketCap rank by market cap
    exchanges: list[str] = field(default_factory=list)  # which of binance / mexc list the pair
    market_cap: float | None = None


_lock = threading.Lock()
_last_try: float | None = None
_last_problem = ""
_force = False
_saved: dict | None = None
_note = ""


def load_saved() -> dict | None:
    global _saved
    if _saved is None:
        try:
            _saved = json.loads(TOP_FILE.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
    return _saved


def saved_coins() -> list[TopCoin]:
    data = load_saved() or {}
    return [TopCoin(**c) for c in data.get("coins", [])]


def coin_info(symbol: str) -> TopCoin | None:
    for c in saved_coins():
        if c.symbol == symbol:
            return c
    return None


def listed_on(symbol: str) -> list[str] | None:
    """Exchanges known to list this pair, or None when unknown (then every exchange is tried)."""
    info = coin_info(symbol)
    return list(info.exchanges) if info and info.exchanges else None


def note() -> str:
    """One line about where the coin list came from, for the window and the console."""
    return _note


def _age_hours(data: dict) -> float:
    try:
        made = datetime.fromisoformat(data["updated"])
    except (KeyError, ValueError, TypeError):
        return float("inf")
    return (datetime.now(timezone.utc) - made).total_seconds() / 3600


def live_pairs(rows: list[dict], now_ms: int | None = None) -> set[str]:
    """Pairs that really traded in the last day (some volume, and a 24h window that ends recently)."""
    now_ms = now_ms or int(time.time() * 1000)
    live = set()
    for row in rows or []:
        try:
            volume = float(row.get("quoteVolume") or row.get("volume") or 0)
            close = int(row.get("closeTime") or now_ms)
        except (TypeError, ValueError):
            continue
        if volume > 0 and now_ms - close < 2 * 86_400_000:
            live.add(row.get("symbol"))
    return live


def _dead(data: dict | None) -> dict[str, str]:
    """Coins recently found with no live market: {"XMR": "2026-11-20T15:20:00+00:00"}."""
    out = {}
    for coin, when in ((data or {}).get("dead") or {}).items():
        try:
            if datetime.now(timezone.utc) - datetime.fromisoformat(when) < timedelta(days=DEAD_DAYS):
                out[coin] = when
        except (TypeError, ValueError):
            pass
    return out


def mark_dead(symbol: str) -> None:
    """The coin's candles stopped (the exchange no longer trades it): drop it so the next coin in the
    ranking takes its place on the next refresh."""
    global _saved, _force
    with _lock:
        data = load_saved()
        if not data:
            return
        coin = next((c["coin"] for c in data.get("coins", []) if c["symbol"] == symbol), None)
        if coin is None:
            return
        data["coins"] = [c for c in data["coins"] if c["symbol"] != symbol]
        data.setdefault("dead", {})[coin] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        _saved = data
        _force = True
        try:
            TOP_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
        except OSError:
            pass


def _exchange_pairs() -> dict[str, set[str]]:
    """Every pair each exchange trades right now (one request per exchange)."""
    from .sources.http import get_json

    pairs: dict[str, set[str]] = {}
    for name, url in EXCHANGE_TICKERS.items():
        try:
            pairs[name] = live_pairs(get_json(url, retries=2))
        except Exception:  # noqa: BLE001 - an exchange being down must not empty the list
            pass
    return pairs


def pick(listings: list[dict], pairs: dict[str, set[str]], n: int, quote: str = "USDT",
         dead: dict | None = None) -> tuple[list[TopCoin], list[dict]]:
    """Top n coins by market cap that are worth predicting and tradable as COINUSDT somewhere."""
    chosen: list[TopCoin] = []
    skipped: list[dict] = []
    for row in sorted(listings, key=lambda r: r.get("cmc_rank") or 10**9):
        if len(chosen) >= n:
            break
        coin = str(row.get("symbol", "")).upper()
        if coin in (dead or {}):
            skipped.append({"coin": coin, "rank": row.get("cmc_rank"), "reason": "no live trading on Binance or MEXC"})
            continue
        tags = {str(t).lower() for t in (row.get("tags") or [])}
        if coin in SKIP_COINS or tags & SKIP_TAGS or coin.startswith("USD"):
            skipped.append({"coin": coin, "rank": row.get("cmc_rank"), "reason": "stablecoin or wrapped token"})
            continue
        pair = coin + quote
        on = [ex for ex in ("binance", "mexc") if pair in pairs.get(ex, set())]
        if not on and pairs:
            skipped.append({"coin": coin, "rank": row.get("cmc_rank"), "reason": f"no live {quote} pair on Binance or MEXC"})
            continue
        usd = (row.get("quote") or {}).get("USD") or {}
        chosen.append(TopCoin(symbol=pair, coin=coin, name=row.get("name", ""), rank=int(row.get("cmc_rank") or 0),
                              exchanges=on, market_cap=usd.get("market_cap")))
    return chosen, skipped


def refresh(api_key: str, n: int) -> dict:
    """Ask CoinMarketCap for the ranking and save the chosen coins."""
    from .sources.http import get_json

    data = get_json(CMC_URL, params={"start": 1, "limit": LISTING_LIMIT, "sort": "market_cap", "convert": "USD"},
                    headers={"X-CMC_PRO_API_KEY": api_key, "Accept": "application/json"}, retries=2)
    listings = data.get("data") or []
    if not listings:
        raise ValueError("CoinMarketCap sent an empty ranking")
    dead = _dead(load_saved())
    chosen, skipped = pick(listings, _exchange_pairs(), n, dead=dead)
    if not chosen:
        raise ValueError("no coin in the ranking has a USDT pair on Binance or MEXC")
    result = {"version": FORMAT_VERSION, "dead": dead,
              "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "n": n,
              "coins": [asdict(c) for c in chosen], "skipped": skipped}
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    TOP_FILE.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def resolve(settings: Settings, force: bool = False) -> list[str]:
    """Set settings.symbols to the current top coins (or leave SYMBOLS alone when TOP_COINS=0).

    Uses the saved list while it is under 12 hours old. If CoinMarketCap can't be reached, the last
    saved list is kept; with no saved list at all, the SYMBOLS from .env are used."""
    global _saved, _last_try, _last_problem, _note, _force
    n = settings.top_coins
    if n <= 0:
        _note = "Coins from SYMBOLS in .env (TOP_COINS=0)"
        return settings.symbols
    with _lock:
        data = load_saved()
        fresh = (bool(data) and data.get("n") == n and data.get("version") == FORMAT_VERSION
                 and _age_hours(data) < REFRESH_HOURS)
        if _force:
            force, _force = True, False
        problem = ""
        if force or not fresh:
            if not settings.cmc_api_key:
                problem = "No CMC_API_KEY in .env, so the top coins can't be looked up"
            elif force or _last_try is None or time.monotonic() - _last_try > RETRY_SECONDS:
                _last_try = time.monotonic()
                try:
                    data = _saved = refresh(settings.cmc_api_key, n)
                    _last_problem = ""
                except Exception as err:  # noqa: BLE001
                    problem = _last_problem = f"Could not update the top {n} from CoinMarketCap ({str(err)[:120]})"
            else:
                problem = _last_problem
        if data and data.get("coins"):
            settings.symbols = [c["symbol"] for c in data["coins"]][:n]
            made = datetime.fromisoformat(data["updated"]).astimezone()
            _note = f"Top {len(settings.symbols)} by CoinMarketCap market cap (list from {made:%d %b %H:%M})"
            if problem:
                _note += f". {problem}; using the saved list"
            skipped = [s["coin"] for s in data.get("skipped", [])]
            if skipped:
                _note += ". Skipped: " + ", ".join(skipped)
        else:
            _note = (problem + ". " if problem else "") + "Showing SYMBOLS from .env instead"
    return settings.symbols
