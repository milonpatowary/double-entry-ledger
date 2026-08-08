'use strict'

const { LedgerError } = require('./errors')

/**
 * Money is an integer count of minor units — cents, pence, satoshi — and never
 * anything else.
 *
 * The reason is not pedantry. 0.1 + 0.2 is 0.30000000000000004 in IEEE 754, and
 * a ledger that stores 0.1 stores a number that is not 0.1. Sum a few million
 * of those and the books stop balancing by amounts nobody can explain, which is
 * the one failure a ledger exists to prevent.
 *
 * So: amounts are integers, validated at the boundary. A float reaching this
 * library is a bug in the caller and is rejected loudly rather than rounded
 * quietly, because a silent round is how the drift starts.
 */

// 2^53 - 1. Beyond this, integer arithmetic in JavaScript stops being exact,
// so a ledger that allowed it would silently lose the property it is built on.
const MAX_SAFE_MINOR_UNITS = Number.MAX_SAFE_INTEGER

/**
 * Currencies and their minor-unit exponent, used only to format for humans.
 * Storage and arithmetic never consult this — they are always minor units.
 *
 * JPY has no minor unit; KWD has three. Assuming everything is 2 is a classic
 * way to be wrong by a factor of 1000 in Kuwait.
 */
const MINOR_UNIT_EXPONENT = {
  USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, CHF: 2, CNY: 2, INR: 2, BRL: 2,
  JPY: 0, KRW: 0,
  BHD: 3, JOD: 3, KWD: 3, OMR: 3, TND: 3
}

function assertAmount (value, label = 'amount') {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new LedgerError(`${label} must be a number, received ${describe(value)}.`, 'invalid_amount')
  }
  if (!Number.isFinite(value)) {
    throw new LedgerError(`${label} must be finite, received ${value}.`, 'invalid_amount')
  }
  if (!Number.isInteger(value)) {
    throw new LedgerError(
      `${label} must be an integer number of minor units, received ${value}. ` +
        'Money is stored in cents/pence, never as a decimal — 12.34 should be passed as 1234.',
      'invalid_amount'
    )
  }
  if (Math.abs(value) > MAX_SAFE_MINOR_UNITS) {
    throw new LedgerError(
      `${label} exceeds the safe integer range; arithmetic would stop being exact.`,
      'invalid_amount'
    )
  }
  return value
}

/** Amounts on a posting must be positive; direction is carried by debit/credit. */
function assertPositiveAmount (value, label = 'amount') {
  assertAmount(value, label)
  if (value <= 0) {
    throw new LedgerError(
      `${label} must be greater than zero, received ${value}. ` +
        'Direction is expressed by debit or credit, not by the sign of the amount.',
      'invalid_amount'
    )
  }
  return value
}

function assertCurrency (value) {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value)) {
    throw new LedgerError(
      `currency must be a three-letter uppercase code, received ${describe(value)}.`,
      'invalid_currency'
    )
  }
  return value
}

/**
 * Format minor units for display. Presentation only — never feed the result
 * back into arithmetic.
 */
function format (minorUnits, currency) {
  assertAmount(minorUnits, 'minorUnits')
  assertCurrency(currency)

  const exponent = MINOR_UNIT_EXPONENT[currency] ?? 2
  if (exponent === 0) return `${minorUnits} ${currency}`

  const negative = minorUnits < 0
  const digits = String(Math.abs(minorUnits)).padStart(exponent + 1, '0')
  const whole = digits.slice(0, -exponent)
  const fraction = digits.slice(-exponent)

  return `${negative ? '-' : ''}${whole}.${fraction} ${currency}`
}

/** Sum minor units, checking each addend and the running total stay exact. */
function sum (amounts, label = 'amount') {
  let total = 0
  for (const amount of amounts) {
    assertAmount(amount, label)
    total += amount
    if (Math.abs(total) > MAX_SAFE_MINOR_UNITS) {
      throw new LedgerError('sum exceeds the safe integer range.', 'invalid_amount')
    }
  }
  return total
}

function describe (value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return String(value)
}

module.exports = {
  assertAmount,
  assertPositiveAmount,
  assertCurrency,
  format,
  sum,
  MINOR_UNIT_EXPONENT,
  MAX_SAFE_MINOR_UNITS
}
