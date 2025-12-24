// server.js
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { admin, db } = require("./firebaseAdmin");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;

// ==============================
// ENV
// ==============================
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
  console.warn("⚠️ ADMIN_KEY no está configurado. Endpoints /api/admin/* quedarán protegidos/inútiles.");
}

// ==============================
// HELPERS DE EXPIRACIÓN (BASE OFFLINE)
// ==============================
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

// Si quieres tolerancia por desfase/atraso de reloj del teléfono:
function addGraceMs(iso, graceDays = 2) {
  if (!iso) return null;
  try {
    const ms = Date.parse(iso) + graceDays * 24 * 60 * 60 * 1000;
    return new Date(ms).toISOString();
  } catch {
    return iso;
  }
}

// ==============================
// PAYPAL HELPERS
// ==============================
async function getPayPalAccessToken() {
  const basicAuth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString("base64");

  const resp = await axios.post(
    `${PAYPAL_BASE}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    }
  );

  return resp.data.access_token;
}

async function getSubscriptionFromPayPal(subscriptionId) {
  const accessToken = await getPayPalAccessToken();

  const resp = await axios.get(
    `${PAYPAL_BASE}/v1/billing/subscriptions/${subscriptionId}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 15000,
    }
  );

  return resp.data;
}

/**
 * Verifica la firma del webhook con la API de PayPal
 */
async function verifyWebhookSignature(req) {
  if (!PAYPAL_WEBHOOK_ID) throw new Error("PAYPAL_WEBHOOK_ID no configurado");

  const transmissionId = req.get("paypal-transmission-id");
  const transmissionTime = req.get("paypal-transmission-time");
  const certUrl = req.get("paypal-cert-url");
  const authAlgo = req.get("paypal-auth-algo");
  const transmissionSig = req.get("paypal-transmission-sig");
  const webhookEvent = req.body;

  const accessToken = await getPayPalAccessToken();

  const resp = await axios.post(
    `${PAYPAL_BASE}/v1/notifications/verify-webhook-signature`,
    {
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: PAYPAL_WEBHOOK_ID,
      webhook_event: webhookEvent,
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  return resp.data.verification_status === "SUCCESS";
}

// ==============================
// FIRESTORE – SUSCRIPCIONES PAYPAL (historial)
// ==============================
async function upsertSubscriptionInFirestore({ subscription, email, lastWebhookEvent }) {
  const subscriptionId = subscription.id;
  const status = subscription.status;
  const planId = subscription.plan_id;
  const startTime = subscription.start_time || null;
  const billingInfo = subscription.billing_info || {};

  const nextBillingTime = billingInfo.next_billing_time || null;
  const lastPaymentTime = billingInfo.last_payment?.time || null;

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

  // Índice por usuario (opcional pero útil)
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
        lastWebhookEvent: lastWebhookEvent || null,
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

// ==============================
// FIRESTORE – ENTITLEMENT OFFLINE (users/{email})
// ==============================
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

  const emailLower = String(email).trim().toLowerCase();
  const ref = db.collection("users").doc(emailLower);

  // Si está activo y no te pasan expiresAtIso, lo calculamos
  let expiresAt = expiresAtIso || (activeForApp ? computeExpiresAtIso(plan) : null);

  // (Opcional) tolerancia de 2 días por reloj incorrecto del teléfono
  expiresAt = addGraceMs(expiresAt, 2);

  await ref.set(
    {
      email: emailLower,
      proActive: !!activeForApp,
      plan: plan || null, // monthly | yearly | null
      source: source || "unknown", // paypal | qr | backend | etc
      subscriptionStatus: subscriptionStatus || null,
      subscriptionId: subscriptionId || null,
      planId: planId || null,
      nextBillingTime: nextBillingTime || null,
      lastPaymentTime: lastPaymentTime || null,

      // 🔑 OFFLINE
      expiresAt, // ISO string
      lastValidatedAt: new Date().toISOString(),

      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// ==============================
// ADMIN – utilidades
// ==============================

// Ping Firestore: para comprobar que Firebase Admin está OK
app.get("/api/admin/ping-firestore", async (req, res) => {
  try {
    await db.collection("test").doc("ping").set(
      {
        ok: true,
        at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return res.json({ ok: true, msg: "Firestore conectado correctamente" });
  } catch (e) {
    console.error("ping-firestore error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ==============================
// AUTH – Registro web (backend)
// ==============================
// POST /api/auth/register
// Body: { email, password }
// Crea usuario en FirebaseAuth para que luego pueda loguear en Android con ese mismo email/pass.
app.post("/api/auth/register", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Missing email or password" });
    }
    if (password.length < 6) {
      return res.status(400).json({ ok: false, error: "Password must be at least 6 characters" });
    }

    // Si ya existe, devolvemos ok=true para no bloquear el flujo (puedes cambiar esto si quieres)
    try {
      const existing = await admin.auth().getUserByEmail(email);
      return res.json({ ok: true, uid: existing.uid, email, alreadyExisted: true });
    } catch (_) {
      // no existe, lo creamos
    }

    const user = await admin.auth().createUser({ email, password });
    return res.json({ ok: true, uid: user.uid, email, alreadyExisted: false });
  } catch (e) {
    console.error("register error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ==============================
// ADMIN – Activación manual QR
// ==============================
// POST /api/admin/activate-qr
// Header: x-admin-key: <ADMIN_KEY>
// Body: { email, plan: "monthly"|"yearly" }
app.post("/api/admin/activate-qr", async (req, res) => {
  try {
    const key = req.header("x-admin-key");
    if (!ADMIN_KEY || !key || key !== ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const email = String(req.body?.email || "").trim().toLowerCase();
    const plan = String(req.body?.plan || "").trim().toLowerCase();

    if (!email || !plan) {
      return res.status(400).json({
        ok: false,
        error: "Missing email or plan",
        example: { email: "usuario@correo.com", plan: "monthly|yearly" },
      });
    }
    if (plan !== "monthly" && plan !== "yearly") {
      return res.status(400).json({ ok: false, error: "Invalid plan. Use monthly or yearly." });
    }

    const expiresAtIso = plan === "yearly" ? daysFromNowToIso(365) : daysFromNowToIso(30);

    await upsertUserEntitlement({
      email,
      activeForApp: true,
      plan,
      source: "qr",
      subscriptionStatus: "ACTIVE",
      expiresAtIso,
    });

    // (Opcional) índice legacy para tu endpoint /api/subscription/status
    await db.collection("userSubscriptions").doc(email).set(
      {
        email,
        userId: email,
        status: "ACTIVE",
        planId: plan === "yearly" ? "MANUAL_YEARLY" : "MANUAL_MONTHLY",
        subscriptionId: `MANUAL_QR_${Date.now()}`,
        startTime: new Date().toISOString(),
        nextBillingTime: null,
        lastPaymentTime: new Date().toISOString(),
        lastWebhookEvent: "MANUAL_QR_ACTIVATION",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.json({
      ok: true,
      message: "User activated by QR",
      email,
      plan,
      expiresAt: expiresAtIso,
    });
  } catch (e) {
    console.error("activate-qr error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ==============================
// PAYPAL – VALIDACIÓN (después de pagar)
// ==============================
// POST /api/paypal/validate-subscription
// Body: { subscriptionId, email, userId }
app.post("/api/paypal/validate-subscription", async (req, res) => {
  try {
    const subscriptionId = String(req.body?.subscriptionId || "").trim();
    const email = String(req.body?.email || req.body?.userId || "").trim().toLowerCase() || null;

    if (!subscriptionId) {
      return res.status(400).json({ ok: false, message: "subscriptionId es requerido" });
    }

    const subscription = await getSubscriptionFromPayPal(subscriptionId);

    const info = await upsertSubscriptionInFirestore({
      subscription,
      email,
      lastWebhookEvent: "VALIDATE_SUBSCRIPTION",
    });

    const activeForApp = ACTIVE_STATUSES.includes(subscription.status);

    // Ajusta estos plan_id a los tuyos reales
    const plan =
      subscription.plan_id === "P-4B997107KS231694UNE3ADTY"
        ? "yearly"
        : subscription.plan_id === "P-7WS92829J39649832NE3ABTY"
        ? "monthly"
        : null;

    if (info.email) {
      // Si PayPal viene ACTIVE, calculamos expiresAt local (offline base)
      // (Si luego llega webhook de cancelación, lo desactiva)
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

    return res.json({
      ok: true,
      userId: info.email,
      activeForApp,
      subscriptionStatus: subscription.status,
      subscriptionId: subscription.id,
      planId: subscription.plan_id,
    });
  } catch (e) {
    console.error("validate-subscription error:", e.response?.data || e.message);
    return res.status(500).json({ ok: false, error: e.response?.data || e.message });
  }
});

// ==============================
// PAYPAL – WEBHOOK (mantener Firestore sincronizado)
// ==============================
// POST /api/paypal/webhook
app.post("/api/paypal/webhook", async (req, res) => {
  try {
    const isValid = await verifyWebhookSignature(req);
    if (!isValid) {
      console.error("Firma de webhook PayPal NO válida");
      return res.status(400).send("INVALID_SIGNATURE");
    }

    const event = req.body;
    const eventType = event.event_type;
    const resource = event.resource || {};
    const subscriptionId = resource.id;

    if (!subscriptionId) {
      return res.status(200).send("NO_SUBSCRIPTION_ID");
    }

    const subscription = await getSubscriptionFromPayPal(subscriptionId);

    const info = await upsertSubscriptionInFirestore({
      subscription,
      email: null, // lo intentará recuperar de subscriptionsById si ya existía
      lastWebhookEvent: eventType,
    });

    const activeForApp = ACTIVE_STATUSES.includes(subscription.status);

    const plan =
      subscription.plan_id === "P-4B997107KS231694UNE3ADTY"
        ? "yearly"
        : subscription.plan_id === "P-7WS92829J39649832NE3ABTY"
        ? "monthly"
        : null;

    // Si el webhook indica cancelación/suspensión, proActive queda false
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
        // Nota: si llega cancelación, no seteo expiresAt nuevo (queda el último, pero proActive=false manda)
      });
    }

    return res.status(200).send("OK");
  } catch (e) {
    console.error("paypal webhook error:", e.response?.data || e.message);
    return res.status(500).send("ERROR");
  }
});

// ==============================
// ENDPOINTS PARA LA APP (status)
// ==============================

// GET /api/subscription/status/:userId  (legacy - lee userSubscriptions)
app.get("/api/subscription/status/:userId", async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.userId).trim().toLowerCase();
    const doc = await db.collection("userSubscriptions").doc(userId).get();

    if (!doc.exists) {
      return res.json({ ok: true, userId, activeForApp: false, subscriptionStatus: "NONE" });
    }

    const data = doc.data();
    const isActive = ACTIVE_STATUSES.includes(data.status);

    return res.json({
      ok: true,
      userId,
      activeForApp: isActive,
      subscriptionStatus: data.status,
      subscriptionId: data.subscriptionId || null,
      planId: data.planId || null,
      nextBillingTime: data.nextBillingTime || null,
      lastPaymentTime: data.lastPaymentTime || null,
    });
  } catch (e) {
    console.error("status/:userId error:", e);
    return res.status(500).json({ ok: false, message: "Error consultando estado" });
  }
});

// GET /api/app/user-status?userId=correo  (tu Android actual)
app.get("/api/app/user-status", async (req, res) => {
  try {
    const raw = String(req.query.userId || "").trim();
    if (!raw) return res.status(400).json({ ok: false, message: "Falta userId" });

    const userId = raw.toLowerCase();
    const doc = await db.collection("userSubscriptions").doc(userId).get();

    if (!doc.exists) {
      return res.json({ ok: true, userId, activeForApp: false, subscriptionStatus: "NONE" });
    }

    const data = doc.data();
    const isActive = ACTIVE_STATUSES.includes(data.status);

    return res.json({
      ok: true,
      userId,
      activeForApp: isActive,
      subscriptionStatus: data.status,
      subscriptionId: data.subscriptionId || null,
      planId: data.planId || null,
      nextBillingTime: data.nextBillingTime || null,
      lastPaymentTime: data.lastPaymentTime || null,
    });
  } catch (e) {
    console.error("/api/app/user-status error:", e);
    return res.status(500).json({ ok: false, message: "Error consultando estado" });
  }
});

// (Opcional pero recomendado) Endpoint directo a users/{email} para que Android no dependa de userSubscriptions
// GET /api/app/entitlement?email=correo
app.get("/api/app/entitlement", async (req, res) => {
  try {
    const email = String(req.query.email || "").trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, message: "Falta email" });

    const doc = await db.collection("users").doc(email).get();
    if (!doc.exists) {
      return res.json({ ok: true, exists: false, email, proActive: false });
    }

    const data = doc.data() || {};
    return res.json({ ok: true, exists: true, ...data });
  } catch (e) {
    console.error("/api/app/entitlement error:", e);
    return res.status(500).json({ ok: false, message: "Error consultando entitlement" });
  }
});

// ==============================
// HOME
// ==============================
app.get("/", (_, res) => {
  res.send("VacEcPro backend funcionando ✅");
});

app.listen(PORT, () => {
  console.log(`🚀 Backend escuchando en puerto ${PORT}`);
});