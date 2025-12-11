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

// Estados que consideramos "activos" para la app
const ACTIVE_STATUSES = ["ACTIVE", "APPROVAL_PENDING", "APPROVED"];

if (!PAYPAL_CLIENT_ID || !PAYPAL_SECRET) {
  console.warn(
    "⚠️ PAYPAL_CLIENT_ID o PAYPAL_SECRET no están configurados. Revisa tus variables de entorno."
  );
}
if (!PAYPAL_WEBHOOK_ID) {
  console.warn(
    "⚠️ PAYPAL_WEBHOOK_ID no está configurado. Los webhooks no podrán verificarse."
  );
}

// ---------- HELPERS PAYPAL ----------

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
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  return resp.data;
}

/**
 * Guarda/actualiza la suscripción en Firestore
 * - subscriptionsById/{subscriptionId}
 * - userSubscriptions/{email} (si conocemos email)
 */
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
    billingInfo.last_payment && billingInfo.last_payment.time
      ? billingInfo.last_payment.time
      : null;

  const subRef = db.collection("subscriptionsById").doc(subscriptionId);
  const subSnap = await subRef.get();
  const prevData = subSnap.exists ? subSnap.data() : {};

  // si no vino email, intenta usar el que ya teníamos
  const finalEmail = email || prevData.email || null;

  // 1) subscriptionsById
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

  // 2) userSubscriptions (solo si conocemos email)
  if (finalEmail) {
    const userRef = db.collection("userSubscriptions").doc(finalEmail.toLowerCase());
    await userRef.set(
      {
        email: finalEmail.toLowerCase(),
        userId: finalEmail.toLowerCase(),
        subscriptionId,
        status,
        planId,
        startTime: startTime || null,
        nextBillingTime,
        lastPaymentTime,
        lastWebhookEvent: lastWebhookEvent || null,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }

  return {
    subscriptionId,
    status,
    planId,
    nextBillingTime,
    lastPaymentTime,
    email: finalEmail,
  };
}

/**
 * Verifica la firma del webhook con la API de PayPal
 */
async function verifyWebhookSignature(req) {
  if (!PAYPAL_WEBHOOK_ID) {
    throw new Error("PAYPAL_WEBHOOK_ID no configurado");
  }

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
    }
  );

  return resp.data.verification_status === "SUCCESS";
}

// ---------- ENDPOINTS ----------

/**
 * POST /api/paypal/validate-subscription
 * Se llama desde tu index.html después de crear la suscripción en PayPal.
 * Body: { subscriptionId, userId, email }
 */
app.post("/api/paypal/validate-subscription", async (req, res) => {
  try {
    const { subscriptionId, userId, email } = req.body;

    if (!subscriptionId) {
      return res
        .status(400)
        .json({ ok: false, message: "subscriptionId es requerido" });
    }

    const subscription = await getSubscriptionFromPayPal(subscriptionId);

    // Guarda/actualiza en Firestore
    const upsertInfo = await upsertSubscriptionInFirestore({
      subscription,
      email: email || userId || null,
      lastWebhookEvent: "VALIDATE_SUBSCRIPTION",
    });

    // Activa para la app si está en alguno de los estados permitidos
    const activeForApp = ACTIVE_STATUSES.includes(subscription.status);

    return res.json({
      ok: true,
      userId: (email || userId || "").toLowerCase() || null,
      activeForApp,
      subscriptionStatus: subscription.status,
      subscriptionId: subscription.id,
      planId: subscription.plan_id,
      nextBillingTime: upsertInfo.nextBillingTime,
      lastPaymentTime: upsertInfo.lastPaymentTime,
    });
  } catch (err) {
    console.error(
      "Error en /api/paypal/validate-subscription:",
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      message: "Error validando suscripción",
      error: err.response?.data || err.message,
    });
  }
});

/**
 * GET /api/subscription/status/:userId
 * Endpoint tipo REST con parámetro en la URL.
 * Lo puedes usar desde scripts, pruebas, etc.
 */
app.get("/api/subscription/status/:userId", async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.userId).toLowerCase();
    const doc = await db.collection("userSubscriptions").doc(userId).get();

    if (!doc.exists) {
      return res.json({
        ok: true,
        userId,
        activeForApp: false,
        subscriptionStatus: "NONE",
      });
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
  } catch (err) {
    console.error(
      "Error en /api/subscription/status:",
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      message: "Error consultando estado de suscripción",
    });
  }
});

/**
 * GET /api/app/user-status?userId=correo
 * Este es el endpoint que usa la APP ANDROID (SubscriptionApi).
 * Mismo comportamiento que /api/subscription/status/:userId pero con query param.
 */
app.get("/api/app/user-status", async (req, res) => {
  try {
    const rawUserId = (req.query.userId || "").toString().trim();
    if (!rawUserId) {
      return res.status(400).json({
        ok: false,
        message: "Falta el parámetro userId (correo).",
      });
    }

    const userId = rawUserId.toLowerCase();
    const doc = await db.collection("userSubscriptions").doc(userId).get();

    if (!doc.exists) {
      return res.json({
        ok: true,
        userId,
        activeForApp: false,
        subscriptionStatus: "NONE",
      });
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
  } catch (err) {
    console.error(
      "Error en /api/app/user-status:",
      err.response?.data || err.message
    );
    return res.status(500).json({
      ok: false,
      message: "Error consultando estado de suscripción",
    });
  }
});

/**
 * POST /api/paypal/webhook
 * PayPal envía aquí eventos cuando cambia algo en la suscripción.
 */
app.post("/api/paypal/webhook", async (req, res) => {
  try {
    // 1) Verificar firma
    const isValid = await verifyWebhookSignature(req);
    if (!isValid) {
      console.error("Firma de webhook PayPal NO válida");
      return res.status(400).send("INVALID_SIGNATURE");
    }

    const event = req.body;
    console.log("Webhook PayPal recibido:", event.event_type);

    const eventType = event.event_type;
    const resource = event.resource || {};
    const subscriptionId = resource.id;

    if (!subscriptionId) {
      console.warn("Webhook sin subscriptionId en resource.id");
      return res.status(200).send("NO_SUBSCRIPTION_ID");
    }

    // 2) Traer estado actual de la suscripción desde PayPal
    const subscription = await getSubscriptionFromPayPal(subscriptionId);

    // 3) Actualizar Firestore
    await upsertSubscriptionInFirestore({
      subscription,
      email: null, // intentará usar el email ya guardado
      lastWebhookEvent: eventType,
    });

    console.log(
      `Webhook procesado para suscripción ${subscriptionId} con estado ${subscription.status}`
    );

    return res.status(200).send("OK");
  } catch (err) {
    console.error(
      "Error procesando webhook PayPal:",
      err.response?.data || err.message
    );
    return res.status(500).send("ERROR");
  }
});

// ---------- ARRANQUE ----------

app.get("/", (req, res) => {
  res.send("VacunasECPro backend funcionando ✅");
});

app.listen(PORT, () => {
  console.log(`✅ VacunasECPro backend escuchando en puerto ${PORT}`);
});