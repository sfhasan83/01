import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Money precision. Most currencies have two decimals, but the Bahraini dinar,
 * Kuwaiti dinar and Omani rial have three (fils and baisa). The database keeps
 * three decimals for every amount; the code rounds to the currency in hand.
 *
 * Each tenant transaction gets a scope (see Db.withTenant). Loading a company's
 * books sets the scope to that company's base currency, so roundMoney() rounds
 * ledger amounts correctly without every caller passing the currency. Amounts
 * in a document's own currency use roundIn(currency, n).
 */

/** ISO 4217 minor units that differ from 2. Kept in step with ref.currencies. */
export const MINOR_UNITS: Readonly<Record<string, number>> = { BHD: 3, KWD: 3, OMR: 3, JOD: 3, IQD: 3, TND: 3, LYD: 3, JPY: 0, KRW: 0 };
export const minorUnits = (currency: string | null | undefined): number => (currency ? MINOR_UNITS[currency] ?? 2 : 2);

const scope = new AsyncLocalStorage<{ dp: number; set?: boolean }>();

/** Run fn with its own precision scope, starting at two decimals. */
export function moneyScope<T>(fn: () => T): T { return scope.run({ dp: 2 }, fn); }
/** Set the current scope to a base currency's precision. */
export function useBaseCurrency(currency: string): void { const s = scope.getStore(); if (s) { s.dp = minorUnits(currency); s.set = true; } }
/** Whether a base currency has been set in this scope yet. */
export const baseCurrencySet = (): boolean => scope.getStore()?.set === true;
/** Decimals of the base currency in the current scope. */
export const moneyDp = (): number => scope.getStore()?.dp ?? 2;

export function roundMoney(n: number, dp: number = moneyDp()): number {
  const f = 10 ** dp;
  return Math.round((n + Number.EPSILON) * f) / f;
}
/** Round an amount held in the given currency. */
export const roundIn = (currency: string | null | undefined, n: number): number => roundMoney(n, minorUnits(currency));
/** The amount as text with the currency's decimals, for files and messages. */
export const fixed = (n: number, currency?: string | null): string => roundMoney(n, currency ? minorUnits(currency) : moneyDp()).toFixed(currency ? minorUnits(currency) : moneyDp());
/** Half of the smallest unit: amounts below this are zero. */
export const dust = (): number => 0.5 / 10 ** moneyDp();
