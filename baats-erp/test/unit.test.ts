import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matches, validateCondition } from '../src/core/rules.ts';
import { base32Decode, base32Encode, hashPassword, passwordProblems, totp, verifyPassword, verifyTotp } from '../src/iam/crypto.ts';
import { validateDefinition } from '../src/workflow/engine.ts';
import { normalizeName } from '../src/mdm/service.ts';

describe('business rules', () => {
  it('evaluates comparison, membership and equality', () => {
    const c = { amount: { gt: 1000, lte: 50000 }, currency: { in: ['AED', 'USD'] }, country: 'AE' };
    assert.equal(matches(c, { amount: 20000, currency: 'AED', country: 'AE' }), true);
    assert.equal(matches(c, { amount: 50001, currency: 'AED', country: 'AE' }), false);
    assert.equal(matches(c, { amount: 20000, currency: 'GBP', country: 'AE' }), false);
    assert.equal(matches(c, { amount: '20000', currency: 'USD', country: 'AE' }), true, 'numeric strings compare as numbers');
  });
  it('fails closed when an attribute is missing', () => {
    assert.equal(matches({ amount: { lte: 100 } }, {}), false);
    assert.equal(matches({ amount: { exists: false } }, {}), true);
  });
  it('supports OR through "any"', () => {
    const c = { any: [{ country: 'AE' }, { amount: { lt: 10 } }] };
    assert.equal(matches(c, { country: 'GB', amount: 5 }), true);
    assert.equal(matches(c, { country: 'GB', amount: 50 }), false);
  });
  it('rejects malformed conditions', () => {
    assert.deepEqual(validateCondition({ amount: { lte: 5 } }), []);
    assert.ok(validateCondition({ amount: { between: [1, 2] } }).length);
    assert.ok(validateCondition({ amount: { lte: '5' } }).length);
    assert.ok(validateCondition({ c: { in: 'AE' } }).length);
  });
});

describe('credentials', () => {
  it('hashes and verifies passwords', async () => {
    const h = await hashPassword('Correct-Horse-9-Battery');
    assert.ok(h.startsWith('scrypt$'));
    assert.equal(await verifyPassword('Correct-Horse-9-Battery', h), true);
    assert.equal(await verifyPassword('wrong', h), false);
  });
  it('enforces password policy', () => {
    assert.ok(passwordProblems('short').length >= 1);
    assert.deepEqual(passwordProblems('Correct-Horse-9-Battery'), []);
  });
  it('matches the RFC 6238 TOTP test vector', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    assert.equal(base32Decode(secret).toString(), '12345678901234567890');
    assert.equal(totp(secret, 59_000), '287082');
    assert.equal(totp(secret, 1_111_111_109_000), '081804');
    assert.equal(verifyTotp(secret, '287082', 59_000 + 30_000), true, 'one step of drift is accepted');
    assert.equal(verifyTotp(secret, '287082', 59_000 + 120_000), false);
  });
});

describe('workflow definition validation', () => {
  it('accepts a valid definition', () => {
    assert.deepEqual(validateDefinition({ steps: [{ key: 'a', approvers: [{ type: 'role', role: 'X' }], mode: { quorum: 2 } }] }), []);
  });
  it('reports every problem', () => {
    const errs = validateDefinition({ steps: [
      { key: 'a', approvers: [] },
      { key: 'a', approvers: [{ type: 'role' }], mode: 'most', when: { x: { near: 1 } } },
    ] });
    assert.ok(errs.some((e) => e.includes('approvers must be a non-empty array')));
    assert.ok(errs.some((e) => e.includes('repeated')));
    assert.ok(errs.some((e) => e.includes('role is required')));
    assert.ok(errs.some((e) => e.includes('mode')));
    assert.ok(errs.some((e) => e.includes('unknown operator')));
  });
});

describe('master data', () => {
  it('normalizes company names for duplicate detection', () => {
    assert.equal(normalizeName('Gulf Foods L.L.C.'), normalizeName('GULF FOODS LLC'));
    assert.equal(normalizeName('Al Noor Trading Co.'), 'al noor');
  });
});
