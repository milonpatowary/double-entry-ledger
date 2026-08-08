'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const money = require('../src/money')
const { formatMinorUnits } = require('../src/index')

test('integers pass, and are returned unchanged', () => {
  assert.equal(money.assertAmount(0), 0)
  assert.equal(money.assertAmount(-1234), -1234)
  assert.equal(money.assertAmount(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER)
})

test('floats are refused, including ones that look harmless', () => {
  for (const value of [0.1, 1.5, 12.34, -0.01, 1e-7]) {
    assert.throws(() => money.assertAmount(value), /integer number of minor units/, `${value}`)
  }
})

test('the classic float error is exactly what this prevents', () => {
  // 0.1 + 0.2 is 0.30000000000000004. A ledger that accepted these would be
  // wrong by amounts nobody can account for once they accumulate.
  assert.notEqual(0.1 + 0.2, 0.3)
  assert.throws(() => money.assertAmount(0.1 + 0.2))

  // In minor units the same sum is exact, forever.
  assert.equal(10 + 20, 30)
})

test('non-numbers, NaN and infinities are refused', () => {
  for (const value of ['100', null, undefined, {}, [], NaN, Infinity, -Infinity]) {
    assert.throws(() => money.assertAmount(value), /invalid|must be/i, String(value))
  }
})

test('amounts beyond exact integer arithmetic are refused', () => {
  assert.throws(() => money.assertAmount(Number.MAX_SAFE_INTEGER + 2), /safe integer range/)
})

test('posting amounts must be strictly positive', () => {
  assert.equal(money.assertPositiveAmount(1), 1)
  assert.throws(() => money.assertPositiveAmount(0), /greater than zero/)
  assert.throws(() => money.assertPositiveAmount(-5), /greater than zero/)
})

test('currency codes must be three uppercase letters', () => {
  assert.equal(money.assertCurrency('USD'), 'USD')
  for (const bad of ['usd', 'US', 'USDT', '', 'U5D', null, 123]) {
    assert.throws(() => money.assertCurrency(bad), /three-letter/, String(bad))
  }
})

test('formatting respects each currency’s minor-unit exponent', () => {
  assert.equal(formatMinorUnits(123456, 'USD'), '1234.56 USD')
  assert.equal(formatMinorUnits(5, 'USD'), '0.05 USD')
  assert.equal(formatMinorUnits(0, 'USD'), '0.00 USD')
  assert.equal(formatMinorUnits(-250, 'USD'), '-2.50 USD')

  // JPY has no minor unit; assuming two would be wrong by a factor of 100.
  assert.equal(formatMinorUnits(1234, 'JPY'), '1234 JPY')

  // KWD has three; assuming two would be wrong by a factor of 10.
  assert.equal(formatMinorUnits(1234, 'KWD'), '1.234 KWD')
})

test('an unknown currency formats with two decimals rather than throwing', () => {
  assert.equal(formatMinorUnits(1234, 'XYZ'), '12.34 XYZ')
})

test('sum checks every addend and the running total', () => {
  assert.equal(money.sum([100, 200, 300]), 600)
  assert.equal(money.sum([]), 0)
  assert.throws(() => money.sum([100, 1.5]), /integer/)
  assert.throws(() => money.sum([Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]), /safe integer/)
})
