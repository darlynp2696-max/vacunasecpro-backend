const admin = require("firebase-admin");

let serviceAccount;

// 🔹 Si estamos en Render (o cualquier servidor) y existe la variable de entorno,
// tomamos la configuración desde ahí:
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log("Usando credenciales de Firebase desde FIREBASE_SERVICE_ACCOUNT");
  } catch (e) {
    console.error("No se pudo parsear FIREBASE_SERVICE_ACCOUNT:", e);
    throw e;
  }
} else {
  // 🔹 Si NO existe la variable de entorno (por ejemplo, en tu PC),
  // seguimos usando el archivo local serviceAccountKey.json
  // que descargaste desde Firebase.
  serviceAccount = require("./serviceAccountKey.json");
  console.log("Usando credenciales de Firebase desde serviceAccountKey.json (local)");
}

// Evitamos inicializar Firebase más de una vez
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

module.exports = { admin, db };