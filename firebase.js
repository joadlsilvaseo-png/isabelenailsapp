const firebaseConfig = {
  apiKey: "AIzaSyC3cBMaCIrF6af3KJpAnrkINErpobu5Ioc",
  authDomain: "isabele-nails-app.firebaseapp.com",
  projectId: "isabele-nails-app",
  storageBucket: "isabele-nails-app.firebasestorage.app",
  messagingSenderId: "311498866336",
  appId: "1:311498866336:web:f063caa25cce715a4813c5",
};

if (!firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
