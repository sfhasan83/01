"""Swing-time study: at what time of day do BTC, ETH and SOL usually make their swing tops and bottoms?

How it works
1. Download up to 5 years of 1-hour candles from Binance (saved in logs/history so later runs only
   fetch what's new).
2. Mark a "swing" at any hour whose high is the highest (swing top) or whose low is the lowest
   (swing bottom) of the surrounding +/- SWING_RADIUS hours, AND where price then moves away from
   it by at least MIN_MOVE_ATR x ATR within the next SWING_RADIUS hours. That keeps only real
   turning points, not noise.
3. Count swings by hour of day in YOUR computer's time zone, and pick the 3 busiest hours, at least
   3 hours apart from each other. Those are the daily swing windows.
4. Honesty check: choose the windows using all years except the last one, then measure how often
   the last year's swings actually landed in them, compared with pure chance.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

from .config import LOG_DIR, Settings, coin_name
from .sources import INTERVAL_MS, binance, drop_unfinished
from .tpsl import atr

HISTORY_DIR = LOG_DIR / "history"
RESULT_FILE = LOG_DIR / "swing_windows.json"
YEARS = 5
SWING_RADIUS = 6      # hours each side
MIN_MOVE_ATR = 2.0    # swing must be followed by a move of at least 2 x ATR(24)
WINDOWS = 3
MIN_GAP_HOURS = 3


def local_tz():
    return datetime.now().astimezone().tzinfo


def load_history(symbol: str, years: int = YEARS, progress=None) -> pd.DataFrame:
    """1h candles for the last `years` years, cached in logs/history/<SYMBOL>_1h.csv."""
    HISTORY_DIR.mkdir(parents=True, exist_ok=True)
    path = HISTORY_DIR / f"{symbol}_1h.csv"
    start = pd.Timestamp.now(tz="UTC") - pd.Timedelta(days=365 * years)
    cached = pd.DataFrame()
    if path.exists():
        cached = pd.read_csv(path, index_col=0)
        cached.index = pd.to_datetime(cached.index, utc=True)
    if not cached.empty and cached.index[0] <= start + pd.Timedelta(days=2):
        since = int(cached.index[-1].value // 1_000_000) + INTERVAL_MS["1h"]
    else:
        cached = pd.DataFrame()
        since = int(start.value // 1_000_000)
    new = binance.fetch_klines_since(symbol, "1h", since, progress=progress)
    df = pd.concat([cached, new[["open", "high", "low", "close", "volume"]]]) if not new.empty else cached
    df = df[~df.index.duplicated(keep="last")].sort_index()
    df = df[df.index >= start]
    df = drop_unfinished(df, "1h")
    df[["open", "high", "low", "close", "volume"]].to_csv(path)
    return df


def find_swings(df: pd.DataFrame, radius: int = SWING_RADIUS, min_move_atr: float = MIN_MOVE_ATR) -> pd.DataFrame:
    """Swing tops and bottoms. Returns rows with columns kind (top/bottom), price, move_pct."""
    win = 2 * radius + 1
    hi, lo = df["high"], df["low"]
    is_top = hi == hi.rolling(win, center=True).max()
    is_bot = lo == lo.rolling(win, center=True).min()
    a = atr(df, 24)
    # how far price travels away from the extreme over the next `radius` hours
    fut_low = lo[::-1].rolling(radius, min_periods=1).min()[::-1].shift(-1)
    fut_high = hi[::-1].rolling(radius, min_periods=1).max()[::-1].shift(-1)
    drop = hi - fut_low
    rise = fut_high - lo
    top = is_top & (drop >= min_move_atr * a)
    bot = is_bot & (rise >= min_move_atr * a)
    out = pd.concat([
        pd.DataFrame({"kind": "top", "price": hi[top], "move_pct": (drop / hi * 100)[top]}),
        pd.DataFrame({"kind": "bottom", "price": lo[bot], "move_pct": (rise / lo * 100)[bot]}),
    ]).sort_index()
    return out


@dataclass
class Window:
    hour: int               # local hour the window starts, 0-23
    share_of_days: float    # share of days with at least one swing in this hour
    lift: float             # how many times more swings than an average hour
    tops: int
    bottoms: int
    median_move_pct: float


@dataclass
class CoinSwingStudy:
    symbol: str
    days: int
    swings_per_day: float
    windows: list[Window]
    hourly_counts: list[int]           # swings per local hour 0..23
    by_year: dict[str, list[int]]      # top 3 hours chosen from each year alone
    test_year_in_windows: float        # last year's swings that landed in the windows (picked without it)
    test_chance: float                 # what pure chance would give
    tz_label: str
    start: str
    end: str
    notes: list[str] = field(default_factory=list)


def _pick_windows(counts: np.ndarray, n: int = WINDOWS, gap: int = MIN_GAP_HOURS) -> list[int]:
    chosen: list[int] = []
    for h in np.argsort(-counts, kind="stable"):
        if all(min(abs(h - c), 24 - abs(h - c)) >= gap for c in chosen):
            chosen.append(int(h))
        if len(chosen) == n:
            break
    return chosen


def study(df: pd.DataFrame, symbol: str, tz=None) -> CoinSwingStudy:
    tz = tz or local_tz()
    swings = find_swings(df)
    local = swings.index.tz_convert(tz)
    hours = local.hour
    counts = np.bincount(hours, minlength=24)
    days = max(int((df.index[-1] - df.index[0]).days), 1)
    avg = counts.mean() or 1
    day_key = local.normalize()
    windows = []
    for h in _pick_windows(counts):
        mask = hours == h
        windows.append(Window(
            hour=h,
            share_of_days=len(set(day_key[mask])) / days,
            lift=float(counts[h] / avg),
            tops=int((swings["kind"].values[mask] == "top").sum()),
            bottoms=int((swings["kind"].values[mask] == "bottom").sum()),
            median_move_pct=float(np.median(swings["move_pct"].values[mask])) if mask.any() else 0.0,
        ))

    by_year = {}
    for year in sorted(set(local.year)):
        m = local.year == year
        if m.sum() >= 100:
            by_year[str(year)] = sorted(_pick_windows(np.bincount(hours[m], minlength=24)))

    # Out-of-sample check: windows from everything before the last 365 days, scored on the last 365 days
    cutoff = df.index[-1] - pd.Timedelta(days=365)
    train = swings.index < cutoff
    test_rate = chance = float("nan")
    if train.sum() > 200 and (~train).sum() > 50:
        picked = _pick_windows(np.bincount(hours[train], minlength=24))
        test_rate = float(np.isin(hours[~train], picked).mean())
        chance = len(picked) / 24
    offset = datetime.now(tz).strftime("%z")
    res = CoinSwingStudy(
        symbol=symbol, days=days, swings_per_day=len(swings) / days, windows=windows,
        hourly_counts=[int(c) for c in counts], by_year=by_year,
        test_year_in_windows=test_rate, test_chance=chance,
        tz_label=f"UTC{offset[:3]}:{offset[3:]}", start=str(df.index[0].date()), end=str(df.index[-1].date()))
    if test_rate == test_rate:  # not NaN
        if test_rate < chance * 1.15:
            res.notes.append("Last year the windows did NOT catch clearly more swings than random hours would.")
        else:
            res.notes.append(f"Last year {test_rate:.0%} of swings fell in these windows vs {chance:.0%} by chance.")
    years = list(by_year.values())
    if len(years) >= 2:
        stable = set(years[0]).intersection(*map(set, years[1:]))
        if not stable:
            res.notes.append("No single hour was a top-3 swing hour in every year; the pattern shifts over time.")
    return res


def run_study(settings: Settings, years: int = YEARS, progress=print) -> list[CoinSwingStudy]:
    results = []
    for sym in settings.symbols:
        progress(f"{coin_name(sym)}: downloading/updating {years} years of hourly prices...")
        try:
            df = load_history(sym, years, progress=lambda n: None)
        except ConnectionError as err:
            progress(f"{coin_name(sym)}: skipped, could not download history from Binance ({err})")
            continue
        progress(f"{coin_name(sym)}: {len(df):,} hourly candles, finding swings...")
        try:
            from . import bigmoves
            bigmoves.record(df, sym, settings.big_move_pct)  # back-fill the 2%+ hour log from 5 years
        except OSError:
            pass
        results.append(study(df, sym))
    save_results(results)
    return results


def save_results(results: list[CoinSwingStudy]) -> None:
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    data = {"created": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "coins": [asdict(r) for r in results]}
    RESULT_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def load_results() -> dict | None:
    try:
        return json.loads(RESULT_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def next_windows(data: dict | None, now: datetime | None = None) -> list[tuple[datetime, list[str]]]:
    """Upcoming swing windows in local time over the next 24h: [(start, [coins]), ...] sorted by time."""
    if not data:
        return []
    now = now or datetime.now().astimezone()
    by_hour: dict[int, list[str]] = {}
    for coin in data.get("coins", []):
        for w in coin["windows"]:
            by_hour.setdefault(w["hour"], []).append(coin_name(coin["symbol"]))
    out = []
    for hour, coins in by_hour.items():
        start = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        if start + timedelta(hours=1) <= now:
            start += timedelta(days=1)
        out.append((start, coins))
    return sorted(out)


def next_window_text(data: dict | None, now: datetime | None = None) -> str:
    upcoming = next_windows(data, now)
    if not upcoming:
        return "Swing windows: not calculated yet. Click 'Swing times' (takes a few minutes the first time)."
    now = now or datetime.now().astimezone()
    start, coins = upcoming[0]
    mins = int((start - now).total_seconds() // 60)
    when = "NOW" if mins <= 0 else (f"in {mins} min" if mins < 120 else f"in {mins // 60}h {mins % 60:02d}m")
    later = ", ".join(f"{s:%H:%M} {'/'.join(c)}" for s, c in upcoming[1:4])
    return f"Next swing window: {start:%H:%M}-{start + timedelta(hours=1):%H:%M} ({when}) for {'/'.join(coins)}.  Then: {later}"


def report_text(results: list[CoinSwingStudy] | list[dict]) -> str:
    lines = ["DAILY SWING WINDOWS (times in your computer's time zone)", ""]
    for r in results:
        r = r if isinstance(r, dict) else asdict(r)
        lines.append(f"== {coin_name(r['symbol'])}  ({r['start']} to {r['end']}, {r['days']} days, {r['tz_label']})")
        lines.append(f"  Swings found: {r['swings_per_day']:.1f} per day on average")
        for i, w in enumerate(r["windows"], 1):
            lean = "mostly tops" if w["tops"] > 1.3 * w["bottoms"] else \
                "mostly bottoms" if w["bottoms"] > 1.3 * w["tops"] else "tops and bottoms"
            lines.append(f"  Window {i}: {w['hour']:02d}:00-{(w['hour'] + 1) % 24:02d}:00   swing on "
                         f"{w['share_of_days']:.0%} of days, {w['lift']:.2f}x an average hour, {lean}, "
                         f"typical move after it {w['median_move_pct']:.2f}%")
        peak = max(r["hourly_counts"]) or 1
        lines.append("  Swings by hour:")
        for h in range(24):
            c = r["hourly_counts"][h]
            lines.append(f"    {h:02d}:00 {'#' * round(30 * c / peak):<30} {c}")
        lines.append("  Top 3 hours chosen from each year alone: " +
                     "; ".join(f"{y}: {', '.join(f'{h:02d}' for h in hs)}" for y, hs in r["by_year"].items()))
        if r["test_year_in_windows"] == r["test_year_in_windows"]:
            lines.append(f"  Honesty check (last 12 months, windows picked without them): "
                         f"{r['test_year_in_windows']:.0%} of swings in the windows vs {r['test_chance']:.0%} by chance")
        lines += [f"  ! {n}" for n in r["notes"]]
        lines.append("")
    lines.append("A window is when swings happen MORE OFTEN than at other hours, not a promise of a swing today.")
    return "\n".join(lines)
