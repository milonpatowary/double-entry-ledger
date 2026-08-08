'use strict'

/**
 * A small MongoDB stand-in, implementing exactly the operations
 * `src/stores/mongo.js` uses.
 *
 * It exists because the store's hardest logic — the guarded `$inc` that makes
 * "insufficient funds" correct under concurrency, and the compensation path
 * taken when there are no transactions — is unreachable without a database,
 * and shipping it unexercised would mean the most delicate code in the library
 * is the only code with no test.
 *
 * Where it is deliberately strict:
 *
 *   - duplicate `_id` and duplicate unique-index values both throw code 11000,
 *     because the store depends on that error to resolve idempotency races
 *   - `updateOne` honours filters like `{ balance: { $gte: n } }`, which is the
 *     entire mechanism behind the balance guard
 *   - a guarded update that matches nothing reports matchedCount 0 rather than
 *     silently upserting, which is what the store checks
 *
 * It is not a substitute for the real server. test/integration/ runs the same
 * contract against a real mongod, and CI runs that on every push.
 */
function createFakeMongo () {
  const collections = new Map()

  function getCollection (name) {
    if (!collections.has(name)) {
      collections.set(name, { docs: new Map(), uniqueIndexes: [] })
    }
    return collections.get(name)
  }

  const matches = (doc, query) => Object.entries(query).every(([k, v]) => matchField(doc, k, v))

  function matchField (doc, key, condition) {
    const value = resolvePath(doc, key)

    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      for (const [op, operand] of Object.entries(condition)) {
        if (op === '$gte' && !(value >= operand)) return false
        if (op === '$gt' && !(value > operand)) return false
        if (op === '$lt' && !(value < operand)) return false
        if (op === '$type') {
          if (operand === 'string' && typeof value !== 'string') return false
        }
        if (!['$gte', '$gt', '$lt', '$type'].includes(op)) {
          throw new Error(`fake-mongo: unsupported operator ${op}`)
        }
      }
      return true
    }

    // A dotted path into an array of subdocuments matches if any element does.
    if (Array.isArray(value)) return value.includes(condition)
    return value === condition
  }

  function resolvePath (doc, path) {
    if (!path.includes('.')) return doc[path]
    const [head, ...rest] = path.split('.')
    const value = doc[head]
    if (Array.isArray(value)) return value.map((v) => resolvePath(v, rest.join('.')))
    return value === undefined ? undefined : resolvePath(value, rest.join('.'))
  }

  function duplicateKeyError (message) {
    const err = new Error(`E11000 duplicate key error: ${message}`)
    err.code = 11000
    return err
  }

  function checkUnique (state, doc, ignoreId = null) {
    for (const field of state.uniqueIndexes) {
      const value = doc[field]
      if (value === undefined || value === null) continue
      for (const [id, existing] of state.docs) {
        if (id === ignoreId) continue
        if (existing[field] === value) throw duplicateKeyError(`${field}: ${value}`)
      }
    }
  }

  function applyUpdate (doc, update) {
    const next = { ...doc }
    if (update.$set) Object.assign(next, update.$set)
    if (update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) next[k] = (next[k] || 0) + v
    }
    return next
  }

  function makeCursor (docs) {
    let list = [...docs]
    const cursor = {
      sort (spec) {
        const keys = Object.entries(spec)
        list.sort((a, b) => {
          for (const [k, dir] of keys) {
            const av = resolvePath(a, k)
            const bv = resolvePath(b, k)
            if (av < bv) return -1 * dir
            if (av > bv) return 1 * dir
          }
          return 0
        })
        return cursor
      },
      limit (n) { list = list.slice(0, n); return cursor },
      async toArray () { return list.map((d) => structuredClone(d)) },
      async * [Symbol.asyncIterator] () {
        for (const d of list) yield structuredClone(d)
      }
    }
    return cursor
  }

  return {
    collection (name) {
      const state = getCollection(name)

      return {
        async createIndex (spec, options = {}) {
          if (options.unique) {
            for (const field of Object.keys(spec)) {
              if (!state.uniqueIndexes.includes(field)) state.uniqueIndexes.push(field)
            }
          }
          return options.name || 'index'
        },

        async insertOne (doc) {
          if (state.docs.has(doc._id)) throw duplicateKeyError(`_id: ${doc._id}`)
          checkUnique(state, doc)
          state.docs.set(doc._id, structuredClone(doc))
          return { insertedId: doc._id, acknowledged: true }
        },

        async findOne (query = {}) {
          for (const doc of state.docs.values()) {
            if (matches(doc, query)) return structuredClone(doc)
          }
          return null
        },

        find (query = {}) {
          return makeCursor([...state.docs.values()].filter((d) => matches(d, query)))
        },

        async updateOne (filter, update, options = {}) {
          for (const [id, doc] of state.docs) {
            if (!matches(doc, filter)) continue
            const next = applyUpdate(doc, update)
            checkUnique(state, next, id)
            state.docs.set(id, next)
            return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0, acknowledged: true }
          }

          if (options.upsert) {
            // Mongo seeds an upsert from the filter's equality terms, then
            // applies $setOnInsert and $inc.
            const seed = {}
            for (const [k, v] of Object.entries(filter)) {
              if (typeof v !== 'object' || v === null) seed[k] = v
            }
            if (seed._id === undefined) seed._id = `gen-${state.docs.size + 1}`
            const created = applyUpdate({ ...seed, ...(update.$setOnInsert || {}) }, update)
            checkUnique(state, created)
            state.docs.set(created._id, created)
            return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1, acknowledged: true }
          }

          return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, acknowledged: true }
        },

        async bulkWrite (operations) {
          for (const op of operations) {
            if (!op.updateOne) throw new Error('fake-mongo: only updateOne is supported in bulkWrite')
            const { filter, update, upsert } = op.updateOne
            await this.updateOne(filter, update, { upsert })
          }
          return { acknowledged: true }
        },

        _size: () => state.docs.size
      }
    },

    _collections: () => [...collections.keys()]
  }
}

module.exports = { createFakeMongo }
