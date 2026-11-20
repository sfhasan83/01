"""Desktop window (tkinter ships with Python on Windows, nothing extra to install).

Layout: a dark header with the market mood, a filter bar, then one sortable row per stock.
The last saved signals show instantly; an update (download + retrain) runs in the background.
"""
from __future__ import annotations

import os
import queue
import sys
import threading
import tkinter as tk
from tkinter import font as tkfont
from tkinter import filedialog, scrolledtext, ttk

from . import HORIZONS
from .config import DATA_DIR, LOG_DIR, PROJECT_DIR, Settings, pct

FONT = "Segoe UI"
PAGE = "#f3f5f8"
CARD = "#ffffff"
ALT = "#f7f9fb"
LINE = "#e1e6ec"
TEXT = "#1f2328"
MUTED = "#6e7781"
DARK = "#161b22"
DARK_CHIP = "#262c36"
DARK_TEXT = "#e6edf3"
DARK_MUTED = "#8b949e"
UP, UP_BG = "#1a7f37", "#dafbe1"
DOWN, DOWN_BG = "#cf222e", "#ffebe9"
GREY_BG = "#eaeef2"
WARN = "#9a6700"

# (key, heading, width, anchor)
COLUMNS = (
    ("symbol", "Symbol", 80, "w"),
    ("name", "Company", 170, "w"),
    ("sector", "Sector", 130, "w"),
    ("close", "Close (Rs)", 82, "e"),
    ("change", "Day", 86, "e"),
    ("1D", "1 day", 84, "center"),
    ("1W", "1 week", 84, "center"),
    ("1M", "1 month", 84, "center"),
    ("tp", "Take profit", 108, "e"),
    ("sl", "Stop loss", 100, "e"),
    ("trend", "Trend", 80, "center"),
    ("rsi", "RSI", 42, "e"),
    ("turnover", "Turnover", 76, "e"),
    ("record", "Backtest", 82, "center"),
)
SIGNAL_FILTERS = ("All signals", "BUY only", "SELL only", "BUY or SELL")


def _money_short(x) -> str:
    if x != x:
        return "n/a"
    for div, unit in ((1e9, "B"), (1e6, "M"), (1e3, "K")):
        if abs(x) >= div:
            return f"{x / div:,.1f}{unit}"
    return f"{x:,.0f}"


class App:
    def __init__(self, root: tk.Tk, settings: Settings):
        self.root, self.settings = root, settings
        self.results: queue.Queue = queue.Queue()
        self.busy = False
        self.scan = None
        self.sort_key, self.sort_desc = "1W", True

        root.title("PSX Signal Bot (signals only)")
        root.geometry("1500x860")
        root.minsize(900, 480)
        root.configure(bg=PAGE)
        if sys.platform == "win32":
            try:
                root.state("zoomed")
            except tk.TclError:
                pass
        icon = PROJECT_DIR / "bot.ico"
        if icon.exists():
            try:
                root.iconbitmap(default=str(icon))
            except tk.TclError:
                pass
        self.f_body = tkfont.Font(family=FONT, size=10)
        self.f_bold = tkfont.Font(family=FONT, size=10, weight="bold")

        self._style()
        self._build_header()
        self._build_filters()
        self._build_footer()
        self._build_table()

        self.root.after(100, self.load_saved)
        self.root.after(400, self.poll)

    # --- layout ------------------------------------------------------------
    def _style(self):
        st = ttk.Style(self.root)
        try:
            st.theme_use("clam")
        except tk.TclError:
            pass
        st.configure("Treeview", font=(FONT, 10), rowheight=26, background=CARD, fieldbackground=CARD,
                     foreground=TEXT, bordercolor=LINE, borderwidth=0)
        st.configure("Treeview.Heading", font=(FONT, 10, "bold"), background=GREY_BG, foreground=TEXT,
                     relief="flat", padding=(6, 6))
        st.map("Treeview.Heading", background=[("active", LINE)])
        st.map("Treeview", background=[("selected", "#ddf4ff")], foreground=[("selected", TEXT)])
        st.configure("TCheckbutton", background=PAGE, font=(FONT, 10))
        st.configure("TLabel", background=PAGE, font=(FONT, 10))

    def _build_header(self):
        head = tk.Frame(self.root, bg=DARK, padx=16, pady=10)
        head.pack(fill="x")
        left = tk.Frame(head, bg=DARK)
        left.pack(side="left")
        tk.Label(left, text="PSX Signal Bot", bg=DARK, fg="white", font=(FONT, 15, "bold")).pack(anchor="w")
        self.subtitle = tk.Label(left, text="Pakistan Stock Exchange · signals only, never places orders",
                                 bg=DARK, fg=DARK_MUTED, font=(FONT, 9))
        self.subtitle.pack(anchor="w")

        right = tk.Frame(head, bg=DARK)
        right.pack(side="right")
        self.update_btn = tk.Button(right, text="⟳  Update data & signals", command=self.update, bg="#238636",
                                    fg="white", activebackground="#2ea043", activeforeground="white", relief="flat",
                                    bd=0, font=(FONT, 10, "bold"), padx=12, pady=4, cursor="hand2")
        self.update_btn.pack(side="right")
        self.status = tk.StringVar(value="")
        # progress / result line, full width under the header (the header itself is full of tiles)
        status_bar = tk.Frame(self.root, bg=DARK_CHIP, padx=16, pady=4)
        status_bar.pack(fill="x")
        tk.Label(status_bar, textvariable=self.status, bg=DARK_CHIP, fg=DARK_TEXT, font=(FONT, 9),
                 anchor="w", justify="left").pack(fill="x")

        chips = tk.Frame(head, bg=DARK)
        chips.pack(side="left", padx=(24, 0))
        self.chips = {}
        for key, title in (("asof", "Prices up to"), ("stocks", "Stocks"), ("breadth", "Above 50-day"),
                           ("mkt5", "Median 5 days"), ("calls", "1-week calls")):
            chip = tk.Frame(chips, bg=DARK_CHIP, padx=10, pady=5)
            chip.pack(side="left", padx=(0, 6))
            tk.Label(chip, text=title.upper(), bg=DARK_CHIP, fg=DARK_MUTED, font=(FONT, 8, "bold"),
                     anchor="w").pack(anchor="w", fill="x")
            value = tk.Label(chip, text="…", bg=DARK_CHIP, fg=DARK_TEXT, font=(FONT, 12, "bold"))
            value.pack(anchor="w")
            self.chips[key] = value

    def _build_filters(self):
        bar = tk.Frame(self.root, bg=PAGE, padx=16, pady=8)
        bar.pack(fill="x")
        ttk.Label(bar, text="Search").pack(side="left")
        self.search = tk.StringVar()
        self.search.trace_add("write", lambda *_: self.fill())
        ttk.Entry(bar, textvariable=self.search, width=18).pack(side="left", padx=(6, 14))
        ttk.Label(bar, text="Sector").pack(side="left")
        self.sector = tk.StringVar(value="All sectors")
        self.sector_box = ttk.Combobox(bar, textvariable=self.sector, values=["All sectors"], width=30,
                                       state="readonly")
        self.sector_box.pack(side="left", padx=(6, 14))
        self.sector_box.bind("<<ComboboxSelected>>", lambda e: self.fill())
        ttk.Label(bar, text="Show").pack(side="left")
        self.sig_filter = tk.StringVar(value=SIGNAL_FILTERS[0])
        box = ttk.Combobox(bar, textvariable=self.sig_filter, values=SIGNAL_FILTERS, width=12, state="readonly")
        box.pack(side="left", padx=(6, 4))
        box.bind("<<ComboboxSelected>>", lambda e: self.fill())
        ttk.Label(bar, text="for").pack(side="left")
        self.horizon = tk.StringVar(value="1W")
        hb = ttk.Combobox(bar, textvariable=self.horizon, values=list(HORIZONS), width=4, state="readonly")
        hb.pack(side="left", padx=(4, 14))
        hb.bind("<<ComboboxSelected>>", lambda e: self.fill())
        self.liquid_only = tk.BooleanVar(value=True)
        ttk.Checkbutton(bar, text="Hide illiquid stocks", variable=self.liquid_only,
                        command=self.fill).pack(side="left")
        self.count_label = tk.Label(bar, text="", bg=PAGE, fg=MUTED, font=(FONT, 9))
        self.count_label.pack(side="right")
        self.note = tk.Label(self.root, text="", bg=PAGE, fg=WARN, font=(FONT, 9), anchor="w", justify="left",
                             padx=16)

    def _build_footer(self):
        foot = tk.Frame(self.root, bg=PAGE, padx=16, pady=8)
        foot.pack(side="bottom", fill="x")
        bar = tk.Frame(foot, bg=PAGE)
        bar.pack(fill="x")
        for text, cmd in (("Stock details", self.details), ("Run backtest", self.backtest),
                          ("Last backtest", self.last_backtest), ("Live track record", self.score),
                          ("Export to CSV", self.export), ("Open data folder", self.open_folder)):
            ttk.Button(bar, text=text, command=cmd).pack(side="left", padx=(0, 6))
        legend = tk.Frame(foot, bg=PAGE)
        legend.pack(anchor="w", pady=(6, 0))
        for text, fg, bg in (("BUY", UP, UP_BG), ("SELL", DOWN, DOWN_BG)):
            tk.Label(legend, text=text, fg=fg, bg=bg, font=(FONT, 9, "bold"), padx=6).pack(side="left", padx=(0, 4))
        tk.Label(legend, text="= call and confidence.  HOLD ▲/▼ = no clear call.  UC/LC = locked at the daily "
                              "price limit (hard to trade).  Double-click a stock for details.",
                 fg=MUTED, bg=PAGE, font=(FONT, 9)).pack(side="left")
        tk.Label(foot, bg=PAGE, fg=MUTED, font=(FONT, 9), anchor="w", justify="left", text=(
            "Signals only: this bot never places orders. Daily stock moves are mostly noise, so even a good "
            "model is wrong very often. Check the backtest, and prefer liquid stocks, before trusting any call.")
        ).pack(anchor="w", pady=(2, 0))

    def _build_table(self):
        wrap = tk.Frame(self.root, bg=LINE)
        wrap.pack(fill="both", expand=True, padx=16, pady=(0, 4))
        wrap.grid_rowconfigure(0, weight=1)
        wrap.grid_columnconfigure(0, weight=1)
        keys = [c[0] for c in COLUMNS]
        self.tree = ttk.Treeview(wrap, columns=keys, show="headings", selectmode="browse")
        for key, head, width, anchor in COLUMNS:
            self.tree.heading(key, text=head, command=lambda k=key: self.sort_by(k))
            self.tree.column(key, width=width, minwidth=40, anchor=anchor, stretch=key in ("name", "sector"))
        vbar = ttk.Scrollbar(wrap, orient="vertical", command=self.tree.yview)
        hbar = ttk.Scrollbar(wrap, orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=vbar.set, xscrollcommand=hbar.set)
        self.tree.grid(row=0, column=0, sticky="nsew", padx=1, pady=1)
        vbar.grid(row=0, column=1, sticky="ns")
        hbar.grid(row=1, column=0, sticky="ew")
        self.tree.tag_configure("BUY", background=UP_BG, foreground=UP)
        self.tree.tag_configure("SELL", background=DOWN_BG, foreground=DOWN)
        self.tree.tag_configure("HOLD", background=CARD)
        self.tree.tag_configure("HOLD_ALT", background=ALT)
        self.tree.tag_configure("illiquid", foreground=MUTED)
        self.tree.bind("<Double-1>", lambda e: self.details())
        self.tree.bind("<Return>", lambda e: self.details())

    # --- data in the table -----------------------------------------------------
    def load_saved(self):
        from .signals import load_scan

        try:
            scan = load_scan()
        except Exception as err:  # noqa: BLE001
            scan = None
            self.status.set(f"Saved signals could not be read: {err}")
        if scan is not None:
            self.show(scan)
            self.status.set(f"Showing saved signals from {scan.created.replace('T', ' ')[:16]}.")
        if self.settings.auto_update or scan is None:
            self.update()
        elif scan is None:
            self.status.set("No signals yet. Click 'Update data & signals' (the first download takes a few minutes).")

    def show(self, scan):
        self.scan = scan
        self.chips["asof"].configure(text=scan.as_of)
        self.chips["stocks"].configure(text=f"{scan.stocks}")
        b = scan.breadth
        self.chips["breadth"].configure(text=f"{b:.0f}%" if b == b else "n/a",
                                        fg=DARK_TEXT if b != b else ("#7ee787" if b >= 55 else "#ff7b72" if b < 45
                                                                     else DARK_TEXT))
        m = scan.market_5d
        self.chips["mkt5"].configure(text=pct(m), fg=DARK_TEXT if m != m else ("#7ee787" if m >= 0 else "#ff7b72"))
        c = scan.counts.get("1W", {})
        self.chips["calls"].configure(text=f"{c.get('BUY', 0)} BUY · {c.get('SELL', 0)} SELL")
        sectors = sorted({s for s in scan.table["sector"] if s})
        self.sector_box.configure(values=["All sectors"] + sectors)
        if scan.notes:
            self.note.configure(text="  ".join(scan.notes))
            self.note.pack(fill="x", before=self.tree.master)
        else:
            self.note.pack_forget()
        self.fill()

    def _rows(self):
        t = self.scan.table
        hz = self.horizon.get()
        if self.liquid_only.get() and "liquid" in t:
            t = t[t["liquid"]]
        if self.sector.get() not in ("", "All sectors"):
            t = t[t["sector"] == self.sector.get()]
        want = self.sig_filter.get()
        if want == "BUY only":
            t = t[t[f"sig_{hz}"] == "BUY"]
        elif want == "SELL only":
            t = t[t[f"sig_{hz}"] == "SELL"]
        elif want == "BUY or SELL":
            t = t[t[f"sig_{hz}"] != "HOLD"]
        q = self.search.get().strip().upper()
        if q:
            t = t[t.index.str.contains(q, regex=False) | t["name"].str.upper().str.contains(q, regex=False)]
        key = self.sort_key
        col = {"symbol": None, "name": "name", "sector": "sector", "close": "close", "change": "change_pct",
               "1D": "p_1D", "1W": "p_1W", "1M": "p_1M", "tp": f"tp_{hz}", "sl": f"sl_{hz}", "trend": "trend",
               "rsi": "rsi", "turnover": "turnover", "record": f"bt_hit_{hz}"}.get(key)
        if col is None:
            t = t.sort_index(ascending=not self.sort_desc)
        elif col in t:
            t = t.sort_values(col, ascending=not self.sort_desc, na_position="last")
        return t

    def fill(self):
        if self.scan is None:
            return
        from .report import signal_cell

        hz = self.horizon.get()
        self.tree.delete(*self.tree.get_children())
        rows = self._rows()
        for i, (sym, r) in enumerate(rows.iterrows()):
            calls, hit = r.get(f"bt_calls_{hz}", float("nan")), r.get(f"bt_hit_{hz}", float("nan"))
            record = f"{hit:.0%} of {int(calls)}" if calls == calls and calls and hit == hit else "-"
            lim = r.get("limit", "")
            day = pct(r["change_pct"]) + (f" {lim}" if isinstance(lim, str) and lim else "")
            values = (sym, r["name"], r["sector"], f"{r['close']:,.2f}", day,
                      signal_cell(r, "1D"), signal_cell(r, "1W"), signal_cell(r, "1M"),
                      f"{r[f'tp_{hz}']:,.2f}", f"{r[f'sl_{hz}']:,.2f}", r["trend"], f"{r['rsi']:.0f}",
                      _money_short(r["turnover"]), record)
            sig = r[f"sig_{hz}"]
            tags = [sig if sig != "HOLD" else ("HOLD" if i % 2 == 0 else "HOLD_ALT")]
            if not r.get("liquid", True):
                tags.append("illiquid")
            self.tree.insert("", "end", iid=sym, values=values, tags=tags)
        heading = {k: h for k, h, _w, _a in COLUMNS}
        for key in heading:
            arrow = (" ▼" if self.sort_desc else " ▲") if key == self.sort_key else ""
            label = heading[key]
            if key in ("tp", "sl"):
                label += f" ({hz})"
            self.tree.heading(key, text=label + arrow)
        self.count_label.configure(text=f"{len(rows)} of {len(self.scan.table)} stocks shown")

    def sort_by(self, key):
        if self.sort_key == key:
            self.sort_desc = not self.sort_desc
        else:
            self.sort_key = key
            self.sort_desc = key not in ("symbol", "name", "sector", "trend")
        self.fill()

    # --- background work ---------------------------------------------------
    def _run(self, kind, fn):
        def worker():
            try:
                self.results.put((kind, fn(), None))
            except Exception as err:  # noqa: BLE001
                self.results.put((kind, None, err))
        threading.Thread(target=worker, daemon=True).start()

    def _progress(self, msg):
        self.results.put(("status", msg, None))

    def update(self):
        if self.busy:
            return
        self.busy = True
        self.update_btn.configure(state="disabled", text="Updating…")

        def job():
            from .signals import run_scan
            from .store import update_all

            summary, err = None, None
            try:
                summary = update_all(self.settings, progress=self._progress)
            except Exception as e:  # noqa: BLE001 - still make signals from the saved data
                err = e
            scan = run_scan(self.settings, progress=self._progress)
            return scan, summary, err
        self._run("scan", job)

    def backtest(self):
        if self.busy:
            self.status.set("Wait for the current job to finish.")
            return
        self.busy = True
        self.status.set("Backtesting all stocks over the saved years (10 to 30 minutes)...")

        def job():
            from .backtest import report_text, walk_forward

            res = walk_forward(self.settings, progress=self._progress)
            return report_text(res, self.settings)
        self._run("text:Backtest", job)

    def last_backtest(self):
        from .backtest import REPORT_FILE

        if REPORT_FILE.exists():
            self.popup("Last backtest", REPORT_FILE.read_text(encoding="utf-8"))
        else:
            self.status.set("No backtest yet: click 'Run backtest'.")

    def score(self):
        def job():
            from .signals import live_record

            t = live_record(self.settings)
            return ("No finished calls to check yet. The bot logs its calls every time it updates; "
                    "come back after a few trading days.") if t.empty else \
                t.to_string(index=False, float_format=lambda x: f"{x:.1%}")
        self._run("text:Live track record", job)

    def details(self):
        sel = self.tree.selection()
        if not sel or self.scan is None:
            self.status.set("Select a stock first.")
            return
        from .report import stock_text
        from .store import load_history

        sym = sel[0]
        self.popup(f"{sym} details", stock_text(self.scan, sym, load_history(sym)), size="900x520")

    def export(self):
        if self.scan is None:
            return
        path = filedialog.asksaveasfilename(defaultextension=".csv", initialfile=f"psx-signals-{self.scan.as_of}.csv",
                                            filetypes=[("CSV", "*.csv")])
        if path:
            self.scan.table.to_csv(path, index_label="symbol", float_format="%.4f")
            self.status.set(f"Saved {path}")

    def open_folder(self):
        folder = DATA_DIR if DATA_DIR.exists() else LOG_DIR
        try:
            if sys.platform == "win32":
                os.startfile(folder)  # noqa: S606
            else:
                self.status.set(str(folder))
        except OSError as err:
            self.status.set(str(err))

    def poll(self):
        try:
            while True:
                kind, value, err = self.results.get_nowait()
                if kind == "status":
                    self.status.set(value)
                elif kind == "scan":
                    self.busy = False
                    self.update_btn.configure(state="normal", text="⟳  Update data & signals")
                    if err:
                        self.status.set(f"Update failed: {err}")
                        continue
                    scan, summary, dl_err = value
                    self.show(scan)
                    text = f"Signals for {scan.as_of}. "
                    text += summary.text() if summary else f"Download failed, used saved prices: {dl_err}"
                    self.status.set(text)
                elif kind.startswith("text:"):
                    self.busy = False
                    self.status.set("")
                    self.popup(kind[5:], str(err) if err else value)
                    if kind == "text:Backtest" and not err:
                        self._reload_record()
        except queue.Empty:
            pass
        self.root.after(400, self.poll)

    def _reload_record(self):
        from .signals import load_stock_record

        rec = load_stock_record()
        if rec is not None and self.scan is not None:
            t = self.scan.table.drop(columns=[c for c in self.scan.table if c.startswith("bt_")])
            self.scan.table = t.join(rec, how="left")
            self.fill()

    def popup(self, title, text, size="1150x600"):
        win = tk.Toplevel(self.root)
        win.title(title)
        win.geometry(size)
        box = scrolledtext.ScrolledText(win, font=("Consolas", 10), wrap="none")
        box.insert("1.0", text)
        box.configure(state="disabled")
        box.pack(fill="both", expand=True)


def run(settings: Settings) -> None:
    root = tk.Tk()
    App(root, settings)
    root.mainloop()
