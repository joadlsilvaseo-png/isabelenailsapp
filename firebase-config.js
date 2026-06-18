import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import { getFirestore } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

import { firebaseConfig } from "./config.js";

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export { app, auth, db, googleProvider };
