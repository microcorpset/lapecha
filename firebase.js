import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

function _d(e,k='cmd25k'){return Array.from(atob(e),(c,i)=>String.fromCharCode(c.charCodeAt(0)^k.charCodeAt(i%k.length))).join('');}

const firebaseConfig = {
  apiKey:            _d("IiQeU2YSJzcLWAAkCC80dW9dWyUMZHAmAVlcexhcKQ8meFYNCSwT"),
  authDomain:        _d("DwwUV1YDAkBdUFQPAkMCW0cOAQwXV1QbE0MHXVg="),
  databaseURL:       _d("CxkQQkZRTEIIU0UOAAUFHwwJAgkFH1EOBQwRXkFGERkAUBsOFh8LQlBGFAgXRgRFBQQWV1cKEAgAU0EKAQwXVxsKEx0="),
  projectId:         _d("DwwUV1YDAkBdUFQPAg=="),
  storageBucket:     _d("DwwUV1YDAkBdUFQPAkMCW0cOAQwXV0YfDB8FVVBFAh0U"),
  messagingSenderId: _d("V11SBwxfU15SAQZa"),
  appId:             _d("UldQAgNeWllUAQNYUFxeRVAJWVpXBgAIVg8HUA1fUl4BU1cKW1lTAFA=")
};

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
