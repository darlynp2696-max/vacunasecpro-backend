require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { admin, db } = require("./firebaseAdmin");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_SECRET = process.env.PAYPAL_SECRET;
const PAYPAL_WEBHOOK_ID = process.env.PAYPAL_WEBHOOK_ID;
const PAYPAL_BASE = "https://api-m.paypal.com"; // LIVE

// Admin key para endpoints manuales (QR)
const ADMIN_KEY = process.env.ADMIN_KEY || "";

// Estados que consideramos "activos" para la app
const ACTIVE_STATUSES = ["ACTIVE", "APPROVAL_PENDING", "APPROVED"];

if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.warn("⚠️ PAYPAL_CLIENT_ID o PAYPAL_SECRET no están configurados.");
}
if (!PAYPAL_WEBHOOK_ID) {
  console.warn("⚠️ PAYPAL_WEBHOOK_ID no está configurado.");
}
if (!ADMIN_KEY) {
  console.warn("⚠️ ADMIN_KEY no está configurado.");
}

/* ======================================================
   HELPERS DE EXPIRACIÓN (BASE OFFLINE)
   ====================================================== */

function daysFromNowToIso(days) {
  const ms = days * 24 * 60 * 60 * 1000;
  return new Date(Date.now() + ms).toISOString();
}

function computeExpiresAtIso(plan) {
  const p = (plan || "").toLowerCase();
  if (p === "yearly") return daysFromNowToIso(365);
  if (p === "monthly") return daysFromNowToIso(30);
  return null;
}

/* ======================================================
   PAYPAL HELPERS
   ====================================================== */

async function getPayPalAccessToken() {
  const basicAuth = Buffer.from(
    `${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`
  ).toString("base64");

  const resp = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  return resp.data.access_token;
}

async function getSubscriptionFromPayPal(subscriptionId) {
  const accessToken = await getPayPalAccessToken();

  const resp = await axios.get(
    `${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  return resp.data;
}

/* ======================================================
   FIRESTORE – SUSCRIPCIONES PAYPAL
   ====================================================== */

async function upsertSubscriptionInFirestore({
  subscription,
  email,
  lastWebhookEvent,
}) {
  const subscriptionId = subscription.id;
  const status = subscription.status;
  const planId = subscription.plan_id;
  const startTime = subscription.start_time;
  const billingInfo = subscription.billing_info || {};

  const nextBillingTime = billingInfo.next_billing_time || null;
  const lastPaymentTime =
    billingInfo.last_payment?.time || null;

  const subRef = db.collection("subscriptionsById").doc(subscriptionId);
  const subSnap = await subRef.get();
  const prevData = subSnap.exists ? subSnap.data() : {};

  const finalEmail = email || prevData.email || null;

  await subRef.set(
    {
      subscriptionId,
      email: finalEmail,
      status,
      planId,
      startTime: startTime || prevData.startTime || null,
      nextBillingTime,
      lastPaymentTime,
      lastWebhookEvent: lastWebhookEvent || prevData.lastWebhookEvent || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  if (finalEmail) {
    const key = finalEmail.toLowerCase();
    await db.collection("userSubscriptions").doc(key).set(
      {
        email: key,
        userId: key,
        subscriptionId,
        status,
        planId,
        startTime,
        nextBillingTime,
        lastPaymentTime,
        lastWebhookEvent,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return {
    email: finalEmail,
    subscriptionId,
    status,
    planId,
    nextBillingTime,
    lastPaymentTime,
  };
}

/* ======================================================
   FIRESTORE – ENTITLEMENT OFFLINE (CLAVE)
   ====================================================== */

async function upsertUserEntitlement({
  email,
  activeForApp,
  plan,
  source,
  subscriptionStatus,
  subscriptionId,
  planId,
  nextBillingTime,
  lastPaymentTime,
  expiresAtIso,
}) {
  if (!email) return;

  const emailLower = email.toLowerCase();
  const ref = db.collection("users").doc(emailLower);

  const expiresAt =
    expiresAtIso || (activeForApp ? computeExpiresAtIso(plan) : null);

  await ref.set(
    {
      email: emailLower,
      proActive: !!activeForApp,
      plan: plan || null,
      source: source || "unknown",
      subscriptionStatus: subscriptionStatus || null,
      subscriptionId: subscriptionId || null,
      planId: planId || null,
      nextBillingTime: nextBillingTime || null,
      lastPaymentTime: lastPaymentTime || null,

      // 🔑 OFFLINE
      expiresAt,
      lastValidatedAt: new Date().toISOString(),

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/* ======================================================
   ADMIN – ACTIVACIÓN MANUAL QR
   ====================================================== */

app.post("/api/admin/activate-qr", async (req, res) => {
  try {
    const key = req.header("x-admin-key");
    if (!ADMIN_KEY || key !== ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { email, plan } = req.body;
    if (!email || !plan) {
      return res.status(400).json({ ok: false, error: "Missing email or plan" });
    }

    const emailLower = email.toLowerCase();
    const planNorm = plan.toLowerCase();

    const expiresAtIso =
      planNorm === "yearly"
        ? daysFromNowToIso(365)
        : daysFromNowToIso(30);

    await upsertUserEntitlement({
      email: emailLower,
      activeForApp: true,
      plan: planNorm,
      source: "qr",
      subscriptionStatus: "ACTIVE",
      expiresAtIso,
    });

    return res.json({
      ok: true,
      message: "User activated by QR",
      email: emailLower,
      plan: planNorm,
      expiresAt: expiresAtIso,
    });
  } catch (e) {
    console.error("activate-qr error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* ======================================================
   PAYPAL – VALIDACIÓN
   ====================================================== */

app.post("/api/paypal/validate-subscription", async (req, res) => {
  try {
    const { subscriptionId, email, userId } = req.body;
    if (!subscriptionId) {
      return res.status(400).json({ ok: false });
    }

    const subscription = await getSubscriptionFromPayPal(subscriptionId);

    const info = await upsertSubscriptionInFirestore({
      subscription,
      email: email || userId || null,
      lastWebhookEvent: "VALIDATE_SUBSCRIPTION",
    });

    const plan =
      subscription.plan_id === "P-4B997107KS231694UNE3ADTY"
        ? "yearly"
        : "monthly";

    const activeForApp = ACTIVE_STATUSES.includes(subscription.status);

    if (info.email) {
      await upsertUserEntitlement({
        email: info.email,
        activeForApp,
        plan,
        source: "paypal",
        subscriptionStatus: subscription.status,
        subscriptionId: subscription.id,
        planId: subscription.plan_id,
        nextBillingTime: info.nextBillingTime,
        lastPaymentTime: info.lastPaymentTime,
      });
    }

    return res.json({ ok: true, activeForApp });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false });
  }
});

/* ======================================================
   ARRANQUE
   ====================================================== */

app.get("/", (_, res) => {
  res.send("VacEcPro backend funcionando ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Backend escuchando en puerto ${PORT}`);
});