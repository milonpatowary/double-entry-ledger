'use strict'

const { LedgerError, InsufficientFundsError, IdempotencyConflictError } = require('../errors')

const DUPLICATE_KEY = 11000

/**
 * MongoDB store. Takes a `Db` (the official driver, or `mongoose.connection.db`).
 *
 * Three collections:
 *
 *   accounts  — one document per account, `_id` is the account id
 *   entries   — append-only; one document per entry, holding all its postings
 *   balances  — a cache over entries, one document per account
 *
 * Keeping an entry's postings inside one document is the central choice. A
 * single-document write is atomic in MongoDB with no transaction and no replica
 * set, so "all of an entry's postings land, or none do" is true by construction
 * rather than by protocol. Splitting postings into their own collection would
 * make the ledger's core invariant depend on a transaction being available.
 *
 * That leaves the balance cache, which does span documents. How that is kept
 * consistent depends on the deployment — see `commit`.
 */
function createMongoStore ({ db, client = null, prefix = '', autoIndex = true } = {}) {
  if (!db || typeof db.collection !== 'function') {
    throw new LedgerError('createMongoStore requires a `db` with a .collection() method.', 'invalid_options')
  }

  const accounts = db.collection(`${prefix}accounts`)
  const entries = db.collection(`${prefix}entries`)
  const balances = db.collection(`${prefix}balances`)

  let indexPromise = null
  let transactionsSupported = null

  function ensureIndexes () {
    if (!indexPromise) {
      indexPromise = buildIndexes().catch((err) => {
        indexPromise = null
        throw err
      })
    }
    return indexPromise
  }

  /**
   * Created one at a time, and the collections created explicitly first.
   *
   * Firing these concurrently races: several `createIndex` calls against a
   * collection that does not exist yet each try to create it implicitly, and
   * the server logs "Conflicted registering namespace". Creating the
   * collections up front removes the race, and doing the rest sequentially
   * keeps it removed. This runs once per process, so there is nothing to gain
   * from the parallelism that caused it.
   */
  async function buildIndexes () {
    for (const name of [`${prefix}accounts`, `${prefix}entries`, `${prefix}balances`]) {
      // Already exists is the normal case and not an error.
      await db.createCollection(name).catch((err) => {
        if (err?.codeName !== 'NamespaceExists' && err?.code !== 48) throw err
      })
    }

    const specs = [
      // Uniqueness is what makes idempotency safe under concurrency: two
      // simultaneous posts with the same key cannot both insert, whatever the
      // application layer believes.
      [entries, { idempotencyKey: 1 },
        { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'idempotency' }],
      [entries, { 'postings.account': 1, createdAt: -1 }, { name: 'by_account' }],
      [entries, { createdAt: 1 }, { name: 'chronological' }],
      [entries, { reverses: 1 }, { sparse: true, name: 'reversals' }],
      [accounts, { currency: 1, type: 1 }, { name: 'by_currency_type' }]
    ]

    for (const [collection, keys, options] of specs) {
      await collection.createIndex(keys, options)
    }
  }

  const ready = async () => { if (autoIndex) await ensureIndexes() }

  /**
   * Transactions need a replica set or a sharded cluster; a standalone mongod
   * rejects them. Rather than require one, this asks the server and adapts.
   *
   * Asking is important. The obvious probe — start a transaction and abort it —
   * is worthless: aborting a transaction that has performed no operations never
   * contacts the server, so it succeeds on a standalone too and the store then
   * takes a path the deployment cannot support. `hello` reports the topology
   * directly: `setName` for a replica set, `msg: "isdbgrid"` for mongos.
   */
  async function canUseTransactions () {
    if (transactionsSupported !== null) return transactionsSupported
    if (!client || typeof client.startSession !== 'function') {
      transactionsSupported = false
      return false
    }
    try {
      const hello = await db.admin().command({ hello: 1 })
      transactionsSupported = Boolean(hello.setName) || hello.msg === 'isdbgrid'
    } catch {
      // If the topology cannot be determined, assume the safer path — the
      // compensating one works everywhere.
      transactionsSupported = false
    }
    return transactionsSupported
  }

  return {
    name: 'mongo',
    ensureIndexes,
    get supportsTransactions () { return transactionsSupported },

    /* ------------------------------ accounts ------------------------------ */

    async createAccount (account) {
      await ready()
      try {
        await accounts.insertOne({ _id: account.id, ...omit(account, 'id') })
      } catch (err) {
        if (err?.code === DUPLICATE_KEY) {
          throw new LedgerError(`Account "${account.id}" already exists.`, 'account_exists', {
            accountId: account.id
          })
        }
        throw err
      }
      await balances.updateOne(
        { _id: account.id },
        { $setOnInsert: { balance: 0, debits: 0, credits: 0, currency: account.currency } },
        { upsert: true }
      )
      return account
    },

    async getAccount (id) {
      await ready()
      const doc = await accounts.findOne({ _id: id })
      return doc ? fromDoc(doc) : null
    },

    async listAccounts (filter = {}) {
      await ready()
      const query = {}
      if (filter.currency) query.currency = filter.currency
      if (filter.type) query.type = filter.type
      const docs = await accounts.find(query).sort({ _id: 1 }).toArray()
      return docs.map(fromDoc)
    },

    /* ------------------------------- entries ------------------------------ */

    async getEntry (id) {
      await ready()
      const doc = await entries.findOne({ _id: id })
      return doc ? fromDoc(doc) : null
    },

    async getEntryByIdempotencyKey (key) {
      await ready()
      const doc = await entries.findOne({ idempotencyKey: key })
      return doc ? fromDoc(doc) : null
    },

    async listEntries ({ account, limit = 100, after = null } = {}) {
      await ready()
      const query = {}
      if (account) query['postings.account'] = account
      if (after) {
        const cursor = await entries.findOne({ _id: after })
        if (cursor) query.createdAt = { $gt: cursor.createdAt }
      }
      const docs = await entries.find(query).sort({ createdAt: 1, _id: 1 }).limit(limit).toArray()
      return docs.map(fromDoc)
    },

    async * streamEntries () {
      await ready()
      const cursor = entries.find({}).sort({ createdAt: 1, _id: 1 })
      for await (const doc of cursor) yield fromDoc(doc)
    },

    async findReversalOf (entryId) {
      await ready()
      const doc = await entries.findOne({ reverses: entryId })
      return doc ? fromDoc(doc) : null
    },

    async markReversal (reversalId, originalId) {
      await ready()
      await entries.updateOne({ _id: reversalId }, { $set: { reverses: originalId } })
    },

    /* ------------------------------- commit ------------------------------- */

    async commit ({ entry, deltas }) {
      await ready()
      return (await canUseTransactions())
        ? commitInTransaction({ entry, deltas })
        : commitWithCompensation({ entry, deltas })
    },

    /* ------------------------------ balances ------------------------------ */

    async getBalance (accountId) {
      await ready()
      const doc = await balances.findOne({ _id: accountId })
      return doc ? { balance: doc.balance, debits: doc.debits, credits: doc.credits, currency: doc.currency } : null
    },

    async replaceBalances (rows) {
      await ready()
      if (!rows.length) return
      await balances.bulkWrite(
        rows.map((row) => ({
          updateOne: {
            filter: { _id: row.account },
            update: {
              $set: {
                balance: row.balance,
                debits: row.debits,
                credits: row.credits,
                currency: row.currency
              }
            },
            upsert: true
          }
        }))
      )
    },

    async close () {}
  }

  /* ------------------------------------------------------------------ *
   * Commit strategies
   * ------------------------------------------------------------------ */

  /** Replica set or sharded cluster: one transaction, nothing to reason about. */
  async function commitInTransaction ({ entry, deltas }) {
    const session = client.startSession()
    try {
      let result = null
      await session.withTransaction(async () => {
        for (const delta of deltas) {
          const applied = await applyDelta(delta, entry, session)
          if (!applied) {
            const current = await balances.findOne({ _id: delta.account }, { session })
            throw new InsufficientFundsError(
              delta.account, current ? current.balance : 0, -delta.delta, delta.currency
            )
          }
        }
        await entries.insertOne({ _id: entry.id, ...omit(entry, 'id') }, { session })
        result = entry
      })
      return result
    } catch (err) {
      if (err?.code === DUPLICATE_KEY && entry.idempotencyKey) {
        return resolveIdempotentRace(entry)
      }
      throw err
    } finally {
      await session.endSession()
    }
  }

  /**
   * Standalone mongod: no transactions, so the balance cache is moved first and
   * compensated if the entry insert fails.
   *
   * The ordering matters. Balances are guarded, so moving them first is what
   * makes "insufficient funds" correct under concurrency — a check-then-write
   * would let two simultaneous withdrawals both pass the check. The entry is
   * the source of truth, so if its insert fails the balance moves are undone.
   *
   * If the process dies between the two, the cache is ahead of the entries. The
   * ledger is still correct — entries are what count — and `reconcile()` finds
   * and repairs the drift. That is the honest cost of running without a replica
   * set, and it is why reconcile exists rather than being optional hygiene.
   */
  async function commitWithCompensation ({ entry, deltas }) {
    const applied = []
    try {
      // Deterministic order, so two concurrent commits touching the same pair of
      // accounts contend in the same sequence rather than deadlocking.
      const ordered = [...deltas].sort((a, b) => a.account.localeCompare(b.account))

      for (const delta of ordered) {
        const ok = await applyDelta(delta, entry, null)
        if (!ok) {
          const current = await balances.findOne({ _id: delta.account })
          throw new InsufficientFundsError(
            delta.account, current ? current.balance : 0, -delta.delta, delta.currency
          )
        }
        applied.push(delta)
      }

      await entries.insertOne({ _id: entry.id, ...omit(entry, 'id') })
      return entry
    } catch (err) {
      await compensate(applied, entry)
      if (err?.code === DUPLICATE_KEY && entry.idempotencyKey) {
        return resolveIdempotentRace(entry)
      }
      throw err
    }
  }

  /**
   * Guarded increment. Returns false when the guard refused.
   *
   * The guard is expressed as a filter rather than a read: `balance >= -delta`
   * means the document only matches when the result would stay at or above
   * zero, so the check and the write are one atomic operation. Reading the
   * balance and then deciding is the bug this avoids — two concurrent
   * withdrawals both read a sufficient balance and both proceed.
   */
  async function applyDelta ({ account, delta, guard, currency }, entry, session) {
    const posting = entry.postings.find((p) => p.account === account)
    const filter = { _id: account }
    if (guard && delta < 0) filter.balance = { $gte: -delta }

    const result = await balances.updateOne(
      filter,
      {
        $inc: {
          balance: delta,
          debits: posting ? posting.debit : 0,
          credits: posting ? posting.credit : 0
        },
        $setOnInsert: { currency }
      },
      // No upsert when guarded: an upsert would create the document and succeed
      // regardless of the guard, which would defeat it entirely.
      { upsert: !(guard && delta < 0), session: session || undefined }
    )

    return result.matchedCount > 0 || result.upsertedCount > 0
  }

  async function compensate (applied, entry) {
    for (const { account, delta } of applied) {
      const posting = entry.postings.find((p) => p.account === account)
      await balances
        .updateOne(
          { _id: account },
          {
            $inc: {
              balance: -delta,
              debits: posting ? -posting.debit : 0,
              credits: posting ? -posting.credit : 0
            }
          }
        )
        .catch(() => {
          // Compensation failing leaves the cache ahead of the entries.
          // reconcile() is the backstop; swallowing here keeps the original
          // error — the one the caller needs — from being replaced.
        })
    }
  }

  /** Two concurrent posts shared an idempotency key; one of them lost. */
  async function resolveIdempotentRace (entry) {
    const winner = await entries.findOne({ idempotencyKey: entry.idempotencyKey })
    if (!winner) throw new LedgerError('Idempotency race resolved to nothing.', 'ledger_error')
    if (winner.fingerprint !== entry.fingerprint) {
      throw new IdempotencyConflictError(entry.idempotencyKey)
    }
    return fromDoc(winner)
  }
}

function fromDoc (doc) {
  const { _id, ...rest } = doc
  return { id: _id, ...rest }
}

function omit (object, key) {
  const { [key]: _removed, ...rest } = object
  return rest
}

module.exports = { createMongoStore }
