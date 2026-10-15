import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../lib/auth';
import { ROLES, roleFor } from '../lib/config';
import { Banner, Body, Button, Card, Field, H1, H2, Small, PasswordStrengthMeter } from '../components/ui';
import BackendSetting from '../components/BackendSetting';
import { colors, radius, spacing, typo } from '../lib/theme';

/**
 * F.1 Registration and authentication, F.2 role-based login.
 * Digital Brand Identity Manual (DBIM) compliant.
 * Features:
 * - Direct password sign-in for registered users (with email OTP fallback)
 * - Registration with email OTP verification + mandatory password + live strength meter
 * - Forgot password with email reset link/token and instant in-app reset
 */
const MODES = {
  SIGN_IN: 'SIGN_IN',
  SIGN_IN_OTP: 'SIGN_IN_OTP',
  REGISTER: 'REGISTER',
  FORGOT: 'FORGOT',
};

const REGISTRABLE = {
  PATIENT: [{ code: 'USER', label: 'Patient', hint: 'Book ambulances for yourself or family' }],
  PROVIDER: [
    { code: 'DRIVER', label: 'Individual driver', hint: 'You own or drive one ambulance' },
    { code: 'ORG', label: 'Organisation', hint: 'A hospital or fleet operator' },
  ],
};

export default function AuthScreen() {
  const { signIn, register, requestOtp, verifyOtp, forgotPassword, resetPassword } = useAuth();

  const [roleKey, setRoleKey] = useState(null);
  const [mode, setMode] = useState(MODES.SIGN_IN);
  const [form, setForm] = useState({
    full_name: '',
    phone_no: '',
    email_id: '',
    password: '',
    confirm_password: '',
  });
  const [resetForm, setResetForm] = useState({
    email_id: '',
    token: '',
    new_password: '',
    confirm_password: '',
    sent: false,
    successMessage: '',
  });
  const [regRole, setRegRole] = useState('USER');
  const [otp, setOtp] = useState({ sent: false, code: '', devCode: '', destination: '', fallbackMessage: '' });
  const [error, setError] = useState('');
  const [infoMessage, setInfoMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [, setBackendNonce] = useState(0);

  const role = roleFor(roleKey);
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }));
  const setReset = (k) => (v) => setResetForm((f) => ({ ...f, [k]: v }));

  async function run(fn) {
    setError('');
    setInfoMessage('');
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setError(e.message || 'An unexpected error occurred');
    } finally {
      setBusy(false);
    }
  }

  function chooseRole(key) {
    setRoleKey(key);
    setMode(MODES.SIGN_IN);
    setError('');
    setInfoMessage('');
    setOtp({ sent: false, code: '', devCode: '', destination: '', fallbackMessage: '' });
    setRegRole(REGISTRABLE[key]?.[0]?.code || 'USER');
  }

  // ------------------------------------------------------- Role picker
  if (!role) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.hero}>
          <View style={styles.iconCircle}>
            <Text style={{ fontSize: 44 }}>🚑</Text>
          </View>
          <H1 style={{ marginTop: spacing.md, textAlign: 'center' }}>Ambulance Booking</H1>
          <Small style={{ textAlign: 'center', marginTop: 4, color: colors.muted }}>
            Emergency Care & Rapid Response System
          </Small>
        </View>

        <Text style={[typo.small, { fontWeight: '700', marginBottom: spacing.sm, textTransform: 'uppercase', letterSpacing: 0.5 }]}>
          Select Sign-In Portal
        </Text>

        {ROLES.map((r) => (
          <Pressable key={r.key} onPress={() => chooseRole(r.key)} style={styles.roleCard}>
            <View style={styles.roleIconWrap}>
              <Text style={{ fontSize: 28 }}>{r.icon}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Body style={{ fontWeight: '700', fontSize: 16 }}>{r.title}</Body>
              <Small>{r.subtitle}</Small>
            </View>
            <Text style={{ color: colors.muted, fontSize: 24 }}>›</Text>
          </Pressable>
        ))}

        <View style={{ marginTop: spacing.lg }}>
          <BackendSetting onChange={() => setBackendNonce((n) => n + 1)} />
        </View>

        <View style={styles.emergencyBanner}>
          <Text style={{ fontSize: 16, marginRight: 8 }}>🚨</Text>
          <Body style={[typo.tiny, { color: colors.warn, fontWeight: '600', flex: 1 }]}>
            In life-threatening medical emergencies, dial 108 directly.
          </Body>
        </View>
      </ScrollView>
    );
  }

  // ---------------------------------------------------- Auth forms
  const canRegister = Boolean(REGISTRABLE[roleKey]);
  const roleOptions = REGISTRABLE[roleKey] || [];
  const isAdmin = roleKey === 'ADMIN';

  // 1. Password sign-in
  const submitPasswordSignIn = () =>
    run(async () => {
      const email = form.email_id.trim();
      if (!email) throw new Error('Please enter your email address');
      if (!form.password) throw new Error('Please enter your password');
      await signIn(roleKey, email, form.password);
    });

  // 2. OTP sign-in (fallback)
  const sendSignInOtp = () =>
    run(async () => {
      const email = form.email_id.trim();
      if (!email || !email.includes('@')) throw new Error('Please enter your email address');
      const r = await requestOtp(email, 'LOGIN');
      setOtp({
        sent: true,
        code: r.otp_code || '',
        devCode: r.otp_code || '',
        destination: r.destination || email,
        fallbackMessage: r.otp_code && r.delivery_status === 'FALLBACK' ? r.message : '',
      });
      setInfoMessage(`Verification code sent to ${r.destination || email}`);
    });

  const submitSignInOtp = () =>
    run(async () => {
      const email = form.email_id.trim();
      if (!otp.code.trim()) throw new Error('Please enter the 6-digit verification code');
      await verifyOtp(roleKey, email, otp.code.trim());
    });

  // 3. Registration: send OTP then verify + password
  const sendRegisterOtp = () =>
    run(async () => {
      if (!form.full_name.trim()) throw new Error('Please enter your full name');
      const email = form.email_id.trim();
      if (!email || !email.includes('@')) throw new Error('Please enter a valid email address');
      const r = await requestOtp(email, 'REGISTER', { phone_no: form.phone_no.trim() });
      setOtp({
        sent: true,
        code: r.otp_code || '',
        devCode: r.otp_code || '',
        destination: r.destination || email,
        fallbackMessage: r.otp_code && r.delivery_status === 'FALLBACK' ? r.message : '',
      });
      setInfoMessage(`Verification code sent to ${r.destination || email}. Enter it below with your new password.`);
    });

  const submitRegister = () =>
    run(async () => {
      const email = form.email_id.trim();
      if (!otp.code.trim()) throw new Error('Please enter the 6-digit verification code sent to your email');
      if (!form.password) throw new Error('Please set a password for your account');
      if (form.password.length < 6) throw new Error('Password must be at least 6 characters');
      if (form.confirm_password && form.password !== form.confirm_password) {
        throw new Error('Passwords do not match');
      }

      await register(roleKey, {
        full_name: form.full_name.trim(),
        email_id: email,
        phone_no: form.phone_no.trim() || undefined,
        password: form.password,
        role_code: regRole,
        otp_code: otp.code.trim(),
      });
    });

  // 4. Forgot password flow
  const submitForgotPassword = () =>
    run(async () => {
      const email = (resetForm.email_id || form.email_id).trim();
      if (!email || !email.includes('@')) throw new Error('Please enter your account email address');
      const res = await forgotPassword(email);
      setResetForm((f) => ({
        ...f,
        sent: true,
        email_id: email,
        token: res.reset_token || '',
        successMessage: res.message || 'Reset code sent to your email.',
      }));
      setInfoMessage('Check your email for the reset code or link');
    });

  const submitResetPassword = () =>
    run(async () => {
      if (!resetForm.token.trim()) throw new Error('Please enter the reset code from your email');
      if (!resetForm.new_password) throw new Error('Please enter your new password');
      if (resetForm.new_password.length < 6) throw new Error('Password must be at least 6 characters');
      if (resetForm.confirm_password && resetForm.new_password !== resetForm.confirm_password) {
        throw new Error('Passwords do not match');
      }

      const res = await resetPassword(resetForm.token.trim(), resetForm.new_password);
      setInfoMessage(res.message || 'Password reset successful! Please sign in with your new password.');
      setForm((f) => ({ ...f, email_id: resetForm.email_id, password: resetForm.new_password }));
      setMode(MODES.SIGN_IN);
      setResetForm({ email_id: '', token: '', new_password: '', confirm_password: '', sent: false, successMessage: '' });
    });

  function switchTab(m) {
    setMode(m);
    setError('');
    setInfoMessage('');
    setOtp({ sent: false, code: '', devCode: '', destination: '', fallbackMessage: '' });
  }

  const tabs = [
    [MODES.SIGN_IN, 'Sign In'],
    ...(canRegister ? [[MODES.REGISTER, 'Register']] : []),
  ];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.bg }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        <Pressable onPress={() => { setRoleKey(null); setError(''); setInfoMessage(''); }} style={styles.back}>
          <Text style={{ color: colors.accent, fontSize: 14.5, fontWeight: '600' }}>‹  Change Mode</Text>
        </Pressable>

        <View style={[styles.hero, { marginBottom: spacing.md }]}>
          <View style={styles.iconCircleSmall}>
            <Text style={{ fontSize: 32 }}>{role.icon}</Text>
          </View>
          <H2 style={{ marginTop: spacing.sm, textAlign: 'center' }}>{role.title}</H2>
          <Small style={{ textAlign: 'center', marginTop: 2, color: colors.muted }}>{role.subtitle}</Small>
        </View>

        {mode !== MODES.FORGOT && (
          <View style={styles.tabs}>
            {tabs.map(([m, label]) => (
              <Pressable
                key={m}
                onPress={() => switchTab(m)}
                style={[styles.tab, (mode === m || (m === MODES.SIGN_IN && mode === MODES.SIGN_IN_OTP)) && styles.tabActive]}
              >
                <Text
                  style={{
                    color: (mode === m || (m === MODES.SIGN_IN && mode === MODES.SIGN_IN_OTP)) ? colors.white : colors.muted,
                    fontWeight: '700',
                    fontSize: 14,
                  }}
                >
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        <Card>
          <Banner kind="error">{error}</Banner>
          {infoMessage ? <Banner kind="info">{infoMessage}</Banner> : null}

          {/* ======================= FORGOT PASSWORD MODE ======================= */}
          {mode === MODES.FORGOT && (
            <View>
              <H2 style={{ marginBottom: 4, fontSize: 18 }}>Reset Password</H2>
              <Small style={{ marginBottom: spacing.md }}>
                Enter your registered email to receive a password reset link and verification code.
              </Small>

              <Field
                label="Registered Email Address"
                value={resetForm.email_id || form.email_id}
                onChangeText={setReset('email_id')}
                placeholder="yourname@gmail.com"
                keyboardType="email-address"
                autoCapitalize="none"
                editable={!resetForm.sent}
              />

              {resetForm.sent && (
                <>
                  <Banner kind="warn">
                    {resetForm.successMessage || 'Verification code sent to your email.'}
                  </Banner>

                  <Field
                    label="Reset Code / Token (from email)"
                    value={resetForm.token}
                    onChangeText={setReset('token')}
                    placeholder="Enter reset code"
                    autoCapitalize="none"
                  />

                  <Field
                    label="New Password"
                    value={resetForm.new_password}
                    onChangeText={setReset('new_password')}
                    placeholder="Enter at least 6 characters"
                    secureTextEntry
                  />

                  <PasswordStrengthMeter password={resetForm.new_password} />

                  <Field
                    label="Confirm New Password"
                    value={resetForm.confirm_password}
                    onChangeText={setReset('confirm_password')}
                    placeholder="Re-enter new password"
                    secureTextEntry
                  />

                  <Button title="Update Password & Sign In" onPress={submitResetPassword} loading={busy} />
                </>
              )}

              {!resetForm.sent && (
                <Button title="Send Reset Link to Email" onPress={submitForgotPassword} loading={busy} />
              )}

              <View style={{ marginTop: spacing.md, alignItems: 'center' }}>
                <Pressable onPress={() => { setMode(MODES.SIGN_IN); setError(''); setInfoMessage(''); }}>
                  <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '600' }}>‹ Back to Sign In</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* ======================= SIGN IN (PASSWORD) ======================= */}
          {mode === MODES.SIGN_IN && (
            <View>
              <Field
                label="Email Address"
                value={form.email_id}
                onChangeText={set('email_id')}
                placeholder="yourname@gmail.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
              />

              <Field
                label="Password"
                value={form.password}
                onChangeText={set('password')}
                placeholder="Enter your password"
                secureTextEntry
              />

              <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: -spacing.sm, marginBottom: spacing.md }}>
                <Pressable onPress={() => { setMode(MODES.FORGOT); setError(''); setInfoMessage(''); setResetForm((f) => ({ ...f, email_id: form.email_id })); }}>
                  <Text style={{ color: colors.info, fontSize: 13, fontWeight: '600' }}>Forgot password?</Text>
                </Pressable>
              </View>

              <Button title="Sign In" onPress={submitPasswordSignIn} loading={busy} />

              {!isAdmin && (
                <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderColor: colors.line, paddingTop: spacing.md }}>
                  <Button
                    title="Sign in with Email OTP instead"
                    variant="ghost"
                    onPress={() => { setMode(MODES.SIGN_IN_OTP); setError(''); setInfoMessage(''); }}
                  />
                </View>
              )}
            </View>
          )}

          {/* ======================= SIGN IN (EMAIL OTP FALLBACK) ======================= */}
          {mode === MODES.SIGN_IN_OTP && (
            <View>
              <Field
                label="Email Address"
                value={form.email_id}
                onChangeText={set('email_id')}
                placeholder="yourname@gmail.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!otp.sent}
                hint={!otp.sent ? "We'll send a 6-digit verification code to your email." : undefined}
              />

              {otp.sent && (
                <>
                  {otp.fallbackMessage ? (
                    <Banner kind="warn">{otp.fallbackMessage}</Banner>
                  ) : (
                    <Banner kind="warn">
                      Verification code sent to {otp.destination || form.email_id}. Check your inbox or spam folder.
                    </Banner>
                  )}
                  <Field
                    label="6-Digit Verification Code"
                    value={otp.code}
                    onChangeText={(v) => setOtp((o) => ({ ...o, code: v }))}
                    placeholder="123456"
                    keyboardType="number-pad"
                    maxLength={6}
                  />
                  <View style={{ gap: spacing.sm }}>
                    <Button title="Verify & Sign In" onPress={submitSignInOtp} loading={busy} />
                    <Button title="Resend Code" variant="ghost" onPress={sendSignInOtp} />
                  </View>
                </>
              )}

              {!otp.sent && (
                <Button title="Send Verification Code" onPress={sendSignInOtp} loading={busy} />
              )}

              <View style={{ marginTop: spacing.md, alignItems: 'center' }}>
                <Pressable onPress={() => { setMode(MODES.SIGN_IN); setError(''); setInfoMessage(''); }}>
                  <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '600' }}>‹ Use Password instead</Text>
                </Pressable>
              </View>
            </View>
          )}

          {/* ======================= REGISTER (OTP + PASSWORD) ======================= */}
          {mode === MODES.REGISTER && (
            <View>
              {roleOptions.length > 1 && (
                <>
                  <Text style={[typo.small, { marginBottom: 6, fontWeight: '600' }]}>I am registering as</Text>
                  <View style={{ gap: spacing.sm, marginBottom: spacing.md }}>
                    {roleOptions.map((o) => (
                      <Pressable
                        key={o.code}
                        onPress={() => !otp.sent && setRegRole(o.code)}
                        style={[styles.optionCard, regRole === o.code && styles.optionCardActive]}
                      >
                        <Body style={{ fontWeight: '700' }}>{o.label}</Body>
                        <Small>{o.hint}</Small>
                      </Pressable>
                    ))}
                  </View>
                </>
              )}

              <Field
                label="Full Name"
                value={form.full_name}
                onChangeText={set('full_name')}
                placeholder="Full Name"
                autoCapitalize="words"
                editable={!otp.sent}
              />

              <Field
                label="Email Address"
                value={form.email_id}
                onChangeText={set('email_id')}
                placeholder="yourname@gmail.com"
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!otp.sent}
                hint={!otp.sent ? "A verification code will be sent to this email" : undefined}
              />

              <Field
                label="Mobile Number (optional)"
                value={form.phone_no}
                onChangeText={set('phone_no')}
                placeholder="10-digit mobile number"
                keyboardType="number-pad"
                maxLength={10}
                editable={!otp.sent}
              />

              {otp.sent ? (
                <>
                  <Banner kind="warn">
                    Enter the 6-digit code sent to {otp.destination || form.email_id} and create your password.
                  </Banner>

                  <Field
                    label="6-Digit Email Verification Code"
                    value={otp.code}
                    onChangeText={(v) => setOtp((o) => ({ ...o, code: v }))}
                    placeholder="123456"
                    keyboardType="number-pad"
                    maxLength={6}
                  />

                  <Field
                    label="Create Password"
                    value={form.password}
                    onChangeText={set('password')}
                    placeholder="Min 6 chars (stronger recommended)"
                    secureTextEntry
                  />

                  <PasswordStrengthMeter password={form.password} />

                  <Field
                    label="Confirm Password"
                    value={form.confirm_password}
                    onChangeText={set('confirm_password')}
                    placeholder="Re-enter password"
                    secureTextEntry
                  />

                  <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                    <Button title="Verify Code & Create Account" onPress={submitRegister} loading={busy} />
                    <Button title="Resend Verification Code" variant="ghost" onPress={sendRegisterOtp} />
                    <Button
                      title="Change Details"
                      variant="ghost"
                      onPress={() => setOtp({ sent: false, code: '', devCode: '', destination: '', fallbackMessage: '' })}
                    />
                  </View>
                </>
              ) : (
                <Button title="Send Verification Code to Email" onPress={sendRegisterOtp} loading={busy} />
              )}
            </View>
          )}
        </Card>

        {!canRegister ? (
          <Small style={{ textAlign: 'center', lineHeight: 18, color: colors.muted }}>
            Control-room administrator accounts are provisioned securely by central management.
          </Small>
        ) : null}

        <Small style={{ textAlign: 'center', marginTop: spacing.md, color: colors.muted }}>
          Demo Account: {role.demo}
        </Small>
        <BackendSetting onChange={() => setBackendNonce((n) => n + 1)} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, paddingTop: spacing.xl * 1.5, paddingBottom: spacing.xl },
  hero: { alignItems: 'center', marginBottom: spacing.xl },
  iconCircle: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: `${colors.accent}14`,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: `${colors.accent}33`,
  },
  iconCircleSmall: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: `${colors.accent}14`,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: `${colors.accent}33`,
  },
  back: { marginBottom: spacing.md },
  roleCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md + 2,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    marginBottom: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 1,
  },
  roleIconWrap: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: 3,
    marginBottom: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tab: { flex: 1, paddingVertical: 11, borderRadius: radius.sm - 2, alignItems: 'center' },
  tabActive: { backgroundColor: colors.accent },
  optionCard: {
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  optionCardActive: { borderColor: colors.accent, backgroundColor: `${colors.accent}10` },
  emergencyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFBEB',
    borderWidth: 1,
    borderColor: '#FDE68A',
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
});
