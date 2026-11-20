"""Turns a Snapshot into readable text for the console."""
from __future__ import annotations

from .config import coin_name, price_text
from .levels import describe, level_text
from .predictor import Snapshot

ARROWS = {"UP": "▲ UP", "DOWN": "▼ DOWN", "NEUTRAL": "• NEUTRAL"}
EXCHANGE_NAMES = {"binance": "Binance", "mexc": "MEXC"}
TV_NAMES = {"STRONG_BUY": "Strong buy", "BUY": "Buy", "NEUTRAL": "Neutral", "SELL": "Sell",
            "STRONG_SELL": "Strong sell"}


def local_hhmm(ts) -> str:
    """Timestamp shown as HH:MM in the computer's own time zone."""
    return ts.to_pydatetime().astimezone().strftime("%H:%M")


def prediction_label(signal) -> str:
    """LONG if the model leans up (P(up) above 0.5), SHORT if it leans down. Shown even for NEUTRAL calls."""
    if signal is None:
        return "-"
    return "LONG ▲" if signal.p_up > 0.5 else "SHORT ▼"


def tpsl_badge(t) -> str:
    """Result of the latest finished TP/SL trade."""
    if t is None or t.last_outcome is None:
        return "waiting"
    return {"TP": "TP ✔ hit", "SL": "SL ✘ hit", "EXPIRED": "expired"}[t.last_outcome]


def tpsl_text(t) -> str:
    """e.g. 'TP 4 · SL 3 · exp 1 (50% TP) · +0.6R'"""
    if t is None or not t.finished:
        return f"{t.open} running" if t and t.open else "-"
    return (f"TP {t.tp} · SL {t.sl} · exp {t.expired} ({t.tp_rate:.0%} TP) · {t.total_r:+.1f}R")


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
    side = "LONG" if r.last_direction == "UP" else "SHORT"
    said = f"predicted {side} (NEUTRAL lean)" if r.last_is_lean else f"predicted {side}"
    return (f"{said} for the candle closing {local_hhmm(r.last_target_close)}, price went {move}.  "
            f"Hit rate: {hit_rate_text(r)}")


def money(x):
    return price_text(x)


def pct(x, signed=True):
    if x is None:
        return "n/a"
    return f"{x:+.2f}%" if signed else f"{x:.1f}%"


def price_lines(snap: Snapshot) -> list[str]:
    """One line per coin, e.g. 'BTC   Binance: $63,090.83   MEXC: $63,125.94'."""
    out = []
    for sym, by_exchange in snap.prices.items():
        prices = "   ".join(f"{EXCHANGE_NAMES.get(k, k)}: {money(v)}" for k, v in by_exchange.items())
        out.append(f"{coin_name(sym):<5} {prices}")
    return out


def cmc_line(snap: Snapshot) -> str:
    c = snap.cmc
    if not c:
        return ""
    if not c.has_data:
        return f"CoinMarketCap: {c.error}" if c.error else ""
    fg = f"{c.fear_greed_value} ({c.fear_greed_label})" if c.fear_greed_value is not None else "n/a"
    coins = "   ".join(f"{name} 1h {pct(q.change_1h)} 24h {pct(q.change_24h)}" for name, q in c.coins.items())
    return f"CoinMarketCap: {coins}   BTC dominance {pct(c.btc_dominance, False)}   Fear & Greed {fg}"


def snapshot_text(snap: Snapshot) -> str:
    out = [f"Crypto movement forecast  ·  {snap.created.astimezone():%Y-%m-%d %H:%M:%S} (your time)", ""]
    if snap.coins_note:
        out.append(snap.coins_note)
    out += price_lines(snap)
    if cmc_line(snap):
        out.append(cmc_line(snap))
    header = (f"{'Coin':<6}{'Timeframe':<10}{'Prediction':<12}{'Bot says':<12}{'Confidence':<12}{'P(up)':<8}{'TradingView':<14}"
              f"{'Agree?':<8}{'For candle closing'}")
    current = None
    for p in snap.predictions:
        if p.symbol != current:
            current = p.symbol
            out += ["", header, "-" * 104]
        if p.error or not p.signal:
            out.append(f"{p.coin:<6}{p.timeframe:<10}ERROR: {p.error}")
            continue
        tv = TV_NAMES.get(p.tv.recommendation or "", "n/a")
        agree = {True: "yes", False: "NO", None: "-"}[p.agrees_with_tv]
        when = local_hhmm(p.target_close_time)
        out.append(f"{p.coin:<6}{p.timeframe:<10}{prediction_label(p.signal):<12}{ARROWS[p.signal.direction]:<12}{p.signal.confidence:<12.0%}"
                   f"{p.signal.p_up:<8.2f}{tv:<14}{agree:<8}{when}  (from {money(p.last_close)})")
        out.append(f"{'':<16}Take profit {money(p.take_profit)}   Stop loss {money(p.stop_loss)}   "
                   f"(entry {money(p.last_close)}, {p.side})")
        out.append(f"{'':<16}Last result: {signal_badge(p.results)}  {result_line(p.results, p.target_close_time)}")
        out.append(f"{'':<16}TP/SL: last {tpsl_badge(p.tpsl_results)}   {tpsl_text(p.tpsl_results)}")
        sup = p.supports[0] if p.supports else None
        res = p.resistances[0] if p.resistances else None
        out.append(f"{'':<16}Rebound levels: support {level_text(sup)}   resistance {level_text(res)}  (rebounds/tests)")
        if p.tv_alert:
            out.append(f"{'':<16}TradingView alert: {p.tv_alert.get('action')} at {p.tv_alert.get('received')}")
    tv_errors = {p.tv.error for p in snap.predictions if p.tv.error}
    if tv_errors:
        out += ["", f"TradingView rating unavailable: {sorted(tv_errors)[0][:200]}"]
    out += ["", "Signals only. Short-term crypto moves are close to random; check `backtest` before trusting any call."]
    return "\n".join(out)


def levels_report(snap: Snapshot) -> str:
    """Full list of rebound levels for every coin and timeframe."""
    lines = ["REBOUND LEVELS  (support = price tends to bounce UP, resistance = bounce DOWN)", "",
             "Rebound rate = how often price bounced 1 ATR back instead of breaking 1 ATR through, on the history",
             "the bot has loaded. On random prices this is about 50%, so only levels clearly above 50% with several",
             "tests mean much. 'strong' needs at least 6 completed tests.", ""]
    for p in snap.predictions:
        if not p.signal:
            continue
        lines.append(f"== {p.coin} {p.timeframe}   price {money(p.last_close)}")
        for lv in reversed(p.resistances):
            lines.append("   " + describe(lv))
        lines.append(f"   {'--- price':<10} {price_text(p.last_close):>13}")
        for lv in p.supports:
            lines.append("   " + describe(lv))
        lines.append("")
    return "\n".join(lines)
