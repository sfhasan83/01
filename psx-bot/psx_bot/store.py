"""Downloads and keeps the daily history of every PSX stock in data/history/<SYMBOL>.csv.

The first download takes a few minutes (one request per stock, about 2 per second so the PSX site
is not hammered). After that, an update only re-downloads stocks whose saved data is behind.
"""
from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Callable

import pandas as pd

from .config import DATA_DIR, Settings
from .sources import yahoo
from .sources.psx import PSXClient, PSXError

HIST_DIR = DATA_DIR / "history"
SYMBOLS_FILE = DATA_DIR / "symbols.csv"
META_FILE = DATA_DIR / "meta.json"
REFERENCE_SYMBOLS = ("OGDC", "HUBC", "LUCK", "ENGRO", "PPL")  # big, always traded: tell us the last trading day
PKT = timezone(timedelta(hours=5))  # Pakistan time, no daylight saving
MARKET_SETTLED_HOUR = 16  # the regular session ends by 3:30 PM PKT; after 4 PM the day's prices are final
WARMUP_DAYS = 300  # extra calendar days kept before the N years, so 200-day averages are ready on day one

Progress = Callable[[str], None]
NO_HISTORY = "no price history on PSX"


@dataclass
class UpdateSummary:
    total: int = 0
    downloaded: int = 0
    up_to_date: int = 0
    from_yahoo: int = 0
    failed: dict = field(default_factory=dict)
    no_history: list = field(default_factory=list)  # listed but never traded (nothing to download)
    last_trading_day: str = ""
    symbols_source: str = "PSX"

    def text(self) -> str:
        parts = [f"{self.total} stocks: {self.downloaded} downloaded, {self.up_to_date} already up to date"]
        if self.from_yahoo:
            parts.append(f"{self.from_yahoo} from Yahoo Finance (PSX failed for them)")
        if self.no_history:
            parts.append(f"{len(self.no_history)} have no trading history")
        if self.failed:
            parts.append(f"{len(self.failed)} failed")
        line = ", ".join(parts) + "."
        if self.last_trading_day:
            line += f" Latest trading day: {self.last_trading_day}."
        if self.symbols_source != "PSX":
            line += f" Stock list: {self.symbols_source}."
        return line


def _load_meta() -> dict:
    try:
        return json.loads(META_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _save_meta(meta: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = META_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, indent=1), encoding="utf-8")
    tmp.replace(META_FILE)


def saved_symbols() -> pd.DataFrame:
    try:
        df = pd.read_csv(SYMBOLS_FILE, dtype={"symbol": str, "name": str, "sector": str}, keep_default_na=False)
        for k in ("is_etf", "is_debt", "is_gem"):
            df[k] = df[k].astype(str).str.lower().isin(("true", "1"))
        return df
    except (OSError, ValueError, KeyError):
        return pd.DataFrame(columns=["symbol", "name", "sector", "is_etf", "is_debt", "is_gem"])


def universe(symbols: pd.DataFrame, settings: Settings) -> pd.DataFrame:
    """Every listed stock (shares), without bonds/sukuk and, unless asked for, without ETFs."""
    df = symbols.copy()
    if settings.symbols:
        wanted = set(settings.symbols)
        known = df[df["symbol"].isin(wanted)]
        extra = [s for s in settings.symbols if s not in set(known["symbol"])]
        extra_df = pd.DataFrame({"symbol": extra, "name": "", "sector": "", "is_etf": False,
                                 "is_debt": False, "is_gem": False})
        return pd.concat([known, extra_df], ignore_index=True)
    df = df[~df["is_debt"]]
    if not settings.include_etfs:
        df = df[~df["is_etf"]]
    if not settings.include_gem:
        df = df[~df["is_gem"]]
    # Bills, bonds, TFCs and sukuk sometimes come without the isDebt flag
    debt_words = r"\b(?:TFC\d*|SUKUK|T-?BILL|PIB|GOVERNMENT|GOP IJARA|IJARA|BOND|PREF\.?|PREFERENCE)\b|\(TFC|PREF SHARE"
    df = df[~df["name"].str.upper().str.contains(debt_words, regex=True, na=False)]
    df = df[~df["sector"].str.upper().str.contains("BILLS AND BONDS|DEBT|FUTURE", regex=True, na=False)]
    df = df[~df["symbol"].str.contains(r"TFC\d*$", regex=True, na=False)]
    return df.drop_duplicates("symbol").sort_values("symbol").reset_index(drop=True)


def history_path(symbol: str):
    safe = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in symbol)
    return HIST_DIR / f"{safe}.csv"


def load_history(symbol: str) -> pd.DataFrame | None:
    path = history_path(symbol)
    if not path.exists():
        return None
    try:
        df = pd.read_csv(path, index_col="date", parse_dates=["date"])
    except (OSError, ValueError):
        return None
    return df[["open", "high", "low", "close", "volume"]].astype(float).sort_index()


def _save_history(symbol: str, df: pd.DataFrame) -> None:
    HIST_DIR.mkdir(parents=True, exist_ok=True)
    path = history_path(symbol)
    tmp = path.with_suffix(".tmp")
    df.to_csv(tmp, date_format="%Y-%m-%d", float_format="%.4f")
    tmp.replace(path)


def drop_unfinished_day(df: pd.DataFrame, now: datetime | None = None) -> pd.DataFrame:
    """While PSX is open (until about 4 PM Pakistan time), today's row is still moving: leave it out."""
    if df.empty:
        return df
    now = now or datetime.now(PKT)
    today = pd.Timestamp(now.date())
    if now.hour < MARKET_SETTLED_HOUR and df.index.max() >= today:
        return df[df.index < today]
    return df


def _trim(df: pd.DataFrame, years: int) -> pd.DataFrame:
    if df.empty:
        return df
    start = df.index.max() - pd.DateOffset(years=years) - pd.Timedelta(days=WARMUP_DAYS)
    return df[df.index >= start]


def update_all(settings: Settings, progress: Progress = print, stop: threading.Event | None = None) -> UpdateSummary:
    client = PSXClient(settings.requests_per_second)
    summary = UpdateSummary()
    progress("Getting the list of PSX stocks...")
    try:
        syms = client.symbols()
        if syms.empty:
            raise PSXError("the PSX symbol list came back empty")
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        syms.to_csv(SYMBOLS_FILE, index=False)
    except PSXError as err:
        syms = saved_symbols()
        if syms.empty:
            raise PSXError(f"Could not get the PSX stock list: {err}") from err
        summary.symbols_source = f"saved copy (PSX failed: {err})"
    uni = universe(syms, settings)
    summary.total = len(uni)
    meta = _load_meta()
    checked = meta.setdefault("checked", {})

    # Which day is the latest trading day? Ask a few big stocks that trade every day.
    ref_day = ""
    for ref in REFERENCE_SYMBOLS:
        try:
            df = drop_unfinished_day(client.history(ref))
            if not df.empty:
                ref_day = df.index.max().strftime("%Y-%m-%d")
                if ref in set(uni["symbol"]):
                    _save_history(ref, _trim(df, settings.years))
                    checked[ref] = ref_day
                break
        except PSXError:
            continue
    summary.last_trading_day = ref_day

    todo = []
    for sym in uni["symbol"]:
        if ref_day and checked.get(sym) == ref_day and history_path(sym).exists():
            summary.up_to_date += 1
        else:
            todo.append(sym)

    lock = threading.Lock()
    done = 0

    def fetch(sym: str):
        if stop is not None and stop.is_set():
            return sym, None, "cancelled"
        try:
            df = drop_unfinished_day(client.history(sym))
            if df.empty:
                return sym, None, NO_HISTORY
            return sym, (df, "PSX"), None
        except PSXError as err:
            if settings.use_yahoo_fallback:
                try:
                    df = drop_unfinished_day(yahoo.history(sym, settings.years + 1))
                    if not df.empty:
                        return sym, (df, "Yahoo"), None
                except ConnectionError:
                    pass
            return sym, None, str(err)

    if todo:
        progress(f"Downloading {len(todo)} stocks (about {len(todo) / settings.requests_per_second / 60:.0f} min)...")
    with ThreadPoolExecutor(max_workers=settings.workers) as pool:
        futures = [pool.submit(fetch, s) for s in todo]
        for fut in as_completed(futures):
            sym, got, err = fut.result()
            with lock:
                done += 1
                if got:
                    df, src = got
                    old = load_history(sym)
                    if old is not None and not old.empty:
                        df = pd.concat([old[old.index < df.index.min()], df])
                    _save_history(sym, _trim(df, settings.years))
                    checked[sym] = ref_day or df.index.max().strftime("%Y-%m-%d")
                    summary.downloaded += 1
                    summary.from_yahoo += src == "Yahoo"
                elif err == NO_HISTORY:
                    summary.no_history.append(sym)
                elif err != "cancelled":
                    summary.failed[sym] = err
                if done % 10 == 0 or done == len(todo):
                    progress(f"Downloaded {done}/{len(todo)} stocks ({sym})...")
                    meta["updated"] = datetime.now().isoformat(timespec="seconds")
                    _save_meta(meta)
    meta["updated"] = datetime.now().isoformat(timespec="seconds")
    meta["last_trading_day"] = ref_day
    _save_meta(meta)
    if stop is not None and stop.is_set():
        raise PSXError("Update cancelled")
    if summary.total and len(summary.failed) == summary.total:
        first = next(iter(summary.failed.values()))
        raise PSXError(f"Every download failed, for example: {first}")
    return summary


def load_all(settings: Settings, min_days: int = 120) -> tuple[dict[str, pd.DataFrame], pd.DataFrame]:
    """Saved histories of the stock universe, and the stock list with names and sectors."""
    syms = saved_symbols()
    uni = universe(syms, settings) if not syms.empty else pd.DataFrame(
        {"symbol": [p.stem for p in HIST_DIR.glob("*.csv")], "name": "", "sector": "",
         "is_etf": False, "is_debt": False, "is_gem": False})
    out = {}
    for sym in uni["symbol"]:
        df = load_history(sym)
        if df is not None and len(df) >= min_days:
            out[sym] = _trim(df, settings.years)
    return out, uni[uni["symbol"].isin(out)].reset_index(drop=True)
