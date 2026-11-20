"""PSX (Pakistan Stock Exchange) daily signal bot. Signals only, never places orders."""

__version__ = "0.1.0"

# Forecast horizons in trading days: tomorrow, about a week, about a month.
HORIZONS = {"1D": 1, "1W": 5, "1M": 20}
