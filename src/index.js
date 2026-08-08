'use strict'

const { createLedger, fingerprintOf } = require('./ledger')
const { createMemoryStore } = require('./stores/memory')
const { createMongoStore } = require('./stores/mongo')
const accounts = require('./accounts')
const money = require('./money')
const errors = require('./errors')

module.exports = {
  createLedger,
  createMemoryStore,
  createMongoStore,

  // Account model
  ACCOUNT_TYPES: accounts.ACCOUNT_TYPES,
  TYPE_NAMES: accounts.TYPE_NAMES,

  // Money helpers — exported because callers need the same integer discipline
  // at their own boundaries, and reimplementing it is how the two drift apart.
  formatMinorUnits: money.format,
  assertAmount: money.assertAmount,
  assertCurrency: money.assertCurrency,

  fingerprintOf,
  ...errors
}

module.exports.default = module.exports
