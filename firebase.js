import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ─── CONFIGURA AQUÍ TUS CREDENCIALES DE FIREBASE ───────────────────────────
// 1. Ve a https://console.firebase.google.com
// 2. Crea un proyecto → Realtime Database → Reglas: true/true para empezar
// 3. Ajustes del proyecto → Tus apps → Web → Copia el objeto firebaseConfig
const firebaseConfig = {
  apiKey:            "AIzaSyDZoj5OkBPGZ68HhVEMb48I-7JbBJcfjAw",
  authDomain:        "lapecha-9bada.firebaseapp.com",
  databaseURL:       "https://lapecha-9bada-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "lapecha-9bada",
  storageBucket:     "lapecha-9bada.firebasestorage.app",
  messagingSenderId: "406594036331",
  appId:             "1:406594036331:web:7345c5bcb8413eaba8472e"
};
// ────────────────────────────────────────────────────────────────────────────

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
export const db = getDatabase(app);

export const authReady = new Promise((resolve, reject) => {
  let settled = false;

  onAuthStateChanged(auth, user => {
    if (!settled && user) {
      settled = true;
      resolve(user);
    }
  });

  signInAnonymously(auth).catch(err => {
    if (!settled) {
      settled = true;
      reject(err);
    }
  });
});
