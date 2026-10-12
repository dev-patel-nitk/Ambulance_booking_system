'use strict';
// F.1 Registration and authentication, F.2 Role-based login.
// DFD processes 0.1.1 Register & Verify OTP, 0.1.2 Authenticate Credentials,
// 0.1.3 Create Session & Assign Role.
const express = require('express');
const bcrypt = require('bcryptjs');
const config = require('../config');
const { db, nowIso, audit } = require('../db');
const { nextId } = require('../utils/ids');
const v = require('../utils/validate');
const { issueToken, revokeSession, authenticate } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const messaging = require('../services/messaging');

const router = express.Router();

// NF.3 brute-force limits. Sign-in counts only failed attempts, so someone
// signing in repeatedly on a shared network is never penalised; OTP issue and
// OTP verification count every attempt, because both are the expensive ones to
// leave open (an unlimited verify makes a 6-digit code exhaustible).
const loginLimiter = rateLimit({
  max: 8,
  windowMs: 10 * 60_000,
  countSuccess: false,
  message: 'Too many failed sign-in attempts. Please wait 10 minutes and try again.',
});

const otpRequestLimiter = rateLimit({
  max: 5,
  windowMs: 15 * 60_000,
  message: 'Too many verification codes requested. Please wait 15 minutes.',
});

const otpVerifyLimiter = rateLimit({
  max: 6,
  windowMs: 15 * 60_000,
  message: 'Too many incorrect verification codes. Please request a new one shortly.',
});

const registerLimiter = rateLimit({
  max: 10,
  windowMs: 60 * 60_000,
  key: (req) => req.ip,
  message: 'Too many accounts created from this device. Please try again later.',
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const OTP_TTL_MS = 5 * 60 * 1000; // Data Dictionary: issue time + 5 min
const findUser = (identifier) => {
  if (!identifier) return null;
  const str = String(identifier).trim();
  if (str.includes('@')) {
    return db.prepare('SELECT * FROM users WHERE LOWER(email_id) = LOWER(?)').get(str);
  }
  const clean = str.replace(/[^0-9]/g, '');
  return db.prepare('SELECT * FROM users WHERE phone_no = ?').get(clean || str);
};

const findUserByPhone = (phone) => findUser(phone);
const findUserByEmail = (email) => db.prepare('SELECT * FROM users WHERE LOWER(email_id) = LOWER(?)').get(String(email).trim());

function sessionResponse(user) {
  const provider = db.prepare('SELECT * FROM providers WHERE user_id = ?').get(user.user_id) || null;
  const { session_token, token_expiry } = issueToken(user, provider);
  return {
    session_token,
    token_expiry,
    user: {
      user_id: user.user_id,
      full_name: user.full_name,
      phone_no: user.phone_no,
      email_id: user.email_id,
      role_code: user.role_code,
      verification_status: user.verification_status,
      registration_date: user.registration_date,
      org_id: user.org_id,
    },
    provider,
  };
}

// ------------------------------------------------- 0.1.1 register + verify
router.post('/register', registerLimiter, asyncRoute(async (req, res) => {
  const full_name = v.name(req.body.full_name);
  const email_id = v.email(req.body.email || req.body.email_id);
  let phone_no = req.body.phone_no ? String(req.body.phone_no).replace(/[^0-9]/g, '') : '';
  if (!phone_no || phone_no.length < 10) {
    phone_no = '9' + String(Math.floor(100000000 + Math.random() * 900000000));
  } else {
    phone_no = v.phone(phone_no);
  }
  const role_code = v.oneOf(req.body.role_code || 'USER', ['USER', 'DRIVER', 'ORG'], 'role_code');
  const password = req.body.password ? v.password(req.body.password) : null;
  const otp_code = req.body.otp_code ? String(req.body.otp_code).trim() : null;

  if (findUserByEmail(email_id)) {
    return res.status(409).json({ error: 'An account already exists for this email address' });
  }
  if (req.body.phone_no && findUserByPhone(phone_no)) {
    return res.status(409).json({ error: 'An account already exists for this mobile number' });
  }

  // If registering via OTP verification, validate the OTP code
  if (otp_code) {
    const row = db.prepare(
      'SELECT * FROM otps WHERE (phone_no = ? OR phone_no = ?) AND consumed = 0 ORDER BY id DESC LIMIT 1'
    ).get(email_id, phone_no);
    if (!row || row.otp_code !== otp_code) {
      return res.status(401).json({ error: 'Incorrect verification code' });
    }
    if (new Date(row.otp_expiry).getTime() < Date.now()) {
      return res.status(401).json({ error: 'This verification code has expired' });
    }
    db.prepare('UPDATE otps SET consumed = 1 WHERE id = ?').run(row.id);
  } else if (!password) {
    return res.status(400).json({ error: 'Email verification code is required to register' });
  }

  const now = nowIso();
  const user_id = nextId('user');
  // Patients are usable immediately; providers stay PENDING until an
  // administrator verifies their documents (F.13).
  const verification_status = role_code === 'USER' ? 'VERIFIED' : 'PENDING';
  const password_hash = password ? bcrypt.hashSync(password, 12) : null;

  db.prepare(
    `INSERT INTO users (user_id, full_name, phone_no, email_id, password_hash, role_code,
                        verification_status, registration_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    user_id, full_name, phone_no, email_id,
    password_hash,
    role_code, verification_status, now.slice(0, 10), now, now
  );

  audit('USER_REGISTERED', {
    actorUserId: user_id, actorRole: role_code, entityType: 'user', entityId: user_id,
    details: { email_id, phone_no, role_code },
  });

  const user = findUser(email_id) || findUser(phone_no);
  res.status(201).json({
    message: 'Registration successful',
    ...sessionResponse(user),
  });
}));

// Passwordless / verification OTP
router.post('/otp/request', otpRequestLimiter, asyncRoute(async (req, res) => {
  const rawId = String(req.body.email || req.body.email_id || req.body.identifier || req.body.phone_no || '').trim();
  if (!rawId) {
    return res.status(400).json({ error: 'Email address or mobile number is required' });
  }
  const purpose = String(req.body.purpose || 'LOGIN').toUpperCase();
  const user = findUser(rawId);

  if (purpose === 'REGISTER' && user) {
    return res.status(409).json({ error: 'An account already exists for this email address. Please sign in instead.' });
  }
  if (purpose === 'LOGIN' && !user) {
    return res.status(404).json({ error: rawId.includes('@') ? 'No account found for this email address' : 'No account found for this mobile number' });
  }

  const targetKey = user ? user.phone_no : rawId;
  const targetEmail = rawId.includes('@') ? rawId : (user?.email_id || config.email.user);

  const otp_code = String(Math.floor(100000 + Math.random() * 900000));
  const otp_expiry = new Date(Date.now() + OTP_TTL_MS).toISOString();

  db.prepare('UPDATE otps SET consumed = 1 WHERE (phone_no = ? OR phone_no = ?) AND consumed = 0')
    .run(targetKey, targetEmail);
  db.prepare(
    'INSERT INTO otps (phone_no, otp_code, otp_expiry, purpose, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(targetKey, otp_code, otp_expiry, purpose, nowIso());

  await messaging.sendOtp({ phoneNo: user?.phone_no || '', email: targetEmail, otpCode: otp_code });
  audit('OTP_ISSUED', { entityType: 'auth', entityId: targetEmail, details: { purpose } });

  res.json({
    message: 'Verification code sent to your email',
    otp_expiry,
    destination: targetEmail,
    // Development convenience only - see EXPOSE_OTP_IN_RESPONSE in .env
    ...(config.exposeOtp ? { otp_code, dev_note: 'otp_code is exposed because EXPOSE_OTP_IN_RESPONSE=true' } : {}),
  });
}));

router.post('/otp/verify', otpVerifyLimiter, asyncRoute(async (req, res) => {
  const rawId = String(req.body.email || req.body.email_id || req.body.identifier || req.body.phone_no || '').trim();
  const otp_code = String(v.required(req.body.otp_code, 'otp_code')).trim();

  const user = findUser(rawId);
  const targetKey = user ? user.phone_no : rawId;
  const targetEmail = rawId.includes('@') ? rawId : (user?.email_id || '');

  const row = db.prepare(
    'SELECT * FROM otps WHERE (phone_no = ? OR phone_no = ?) AND consumed = 0 ORDER BY id DESC LIMIT 1'
  ).get(targetKey, targetEmail);

  if (!row || row.otp_code !== otp_code) {
    return res.status(401).json({ error: 'Incorrect verification code' });
  }
  if (new Date(row.otp_expiry).getTime() < Date.now()) {
    return res.status(401).json({ error: 'This verification code has expired' });
  }

  db.prepare('UPDATE otps SET consumed = 1 WHERE id = ?').run(row.id);

  if (!user) {
    return res.status(404).json({ error: rawId.includes('@') ? 'No account found for this email address' : 'No account found for this mobile number' });
  }

  if (user.verification_status === 'PENDING' && user.role_code === 'USER') {
    db.prepare('UPDATE users SET verification_status = ?, updated_at = ? WHERE user_id = ?')
      .run('VERIFIED', nowIso(), user.user_id);
  }

  audit('OTP_VERIFIED', { actorUserId: user.user_id, entityType: 'user', entityId: user.user_id });
  res.json({ message: 'Verified', ...sessionResponse(user) });
}));

// --------------------------------------- 0.1.2 + 0.1.3 login, session, role
router.post('/login', loginLimiter, asyncRoute(async (req, res) => {
  const rawId = req.body.email || req.body.email_id || req.body.identifier || req.body.phone_no;
  if (!rawId) {
    return res.status(400).json({ error: 'Email address or mobile number is required' });
  }

  const user = findUser(rawId);
  const password = v.password(req.body.password);
  const expectedRole = req.body.role_code
    ? v.oneOf(req.body.role_code, v.ROLE_CODES, 'role_code')
    : null;

  if (!user || !user.password_hash || !bcrypt.compareSync(password, user.password_hash)) {
    audit('LOGIN_FAILED', { entityType: 'user', entityId: String(rawId) });
    return res.status(401).json({ error: 'Incorrect email/mobile number or password' });
  }
  if (user.verification_status === 'SUSPENDED') {
    return res.status(403).json({ error: 'This account has been suspended by an administrator' });
  }
  // F.2: the selected mode must match the role granted to the account.
  if (expectedRole && expectedRole !== user.role_code) {
    // The article travels with the noun: "an organisation", not "a organisation".
    const readable = { USER: 'a patient', DRIVER: 'a driver', ORG: 'an organisation', ADMIN: 'an administrator' };
    return res.status(403).json({
      error: `This account is registered as ${readable[user.role_code]}. Choose that mode to sign in.`,
      role_code: user.role_code,
    });
  }

  audit('LOGIN_SUCCESS', {
    actorUserId: user.user_id, actorRole: user.role_code, entityType: 'user', entityId: user.user_id,
  });
  res.json({ message: 'Signed in', ...sessionResponse(user) });
}));

/**
 * Ends the current session by revoking its record in D1. Clearing the token on
 * the device alone would leave a still-valid token in existence for up to 24
 * hours; revoking it here means the server stops honouring it immediately.
 */
router.post('/logout', authenticate, asyncRoute(async (req, res) => {
  const revoked = req.claims.jti ? revokeSession(req.claims.jti) : false;
  audit('LOGOUT', {
    actorUserId: req.user.user_id, actorRole: req.user.role_code,
    entityType: 'session', entityId: req.claims.jti || null,
  });
  res.json({ message: 'Signed out', revoked });
}));

/** The account's own session history - what D1 now holds about their logins. */
router.get('/sessions', authenticate, asyncRoute(async (req, res) => {
  const sessions = db.prepare(
    `SELECT token_id, role_code, issued_at, token_expiry, revoked, revoked_at
     FROM sessions WHERE user_id = ? ORDER BY id DESC LIMIT 25`
  ).all(req.user.user_id);

  res.json({
    sessions: sessions.map((s) => ({ ...s, current: s.token_id === req.claims.jti })),
  });
}));

router.get('/me', authenticate, (req, res) => {
  res.json({
    user: {
      user_id: req.user.user_id,
      full_name: req.user.full_name,
      phone_no: req.user.phone_no,
      email_id: req.user.email_id,
      role_code: req.user.role_code,
      verification_status: req.user.verification_status,
      registration_date: req.user.registration_date,
      org_id: req.user.org_id,
    },
    provider: req.provider,
    organisation: req.user.org_id
      ? db.prepare('SELECT * FROM organisations WHERE org_id = ?').get(req.user.org_id)
      : null,
  });
});

router.patch('/me', authenticate, asyncRoute(async (req, res) => {
  const full_name = req.body.full_name ? v.name(req.body.full_name) : req.user.full_name;
  const email_id = req.body.email_id !== undefined ? v.email(req.body.email_id) : req.user.email_id;

  db.prepare('UPDATE users SET full_name = ?, email_id = ?, updated_at = ? WHERE user_id = ?')
    .run(full_name, email_id, nowIso(), req.user.user_id);

  audit('PROFILE_UPDATED', { actorUserId: req.user.user_id, entityType: 'user', entityId: req.user.user_id });
  res.json({ message: 'Profile updated', user: db.prepare('SELECT * FROM users WHERE user_id = ?').get(req.user.user_id) });
}));

router.post('/password', authenticate, asyncRoute(async (req, res) => {
  const current = String(v.required(req.body.current_password, 'current_password'));
  const next = v.password(req.body.new_password, 'new_password');

  if (!req.user.password_hash || !bcrypt.compareSync(current, req.user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?')
    .run(bcrypt.hashSync(next, 12), nowIso(), req.user.user_id);

  audit('PASSWORD_CHANGED', { actorUserId: req.user.user_id, entityType: 'user', entityId: req.user.user_id });
  res.json({ message: 'Password updated' });
}));

module.exports = router;
