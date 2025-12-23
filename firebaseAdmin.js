// firebaseAdmin.js
const admin = require("firebase-admin");

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Producción (Render) → la clave viene en JSON por variable de entorno
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("Usando credenciales de Firebase desde FIREBASE_SERVICE_ACCOUNT (env)");
  } catch (e) {
    console.error("No se pudo parsear FIREBASE_SERVICE_ACCOUNT:", e.message);
    throw e;
  }
} else {
  // Desarrollo local → leemos el archivo serviceAccountKey.json
  console.log("Usando credenciales de Firebase desde serviceAccountKey.json (local)");
  serviceAccount = require("./serviceAccountKey.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

module.exports = { admin, db };