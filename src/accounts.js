'use strict'

const { LedgerError } = require('./errors')

/**
 * The five account types of double-entry bookkeeping, and which direction
 * increases each one.
 *
 * This is the part that trips up programmers coming to accounting: a debit is
 * not "money in" and a credit is not "money out". A debit increases an asset
 * and *decreases* a liability. Both are just the two sides of the equation:
 *
 *   assets + expenses  =  liabilities + equity + revenue
 *
 * Storing the normal direction per type lets `balance()` return a number that
 * reads the way a human expects — a customer's wallet (a liability, because you
 * owe them the money) shows a positive balance when they have funds, rather
 * than a negative one that everyone then remembers to flip.
 */
const ACCOUNT_TYPES = {
  asset: { normal: 'debit' },
  expense: { normal: 'debit' },
  liability: { normal: 'credit' },
  equity: { normal: 'credit' },
  revenue: { normal: 'credit' }
}

const TYPE_NAMES = Object.keys(ACCOUNT_TYPES)

function assertAccountType (type) {
  if (!ACCOUNT_TYPES[type]) {
    throw new LedgerError(
      `Unknown account type "${type}". Expected one of: ${TYPE_NAMES.join(', ')}.`,
      'invalid_account_type',
      { type }
    )
  }
  return type
}

function assertAccountId (id) {
  if (typeof id !== 'string' || id.length === 0) {
    throw new LedgerError('Account id must be a non-empty string.', 'invalid_account_id', { id })
  }
  if (id.length > 256) {
    throw new LedgerError('Account id must be 256 characters or fewer.', 'invalid_account_id', { id })
  }
  return id
}

/** Which way this posting moves this account's balance, in its normal direction. */
function signedDelta (accountType, { debit = 0, credit = 0 }) {
  const normal = ACCOUNT_TYPES[accountType].normal
  return normal === 'debit' ? debit - credit : credit - debit
}

module.exports = { ACCOUNT_TYPES, TYPE_NAMES, assertAccountType, assertAccountId, signedDelta }
