# BTC Movement Bot (Windows)

A small Windows program that predicts whether Bitcoin will go **UP** or **DOWN** over the next
**5 minutes, 15 minutes and 1 hour**, using data from **Binance, MEXC, CoinMarketCap and TradingView**.

> **Signals only.** The bot never logs in to an exchange and never places orders.
> **Please read [How good are the predictions?](#how-good-are-the-predictions) before using it.**

## What you get

- A **desktop window** (`start-gui.bat`) that refreshes every minute.
- A **console view** (`start-watch.bat`) if you prefer a text screen.
- A **backtest** (`backtest.bat`) that shows how accurate the bot would have been on recent history.
- A **live track record**: every prediction is saved to `logs\predictions.csv`, and the
  "Live track record" button (or `python -m btc_bot score`) checks how they actually turned out.
- An optional **TradingView alert receiver** (`start-webhook.bat`).

For each timeframe it shows:

| Column | Meaning |
|---|---|
| Bot says | `UP`, `DOWN`, or `NEUTRAL` when the bot is not sure enough |
| Confidence | How sure the model is (50% = coin flip) |
| P(up) | The model's probability that the candle closes higher |
| TradingView | TradingView's own technical rating for the same timeframe (Strong buy ... Strong sell) |
| Agree? | Whether the bot and TradingView point the same way |
| For candle closing | The local time the predicted candle closes, and the price it is measured from |

Above the table you see the live price on Binance and MEXC, and from CoinMarketCap the 1h and 24h change,
BTC dominance and the Fear & Greed index.

## Setup on Windows (about 5 minutes)

1. **Install Python 3.10 or newer** from <https://www.python.org/downloads/>.
   On the first installer screen tick **"Add python.exe to PATH"**.
2. **Download this folder**: on GitHub click **Code → Download ZIP**, unzip it, and open the `btc-bot` folder.
3. **Double-click `setup.bat`.** It creates a private Python environment in `.venv` and installs everything.
4. **Get a free CoinMarketCap API key** at <https://coinmarketcap.com/api/> (Basic plan).
   Open the new `.env` file in Notepad and paste it after `CMC_API_KEY=`. Save.
   (The bot still works without it; you just won't see the CoinMarketCap line.)
5. **Double-click `start-gui.bat`.** The first update takes 20 to 40 seconds while it downloads history and trains.

Binance, MEXC and TradingView need **no account or key**: the bot only reads public market data.

## Commands

Double-click a `.bat` file, or run these in a Command Prompt inside the folder:

| What | Double-click | Or type |
|---|---|---|
| Desktop window | `start-gui.bat` | `.venv\Scripts\python -m btc_bot gui` |
| Console, auto-refresh | `start-watch.bat` | `.venv\Scripts\python -m btc_bot watch` |
| One forecast | | `.venv\Scripts\python -m btc_bot predict` |
| Backtest | `backtest.bat` | `.venv\Scripts\python -m btc_bot backtest --candles 5000` |
| Live track record | | `.venv\Scripts\python -m btc_bot score` |
| TradingView alerts | `start-webhook.bat` | `.venv\Scripts\python -m btc_bot webhook` |

## Settings (`.env`)

| Setting | Default | What it does |
|---|---|---|
| `CMC_API_KEY` | empty | CoinMarketCap key |
| `SYMBOL` | `BTCUSDT` | Pair to follow on all sources |
| `PRIMARY_EXCHANGE` | `binance` | Exchange the model learns from. If it fails, the bot switches to the other one automatically |
| `HISTORY_CANDLES` | `3000` | Past candles used to train each timeframe |
| `CONFIDENCE_THRESHOLD` | `0.58` | Below this the bot says NEUTRAL instead of guessing |
| `REFRESH_SECONDS` | `60` | How often the window refreshes |
| `WEBHOOK_PORT` / `WEBHOOK_SECRET` | `8080` / `change-me` | TradingView alert receiver |
| `FEE_RATE` | `0.001` | Fee per trade side used by the backtest (0.1%) |

## How it works

1. **Data.** Downloads the latest closed 5m, 15m and 1h candles from Binance (or MEXC as a fallback).
   The candle that is still forming is ignored, so the model only sees finished candles.
2. **Features.** Builds about 30 standard indicators from those candles: recent returns, volatility,
   RSI, MACD, distance from the 20 and 50 EMAs, Bollinger %B, ATR, candle shape, volume surprise and time of day.
3. **Model.** For each timeframe it trains a blend of logistic regression and small gradient-boosted
   trees (scikit-learn) on the latest candles, then predicts whether the *next* candle closes higher.
   It retrains on every refresh, so it keeps up with the market.
4. **TradingView.** TradingView has no official public data API. The bot uses the
   [`tradingview-ta`](https://pypi.org/project/tradingview-ta/) library to read TradingView's own
   technical rating for BINANCE:BTCUSDT on each timeframe and shows it next to the bot's call.
   It is shown for comparison and is not mixed into the bot's probability, because it can't be backtested.
5. **CoinMarketCap.** Shows market-wide context (24h change, dominance, Fear & Greed). It is not used by
   the model either, since the free plan has no minute-by-minute history to learn from.

### TradingView alerts (optional)

If you have your own TradingView strategy or indicator alerts, the bot can show them too:

1. Run `start-webhook.bat` (keeps running on port 8080).
2. TradingView must be able to reach your PC from the internet. Use a tunnel such as
   [ngrok](https://ngrok.com/) (`ngrok http 8080`) or Cloudflare Tunnel, or forward port 8080 on your router.
   Webhooks need a paid TradingView plan.
3. In the TradingView alert, set **Webhook URL** to `https://<your-tunnel-address>/tradingview` and the **Message** to:
   ```json
   {"secret": "your WEBHOOK_SECRET", "timeframe": "{{interval}}", "action": "buy", "price": {{close}}}
   ```
   Use `"action": "sell"` for sell alerts. The latest alert per timeframe appears under the forecast.

## How good are the predictions?

Honestly: **not very, and nobody's are.** Over 5 to 60 minutes, Bitcoin's direction is very close to a coin flip.
Most of the movement is noise, any pattern that works gets traded away quickly, and fees eat small edges.
Expect accuracy in the **50% to 55%** range, and some weeks below 50%.

That is why the bot includes two honest checks:

- **Backtest (walk-forward).** It trains only on the past, predicts the next block of candles it has never seen,
  moves forward and repeats. It reports accuracy against two simple rules ("always up" and "same as last candle")
  and what following the confident calls would have earned **after fees**. If the bot doesn't beat the simple rules,
  the report says so.
- **Live track record.** Real predictions logged while you use it, scored against what really happened.
  This is the number to trust, once a few hundred predictions have been checked.

In testing on purely random price data the bot correctly reports **no edge** (about 50% accuracy) and
shows that trading its calls would lose money to fees. Run the backtest on real data and judge for yourself.

**Do not trade money you can't afford to lose based on this bot.** It is a tool for study, not financial advice.

## Troubleshooting

- **"Python was not found"**: reinstall Python and tick "Add python.exe to PATH", then run `setup.bat` again.
- **"Could not load candles"**: your internet or country may block Binance. Set `PRIMARY_EXCHANGE=mexc` in `.env`.
- **TradingView shows n/a**: TradingView sometimes rate-limits. It recovers on its own after a few minutes.
- **CoinMarketCap errors**: check the key in `.env`. The free plan allows about 330 calls a day, so the bot
  refreshes CoinMarketCap only every 15 minutes (about 290 calls a day if left running), even when the prices refresh every minute.

## For developers

```
btc_bot/
  sources/   binance.py, mexc.py, coinmarketcap.py, tradingview.py (data)
  features.py   indicators (no look-ahead)
  model.py      logistic regression + gradient boosting blend
  backtest.py   walk-forward backtest
  predictor.py  ties sources and model together, logs predictions
  gui.py / cli.py / webhook.py
tests/          offline tests with synthetic data and mocked APIs
```

Run the tests with `pip install pytest` and `python -m pytest tests`.
