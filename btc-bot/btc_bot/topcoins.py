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
from datetime import datetime, timezone

from .config import LOG_DIR, Settings

TOP_FILE = LOG_DIR / "top_coins.json"
REFRESH_HOURS = 12
RETRY_SECONDS = 1800       # after a failed refresh, wait 30 minutes before asking CoinMarketCap again
LISTING_LIMIT = 60         # look this far down the ranking to find N coins worth following
CMC_URL = "https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest"
EXCHANGE_TICKERS = {"binance": "https://api.binance.com/api/v3/ticker/price",
                    "mexc": "https://api.mexc.com/api/v3/ticker/price"}

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


def _exchange_pairs() -> dict[str, set[str]]:
    """Every pair each exchange trades right now (one request per exchange)."""
    from .sources.http import get_json

    pairs: dict[str, set[str]] = {}
    for name, url in EXCHANGE_TICKERS.items():
        try:
            pairs[name] = {row["symbol"] for row in get_json(url, retries=2)}
        except Exception:  # noqa: BLE001 - an exchange being down must not empty the list
            pass
    return pairs


def pick(listings: list[dict], pairs: dict[str, set[str]], n: int, quote: str = "USDT") -> tuple[list[TopCoin], list[dict]]:
    """Top n coins by market cap that are worth predicting and tradable as COINUSDT somewhere."""
    chosen: list[TopCoin] = []
    skipped: list[dict] = []
    for row in sorted(listings, key=lambda r: r.get("cmc_rank") or 10**9):
        if len(chosen) >= n:
            break
        coin = str(row.get("symbol", "")).upper()
        tags = {str(t).lower() for t in (row.get("tags") or [])}
        if coin in SKIP_COINS or tags & SKIP_TAGS or coin.startswith("USD"):
            skipped.append({"coin": coin, "rank": row.get("cmc_rank"), "reason": "stablecoin or wrapped token"})
            continue
        pair = coin + quote
        on = [ex for ex in ("binance", "mexc") if pair in pairs.get(ex, set())]
        if not on and pairs:
            skipped.append({"coin": coin, "rank": row.get("cmc_rank"), "reason": f"no {quote} pair on Binance or MEXC"})
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
    chosen, skipped = pick(listings, _exchange_pairs(), n)
    if not chosen:
        raise ValueError("no coin in the ranking has a USDT pair on Binance or MEXC")
    result = {"updated": datetime.now(timezone.utc).isoformat(timespec="seconds"), "n": n,
              "coins": [asdict(c) for c in chosen], "skipped": skipped}
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    TOP_FILE.write_text(json.dumps(result, indent=2), encoding="utf-8")
    return result


def resolve(settings: Settings, force: bool = False) -> list[str]:
    """Set settings.symbols to the current top coins (or leave SYMBOLS alone when TOP_COINS=0).

    Uses the saved list while it is under 12 hours old. If CoinMarketCap can't be reached, the last
    saved list is kept; with no saved list at all, the SYMBOLS from .env are used."""
    global _saved, _last_try, _last_problem, _note
    n = settings.top_coins
    if n <= 0:
        _note = "Coins from SYMBOLS in .env (TOP_COINS=0)"
        return settings.symbols
    with _lock:
        data = load_saved()
        fresh = bool(data) and data.get("n") == n and _age_hours(data) < REFRESH_HOURS
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
