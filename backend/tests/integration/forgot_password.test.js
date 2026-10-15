'use strict';
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('../helpers');
const { get, post, ACCOUNTS } = h;
const { passwordStrength } = require('../../src/utils/validate');

before(async () => { await h.startTestServer(); });
after(async () => { await h.stopTestServer(); });

test('password strength evaluator', () => {
  assert.equal(passwordStrength('').score, 0);
  assert.equal(passwordStrength('').label, 'Very weak');
  assert.equal(passwordStrength('123').score, 1);

  const fair = passwordStrength('Abc12345');
  assert.ok(fair.score >= 3);

  const strong = passwordStrength('SuperSecret@2026!');
  assert.equal(strong.score, 4);
  assert.equal(strong.label, 'Strong');
  assert.equal(strong.feedback.length, 0);
});

test('forgot password and reset password lifecycle', async () => {

  // 1. Request reset for an existing account
  const forgotRes = await post('/api/auth/forgot-password', { email: 'ramesh@example.in' });
  assert.equal(forgotRes.status, 200);
  assert.ok(forgotRes.body.token_expiry);
  assert.ok(forgotRes.body.reset_token, 'reset token is returned in test environment');

  const token = forgotRes.body.reset_token;

  // 2. Attempt reset with an invalid token
  const invalidRes = await post('/api/auth/reset-password', {
    token: 'non-existent-token',
    password: 'NewStrongPassword1!',
  });
  assert.equal(invalidRes.status, 400);

  // 3. Reset password successfully
  const resetRes = await post('/api/auth/reset-password', {
    token,
    password: 'NewStrongPassword1!',
  });
  assert.equal(resetRes.status, 200);
  assert.match(resetRes.body.message, /reset successfully/i);

  // 4. Token cannot be reused
  const reuseRes = await post('/api/auth/reset-password', {
    token,
    password: 'AnotherPassword2@',
  });
  assert.equal(reuseRes.status, 400);

  // 5. Sign in with the new password
  const loginRes = await post('/api/auth/login', {
    email: 'ramesh@example.in',
    password: 'NewStrongPassword1!',
  });
  assert.equal(loginRes.status, 200);
  assert.ok(loginRes.body.session_token);
});
