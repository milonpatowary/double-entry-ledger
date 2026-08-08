'use strict'

const { LedgerError, InsufficientFundsError, IdempotencyConflictError } = require('../errors')

/**
 * In-memory store. The default, and the one the test suite runs against.
 *
 * It is not a toy: it implements the same contract as the MongoDB store,
 * including the guarded commit, so the ledger rules are exercised in full
 * without a database. What it cannot give you is durability or sharing between
 * processes, which is why production wants the MongoDB store.
 *
 * Atomicity here is free. JavaScript runs one thing at a time, so as long as
 * `commit` performs no `await` between validating the guards and applying the
 * writes, no other operation can interleave. That property is load-bearing —
 * adding an await inside the critical section below would silently introduce
 * exactly the race this store exists to model correctly.
 */
function createMemoryStore () {
  const accounts = new Map()
  const entries = new Map()
  const entriesByIdempotencyKey = new Map()
  const balances = new Map()
  const reversalByOriginal = new Map()
  const order = [] // insertion order, so listing is chronological and stable

  const blankBalance = (currency) => ({ balance: 0, debits: 0, credits: 0, currency })

  return {
    name: 'memory',
    supportsTransactions: true, // trivially, being single-threaded

    /* ------------------------------ accounts ------------------------------ */

    async createAccount (account) {
      if (accounts.has(account.id)) {
        throw new LedgerError(`Account "${account.id}" already exists.`, 'account_exists', {
          accountId: account.id
        })
      }
      accounts.set(account.id, { ...account })
      balances.set(account.id, blankBalance(account.currency))
      return { ...account }
    },

    async getAccount (id) {
      const account = accounts.get(id)
      return account ? { ...account } : null
    },

    async listAccounts (filter = {}) {
      let all = [...accounts.values()].map((a) => ({ ...a }))
      if (filter.currency) all = all.filter((a) => a.currency === filter.currency)
      if (filter.type) all = all.filter((a) => a.type === filter.type)
      return all.sort((a, b) => a.id.localeCompare(b.id))
    },

    /* ------------------------------- entries ------------------------------ */

    async getEntry (id) {
      const entry = entries.get(id)
      return entry ? clone(entry) : null
    },

    async getEntryByIdempotencyKey (key) {
      const id = entriesByIdempotencyKey.get(key)
      return id ? clone(entries.get(id)) : null
    },

    async listEntries ({ account, limit = 100, after = null } = {}) {
      let ids = order
      if (after) {
        const index = ids.indexOf(after)
        ids = index === -1 ? ids : ids.slice(index + 1)
      }
      const out = []
      for (const id of ids) {
        const entry = entries.get(id)
        if (account && !entry.postings.some((p) => p.account === account)) continue
        out.push(clone(entry))
        if (out.length >= limit) break
      }
      return out
    },

    async * streamEntries () {
      for (const id of order) yield clone(entries.get(id))
    },

    async findReversalOf (entryId) {
      const id = reversalByOriginal.get(entryId)
      return id ? clone(entries.get(id)) : null
    },

    async markReversal (reversalId, originalId) {
      const entry = entries.get(reversalId)
      if (entry) entry.reverses = originalId
      reversalByOriginal.set(originalId, reversalId)
    },

    /* ------------------------------- commit ------------------------------- */

    /**
     * Write the entry and move the balances, or do neither.
     *
     * Everything below this line runs without awaiting, which is what makes it
     * atomic in a single-threaded runtime.
     */
    async commit ({ entry, deltas }) {
      if (entry.idempotencyKey) {
        const existingId = entriesByIdempotencyKey.get(entry.idempotencyKey)
        if (existingId) {
          const existing = entries.get(existingId)
          if (existing.fingerprint !== entry.fingerprint) {
            throw new IdempotencyConflictError(entry.idempotencyKey)
          }
          return clone(existing)
        }
      }

      // Check every guard before applying any delta, so a rejected entry leaves
      // nothing half-moved.
      for (const { account, delta, guard, currency } of deltas) {
        if (!guard) continue
        const current = balances.get(account) || blankBalance(currency)
        const next = current.balance + delta
        if (next < guard.min) {
          throw new InsufficientFundsError(account, current.balance, -delta, currency)
        }
      }

      for (const { account, delta, currency } of deltas) {
        const current = balances.get(account) || blankBalance(currency)
        const posting = entry.postings.find((p) => p.account === account)
        balances.set(account, {
          currency,
          balance: current.balance + delta,
          debits: current.debits + (posting ? posting.debit : 0),
          credits: current.credits + (posting ? posting.credit : 0)
        })
      }

      entries.set(entry.id, clone(entry))
      order.push(entry.id)
      if (entry.idempotencyKey) entriesByIdempotencyKey.set(entry.idempotencyKey, entry.id)

      return clone(entry)
    },

    /* ------------------------------ balances ------------------------------ */

    async getBalance (accountId) {
      const b = balances.get(accountId)
      return b ? { ...b } : null
    },

    async replaceBalances (rows) {
      for (const row of rows) {
        balances.set(row.account, {
          balance: row.balance,
          debits: row.debits,
          credits: row.credits,
          currency: row.currency
        })
      }
    },

    /* -------------------------- test/ops helpers -------------------------- */

    async close () {},
    _counts: () => ({ accounts: accounts.size, entries: entries.size })
  }
}

// Entries are handed out as copies so a caller mutating a returned object
// cannot reach back into the ledger's own state. An append-only store that
// hands out live references is not append-only.
const clone = (value) => (value === null || value === undefined ? value : structuredClone(value))

module.exports = { createMemoryStore }
