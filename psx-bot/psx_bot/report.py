"""Plain-text views of a scan (for the console and the details window)."""
from __future__ import annotations

import pandas as pd

from . import HORIZONS
from .config import pct, rs


def signal_cell(row, hz: str) -> str:
    sig = row.get(f"sig_{hz}", "")
    conf = row.get(f"conf_{hz}", float("nan"))
    if not isinstance(sig, str) or not sig:
        return "-"
    lean = "▲" if row.get(f"p_{hz}", 0.5) > 0.5 else "▼"
    return f"{sig} {conf:.0%}" if sig != "HOLD" else f"HOLD {lean}"


def scan_text(scan, top: int = 25, horizon: str = "1W", liquid_only: bool = True) -> str:
    t = scan.table
    lines = [f"PSX signals for {scan.as_of} (made {scan.created.replace('T', ' ')})",
             f"{scan.stocks} stocks · {scan.breadth:.0f}% above their 50-day average · "
             f"median 5-day move {pct(scan.market_5d)}"]
    for hz in HORIZONS:
        c = scan.counts.get(hz, {})
        lines.append(f"  {hz}: {c.get('BUY', 0)} BUY, {c.get('SELL', 0)} SELL, {c.get('HOLD', 0)} HOLD")
    view = t[t["liquid"]] if liquid_only and "liquid" in t else t
    for side, asc in (("BUY", False), ("SELL", True)):
        part = view[view[f"sig_{horizon}"] == side].sort_values(f"p_{horizon}", ascending=asc).head(top)
        lines += ["", f"Top {side} calls ({horizon}{', liquid stocks only' if liquid_only else ''}):"]
        if part.empty:
            lines.append("  none")
            continue
        lines.append(f"  {'Symbol':<9}{'Close':>12}{'Day':>12}  {'1D':<10}{'1W':<10}{'1M':<10}"
                     f"{'TP (' + horizon + ')':>14}{'SL (' + horizon + ')':>14}  Sector")
        for sym, r in part.iterrows():
            lim = r.get("limit", "")
            day = pct(r["change_pct"]) + (f" {lim}" if isinstance(lim, str) and lim else "")
            lines.append(f"  {sym:<9}{rs(r['close']):>12}{day:>12}  "
                         f"{signal_cell(r, '1D'):<10}{signal_cell(r, '1W'):<10}{signal_cell(r, '1M'):<10}"
                         f"{rs(r[f'tp_{horizon}']):>14}{rs(r[f'sl_{horizon}']):>14}  {str(r['sector'])[:30]}")
    for n in scan.notes:
        lines.append(f"\nNote: {n}")
    return "\n".join(lines)


def stock_text(scan, sym: str, history: pd.DataFrame | None = None) -> str:
    r = scan.table.loc[sym]
    lines = [f"{sym}  {r.get('name', '')}", f"Sector: {r.get('sector', '') or 'n/a'}",
             f"Close on {scan.as_of}: {rs(r['close'])}  ({pct(r['change_pct'])} on the day, "
             f"{pct(r['change_5d_pct'])} over 5 sessions)",
             (f"Closed locked at the {'upper' if r.get('limit') == 'UC' else 'lower'} price limit "
              "(UC/LC): there may have been no sellers/buyers at this price.\n"
              if isinstance(r.get("limit"), str) and r.get("limit") else "") +
             f"Trend: {r['trend']}   RSI(14): {r['rsi']:.0f}   Daily range (ATR): {rs(r['atr'])}",
             f"Average turnover (20 sessions): Rs {r['turnover']:,.0f} a day"
             + ("" if r.get("liquid", True) else "  (ILLIQUID: hard to buy or sell at these prices)"),
             f"20-session support {rs(r['support'])}, resistance {rs(r['resistance'])}", ""]
    for hz, n in HORIZONS.items():
        p = r[f"p_{hz}"]
        lines.append(f"{hz} ({n} session{'s' if n > 1 else ''}): {r[f'sig_{hz}']}  chance of closing higher "
                     f"{p:.0%}.  If {'bought' if p >= 0.5 else 'sold'} at {rs(r['close'])}: "
                     f"take profit {rs(r[f'tp_{hz}'])}, stop loss {rs(r[f'sl_{hz}'])}")
        calls, hit = r.get(f"bt_calls_{hz}"), r.get(f"bt_hit_{hz}")
        if calls == calls and calls:
            lines.append(f"      Backtest for this stock: {int(calls)} calls, {hit:.0%} right")
    if history is not None and not history.empty:
        lines += ["", "Last 10 sessions:", f"  {'Date':<12}{'Open':>10}{'High':>10}{'Low':>10}{'Close':>10}{'Volume':>14}"]
        for d, h in history.tail(10).iterrows():
            lines.append(f"  {d:%Y-%m-%d}  {h['open']:>10,.2f}{h['high']:>10,.2f}{h['low']:>10,.2f}"
                         f"{h['close']:>10,.2f}{h['volume']:>14,.0f}")
    lines += ["", "Signals only: this bot never places orders. SELL means the model expects the price to "
                  "fall: a reason to avoid or exit, not advice to short."]
    return "\n".join(lines)
