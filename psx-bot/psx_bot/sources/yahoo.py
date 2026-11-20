"""Backup daily prices from Yahoo Finance (PSX tickers end in .KA). Used only when PSX itself fails."""
from __future__ import annotations

import pandas as pd
import requests

from .psx import UA, clean_ohlcv, explain

URL = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}.KA"


def history(symbol: str, years: int = 6, session: requests.Session | None = None) -> pd.DataFrame:
    s = session or requests.Session()
    url = URL.format(symbol=symbol)
    try:
        resp = s.get(url, params={"range": f"{years}y", "interval": "1d"}, headers={"User-Agent": UA}, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except (requests.RequestException, ValueError) as err:
        raise ConnectionError(explain(url, err)) from err
    return parse_chart(data)


def parse_chart(data: dict) -> pd.DataFrame:
    try:
        res = data["chart"]["result"][0]
        q = res["indicators"]["quote"][0]
        idx = pd.to_datetime(res["timestamp"], unit="s", utc=True).tz_convert("Asia/Karachi").tz_localize(None)
    except (KeyError, IndexError, TypeError) as err:
        raise ConnectionError("Yahoo Finance has no data for this symbol") from err
    df = pd.DataFrame({k: q.get(k) for k in ("open", "high", "low", "close", "volume")}, index=idx)
    df.index.name = "date"
    return clean_ohlcv(df.astype(float))
