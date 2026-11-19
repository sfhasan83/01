"""CoinMarketCap market context: BTC quote, global market stats and the Fear & Greed index.

Needs a free API key (CMC_API_KEY in .env). These numbers are shown as context next to the
predictions. They are not fed into the model, because the free plan has no history to train on.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from .http import get_json

BASE_URL = "https://pro-api.coinmarketcap.com"
# The free plan allows about 330 calls a day and each refresh makes 3 calls,
# so the result is reused for 15 minutes (about 290 calls a day if left running).
CACHE_SECONDS = 900
_cache: dict[str, tuple[float, "MarketContext"]] = {}


@dataclass
class CoinQuote:
    price: float | None = None
    change_1h: float | None = None
    change_24h: float | None = None
    volume_24h: float | None = None


@dataclass
class MarketContext:
    coins: dict[str, CoinQuote] = field(default_factory=dict)  # "BTC" -> quote
    btc_dominance: float | None = None
    total_market_cap_change_24h: float | None = None
    fear_greed_value: int | None = None
    fear_greed_label: str | None = None
    error: str | None = None

    @property
    def has_data(self) -> bool:
        return bool(self.coins) or self.fear_greed_value is not None or self.btc_dominance is not None


def _first(entry):
    # v1 returns a dict per symbol, v2 returns a list per symbol
    return entry[0] if isinstance(entry, list) else entry


def fetch_context(api_key: str, symbols: list[str] | str = "BTC") -> MarketContext:
    """One quote call covers every coin, plus one call each for global stats and Fear & Greed."""
    if not api_key:
        return MarketContext(error="No CMC_API_KEY set in .env")
    symbols = [symbols] if isinstance(symbols, str) else list(symbols)
    key = ",".join(symbols)
    cached = _cache.get(key)
    if cached and time.monotonic() - cached[0] < CACHE_SECONDS:
        return cached[1]
    ctx = _fetch(api_key, symbols)
    if ctx.coins:
        _cache[key] = (time.monotonic(), ctx)
    return ctx


def _fetch(api_key: str, symbols: list[str]) -> MarketContext:
    headers = {"X-CMC_PRO_API_KEY": api_key, "Accept": "application/json"}
    ctx = MarketContext()
    problems = []
    try:
        data = get_json(f"{BASE_URL}/v1/cryptocurrency/quotes/latest",
                        params={"symbol": ",".join(symbols), "convert": "USD"}, headers=headers)
        for sym in symbols:
            if sym not in data.get("data", {}):
                continue
            quote = _first(data["data"][sym])["quote"]["USD"]
            ctx.coins[sym] = CoinQuote(price=quote.get("price"), change_1h=quote.get("percent_change_1h"),
                                       change_24h=quote.get("percent_change_24h"),
                                       volume_24h=quote.get("volume_24h"))
    except Exception as err:  # noqa: BLE001 - context is optional, never crash the bot
        problems.append(f"quote: {err}")
    try:
        data = get_json(f"{BASE_URL}/v1/global-metrics/quotes/latest", headers=headers)["data"]
        ctx.btc_dominance = data.get("btc_dominance")
        usd = data.get("quote", {}).get("USD", {})
        ctx.total_market_cap_change_24h = usd.get("total_market_cap_yesterday_percentage_change")
    except Exception as err:  # noqa: BLE001
        problems.append(f"global: {err}")
    try:
        data = get_json(f"{BASE_URL}/v3/fear-and-greed/latest", headers=headers)["data"]
        ctx.fear_greed_value = int(data.get("value"))
        ctx.fear_greed_label = data.get("value_classification")
    except Exception as err:  # noqa: BLE001
        problems.append(f"fear&greed: {err}")
    if problems:
        ctx.error = "; ".join(problems)
    return ctx
