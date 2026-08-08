'use strict'

const { createHash, randomUUID } = require('node:crypto')

const money = require('./money')
const { assertAccountType, assertAccountId, signedDelta, ACCOUNT_TYPES } = require('./accounts')
const {
  LedgerError,
  UnbalancedEntryError,
  UnknownAccountError,
  CurrencyMismatchError,
  IdempotencyConflictError,
  ImmutableEntryError
} = require('./errors')

/**
 * The ledger.
 *
 * Storage lives behind a small interface (see stores/), so this file contains
 * only the rules. That split is deliberate: the rules are the part worth being
 * certain about, and they can be exercised exhaustively in memory without a
 * database anywhere near them.
 *
 * Four invariants are enforced here and nowhere else:
 *
 *   1. Every entry balances. Debits equal credits, exactly, in integer minor
 *      units. An entry that does not balance is refused, never adjusted.
 *   2. Entries are append-only. Nothing is updated or deleted. A mistake is
 *      corrected by a reversing entry, so the error and the correction are both
 *      permanently visible.
 *   3. One currency per entry. Cross-currency movement goes through explicit FX
 *      postings, because an implicit conversion is a rate nobody recorded.
 *   4. A posting names an account that already exists. A typo must not open a
 *      new account and quietly balance against it.
 */
function createLedger ({ store, now = () => new Date(), generateId = () => randomUUID() } = {}) {
  if (!store) throw new LedgerError('createLedger requires a `store`.', 'invalid_options')

  /* ---------------------------------------------------------------- *
   * Accounts
   * ---------------------------------------------------------------- */

  async function createAccount (spec) {
    const { id, type, currency, allowNegative, metadata = {} } = spec || {}

    assertAccountId(id)
    assertAccountType(type)
    money.assertCurrency(currency)

    // Only liabilities are guarded by default, and the reason is specific: a
    // liability is usually a customer balance, so negative means you let
    // someone spend money they did not have. That is the error worth making
    // impossible rather than merely reportable.
    //
    // Everything else legitimately goes negative. A bank account can be
    // overdrawn. Revenue goes negative when refunds exceed sales in a period.
    // Equity goes negative as an accumulated deficit. Guarding those would
    // reject correct bookkeeping, so callers opt in per account instead.
    const guarded = allowNegative === undefined ? type === 'liability' : !allowNegative

    const account = {
      id,
      type,
      currency,
      allowNegative: !guarded,
      metadata,
      createdAt: now()
    }

    await store.createAccount(account)
    return account
  }

  async function getAccount (id) {
    return store.getAccount(assertAccountId(id))
  }

  async function listAccounts (filter = {}) {
    return store.listAccounts(filter)
  }

  /* ---------------------------------------------------------------- *
   * Posting
   * ---------------------------------------------------------------- */

  /**
   * Write one balanced entry.
   *
   * Returns the stored entry. If `idempotencyKey` was used before with the same
   * financial content, the original entry is returned untouched and nothing is
   * written — a retry is not an error, it is the point.
   */
  async function post (spec) {
    const { postings, description = '', idempotencyKey = null, metadata = {}, id } = spec || {}

    if (!Array.isArray(postings) || postings.length < 2) {
      throw new LedgerError(
        'An entry needs at least two postings. A single-sided entry cannot balance, ' +
          'which is the whole reason to use a ledger rather than a column of numbers.',
        'invalid_entry'
      )
    }

    // Resolve accounts first: everything downstream depends on their currency
    // and type, and an unknown account should fail before any arithmetic.
    const resolved = []
    let currency = null

    for (const [index, posting] of postings.entries()) {
      const accountId = assertAccountId(posting.account)
      const account = await store.getAccount(accountId)
      if (!account) throw new UnknownAccountError(accountId)

      const hasDebit = posting.debit !== undefined && posting.debit !== null
      const hasCredit = posting.credit !== undefined && posting.credit !== null

      if (hasDebit === hasCredit) {
        throw new LedgerError(
          `Posting ${index} must specify exactly one of debit or credit.` +
            (hasDebit ? ' It specified both.' : ' It specified neither.'),
          'invalid_posting',
          { index }
        )
      }

      const debit = hasDebit ? money.assertPositiveAmount(posting.debit, `posting[${index}].debit`) : 0
      const credit = hasCredit ? money.assertPositiveAmount(posting.credit, `posting[${index}].credit`) : 0

      if (currency === null) currency = account.currency
      else if (account.currency !== currency) {
        throw new CurrencyMismatchError(currency, account.currency, accountId)
      }

      resolved.push({ account: accountId, accountType: account.type, debit, credit })
    }

    // The invariant.
    const debits = money.sum(resolved.map((p) => p.debit), 'debit')
    const credits = money.sum(resolved.map((p) => p.credit), 'credit')
    if (debits !== credits) throw new UnbalancedEntryError(debits, credits, currency)

    const fingerprint = fingerprintOf(resolved, currency)

    // An idempotent replay must not re-apply the balance deltas, so this is
    // checked before anything is written. The store's commit does the same
    // check atomically — this one only saves the work in the common case.
    if (idempotencyKey) {
      const existing = await store.getEntryByIdempotencyKey(idempotencyKey)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError(idempotencyKey)
        return existing
      }
    }

    const entry = {
      id: id || generateId(),
      currency,
      description,
      metadata,
      idempotencyKey,
      fingerprint,
      postings: resolved.map(({ account, debit, credit }) => ({ account, debit, credit })),
      amount: debits, // the entry's magnitude; debits === credits by definition
      reverses: null,
      createdAt: now()
    }

    // Balance deltas are expressed in each account's normal direction, so a
    // credit to a liability is a positive movement.
    //
    // Only guarded accounts constrain the commit; the store enforces the guard
    // atomically, because checking a balance and then writing is a race that
    // overdraws under concurrency.
    const deltas = []
    for (const p of resolved) {
      const account = await store.getAccount(p.account)
      deltas.push({
        account: p.account,
        currency,
        delta: signedDelta(p.accountType, p),
        guard: account.allowNegative ? null : { min: 0 }
      })
    }

    return store.commit({ entry, deltas })
  }

  /**
   * Reverse an entry by writing its mirror image.
   *
   * The original stays exactly as it was. That is not squeamishness about
   * deletion: an audit that cannot see the mistake cannot see that it was
   * caught, and "the number changed and nobody knows why" is the failure mode
   * this trades away.
   */
  async function reverse (entryId, { description, idempotencyKey, metadata = {} } = {}) {
    const original = await store.getEntry(entryId)
    if (!original) throw new LedgerError(`Entry "${entryId}" not found.`, 'unknown_entry', { entryId })

    if (original.reverses) {
      throw new ImmutableEntryError(entryId, 'reverse a reversing entry — reverse the original instead')
    }

    const existingReversal = await store.findReversalOf(entryId)
    if (existingReversal) return existingReversal

    const mirrored = original.postings.map((p) => ({
      account: p.account,
      ...(p.debit ? { credit: p.debit } : { debit: p.credit })
    }))

    const entry = await post({
      postings: mirrored,
      description: description || `Reversal of ${entryId}`,
      idempotencyKey: idempotencyKey || `reverse:${entryId}`,
      metadata: { ...metadata, reversalOf: entryId }
    })

    await store.markReversal(entry.id, entryId)
    return { ...entry, reverses: entryId }
  }

  /* ---------------------------------------------------------------- *
   * Reading
   * ---------------------------------------------------------------- */

  async function balance (accountId) {
    assertAccountId(accountId)
    const account = await store.getAccount(accountId)
    if (!account) throw new UnknownAccountError(accountId)

    const cached = await store.getBalance(accountId)
    return {
      account: accountId,
      currency: account.currency,
      balance: cached ? cached.balance : 0,
      debits: cached ? cached.debits : 0,
      credits: cached ? cached.credits : 0,
      formatted: money.format(cached ? cached.balance : 0, account.currency)
    }
  }

  async function getEntry (entryId) {
    return store.getEntry(entryId)
  }

  async function listEntries (filter = {}) {
    return store.listEntries(filter)
  }

  /**
   * Recompute every balance from the entries and compare against the cache.
   *
   * The entries are the ledger; balances are a cache over them. This is what
   * makes that claim checkable rather than merely stated — and it is the job
   * that should run on a schedule, because a cache nobody verifies is a cache
   * that is eventually wrong without anyone noticing.
   */
  async function reconcile ({ repair = false } = {}) {
    const computed = new Map()
    const accounts = await store.listAccounts()
    for (const account of accounts) {
      computed.set(account.id, { balance: 0, debits: 0, credits: 0, currency: account.currency })
    }

    let entryCount = 0
    const perCurrency = new Map()

    for await (const entry of store.streamEntries()) {
      entryCount += 1

      // Re-check the invariant on the way past. An entry that does not balance
      // should be impossible; finding one means something wrote around this
      // library, and that is worth knowing immediately.
      const d = entry.postings.reduce((s, p) => s + p.debit, 0)
      const c = entry.postings.reduce((s, p) => s + p.credit, 0)
      if (d !== c) {
        throw new UnbalancedEntryError(d, c, entry.currency)
      }

      const totals = perCurrency.get(entry.currency) || { debits: 0, credits: 0 }
      totals.debits += d
      totals.credits += c
      perCurrency.set(entry.currency, totals)

      for (const posting of entry.postings) {
        const acc = computed.get(posting.account)
        if (!acc) continue // account deleted out from under us; reported below
        const account = accounts.find((a) => a.id === posting.account)
        acc.debits += posting.debit
        acc.credits += posting.credit
        acc.balance += signedDelta(account.type, posting)
      }
    }

    const drift = []
    for (const [accountId, expected] of computed) {
      const cached = (await store.getBalance(accountId)) || { balance: 0, debits: 0, credits: 0 }
      if (
        cached.balance !== expected.balance ||
        cached.debits !== expected.debits ||
        cached.credits !== expected.credits
      ) {
        drift.push({
          account: accountId,
          currency: expected.currency,
          cached: { balance: cached.balance, debits: cached.debits, credits: cached.credits },
          computed: { balance: expected.balance, debits: expected.debits, credits: expected.credits },
          difference: expected.balance - cached.balance
        })
      }
    }

    if (repair && drift.length) {
      await store.replaceBalances(
        [...computed].map(([account, v]) => ({ account, ...v }))
      )
    }

    return {
      entries: entryCount,
      accounts: computed.size,
      balanced: [...perCurrency].every(([, t]) => t.debits === t.credits),
      totals: Object.fromEntries(perCurrency),
      drift,
      repaired: repair ? drift.length : 0
    }
  }

  /**
   * A trial balance: every account with a non-zero balance, per currency, and
   * whether the two sides agree. The oldest report in accounting and still the
   * fastest way to see that the books are sound.
   */
  async function trialBalance ({ currency } = {}) {
    const accounts = await store.listAccounts(currency ? { currency } : {})
    const rows = []
    let debits = 0
    let credits = 0

    for (const account of accounts) {
      const cached = (await store.getBalance(account.id)) || { balance: 0, debits: 0, credits: 0 }
      if (cached.debits === 0 && cached.credits === 0) continue

      const normal = ACCOUNT_TYPES[account.type].normal
      const debitColumn = normal === 'debit' ? cached.balance : 0
      const creditColumn = normal === 'credit' ? cached.balance : 0

      debits += debitColumn
      credits += creditColumn

      rows.push({
        account: account.id,
        type: account.type,
        currency: account.currency,
        debit: debitColumn,
        credit: creditColumn,
        formatted: money.format(cached.balance, account.currency)
      })
    }

    rows.sort((a, b) => a.account.localeCompare(b.account))
    return { rows, totals: { debits, credits }, balanced: debits === credits }
  }

  return {
    createAccount,
    getAccount,
    listAccounts,
    post,
    reverse,
    balance,
    getEntry,
    listEntries,
    reconcile,
    trialBalance,
    store
  }
}

/**
 * Identifies an entry by its financial content, so a retry is recognised and a
 * different entry under the same key is caught.
 *
 * Postings are sorted, because [debit A, credit B] and [credit B, debit A] are
 * the same entry written two ways and a retry should not depend on argument
 * order. Description and metadata are excluded: they are annotation, and a
 * caller who retries with a tidier description has not changed the money.
 */
function fingerprintOf (postings, currency) {
  const canonical = postings
    .map((p) => `${p.account}|${p.debit}|${p.credit}`)
    .sort()
    .join(';')
  return createHash('sha256').update(`${currency}\n${canonical}`).digest('hex')
}

module.exports = { createLedger, fingerprintOf }
