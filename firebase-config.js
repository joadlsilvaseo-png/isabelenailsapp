import { initializeApp } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";

import {
  getAuth,
  GoogleAuthProvider,
} from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

import { getFirestore } from "https://www.gstatic.com/firebasejs/12.14.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyC3cBMaCIrF6af3KJpAnrkINErpobu5Ioc",
  authDomain: "isabele-nails-app.firebaseapp.com",
  projectId: "isabele-nails-app",
  storageBucket: "isabele-nails-app.firebasestorage.app",
  messagingSenderId: "311498866336",
  appId: "1:311498866336:web:f063caa25cce715a4813c5",
};

const app = initializeApp(firebaseConfig);

const auth = getAuth(app);
const db = getFirestore(app);
const googleProvider = new GoogleAuthProvider();

export { app, auth, db, googleProvider };
