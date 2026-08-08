'use strict'

/**
 * Every error this library throws carries a machine-readable `code`, because
 * callers routinely need to branch on the difference between "insufficient
 * funds" (show the user something) and "unbalanced entry" (a bug, page someone).
 */
class LedgerError extends Error {
  constructor (message, code = 'ledger_error', details = {}) {
    super(message)
    this.name = this.constructor.name
    this.code = code
    Object.assign(this, details)
    Error.captureStackTrace?.(this, this.constructor)
  }
}

/**
 * Debits did not equal credits.
 *
 * This is the invariant the whole library exists to hold, so it is never
 * softened, never rounded into balance, and never written anyway with a warning.
 */
class UnbalancedEntryError extends LedgerError {
  constructor (debits, credits, currency) {
    super(
      `Entry does not balance: debits ${debits} vs credits ${credits} (${currency}). ` +
        `Difference of ${debits - credits} minor units.`,
      'unbalanced_entry',
      { debits, credits, currency, difference: debits - credits }
    )
  }
}

/** An account named by a posting does not exist. Never auto-created — see the README. */
class UnknownAccountError extends LedgerError {
  constructor (accountId) {
    super(
      `Account "${accountId}" does not exist. Accounts are created explicitly; ` +
        'a typo must not silently open a new account and quietly balance against it.',
      'unknown_account',
      { accountId }
    )
  }
}

/** Two postings in one entry named different currencies. */
class CurrencyMismatchError extends LedgerError {
  constructor (expected, found, accountId) {
    super(
      `Entry is in ${expected} but account "${accountId}" is ${found}. ` +
        'Cross-currency movement needs explicit FX postings through a conversion account.',
      'currency_mismatch',
      { expected, found, accountId }
    )
  }
}

/** A guarded account would have gone below zero. */
class InsufficientFundsError extends LedgerError {
  constructor (accountId, available, requested, currency) {
    // Amounts are stated as minor units and said to be minor units. Writing
    // "3750 USD" for $37.50 is the same category error the library exists to
    // stamp out, and it would be a poor look in the one message users read most.
    super(
      `Account "${accountId}" has ${available} available but ${requested} was requested ` +
        `(${currency}, minor units).`,
      'insufficient_funds',
      { accountId, available, requested, currency, shortfall: requested - available }
    )
  }
}

/**
 * The same idempotency key was reused for a materially different entry.
 *
 * Returning the original would tell the caller their second, different entry
 * succeeded. Refusing is the only honest answer.
 */
class IdempotencyConflictError extends LedgerError {
  constructor (idempotencyKey) {
    super(
      `Idempotency key "${idempotencyKey}" was already used for a different entry.`,
      'idempotency_conflict',
      { idempotencyKey }
    )
  }
}

/** An attempt to modify or delete something the ledger keeps append-only. */
class ImmutableEntryError extends LedgerError {
  constructor (entryId, action) {
    super(
      `Cannot ${action} entry "${entryId}". The ledger is append-only — ` +
        'correct a mistake with a reversing entry, which leaves both the error and the ' +
        'correction visible.',
      'immutable_entry',
      { entryId, action }
    )
  }
}

module.exports = {
  LedgerError,
  UnbalancedEntryError,
  UnknownAccountError,
  CurrencyMismatchError,
  InsufficientFundsError,
  IdempotencyConflictError,
  ImmutableEntryError
}
