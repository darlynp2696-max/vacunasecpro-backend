// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { admin, db } = require('./firebaseAdmin');

const app = express();
const PORT = process.env.PORT || 4000;

// CORS (ajusta origins en producción)
app.use(cors());
app.use(express.json());

// Config PayPal (LIVE)
const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_API_BASE = 'https://api-m.paypal.com';

// Helper: obtener token de PayPal
async function getPayPalAccessToken() {
  const resp = await axios({
    url: `${PAYPAL_API_BASE}/v1/oauth2/token`,
    method: 'post',
    auth: {
      username: PAYPAL_CLIENT_ID,
      password: PAYPAL_CLIENT_SECRET,
    },
    params: {
      grant_type: 'client_credentials',
    },
  });
  return resp.data.access_token;
}

// Helper: obtener detalles de la suscripción
async function getPayPalSubscription(subscriptionId) {
  const token = await getPayPalAccessToken();
  const resp = await axios.get(
    `${PAYPAL_API_BASE}/v1/billing/subscriptions/${subscriptionId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  return resp.data;
}

// 🔹 Guardar/actualizar suscripción en Firestore
async function saveSubscriptionRecord({
  userId,
  email,
  subscriptionId,
  planId,
  status,
  nextBillingTime,
  raw,
}) {
  const docRef = db.collection('subscriptions').doc(userId);

  await docRef.set(
    {
      userId,
      email,
      subscriptionId,
      planId,
      status,
      nextBillingTime: nextBillingTime || null,
      raw: raw || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

// 🔹 Leer suscripción desde Firestore
async function getSubscriptionRecord(userId) {
  const doc = await db.collection('subscriptions').doc(userId).get();
  if (!doc.exists) return null;
  return doc.data();
}

// ✅ Endpoint: validar suscripción después del pago
app.post('/api/paypal/validate-subscription', async (req, res) => {
  try {
    const { subscriptionId, userId, email } = req.body;

    if (!subscriptionId || !userId || !email) {
      return res.status(400).json({
        ok: false,
        error: 'subscriptionId, userId y email son obligatorios',
      });
    }

    console.log('Validando suscripción:', subscriptionId, 'para', userId);

    const paypalSub = await getPayPalSubscription(subscriptionId);

    const status = paypalSub.status; // ACTIVE, SUSPENDED, CANCELLED, etc.
    const planId = paypalSub.plan_id;
    const nextBillingTime =
      paypalSub.billing_info?.next_billing_time || null;

    // Lógica de si consideramos activa para la app
    const activeStatuses = ['ACTIVE', 'TRIALING'];
    const activeForApp = activeStatuses.includes(status);

    // Guardamos en Firestore
    await saveSubscriptionRecord({
      userId,
      email,
      subscriptionId,
      planId,
      status,
      nextBillingTime,
      raw: {
        status,
        planId,
        nextBillingTime,
      },
    });

    return res.json({
      ok: true,
      userId,
      email,
      subscriptionId,
      subscriptionStatus: status,
      activeForApp,
      planId,
      nextBillingTime,
    });
  } catch (err) {
    console.error('Error validando suscripción PayPal:', err?.response?.data || err);

    return res.status(500).json({
      ok: false,
      error: 'Error al validar la suscripción en PayPal',
      details: err?.response?.data || err.message,
    });
  }
});

// ✅ Endpoint: consultar estado por userId (correo)
app.get('/api/subscription/status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({
        ok: false,
        error: 'userId requerido',
      });
    }

    const record = await getSubscriptionRecord(userId);

    if (!record) {
      return res.json({
        ok: true,
        userId,
        activeForApp: false,
        subscriptionStatus: 'NONE',
      });
    }

    const activeStatuses = ['ACTIVE', 'TRIALING'];
    const activeForApp = activeStatuses.includes(record.status);

    return res.json({
      ok: true,
      userId: record.userId,
      activeForApp,
      subscriptionStatus: record.status,
      subscriptionId: record.subscriptionId,
      planId: record.planId,
      nextBillingTime: record.nextBillingTime,
    });
  } catch (err) {
    console.error('Error consultando suscripción:', err);
    return res.status(500).json({
      ok: false,
      error: 'Error consultando suscripción',
      details: err.message,
    });
  }
});

// (Opcional) Endpoint debug: listar todas las suscripciones (solo desarrollo)
app.get('/api/subscription/debug/all', async (req, res) => {
  try {
    const snap = await db.collection('subscriptions').get();
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send('VacunasECPro backend OK');
});

app.listen(PORT, () => {
  console.log(`✅ VacunasECPro backend escuchando en puerto ${PORT}`);
});