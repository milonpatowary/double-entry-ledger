'use strict'

/**
 * The store contract, against a real mongod.
 *
 * The unit suite runs the same scenarios against a hand-written stand-in, and a
 * stand-in agrees with whatever its author believed. This is where that belief
 * is checked: duplicate-key error codes, the exact semantics of a conditional
 * `$inc`, upsert seeding, and whether transactions are actually available.
 *
 *   docker compose up -d
 *   MONGO_URL=mongodb://127.0.0.1:27017 npm run test:integration
 *
 * Skips cleanly when MONGO_URL is unset or the driver is not installed.
 */

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  createLedger,
  createMongoStore,
  InsufficientFundsError,
  IdempotencyConflictError
} = require('../../src/index')

function optional (name) {
  try { return require(name) } catch { return null }
}

test('mongodb', async (t) => {
  const mongodb = optional('mongodb')
  if (!mongodb || !process.env.MONGO_URL) {
    t.skip('set MONGO_URL and install mongodb to run these')
    return
  }

  const client = new mongodb.MongoClient(process.env.MONGO_URL)
  await client.connect()

  const db = client.db('double_entry_ledger_it')
  const info = await db.admin().command({ buildInfo: 1 })
  t.diagnostic(`mongod ${info.version}`)

  // Namespaced per run so reruns never collide with leftovers.
  const prefix = `t${process.pid}_`

  const build = async () => {
    const store = createMongoStore({ db, client, prefix })
    let seq = 0
    const ledger = createLedger({
      store,
      now: () => new Date(Date.UTC(2026, 0, 1) + seq * 1000),
      generateId: () => `${prefix}e${String(++seq).padStart(5, '0')}`
    })
    return ledger
  }

  const cleanup = async () => {
    for (const name of ['accounts', 'entries', 'balances']) {
      await db.collection(`${prefix}${name}`).deleteMany({})
    }
  }

  try {
    await t.test('transaction support is detected', async () => {
      const ledger = await build()
      await ledger.createAccount({ id: 'probe', type: 'asset', currency: 'USD' })
      await ledger.createAccount({ id: 'probe2', type: 'revenue', currency: 'USD' })
      await ledger.post({
        postings: [{ account: 'probe', debit: 1 }, { account: 'probe2', credit: 1 }]
      })
      t.diagnostic(`transactions: ${ledger.store.supportsTransactions}`)
      assert.ok(
        ledger.store.supportsTransactions === true || ledger.store.supportsTransactions === false,
        'the store made a determination either way'
      )
      await cleanup()
    })

    await t.test('a balanced entry moves both balances', async () => {
      const ledger = await build()
      await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
      await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD' })

      await ledger.post({
        postings: [{ account: 'bank', debit: 5000 }, { account: 'wallet', credit: 5000 }]
      })

      assert.equal((await ledger.balance('bank')).balance, 5000)
      assert.equal((await ledger.balance('wallet')).balance, 5000)
      await cleanup()
    })

    await t.test('the unique index makes idempotency safe under real concurrency', async () => {
      const ledger = await build()
      await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
      await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD' })

      const spec = {
        idempotencyKey: 'dep-1',
        postings: [{ account: 'bank', debit: 1000 }, { account: 'wallet', credit: 1000 }]
      }
      const results = await Promise.all(Array.from({ length: 10 }, () => ledger.post(spec)))

      assert.equal(new Set(results.map((r) => r.id)).size, 1, 'one entry, ten callers')
      assert.equal((await ledger.balance('wallet')).balance, 1000, 'applied exactly once')
      await cleanup()
    })

    await t.test('the same key with different money conflicts', async () => {
      const ledger = await build()
      await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
      await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD' })

      await ledger.post({
        idempotencyKey: 'k',
        postings: [{ account: 'bank', debit: 100 }, { account: 'wallet', credit: 100 }]
      })
      await assert.rejects(
        ledger.post({
          idempotencyKey: 'k',
          postings: [{ account: 'bank', debit: 200 }, { account: 'wallet', credit: 200 }]
        }),
        IdempotencyConflictError
      )
      await cleanup()
    })

    await t.test('the guard holds against genuinely concurrent withdrawals', async () => {
      const ledger = await build()
      await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
      await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD' })
      await ledger.createAccount({ id: 'revenue', type: 'revenue', currency: 'USD' })

      await ledger.post({
        postings: [{ account: 'bank', debit: 5000 }, { account: 'wallet', credit: 5000 }]
      })

      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () =>
          ledger.post({
            postings: [{ account: 'wallet', debit: 1000 }, { account: 'revenue', credit: 1000 }]
          })
        )
      )

      const ok = results.filter((r) => r.status === 'fulfilled')
      assert.equal(ok.length, 5, 'exactly five withdrawals of 1000 fit in 5000')
      for (const r of results.filter((r) => r.status === 'rejected')) {
        assert.ok(r.reason instanceof InsufficientFundsError)
      }
      assert.equal((await ledger.balance('wallet')).balance, 0, 'landed exactly on zero')

      const report = await ledger.reconcile()
      assert.deepEqual(report.drift, [], 'and the cache agrees with the entries')
      await cleanup()
    })

    await t.test('reconcile recomputes from entries and repairs drift', async () => {
      const ledger = await build()
      await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
      await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD' })
      await ledger.post({
        postings: [{ account: 'bank', debit: 2000 }, { account: 'wallet', credit: 2000 }]
      })

      await ledger.store.replaceBalances([
        { account: 'wallet', balance: 9999, debits: 0, credits: 9999, currency: 'USD' }
      ])

      const drifted = await ledger.reconcile()
      assert.equal(drifted.drift.length, 1)
      assert.equal(drifted.drift[0].computed.balance, 2000)

      await ledger.reconcile({ repair: true })
      assert.deepEqual((await ledger.reconcile()).drift, [])
      await cleanup()
    })

    await t.test('reversal restores balances and keeps both entries', async () => {
      const ledger = await build()
      await ledger.createAccount({ id: 'bank', type: 'asset', currency: 'USD' })
      await ledger.createAccount({ id: 'wallet', type: 'liability', currency: 'USD' })

      const original = await ledger.post({
        postings: [{ account: 'bank', debit: 3000 }, { account: 'wallet', credit: 3000 }]
      })
      await ledger.reverse(original.id)

      assert.equal((await ledger.balance('wallet')).balance, 0)
      assert.equal((await ledger.listEntries({ limit: 50 })).length, 2)
      assert.equal((await ledger.getEntry(original.id)).postings[0].debit, 3000)
      await cleanup()
    })
  } finally {
    await cleanup().catch(() => {})
    await client.close()
  }
})
