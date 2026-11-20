"""Desktop window (tkinter ships with Python on Windows, nothing extra to install).

Layout: a dark header with the market mood, then one block per coin (largest market cap first).
Each block shows the coin's prices on the left and one row per timeframe on the right. The table
scrolls, and its column headings stay in place while it does.
"""
from __future__ import annotations

import queue
import sys
import threading
import tkinter as tk
from tkinter import font as tkfont
from tkinter import scrolledtext, ttk

from . import TIMEFRAMES
from .config import PROJECT_DIR, Settings, coin_name
# Heavy modules (pandas, scikit-learn, the data sources) are imported in the background after the
# window is on screen, so the bot opens instantly instead of after several seconds.

FONT = "Segoe UI"
PAGE = "#f3f5f8"
CARD = "#ffffff"
ALT = "#f7f9fb"           # every other coin block
LINE = "#e1e6ec"
TEXT = "#1f2328"
MUTED = "#6e7781"
DARK = "#161b22"          # header
DARK_CHIP = "#262c36"
DARK_TEXT = "#e6edf3"
DARK_MUTED = "#8b949e"
UP, UP_BG = "#1a7f37", "#dafbe1"
DOWN, DOWN_BG = "#cf222e", "#ffebe9"
GREY_BG = "#eaeef2"
WARN = "#9a6700"
ORANGE = "#bc4c00"
COLOURS = {"UP": UP, "DOWN": DOWN, "NEUTRAL": MUTED}
LEVEL_COLOURS = {"strong": "#0550ae", "medium": TEXT, "weak": MUTED}  # blue = strong level

# (key, heading, widest expected text, alignment)
COLUMNS = (
    ("tf", "Time", "15m", "center"),
    ("pred", "Prediction", "SHORT ▼", "center"),
    ("bot", "Bot says", "NEUTRAL", "center"),
    ("conf", "Conf.", "100%", "center"),
    ("tv", "TradingView", "Strong sell", "center"),
    ("closes", "Closes", "00:00", "center"),
    ("entry", "Entry", "$123,456.78", "e"),
    ("tp", "Take profit", "$123,456.78", "e"),
    ("sl", "Stop loss", "$123,456.78", "e"),
    ("tpsl", "TP/SL", "SL ✘ hit", "center"),
    ("last", "Last call", "NO ✘ MISSED (lean)", "center"),
    ("record", "Hit rate · R", "100% of 999 · -10.0R", "center"),
    ("sup", "Support (bounce up)", "$123,456.78 · 17/25", "e"),
    ("res", "Resistance (bounce down)", "$123,456.78 · 17/25", "e"),
)
PILL_COLUMNS = {"pred", "tpsl", "last"}
COIN_COL_SAMPLE = "$123,456.78  #10 Dogecoin"


class Tooltip:
    """Small grey box with more detail while the mouse is over a cell."""

    def __init__(self, widget):
        self.widget, self.text, self.win = widget, "", None
        widget.bind("<Enter>", self.show, add="+")
        widget.bind("<Leave>", self.hide, add="+")

    def show(self, _event=None):
        if not self.text or self.win:
            return
        self.win = tk.Toplevel(self.widget)
        self.win.wm_overrideredirect(True)
        x, y = self.widget.winfo_rootx() + 10, self.widget.winfo_rooty() + self.widget.winfo_height() + 2
        self.win.wm_geometry(f"+{x}+{y}")
        tk.Label(self.win, text=self.text, bg="#fffbe6", fg=TEXT, font=(FONT, 9), justify="left",
                 relief="solid", bd=1, padx=6, pady=4).pack()

    def hide(self, _event=None):
        if self.win:
            self.win.destroy()
            self.win = None


class App:
    def __init__(self, root: tk.Tk, settings: Settings):
        self.root, self.settings = root, settings
        self.results: queue.Queue = queue.Queue()
        self.busy = False
        self.last_snapshot = None
        self.shown_symbols: list[str] = []
        self.cells: dict[tuple[str, str], dict[str, tuple[tk.Label, Tooltip]]] = {}
        self.coin_cells: dict[str, dict[str, tk.Widget]] = {}

        root.title("Crypto Movement Bot (signals only)")
        root.geometry("1600x900")
        root.minsize(900, 480)
        root.configure(bg=PAGE)
        if sys.platform == "win32":
            try:
                root.state("zoomed")  # 10 coins need the room: start maximised
            except tk.TclError:
                pass
        icon = PROJECT_DIR / "bot.ico"
        if icon.exists():
            try:
                root.iconbitmap(default=str(icon))
            except tk.TclError:  # .ico files only work on Windows
                pass
        self.f_body = tkfont.Font(family=FONT, size=10)
        self.f_bold = tkfont.Font(family=FONT, size=10, weight="bold")
        self.f_small = tkfont.Font(family=FONT, size=9)
        self.f_coin = tkfont.Font(family=FONT, size=12, weight="bold")
        self.f_price = tkfont.Font(family=FONT, size=11, weight="bold")

        self._build_header()
        self._build_info()
        self._build_footer()  # packed at the bottom before the table, so the table gets the space left
        self._build_table()
        self.build_rows(self._initial_symbols())

        self.root.after(200, self.refresh)
        self.root.after(500, self.poll)

    # --- layout ------------------------------------------------------------
    def _build_header(self):
        head = tk.Frame(self.root, bg=DARK, padx=16, pady=10)
        head.pack(fill="x")
        left = tk.Frame(head, bg=DARK)
        left.pack(side="left")
        tk.Label(left, text="Crypto Movement Bot", bg=DARK, fg="white", font=(FONT, 15, "bold")).pack(anchor="w")
        self.subtitle = tk.Label(left, text="Signals only, never places orders", bg=DARK, fg=DARK_MUTED,
                                 font=(FONT, 9))
        self.subtitle.pack(anchor="w")

        right = tk.Frame(head, bg=DARK)
        right.pack(side="right")
        tk.Button(right, text="⟳  Refresh now", command=self.refresh, bg="#238636", fg="white",
                  activebackground="#2ea043", activeforeground="white", relief="flat", bd=0,
                  font=(FONT, 10, "bold"), padx=12, pady=4, cursor="hand2").pack(side="right")
        self.status = tk.StringVar(value="")
        tk.Label(right, textvariable=self.status, bg=DARK, fg=DARK_MUTED, font=(FONT, 9), wraplength=420,
                 justify="right").pack(side="right", padx=12)

        self.chips_frame = tk.Frame(head, bg=DARK)
        self.chips_frame.pack(side="left", padx=(32, 0))
        self.chips = {}
        for key, title in (("dom", "BTC dominance"), ("fg", "Fear & Greed"), ("mcap", "Market cap 24h")):
            chip = tk.Frame(self.chips_frame, bg=DARK_CHIP, padx=12, pady=5)
            chip.pack(side="left", padx=(0, 8))
            tk.Label(chip, text=title.upper(), bg=DARK_CHIP, fg=DARK_MUTED, font=(FONT, 8, "bold")).pack(anchor="w")
            value = tk.Label(chip, text="…", bg=DARK_CHIP, fg=DARK_TEXT, font=(FONT, 12, "bold"))
            value.pack(anchor="w")
            self.chips[key] = value

    def _build_info(self):
        info = tk.Frame(self.root, bg=PAGE, padx=16, pady=8)
        info.pack(fill="x")
        self.swing_label = tk.Label(info, text="", font=(FONT, 10, "bold"), fg=TEXT, bg=PAGE, anchor="w",
                                    justify="left")
        self.swing_label.pack(anchor="w")
        self.bigmove_label = tk.Label(info, text="", font=(FONT, 10), fg=TEXT, bg=PAGE, anchor="w")
        self.bigmove_label.pack(anchor="w")
        self.coins_note = tk.Label(info, text="", font=(FONT, 9), fg=MUTED, bg=PAGE, anchor="w", justify="left")
        self.coins_note.pack(anchor="w")
        # TradingView / CoinMarketCap problems: only shown (and only take space) when there is one
        self.warn_note = tk.Label(info, text="", font=(FONT, 9), fg=WARN, bg=PAGE, anchor="w", justify="left")

    def _warn(self, tv: str = None, cmc: str = None):
        if tv is not None:
            self._tv_warn = tv
        if cmc is not None:
            self._cmc_warn = cmc
        text = "\n".join(t for t in (getattr(self, "_tv_warn", ""), getattr(self, "_cmc_warn", "")) if t)
        self.warn_note.configure(text=text)
        if text:
            self.warn_note.pack(anchor="w")
        else:
            self.warn_note.pack_forget()

    def _build_footer(self):
        foot = tk.Frame(self.root, bg=PAGE, padx=16, pady=8)
        foot.pack(side="bottom", fill="x")
        bar = tk.Frame(foot, bg=PAGE)
        bar.pack(fill="x")
        for text, cmd in (("Run backtest", self.backtest), ("Live track record", self.score),
                          ("Swing times", self.swings), ("Rebound levels", self.show_levels),
                          ("Big moves (2%+)", self.show_bigmoves)):
            ttk.Button(bar, text=text, command=cmd).pack(side="left", padx=(0, 6))
        legend = tk.Frame(bar, bg=PAGE)
        legend.pack(side="right")
        for text, fg, bg in (("LONG ▲", UP, UP_BG), ("SHORT ▼", DOWN, DOWN_BG)):
            tk.Label(legend, text=text, fg=fg, bg=bg, font=(FONT, 9, "bold"), padx=6).pack(side="left", padx=(0, 4))
        tk.Label(legend, text="= which way the model leans.   Blue level = strong (6+ tests).   "
                              "Hover a hit rate for details.", fg=MUTED, bg=PAGE, font=(FONT, 9)).pack(side="left")
        tk.Label(foot, bg=PAGE, fg=MUTED, font=(FONT, 9), anchor="w", justify="left", text=(
            "Signals only: this bot never places orders. Short-term crypto moves are close to random, "
            "so even a good model is wrong very often. Check the backtest before trusting any call.")
        ).pack(anchor="w", pady=(6, 0))

    def _build_table(self):
        pad = 16  # cell padding, left + right
        self.col_widths = [max(self.f_small.measure(COIN_COL_SAMPLE), self.f_coin.measure("WWWW #10")) + pad + 8]
        for _key, head, sample, _a in COLUMNS:
            self.col_widths.append(max(self.f_bold.measure(head), self.f_bold.measure(sample) + 12) + pad)

        wrap = tk.Frame(self.root, bg=LINE, bd=0)
        wrap.pack(fill="both", expand=True, padx=16, pady=(0, 4))
        wrap.grid_rowconfigure(1, weight=1)
        wrap.grid_columnconfigure(0, weight=1)

        self.head_canvas = tk.Canvas(wrap, bg=GREY_BG, highlightthickness=0, bd=0)
        self.head_canvas.grid(row=0, column=0, sticky="ew", pady=(1, 0), padx=(1, 0))
        self.head = tk.Frame(self.head_canvas, bg=GREY_BG)
        self.head_win = self.head_canvas.create_window(0, 0, window=self.head, anchor="nw")
        headings = ["Coin"] + [h for _k, h, _s, _a in COLUMNS]
        for c, h in enumerate(headings):
            self.head.grid_columnconfigure(c, minsize=self.col_widths[c], weight=1)
            tk.Label(self.head, text=h, bg=GREY_BG, fg=TEXT, font=self.f_bold, pady=7,
                     anchor="w" if c == 0 else "center", padx=10).grid(row=0, column=c, sticky="nsew")

        self.canvas = tk.Canvas(wrap, bg=CARD, highlightthickness=0, bd=0)
        self.canvas.grid(row=1, column=0, sticky="nsew", padx=(1, 0))
        vbar = ttk.Scrollbar(wrap, orient="vertical", command=self.canvas.yview)
        vbar.grid(row=1, column=1, sticky="ns")
        hbar = ttk.Scrollbar(wrap, orient="horizontal", command=self._xview)
        hbar.grid(row=2, column=0, sticky="ew")
        self.canvas.configure(yscrollcommand=vbar.set, xscrollcommand=hbar.set)
        self.body = tk.Frame(self.canvas, bg=CARD)
        self.body_win = self.canvas.create_window(0, 0, window=self.body, anchor="nw")
        for c, w in enumerate(self.col_widths):
            self.body.grid_columnconfigure(c, minsize=w, weight=1)
        self.body.bind("<Configure>", lambda e: self._fit())
        self.canvas.bind("<Configure>", lambda e: self._fit())
        self.canvas.bind("<Enter>", lambda e: self._wheel(True))
        self.canvas.bind("<Leave>", lambda e: self._wheel(False))

    def _xview(self, *args):
        self.canvas.xview(*args)
        self.head_canvas.xview(*args)

    def _fit(self):
        """Stretch the table to the window width (or scroll sideways when the window is narrower)."""
        natural = max(sum(self.col_widths), self.body.winfo_reqwidth(), self.head.winfo_reqwidth())
        width = max(natural, self.canvas.winfo_width())
        self.canvas.itemconfigure(self.body_win, width=width)
        self.head_canvas.itemconfigure(self.head_win, width=width)
        self.head_canvas.configure(height=self.head.winfo_reqheight())
        # never let the scroll area be shorter than the canvas, or Tk shifts the rows down and leaves a gap on top
        height = max(self.body.winfo_reqheight(), self.canvas.winfo_height())
        self.canvas.configure(scrollregion=(0, 0, width, height))
        self.head_canvas.configure(scrollregion=(0, 0, width, self.head.winfo_reqheight()))

    def _wheel(self, on: bool):
        if on:
            self.canvas.bind_all("<MouseWheel>", lambda e: self.canvas.yview_scroll(int(-e.delta / 120) or
                                                                                  (-1 if e.delta > 0 else 1), "units"))
            self.canvas.bind_all("<Button-4>", lambda e: self.canvas.yview_scroll(-3, "units"))
            self.canvas.bind_all("<Button-5>", lambda e: self.canvas.yview_scroll(3, "units"))
        else:
            for seq in ("<MouseWheel>", "<Button-4>", "<Button-5>"):
                self.canvas.unbind_all(seq)

    def _initial_symbols(self) -> list[str]:
        """Before the first update: the saved top coins, so the window looks right straight away."""
        if self.settings.top_coins > 0:
            from .topcoins import saved_coins

            saved = [c.symbol for c in saved_coins()][: self.settings.top_coins]
            if saved:
                return saved
        return list(self.settings.symbols)

    def _cell(self, row: int, col: int, bg: str, anchor: str, pill: bool) -> tuple[tk.Label, Tooltip]:
        box = tk.Frame(self.body, bg=bg)
        box.grid(row=row, column=col, sticky="nsew")
        lbl = tk.Label(box, text="", bg=bg, fg=TEXT, font=self.f_body, padx=8 if pill else 0, pady=1 if pill else 0)
        lbl.pack(anchor={"e": "e", "w": "w"}.get(anchor, "center"), expand=True, padx=8, pady=4)
        lbl.row_bg = bg
        return lbl, Tooltip(lbl)

    def build_rows(self, symbols: list[str]):
        """One block per coin: prices on the left (spanning its rows), one row per timeframe."""
        from .topcoins import coin_info

        for w in self.body.winfo_children():
            w.destroy()
        self.cells, self.coin_cells = {}, {}
        self.shown_symbols = list(symbols)
        r = 0
        for i, sym in enumerate(symbols):
            bg = CARD if i % 2 == 0 else ALT
            info = coin_info(sym)
            coin = tk.Frame(self.body, bg=bg, padx=10, pady=6)
            coin.grid(row=r, column=0, rowspan=len(TIMEFRAMES), sticky="nsew")
            strip = tk.Frame(coin, bg=LINE, width=4)
            strip.pack(side="left", fill="y", padx=(0, 10))
            inner = tk.Frame(coin, bg=bg)
            inner.pack(side="left", fill="both", expand=True)
            top = tk.Frame(inner, bg=bg)
            top.pack(anchor="w")
            tk.Label(top, text=coin_name(sym), bg=bg, fg=TEXT, font=self.f_coin).pack(side="left")
            rank = f"#{info.rank}  {info.name}" if info and info.rank else ""
            tk.Label(top, text=rank, bg=bg, fg=MUTED, font=self.f_small).pack(side="left", padx=(6, 0), pady=(3, 0))
            price = tk.Label(inner, text="…", bg=bg, fg=TEXT, font=self.f_price)
            price.pack(anchor="w")
            other = tk.Label(inner, text="", bg=bg, fg=MUTED, font=self.f_small)
            other.pack(anchor="w")
            change = tk.Frame(inner, bg=bg)
            change.pack(anchor="w")
            ch1 = tk.Label(change, text="", bg=bg, fg=MUTED, font=self.f_small)
            ch1.pack(side="left")
            ch24 = tk.Label(change, text="", bg=bg, fg=MUTED, font=self.f_small)
            ch24.pack(side="left", padx=(8, 0))
            self.coin_cells[sym] = {"strip": strip, "price": price, "other": other, "ch1": ch1, "ch24": ch24}
            for tf in TIMEFRAMES:
                row = {}
                for c, (key, _h, _s, anchor) in enumerate(COLUMNS, start=1):
                    row[key] = self._cell(r, c, bg, anchor, key in PILL_COLUMNS)
                row["tf"][0].configure(text=tf, font=self.f_bold, fg=MUTED)
                row["pred"][0].configure(text="loading…", fg=MUTED)
                self.cells[(sym, tf)] = row
                r += 1
            tk.Frame(self.body, bg=LINE, height=1).grid(row=r, column=0, columnspan=len(COLUMNS) + 1, sticky="ew")
            r += 1
        self.canvas.yview_moveto(0)
        self.root.after_idle(self._fit)

    # --- background work -------------------------------------------------
    def _run(self, kind, fn):
        def worker():
            try:
                self.results.put((kind, fn(), None))
            except Exception as err:  # noqa: BLE001
                self.results.put((kind, None, err))
        threading.Thread(target=worker, daemon=True).start()

    def refresh(self):
        if self.busy:
            return
        self.busy = True
        self.status.set("Updating..." if self.last_snapshot else
                        "Starting: downloading prices and training (first start takes longest)...")

        def job():
            from .predictor import take_snapshot  # imported here, off the window's thread

            return take_snapshot(self.settings)
        self._run("snapshot", job)

    def backtest(self):
        self.status.set("Backtesting (a few minutes for all coins)...")

        def job():
            from .backtest import format_result, walk_forward
            from .predictor import load_candles

            parts = []
            for sym in self.settings.symbols:
                for tf in TIMEFRAMES:
                    name = f"{coin_name(sym)} {tf}"
                    try:
                        candles, src = load_candles(self.settings, tf, total=max(5000, self.settings.history_candles),
                                                    symbol=sym)
                        parts.append(format_result(walk_forward(candles, name, self.settings.confidence_threshold,
                                                                self.settings.fee_rate,
                                                                sl_mult=self.settings.sl_atr_mult,
                                                                tp_mult=self.settings.tp_atr_mult,
                                                                tp_sl_candles=self.settings.tp_sl_candles)) + f"\n  (data: {src})")
                    except Exception as err:  # noqa: BLE001
                        parts.append(f"== {name}: failed: {err}")
            return "\n\n".join(parts)
        self._run("text:Backtest", job)

    def show_bigmoves(self):
        from .bigmoves import report_text

        self.popup("Big moves", report_text(self.settings.big_move_pct))

    def show_levels(self):
        if self.last_snapshot is None:
            self.status.set("Wait for the first update, then try again.")
            return
        from .report import levels_report

        self.popup("Rebound levels", levels_report(self.last_snapshot))

    def tick_swings(self):
        """Update the 'next swing window' line every 30 seconds; orange when a window is near."""
        from .swings import load_results, next_window_text, next_windows

        data = load_results()
        self.swing_label.configure(text=next_window_text(data))
        upcoming = next_windows(data)
        near = False
        if upcoming:
            from datetime import datetime
            mins = (upcoming[0][0] - datetime.now().astimezone()).total_seconds() / 60
            near = mins <= 30
        self.swing_label.configure(fg="#bc4c00" if near else TEXT)
        self.root.after(30_000, self.tick_swings)

    def tick_swings_once(self):
        from .swings import load_results, next_window_text

        self.swing_label.configure(text=next_window_text(load_results()))

    def swings(self):
        self.status.set("Studying swing times (first run downloads 5 years of data, a few minutes)...")
        from .swings import load_results, report_text, run_study

        def job():
            results = run_study(self.settings, progress=lambda msg: self.results.put(("status", msg, None)))
            return report_text(results)
        data = load_results()
        if data:  # show the saved study straight away, refresh it in the background
            self.popup("Swing times (saved study, updating...)", report_text(data["coins"]))
        self._run("text:Swing times", job)

    def score(self):
        from .predictor import score_log

        def job():
            t = score_log(self.settings)
            return "No finished predictions logged yet." if t.empty else \
                t.to_string(index=False, float_format=lambda x: f"{x:.1%}")
        self._run("text:Live track record", job)

    def poll(self):
        try:
            while True:
                kind, value, err = self.results.get_nowait()
                if kind == "snapshot":
                    self.busy = False
                    if err:
                        self.status.set(f"Update failed: {err}")
                    else:
                        first = self.last_snapshot is None
                        self.show(value)
                        if first:
                            self.tick_swings()
                    self.root.after(self.settings.refresh_seconds * 1000, self.refresh)
                elif kind == "status":
                    self.status.set(value)
                elif kind.startswith("text:"):
                    self.status.set("")
                    self.popup(kind[5:], str(err) if err else value)
                    if kind == "text:Swing times":
                        self.root.after(100, self.tick_swings_once)
        except queue.Empty:
            pass
        self.root.after(500, self.poll)

    # --- display ---------------------------------------------------------
    def _set(self, label_tip, text, fg=TEXT, bg=None, bold=False, tip=""):
        lbl, tooltip = label_tip
        lbl.configure(text=text, fg=fg, bg=bg or lbl.row_bg, font=self.f_bold if bold else self.f_body)
        tooltip.text = tip

    def _show_market(self, snap):
        from .report import pct

        c = snap.cmc
        dom = c.btc_dominance if c else None
        self.chips["dom"].configure(text=pct(dom, False) if dom is not None else "n/a")
        if c and c.fear_greed_value is not None:
            v = c.fear_greed_value
            colour = "#ff7b72" if v < 25 else "#ffa657" if v < 45 else DARK_TEXT if v <= 55 else "#7ee787"
            self.chips["fg"].configure(text=f"{v} · {c.fear_greed_label}", fg=colour)
        else:
            self.chips["fg"].configure(text="n/a", fg=DARK_TEXT)
        m = c.total_market_cap_change_24h if c else None
        self.chips["mcap"].configure(text=pct(m) if m is not None else "n/a",
                                     fg=DARK_TEXT if m is None else ("#7ee787" if m >= 0 else "#ff7b72"))
        self._warn(cmc=f"CoinMarketCap: {c.error[:200]}" if c and c.error else "")

    def _show_coin(self, sym, snap):
        from .report import EXCHANGE_NAMES, money, pct

        cells = self.coin_cells.get(sym)
        if not cells:
            return
        prices = snap.prices.get(sym, {})
        listed = [(k, v) for k, v in prices.items() if v is not None]
        if listed:
            main_ex, main = listed[0]
            cells["price"].configure(text=money(main))
            rest = [f"{EXCHANGE_NAMES.get(k, k)} {money(v)}" for k, v in listed[1:]]
            missing = [EXCHANGE_NAMES.get(k, k) for k, v in prices.items() if v is None]
            text = "   ".join(rest) if rest else f"{EXCHANGE_NAMES.get(main_ex, main_ex)} only"
            if rest and missing:
                text += f"   (no {', '.join(missing)})"
            elif not rest:
                text = f"{EXCHANGE_NAMES.get(main_ex, main_ex)} price"
            cells["other"].configure(text=text)
        else:
            cells["price"].configure(text="n/a")
            cells["other"].configure(text="no price yet")
        q = snap.cmc.coins.get(coin_name(sym)) if snap.cmc else None
        for key, label, value in (("ch1", "1h", q.change_1h if q else None), ("ch24", "24h", q.change_24h if q else None)):
            colour = MUTED if value is None else (UP if value >= 0 else DOWN)
            cells[key].configure(text=f"{label} {pct(value)}" if value is not None else "", fg=colour)
        day = q.change_24h if q else None
        cells["strip"].configure(bg=LINE if day is None else (UP if day >= 0 else DOWN))

    def _row_error(self, sym, tf, row, text, full):
        """A failed row shows its reason in one wide cell instead of squeezing it into a column."""
        lbl = row.get("error_label")
        if not text:
            if lbl:
                lbl.master.grid_remove()
            return
        if lbl is None:
            pred = row["pred"][0].master
            info = pred.grid_info()
            box = tk.Frame(self.body, bg=row["pred"][0].row_bg)
            box.grid(row=info["row"], column=info["column"] + 1, columnspan=len(COLUMNS) - 2, sticky="nsew")
            lbl = tk.Label(box, text="", bg=box["bg"], fg=WARN, font=self.f_body, anchor="w")
            lbl.pack(fill="x", padx=8, pady=4)
            row["error_label"] = lbl
            row["error_tip"] = Tooltip(lbl)
        lbl.configure(text=text)
        row["error_tip"].text = full
        lbl.master.grid()

    def show(self, snap):
        from .bigmoves import latest_text
        from .levels import level_text
        from .report import (TV_NAMES, hit_rate_text, local_hhmm, money, prediction_label, signal_badge,
                             tpsl_badge, tpsl_text)

        self.last_snapshot = snap
        symbols = snap.symbols or list(dict.fromkeys(p.symbol for p in snap.predictions))
        if symbols != self.shown_symbols:
            self.build_rows(symbols)
        self.subtitle.configure(text=f"Following {len(symbols)} coins · signals only, never places orders")
        self.bigmove_label.configure(text=latest_text())
        self.coins_note.configure(text=snap.coins_note)
        tv_errors = {p.tv.error for p in snap.predictions if p.tv.error and p.tv.error != "no rating yet"}
        self._warn(tv=f"TradingView rating unavailable: {sorted(tv_errors)[0][:160]}" if tv_errors else "")
        self._show_market(snap)
        for sym in symbols:
            self._show_coin(sym, snap)

        for p in snap.predictions:
            row = self.cells.get((p.symbol, p.timeframe))
            if not row:
                continue
            if p.error or not p.signal:
                self._set(row["pred"], "error", WARN, bold=True, tip=p.error or "")
                for key in ("bot", "conf", "tv", "closes", "entry", "tp", "sl", "tpsl", "last", "sup", "res"):
                    self._set(row[key], "")
                cause = (p.error or "").split(" candles. ", 1)[-1].split(" | ")[0]
                self._set(row["record"], "")
                self._row_error(p.symbol, p.timeframe, row, cause, p.error or "")
                continue
            self._row_error(p.symbol, p.timeframe, row, "", "")
            s, r, t = p.signal, p.results, p.tpsl_results
            side = "LONG" if s.p_up > 0.5 else "SHORT"
            self._set(row["pred"], prediction_label(s), UP if side == "LONG" else DOWN,
                      UP_BG if side == "LONG" else DOWN_BG, bold=True, tip=f"P(up) = {s.p_up:.2f}")
            self._set(row["bot"], s.direction, COLOURS[s.direction], bold=s.direction != "NEUTRAL")
            self._set(row["conf"], f"{s.confidence:.0%}")
            tv = TV_NAMES.get(p.tv.recommendation or "", "n/a")
            self._set(row["tv"], tv, {"UP": UP, "DOWN": DOWN}.get(p.tv.direction, MUTED),
                      tip=(p.tv.error or "") if tv == "n/a" else "")
            self._set(row["closes"], local_hhmm(p.target_close_time), MUTED)
            self._set(row["entry"], money(p.last_close))
            self._set(row["tp"], money(p.take_profit), UP)
            self._set(row["sl"], money(p.stop_loss), DOWN)
            if not t or t.last_outcome in (None, "EXPIRED"):
                self._set(row["tpsl"], tpsl_badge(t), MUTED, GREY_BG if t and t.last_outcome else None,
                          tip=f"TP/SL: {tpsl_text(t)}")
            else:
                good = t.last_outcome == "TP"
                self._set(row["tpsl"], tpsl_badge(t), UP if good else DOWN, UP_BG if good else DOWN_BG, bold=True,
                          tip=f"TP/SL: {tpsl_text(t)}")
            if not r or r.last_hit is None:
                self._set(row["last"], "waiting", MUTED, GREY_BG,
                          tip=f"First check when the candle closes at {local_hhmm(p.target_close_time)}")
            else:
                self._set(row["last"], signal_badge(r), "white", UP if r.last_hit else DOWN, bold=True)
            if r and r.all_checked:
                record = f"{r.all_hit_rate:.0%} of {r.all_checked}"
                if t and t.finished:
                    record += f" · {t.total_r:+.1f}R"
                rate = r.all_hit_rate
                colour = UP if rate >= 0.55 else DOWN if rate < 0.45 else TEXT
                self._set(row["record"], record, colour,
                          tip=f"Leans right: {hit_rate_text(r)}\nTP/SL plan: {tpsl_text(t)}")
            else:
                self._set(row["record"], "-", MUTED)
            sup = p.supports[0] if p.supports else None
            res = p.resistances[0] if p.resistances else None
            self._set(row["sup"], level_text(sup), LEVEL_COLOURS.get(sup.strength if sup else "", MUTED))
            self._set(row["res"], level_text(res), LEVEL_COLOURS.get(res.strength if res else "", MUTED))
        self.status.set(f"Updated {snap.created.astimezone():%H:%M:%S}")

    def popup(self, title, text):
        win = tk.Toplevel(self.root)
        win.title(title)
        win.geometry("1150x560")
        box = scrolledtext.ScrolledText(win, font=("Consolas", 10), wrap="none")
        box.insert("1.0", text)
        box.configure(state="disabled")
        box.pack(fill="both", expand=True)


def run(settings: Settings) -> None:
    root = tk.Tk()
    App(root, settings)
    root.mainloop()
