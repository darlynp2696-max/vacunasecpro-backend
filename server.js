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
  console.warn(
    "⚠️ PAYPAL_CLIENT_ID o PAYPAL_SECRET no están configurados. Revisa tus variables de entorno."
  );
}
if (!PAYPAL_WEBHOOK_ID) {
  console.warn(
    "⚠️ PAYPAL_WEBHOOK_ID no está configurado. Los webhooks no podrán verificarse."
  );
}
if (!ADMIN_KEY) {
  console.warn(
    "⚠️ ADMIN_KEY no está configurado. /api/admin/activate-qr estará deshabilitado por seguridad."
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
    const userKey = finalEmail.toLowerCase();
    const userRef = db.collection("userSubscriptions").doc(userKey);
    await userRef.set(
      {
        email: userKey,
        userId: userKey,
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
 * Actualiza "entitlement" simple para la app en:
 * users/{emailLower}
 * proActive: true/false, plan, source, status...
 */
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
}) {
  if (!email) return;

  const emailLower = String(email).trim().toLowerCase();
  const ref = db.collection("users").doc(emailLower);

  await ref.set(
    {
      email: emailLower,
      proActive: !!activeForApp,
      plan: plan || null,               // "monthly" | "yearly" | null
      source: source || "unknown",      // "paypal" | "qr" | "backend" | etc.
      subscriptionStatus: subscriptionStatus || null,
      subscriptionId: subscriptionId || null,
      planId: planId || null,
      nextBillingTime: nextBillingTime || null,
      lastPaymentTime: lastPaymentTime || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
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

// ---------- ADMIN ENDPOINTS ----------

// Ping Firestore: útil para comprobar que Firebase Admin está OK
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

// Activación manual por QR (requiere header x-admin-key)
app.post("/api/admin/activate-qr", async (req, res) => {
  try {
    const key = req.header("x-admin-key");
    if (!ADMIN_KEY || !key || key !== ADMIN_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { email, plan } = req.body || {};
    if (!email || !plan) {
      return res.status(400).json({
        ok: false,
        error: "Missing email or plan",
        example: { email: "usuario@correo.com", plan: "monthly|yearly" },
      });
    }

    const emailLower = String(email).trim().toLowerCase();
    const planNorm = String(plan).trim().toLowerCase();
    if (planNorm !== "monthly" && planNorm !== "yearly") {
      return res.status(400).json({
        ok: false,
        error: "Invalid plan. Use monthly or yearly.",
      });
    }

    // Escribe el “entitlement” directo para la app
    await db.collection("users").doc(emailLower).set(
      {
        email: emailLower,
        proActive: true,
        plan: planNorm,
        source: "qr",
        subscriptionStatus: "ACTIVE",
        activatedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    // (Opcional) también escribir userSubscriptions para que tu endpoint actual lo vea:
    await db.collection("userSubscriptions").doc(emailLower).set(
      {
        email: emailLower,
        userId: emailLower,
        status: "ACTIVE",
        planId: planNorm === "yearly" ? "MANUAL_YEARLY" : "MANUAL_MONTHLY",
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
      email: emailLower,
      plan: planNorm,
    });
  } catch (e) {
    console.error("activate-qr error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- ENDPOINTS PAYPAL ----------

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

    // Guarda/actualiza en Firestore (colecciones actuales)
    const upsertInfo = await upsertSubscriptionInFirestore({
      subscription,
      email: email || userId || null,
      lastWebhookEvent: "VALIDATE_SUBSCRIPTION",
    });

    const userEmail = (email || userId || "").toLowerCase() || null;

    // Activa para la app si está en alguno de los estados permitidos
    const activeForApp = ACTIVE_STATUSES.includes(subscription.status);

    // ✅ NUEVO: guarda/actualiza “users/{email}” para que Android pueda leerlo
    if (userEmail) {
      const plan =
        subscription.plan_id === "P-4B997107KS231694UNE3ADTY"
          ? "yearly"
          : subscription.plan_id === "P-7WS92829J39649832NE3ABTY"
          ? "monthly"
          : null;

      await upsertUserEntitlement({
        email: userEmail,
        activeForApp,
        plan,
        source: "paypal",
        subscriptionStatus: subscription.status,
        subscriptionId: subscription.id,
        planId: subscription.plan_id,
        nextBillingTime: upsertInfo.nextBillingTime,
        lastPaymentTime: upsertInfo.lastPaymentTime,
      });
    }

    return res.json({
      ok: true,
      userId: userEmail,
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
 */
app.get("/api/subscription/status/:userId", async (req, res) => {
  try {
    const userId = decodeURIComponent(req.params.userId).toLowerCase();
    const doc = await db.collection("userSubscriptions").doc(userId).get();

    if (!doc.exists) {
      // cache simple en users/{email} -> proActive false
      await upsertUserEntitlement({
        email: userId,
        activeForApp: false,
        plan: null,
        source: "backend",
        subscriptionStatus: "NONE",
      });

      return res.json({
        ok: true,
        userId,
        activeForApp: false,
        subscriptionStatus: "NONE",
      });
    }

    const data = doc.data();
    const isActive = ACTIVE_STATUSES.includes(data.status);

    // cache simple en users/{email}
    await upsertUserEntitlement({
      email: userId,
      activeForApp: isActive,
      plan: (data.planId || "").toString().toLowerCase().includes("year")
        ? "yearly"
        : (data.planId || "").toString().toLowerCase().includes("month")
        ? "monthly"
        : null,
      source: data.lastWebhookEvent === "MANUAL_QR_ACTIVATION" ? "qr" : "backend",
      subscriptionStatus: data.status,
      subscriptionId: data.subscriptionId || null,
      planId: data.planId || null,
      nextBillingTime: data.nextBillingTime || null,
      lastPaymentTime: data.lastPaymentTime || null,
    });

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
      // cache simple en users/{email} -> proActive false
      await upsertUserEntitlement({
        email: userId,
        activeForApp: false,
        plan: null,
        source: "backend",
        subscriptionStatus: "NONE",
      });

      return res.json({
        ok: true,
        userId,
        activeForApp: false,
        subscriptionStatus: "NONE",
      });
    }

    const data = doc.data();
    const isActive = ACTIVE_STATUSES.includes(data.status);

    // cache simple en users/{email}
    await upsertUserEntitlement({
      email: userId,
      activeForApp: isActive,
      plan: (data.planId || "").toString().toLowerCase().includes("year")
        ? "yearly"
        : (data.planId || "").toString().toLowerCase().includes("month")
        ? "monthly"
        : null,
      source: data.lastWebhookEvent === "MANUAL_QR_ACTIVATION" ? "qr" : "backend",
      subscriptionStatus: data.status,
      subscriptionId: data.subscriptionId || null,
      planId: data.planId || null,
      nextBillingTime: data.nextBillingTime || null,
      lastPaymentTime: data.lastPaymentTime || null,
    });

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
 */
app.post("/api/paypal/webhook", async (req, res) => {
  try {
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

    const subscription = await getSubscriptionFromPayPal(subscriptionId);

    const upsertInfo = await upsertSubscriptionInFirestore({
      subscription,
      email: null,
      lastWebhookEvent: eventType,
    });

    // Si conocemos email en subscriptionsById, lo obtendrá upsertSubscriptionInFirestore
    const emailLower = (upsertInfo.email || "").toLowerCase() || null;
    const activeForApp = ACTIVE_STATUSES.includes(subscription.status);

    if (emailLower) {
      const plan =
        subscription.plan_id === "P-4B997107KS231694UNE3ADTY"
          ? "yearly"
          : subscription.plan_id === "P-7WS92829J39649832NE3ABTY"
          ? "monthly"
          : null;

      await upsertUserEntitlement({
        email: emailLower,
        activeForApp,
        plan,
        source: "paypal",
        subscriptionStatus: subscription.status,
        subscriptionId: subscription.id,
        planId: subscription.plan_id,
        nextBillingTime: upsertInfo.nextBillingTime,
        lastPaymentTime: upsertInfo.lastPaymentTime,
      });
    }

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