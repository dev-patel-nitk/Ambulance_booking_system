'use strict';
// F.6 / F.14 - outbound alerts.
//
// Transport is pluggable. With WHATSAPP_TOKEN set the service calls the Meta
// WhatsApp Business Cloud API; with the variable empty it falls back to a mock
// transport that persists the message and prints it, so the whole dispatch flow
// is demonstrable without a Meta business account. Either way the message row in
// `messages` is identical, which is what the admin dashboard reads.
const config = require('../config');
const { db, nowIso } = require('../db');
const { messageId } = require('../utils/ids');

const usingCloudApi = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);

function toE164(phoneNo) {
  const digits = String(phoneNo).replace(/[^0-9]/g, '');
  return digits.length > 10 ? digits : config.whatsapp.countryCode + digits;
}

function to10Digits(phoneNo) {
  const digits = String(phoneNo).replace(/[^0-9]/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

const usingFast2sms = () => Boolean(config.sms?.fast2smsApiKey);

let mailTransporter = null;
function getMailTransporter() {
  if (mailTransporter) return mailTransporter;
  if (!config.email?.user || !config.email?.pass) return null;
  const nodemailer = require('nodemailer');
  const port = Number(config.email.port || 587);
  const secure = Boolean(config.email.secure && port === 465);
  mailTransporter = nodemailer.createTransport({
    host: config.email.host || 'smtp.gmail.com',
    port,
    secure,
    auth: {
      user: config.email.user,
      pass: config.email.pass,
    },
    tls: {
      rejectUnauthorized: false,
    },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });
  return mailTransporter;
}

const usingEmail = () => Boolean(config.email?.webhookUrl || config.email?.resendApiKey || config.email?.brevoApiKey || (config.email?.user && config.email?.pass));

async function sendEmail({ to, subject, html, text }) {
  // 1. Google Apps Script Webhook Relay (HTTPS port 443 - zero SMTP port blocks, native Gmail delivery)
  if (config.email.webhookUrl) {
    try {
      const res = await fetch(config.email.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to, subject, html, text }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.success || res.ok) {
        return { messageId: 'webhook-' + Date.now(), transport: 'webhook' };
      }
      console.warn('[email:webhook] Webhook returned error:', data);
    } catch (e) {
      console.warn('[email:webhook] Webhook failed, falling back to SMTP:', e.message);
    }
  }

  // 2. Resend HTTPS API (port 443 - bypasses all cloud SMTP port blocks)
  if (config.email.resendApiKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.email.resendApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: config.email.from || 'Ambulance Booking System <onboarding@resend.dev>',
          to: [to],
          subject,
          html,
          text,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.id) {
        return { messageId: data.id, transport: 'resend' };
      }
      console.warn('[email:resend] Failed, falling back to SMTP:', data);
    } catch (e) {
      console.warn('[email:resend] Error, falling back to SMTP:', e.message);
    }
  }

  // 3. Brevo HTTPS API (port 443 - zero cloud port block, 300 free emails/day)
  if (config.email.brevoApiKey) {
    try {
      const senderEmail = config.email.brevoSenderEmail || config.email.user || 'devjipatelop@gmail.com';
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': config.email.brevoApiKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          sender: { name: 'Ambulance Booking System', email: senderEmail },
          to: [{ email: to }],
          subject,
          htmlContent: html,
          textContent: text,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.messageId) {
        console.log(`[email:brevo] Sent successfully to ${to} (id: ${data.messageId})`);
        return { messageId: data.messageId, transport: 'brevo' };
      }
      console.warn('[email:brevo] API call failed:', res.status, data);
    } catch (e) {
      console.warn('[email:brevo] Error, falling back to SMTP:', e.message);
    }
  }

  // 4. Direct Gmail SMTP (port 587 STARTTLS)
  const transporter = getMailTransporter();
  if (!transporter) throw new Error('Email credentials not configured');
  return Promise.race([
    transporter.sendMail({
      from: config.email.from || `"Ambulance Booking System" <${config.email.user}>`,
      to,
      subject,
      text,
      html,
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Email send timed out (4s)')), 4000)
    ),
  ]);
}

function record({ recipientPhone, channel, templateId, body, bookingId, deliveryState, providerResponse }) {
  const id = messageId();
  db.prepare(
    `INSERT INTO messages (message_id, booking_id, recipient_phone, message_channel,
                           message_template_id, body, delivery_state, delivery_timestamp,
                           provider_response, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    bookingId || null,
    recipientPhone,
    channel,
    templateId || null,
    body || null,
    deliveryState,
    nowIso(),
    providerResponse ? JSON.stringify(providerResponse).slice(0, 2000) : null,
    nowIso()
  );
  return Object.assign(new String(id), { id, deliveryState });
}

/** Meta rejects a template parameter containing a newline or a tab. */
const flatten = (v) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim();

/**
 * Builds the Cloud API payload.
 *
 * Free-form text is only accepted inside the 24-hour customer service window -
 * that is, to someone who messaged the business first. A dispatch alert to a
 * driver is business-initiated and almost never inside it, so production must
 * send an approved template instead. WHATSAPP_USE_TEMPLATES chooses, because a
 * test number with the window open works perfectly well with plain text and
 * needs no template approval at all.
 */
function cloudApiPayload({ phoneNo, body, params, templateId }) {
  const to = toE164(phoneNo);

  if (config.whatsapp.useTemplates && Array.isArray(params) && params.length) {
    return {
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateId,
        language: { code: config.whatsapp.templateLanguage },
        components: [{
          type: 'body',
          parameters: params.map((p) => ({ type: 'text', text: flatten(p) })),
        }],
      },
    };
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };
}

async function sendViaCloudApi({ phoneNo, body, params, templateId }) {
  const url = `https://graph.facebook.com/${config.whatsapp.apiVersion}/${config.whatsapp.phoneNumberId}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.whatsapp.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cloudApiPayload({ phoneNo, body, params, templateId })),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.message || 'WhatsApp send failed'), { detail: json });
  return json;
}

/**
 * Sends a WhatsApp alert. Resolves to the stored message row id; never rejects,
 * because a messaging outage must not block a dispatch (NF.1).
 */
async function sendWhatsApp({ phoneNo, body, params, templateId, bookingId }) {
  const template = templateId || config.whatsapp.templates.dispatch;
  if (!usingCloudApi()) {
    console.log(`\n[whatsapp:mock -> +${toE164(phoneNo)}] template=${template}\n${body}\n`);
    return record({
      recipientPhone: phoneNo, channel: 'WHATSAPP', templateId: template,
      body, bookingId, deliveryState: 'SENT',
      providerResponse: { transport: 'mock' },
    });
  }
  try {
    const response = await sendViaCloudApi({ phoneNo, body, params, templateId: template });
    return record({
      recipientPhone: phoneNo, channel: 'WHATSAPP', templateId: template,
      body, bookingId, deliveryState: 'SENT', providerResponse: response,
    });
  } catch (err) {
    console.error('[whatsapp] send failed:', err.message);
    return record({
      recipientPhone: phoneNo, channel: 'WHATSAPP', templateId: template,
      body, bookingId, deliveryState: 'FAILED',
      providerResponse: { error: err.message, detail: err.detail },
    });
  }
}

async function sendViaFast2SMS({ phoneNo, otpCode }) {
  const numbers = to10Digits(phoneNo);
  const url = 'https://www.fast2sms.com/dev/bulkV2';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: config.sms.fast2smsApiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      route: 'otp',
      variables_values: String(otpCode),
      numbers,
    }),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.return === false || (json.status_code && json.status_code !== 200)) {
    const errorMsg = json?.message || (Array.isArray(json?.message) ? json.message.join(', ') : 'Fast2SMS OTP delivery failed');
    throw Object.assign(new Error(errorMsg), { detail: json });
  }
  return json;
}

/** OTP delivery path: sends to Email when configured, or SMS / mock. */
async function sendOtp({ phoneNo, email, otpCode }) {
  const body = `Your Ambulance Booking System verification code is ${otpCode}. It is valid for 5 minutes. Do not share this code.`;

  // 1. Email OTP delivery (zero KYC, instant Gmail delivery)
  if (usingEmail()) {
    let recipientEmail = email;
    if (!recipientEmail && phoneNo) {
      try {
        const user = db.prepare('SELECT email_id FROM users WHERE phone_no = ?').get(phoneNo);
        if (user?.email_id && user.email_id.includes('@')) {
          recipientEmail = user.email_id;
        }
      } catch (_) {}
    }
    if (!recipientEmail) {
      recipientEmail = config.email.user;
    }

    try {
      const info = await sendEmail({
        to: recipientEmail,
        subject: `🚑 Your Ambulance Verification Code: ${otpCode}`,
        text: body,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
            <div style="text-align: center; margin-bottom: 20px;">
              <span style="font-size: 38px;">🚑</span>
              <h2 style="color: #0f172a; margin: 8px 0 0; font-size: 20px;">Ambulance Booking System</h2>
              <p style="color: #64748b; font-size: 13px; margin-top: 4px;">Account Verification Code</p>
            </div>
            <div style="background-color: #f8fafc; border: 1px dashed #cbd5e1; border-radius: 8px; padding: 18px; text-align: center; margin-bottom: 20px;">
              <p style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 6px;">Your One-Time Password</p>
              <h1 style="font-size: 34px; letter-spacing: 8px; color: #dc2626; margin: 0; font-family: monospace;">${otpCode}</h1>
              <p style="color: #94a3b8; font-size: 12px; margin: 6px 0 0;">Valid for 5 minutes</p>
            </div>
            <p style="color: #475569; font-size: 14px; line-height: 1.5; margin-bottom: 16px;">
              Use this code to sign in or verify your account. For security reasons, please do not share this code with anyone.
            </p>
            <div style="border-top: 1px solid #f1f5f9; padding-top: 14px; text-align: center;">
              <p style="color: #94a3b8; font-size: 12px; margin: 0;">Sent to: ${recipientEmail} ${phoneNo ? `(Mobile: ${phoneNo})` : ''}</p>
            </div>
          </div>
        `,
      });

      console.log(`\n[otp:email -> ${recipientEmail}] OTP sent successfully: ${otpCode} (id: ${info.messageId})\n`);
      return record({
        recipientPhone: phoneNo || recipientEmail,
        channel: 'SMS',
        templateId: 'EMAIL_OTP',
        body,
        deliveryState: 'SENT',
        providerResponse: { transport: 'email', messageId: info.messageId, recipient: recipientEmail },
      });
    } catch (err) {
      console.error(`\n[otp:email] Send failed to ${recipientEmail}:`, err.message, '\n');
      if (phoneNo && usingFast2sms()) {
        try {
          const smsRes = await sendViaFast2SMS({ phoneNo, otpCode });
          console.log(`\n[sms:fast2sms-fallback -> ${phoneNo}] OTP sent successfully via SMS fallback: ${otpCode}\n`);
          return record({
            recipientPhone: phoneNo,
            channel: 'SMS',
            templateId: 'FAST2SMS_OTP_FALLBACK',
            body,
            deliveryState: 'SENT',
            providerResponse: smsRes,
          });
        } catch (smsErr) {
          console.error('[sms:fast2sms-fallback] SMS fallback also failed:', smsErr.message);
        }
      }
      return record({
        recipientPhone: phoneNo || recipientEmail,
        channel: 'SMS',
        templateId: 'EMAIL_OTP',
        body,
        deliveryState: 'FAILED',
        providerResponse: { transport: 'email', error: err.message, detail: err },
      });
    }
  }

  // 2. SMS delivery via Fast2SMS
  if (usingFast2sms()) {
    try {
      const response = await sendViaFast2SMS({ phoneNo, otpCode });
      console.log(`\n[sms:fast2sms -> ${phoneNo}] OTP sent successfully: ${otpCode} (req_id: ${response?.request_id || 'ok'})\n`);
      return record({
        recipientPhone: phoneNo,
        channel: 'SMS',
        templateId: 'FAST2SMS_OTP',
        body,
        deliveryState: 'SENT',
        providerResponse: response,
      });
    } catch (err) {
      console.error(`\n[sms:fast2sms] Delivery failed to ${phoneNo}:`, err.message, '\n');
      return record({
        recipientPhone: phoneNo,
        channel: 'SMS',
        templateId: 'FAST2SMS_OTP',
        body,
        deliveryState: 'FAILED',
        providerResponse: { error: err.message, detail: err.detail },
      });
    }
  }

  // 3. Fallback to mock transport
  console.log(`\n[otp:mock -> ${phoneNo}] ${otpCode}\n`);
  return record({
    recipientPhone: phoneNo,
    channel: 'SMS',
    templateId: 'MOCK_OTP',
    body,
    deliveryState: 'SENT',
    providerResponse: { transport: 'mock' },
  });
}

/** Marks a delivery receipt, e.g. from a Meta webhook. */
function updateDeliveryState(msgId, state) {
  db.prepare(
    'UPDATE messages SET delivery_state = ?, delivery_timestamp = ? WHERE message_id = ?'
  ).run(state, nowIso(), msgId);
}

// ------------------------------------------------------------- templates
/**
 * Each builder returns both forms of the same message:
 *
 *   body   - the readable text, used by the mock transport, the alert log, and
 *            the Cloud API inside the 24-hour customer service window
 *   params - the ordered variables for the approved WhatsApp template of the
 *            same name, used outside that window
 *
 * Call sites spread the result into sendWhatsApp, so both travel together and
 * cannot drift apart.
 *
 * Template parameters may not contain newlines or tabs - Meta rejects the
 * message - so the layout lives in the approved template and each parameter is
 * a single flat value.
 */
const templates = {
  dispatchAlert({ booking, provider, distanceKm, expirySeconds }) {
    const pickup = booking.address_text || `${booking.latitude}, ${booking.longitude}`;
    const lines = [
      'AMBULANCE DISPATCH REQUEST',
      `Booking: ${booking.booking_id}`,
      `Type: ${booking.ambulance_type}`,
      `Pickup: ${pickup}`,
    ];
    if (booking.landmark) lines.push(`Landmark: ${booking.landmark}`);
    if (distanceKm != null) lines.push(`Distance: ${distanceKm.toFixed(2)} km`);
    if (booking.notes) lines.push(`Notes: ${booking.notes}`);
    lines.push(`Vehicle: ${provider.vehicle_reg_no}`);
    lines.push(`Respond in the driver app within ${expirySeconds} seconds, or the request moves to the next ambulance.`);

    return {
      body: lines.join('\n'),
      params: [
        booking.booking_id,
        booking.ambulance_type,
        pickup,
        distanceKm != null ? `${distanceKm.toFixed(2)} km` : 'nearby',
        String(expirySeconds),
      ],
    };
  },

  assignmentConfirmed({ booking, provider, driverName, etaMinutes }) {
    return {
      body: [
        'AMBULANCE ASSIGNED',
        `Booking: ${booking.booking_id}`,
        `Driver: ${driverName} (${provider.vehicle_reg_no}, ${provider.ambulance_type})`,
        etaMinutes ? `ETA: about ${etaMinutes} minute(s)` : null,
        'Track the ambulance live in the app.',
      ].filter(Boolean).join('\n'),
      params: [
        booking.booking_id,
        driverName,
        `${provider.vehicle_reg_no}, ${provider.ambulance_type}`,
        etaMinutes ? `about ${etaMinutes} minute(s)` : 'shortly',
      ],
    };
  },

  statusUpdate({ booking, milestone, etaMinutes }) {
    const readable = {
      ASSIGNED: 'An ambulance has been assigned to your request.',
      ENROUTE: 'The ambulance is on the way to your pickup point.',
      ARRIVED: 'The ambulance has arrived at your pickup point.',
      ONBOARD: 'The patient is on board. The ambulance is moving to the hospital.',
      COMPLETED: 'The trip is complete. Your invoice is ready in the app.',
    };
    const text = readable[milestone] || milestone;
    return {
      body: [
        `Booking ${booking.booking_id}: ${text}`,
        etaMinutes ? `ETA: about ${etaMinutes} minute(s)` : null,
      ].filter(Boolean).join('\n'),
      params: [
        booking.booking_id,
        text,
        etaMinutes ? `about ${etaMinutes} minute(s)` : 'shortly',
      ],
    };
  },
};

module.exports = {
  sendWhatsApp,
  sendOtp,
  sendEmail,
  sendViaFast2SMS,
  usingFast2sms,
  usingEmail,
  updateDeliveryState,
  templates,
  usingCloudApi,
  toE164,
  to10Digits,
};
