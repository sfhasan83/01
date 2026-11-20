"""Pakistan Stock Exchange data portal (dps.psx.com.pk). Free, no account or key needed.

  GET  /symbols                 JSON list of every listed instrument (symbol, name, sectorName, isETF, isDebt, isGEM)
  POST /historical  symbol=X    HTML table with the full daily history: DATE, OPEN, HIGH, LOW, CLOSE, VOLUME
  GET  /trading-board/REG/main  HTML table with today's live prices for the regular market

Since September 2026 the portal rejects these data requests (HTTP 403) unless they carry an
X-Req-Id header. The value is embedded in every page of the site as window.__ps._k and
changes every few minutes, so it is read from the home page and refreshed on a 403.
"""
from __future__ import annotations

import json
import re
import threading
import time
from datetime import datetime
from html.parser import HTMLParser
from urllib.parse import urlparse

import pandas as pd
import requests

BASE = "https://dps.psx.com.pk"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
      "Chrome/130.0.0.0 Safari/537.36")
TOKEN_TTL = 240  # seconds; the site rotates it roughly every 5 minutes
_TOKEN_RE = re.compile(r"window\.__ps\s*=\s*(\{.*?\})\s*(?:;|</script>)", re.DOTALL)
DATE_FORMATS = ("%b %d, %Y", "%d-%b-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d %b %Y", "%B %d, %Y")


class PSXError(ConnectionError):
    pass


def explain(url: str, err: Exception | None) -> str:
    """Short, plain message instead of a page of urllib3 text."""
    host = urlparse(url).hostname or url
    text = str(err)
    if "NameResolutionError" in text or "getaddrinfo failed" in text or "Name or service not known" in text:
        return (f"can't look up {host}: this PC has no working internet/DNS right now "
                "(check the connection, VPN or firewall)")
    if "ConnectTimeout" in text or "timed out" in text:
        return f"{host} did not answer in time (slow or blocked connection)"
    if "SSLError" in text or "CERTIFICATE" in text:
        return f"secure connection to {host} failed (antivirus web shield or proxy?): {text[:120]}"
    return f"request to {url} failed: {text[:200]}"


def extract_token(html: str) -> str | None:
    m = _TOKEN_RE.search(html)
    if not m:
        return None
    try:
        data = json.loads(m.group(1))
    except ValueError:
        return None
    tok = data.get("_k") if isinstance(data, dict) else None
    return tok if isinstance(tok, str) and len(tok) >= 8 else None


class _RateLimiter:
    def __init__(self, per_second: float):
        self.gap = 1.0 / per_second
        self.lock = threading.Lock()
        self.next_at = 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            delay = self.next_at - now
            self.next_at = max(now, self.next_at) + self.gap
        if delay > 0:
            time.sleep(delay)


class PSXClient:
    """Thread-safe client: shares one session, one token and one rate limit across threads."""

    def __init__(self, requests_per_second: float = 2.0, timeout: int = 30):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": BASE + "/",
        })
        self.timeout = timeout
        self.limiter = _RateLimiter(requests_per_second)
        self._token: str | None = None
        self._token_at = 0.0
        self._token_lock = threading.Lock()

    # --- token ----------------------------------------------------------
    def token(self, force: bool = False) -> str | None:
        with self._token_lock:
            if not force and self._token and time.monotonic() - self._token_at < TOKEN_TTL:
                return self._token
            try:
                self.limiter.wait()
                resp = self.session.get(BASE + "/", timeout=self.timeout,
                                        headers={"Accept": "text/html,application/xhtml+xml"})
                tok = extract_token(resp.text) if resp.ok else None
            except requests.RequestException as err:
                raise PSXError(explain(BASE, err)) from err
            self._token, self._token_at = tok, time.monotonic()
            return tok

    # --- requests -------------------------------------------------------
    def request(self, method: str, path: str, data: dict | None = None, retries: int = 3) -> requests.Response:
        url = BASE + path
        last: Exception | None = None
        refreshed = False
        attempt = 0
        while attempt < retries:
            tok = self.token()
            headers = {"X-Requested-With": "XMLHttpRequest", "Accept": "*/*"}
            if tok:
                headers["X-Req-Id"] = tok
            try:
                self.limiter.wait()
                resp = self.session.request(method, url, data=data, headers=headers, timeout=self.timeout)
            except requests.RequestException as err:
                last = err
                attempt += 1
                time.sleep(attempt)
                continue
            if resp.status_code == 403 and not refreshed:
                refreshed = True
                self.token(force=True)
                continue
            if resp.status_code == 429 or resp.status_code >= 500:
                last = PSXError(f"HTTP {resp.status_code}")
                attempt += 1
                time.sleep(2 * attempt)
                continue
            if resp.status_code >= 400:
                raise PSXError(f"{url} answered HTTP {resp.status_code}"
                               + (" (the site refused the request; its access token format may have changed)"
                                  if resp.status_code == 403 else ""))
            return resp
        raise PSXError(explain(url, last))

    def symbols(self) -> pd.DataFrame:
        """All listed instruments: symbol, name, sector, is_etf, is_debt, is_gem."""
        resp = self.request("GET", "/symbols")
        try:
            data = resp.json()
        except ValueError as err:
            raise PSXError("the PSX symbol list was not valid JSON") from err
        return parse_symbols(data)

    def history(self, symbol: str) -> pd.DataFrame:
        """Full daily OHLCV history for one symbol (PSX returns every year in one response)."""
        resp = self.request("POST", "/historical", data={"symbol": symbol})
        return parse_history(resp.text)

    def live_board(self) -> pd.DataFrame:
        """Today's regular-market board: symbol, ldcp (last close), current, change, volume..."""
        resp = self.request("GET", "/trading-board/REG/main")
        return parse_board(resp.text)


# --- parsing ------------------------------------------------------------
def parse_symbols(data) -> pd.DataFrame:
    if isinstance(data, dict):  # tolerate {"data": [...]}
        data = data.get("data") or data.get("symbols") or []
    rows = []
    for item in data or []:
        if not isinstance(item, dict) or not item.get("symbol"):
            continue
        rows.append({
            "symbol": str(item["symbol"]).strip().upper(),
            "name": str(item.get("name") or "").strip(),
            "sector": str(item.get("sectorName") or item.get("sector") or "").strip(),
            "is_etf": bool(item.get("isETF", False)),
            "is_debt": bool(item.get("isDebt", False)),
            "is_gem": bool(item.get("isGEM", False)),
        })
    return pd.DataFrame(rows, columns=["symbol", "name", "sector", "is_etf", "is_debt", "is_gem"])


class _TableParser(HTMLParser):
    """Collects header texts and row cell texts of the first <table>."""

    def __init__(self):
        super().__init__()
        self.depth = 0          # table nesting
        self.done = False
        self.headers: list[str] = []
        self.rows: list[list[str]] = []
        self._row: list[str] | None = None
        self._cell: list[str] | None = None
        self._is_th = False

    def handle_starttag(self, tag, attrs):
        if self.done:
            return
        if tag == "table":
            self.depth += 1
        elif self.depth and tag == "tr":
            self._row = []
        elif self.depth and tag in ("td", "th"):
            self._cell, self._is_th = [], tag == "th"

    def handle_endtag(self, tag):
        if self.done:
            return
        if tag in ("td", "th") and self._cell is not None:
            text = " ".join("".join(self._cell).split())
            if self._is_th:
                self.headers.append(text)
            elif self._row is not None:
                self._row.append(text)
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None
        elif tag == "table" and self.depth:
            self.depth -= 1
            if self.depth == 0:
                self.done = True

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


def parse_table(html: str) -> tuple[list[str], list[list[str]]]:
    p = _TableParser()
    p.feed(html)
    return p.headers, p.rows


def to_number(text: str) -> float:
    t = (text or "").replace(",", "").replace("%", "").replace("Rs.", "").replace("PKR", "").strip()
    if t in ("", "-", "--"):
        return float("nan")
    if t.startswith("(") and t.endswith(")"):
        t = "-" + t[1:-1]
    try:
        return float(t)
    except ValueError:
        return float("nan")


def to_date(text: str):
    t = (text or "").strip()
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            continue
    try:
        return pd.Timestamp(t).to_pydatetime()
    except (ValueError, TypeError):
        return None


def _col(headers: list[str], *names: str) -> int | None:
    upper = [h.upper().strip() for h in headers]
    for name in names:
        if name in upper:
            return upper.index(name)
    return None


def parse_history(html: str) -> pd.DataFrame:
    """HTML table -> DataFrame indexed by date with open, high, low, close, volume (oldest first)."""
    headers, rows = parse_table(html)
    cols = ["open", "high", "low", "close", "volume"]
    if not rows:
        return pd.DataFrame(columns=cols, index=pd.DatetimeIndex([], name="date"))
    idx = {
        "date": _col(headers, "DATE", "TIME"),
        "open": _col(headers, "OPEN"),
        "high": _col(headers, "HIGH"),
        "low": _col(headers, "LOW"),
        "close": _col(headers, "CLOSE", "PRICE", "CURRENT"),
        "volume": _col(headers, "VOLUME", "VOL."),
    }
    if not headers or idx["date"] is None or idx["close"] is None:  # no usable header row: assume PSX's order
        idx = {"date": 0, "open": 1, "high": 2, "low": 3, "close": 4, "volume": 5}
    out = []
    for r in rows:
        def cell(k):
            i = idx.get(k)
            return r[i] if i is not None and i < len(r) else ""
        d = to_date(cell("date"))
        if d is None:
            continue
        rec = {"date": d}
        for k in cols:
            rec[k] = to_number(cell(k))
        out.append(rec)
    df = pd.DataFrame(out, columns=["date"] + cols)
    return clean_ohlcv(df.set_index("date"))


def clean_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df.index = pd.DatetimeIndex(pd.to_datetime(df.index)).normalize()
    df.index.name = "date"
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df[df["close"].notna() & (df["close"] > 0)]
    for k in ("open", "high", "low"):
        df[k] = df[k].where(df[k] > 0, df["close"])  # some rows only carry a close
    df["high"] = df[["open", "high", "low", "close"]].max(axis=1)
    df["low"] = df[["open", "high", "low", "close"]].min(axis=1)
    df["volume"] = df["volume"].fillna(0).clip(lower=0)
    return df[["open", "high", "low", "close", "volume"]].astype(float)


def parse_board(html: str) -> pd.DataFrame:
    headers, rows = parse_table(html)
    if not headers or not rows:
        return pd.DataFrame(columns=["symbol", "ldcp", "current", "change", "change_pct", "volume"])
    names = {"SYMBOL": "symbol", "SCRIP": "symbol", "LDCP": "ldcp", "CURRENT": "current", "CHANGE": "change",
             "CHANGE (%)": "change_pct", "VOLUME": "volume", "OPEN": "open", "HIGH": "high", "LOW": "low"}
    keys = [names.get(h.upper().strip(), h.lower()) for h in headers]
    recs = []
    for r in rows:
        rec = {k: (r[i] if i < len(r) else "") for i, k in enumerate(keys)}
        if not rec.get("symbol"):
            continue
        sym = rec["symbol"].split()[0].upper()
        out = {"symbol": sym}
        for k in ("ldcp", "current", "change", "change_pct", "volume", "open", "high", "low"):
            if k in rec:
                out[k] = to_number(rec[k])
        recs.append(out)
    return pd.DataFrame(recs)
