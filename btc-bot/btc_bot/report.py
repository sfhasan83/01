"""Turns a Snapshot into readable text for the console."""
from __future__ import annotations

from .predictor import Snapshot

ARROWS = {"UP": "▲ UP", "DOWN": "▼ DOWN", "NEUTRAL": "• NEUTRAL"}
EXCHANGE_NAMES = {"binance": "Binance", "mexc": "MEXC"}
TV_NAMES = {"STRONG_BUY": "Strong buy", "BUY": "Buy", "NEUTRAL": "Neutral", "SELL": "Sell",
            "STRONG_SELL": "Strong sell"}


def local_hhmm(ts) -> str:
    """Timestamp shown as HH:MM in the computer's own time zone."""
    return ts.to_pydatetime().astimezone().strftime("%H:%M")


def signal_badge(r) -> str:
    """Result of the last checked prediction: 'YES ✔ HIT', 'NO ✘ MISSED' (+ '(lean)') or 'waiting'."""
    if r is None or r.last_hit is None:
        return "waiting"
    text = "YES ✔ HIT" if r.last_hit else "NO ✘ MISSED"
    return f"{text} (lean)" if r.last_is_lean else text


def hit_rate_text(r) -> str:
    """e.g. 'signals 3/5 (60%) · all 10/18 (56%)'."""
    if r is None or not r.all_checked:
        return "-"
    every = f"all {r.all_hits}/{r.all_checked} ({r.all_hit_rate:.0%})"
    if not r.checked:
        return every
    return f"signals {r.hits}/{r.checked} ({r.hit_rate:.0%}) · {every}"


def result_line(r, next_due=None) -> str:
    """One sentence about the last checked prediction, for the console or the window."""
    if r is None or r.last_hit is None:
        when = f" The first one is checked at {local_hhmm(next_due)}." if next_due is not None else ""
        return f"Nothing checked yet: a result appears when a predicted candle closes.{when}"
    move = f"{money(r.last_from_price)} → {money(r.last_close_price)}"
    said = f"leaned {r.last_direction} (NEUTRAL)" if r.last_is_lean else f"said {r.last_direction}"
    return (f"{said} for the candle closing {local_hhmm(r.last_target_close)}, price went {move}.  "
            f"Hit rate: {hit_rate_text(r)}")


def money(x):
    return "n/a" if x is None else f"${x:,.2f}"


def pct(x, signed=True):
    if x is None:
        return "n/a"
    return f"{x:+.2f}%" if signed else f"{x:.1f}%"


def snapshot_text(snap: Snapshot) -> str:
    out = [f"BTC movement forecast  ·  {snap.created.astimezone():%Y-%m-%d %H:%M:%S} (your time)", ""]
    prices = "   ".join(f"{EXCHANGE_NAMES.get(k, k)}: {money(v)}" for k, v in snap.prices.items())
    out.append(f"Live price   {prices}")
    if snap.cmc:
        c = snap.cmc
        if c.price is not None or c.fear_greed_value is not None:
            fg = f"{c.fear_greed_value} ({c.fear_greed_label})" if c.fear_greed_value is not None else "n/a"
            out.append(f"CoinMarketCap  1h {pct(c.change_1h)}  24h {pct(c.change_24h)}  "
                       f"BTC dominance {pct(c.btc_dominance, False)}  Fear & Greed {fg}")
        if c.error:
            out.append(f"CoinMarketCap  ({c.error})")
    out.append("")
    out.append(f"{'Timeframe':<10}{'Bot says':<12}{'Confidence':<12}{'P(up)':<8}{'TradingView':<14}"
               f"{'Agree?':<8}{'For candle closing'}")
    out.append("-" * 86)
    for p in snap.predictions:
        if p.error or not p.signal:
            out.append(f"{p.timeframe:<10}ERROR: {p.error}")
            continue
        tv = TV_NAMES.get(p.tv.recommendation or "", "n/a")
        agree = {True: "yes", False: "NO", None: "-"}[p.agrees_with_tv]
        when = local_hhmm(p.target_close_time)
        out.append(f"{p.timeframe:<10}{ARROWS[p.signal.direction]:<12}{p.signal.confidence:<12.0%}"
                   f"{p.signal.p_up:<8.2f}{tv:<14}{agree:<8}{when}  (from {money(p.last_close)})")
        out.append(f"{'':<10}Last result: {signal_badge(p.results)}  {result_line(p.results, p.target_close_time)}")
        if p.tv_alert:
            out.append(f"{'':<10}TradingView alert: {p.tv_alert.get('action')} at {p.tv_alert.get('received')}")
    tv_errors = {p.tv.error for p in snap.predictions if p.tv.error}
    if tv_errors:
        out += ["", f"TradingView rating unavailable: {sorted(tv_errors)[0][:200]}"]
    out += ["", "Signals only. Short-term BTC moves are close to random; check `backtest` before trusting any call."]
    return "\n".join(out)
