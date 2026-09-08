// Configuration Firebase (copiée de src/services/firebase.ts)
const firebaseConfig = {
  projectId: "allwhist-61182",
  appId: "1:814265216795:web:c3f057ccc617633045edbe",
  storageBucket: "allwhist-61182.firebasestorage.app",
  apiKey: "AIzaSyAyCGrKJ1LWyJWQamWGYg8PH2MBNxTzLYM",
  authDomain: "allwhist-61182.firebaseapp.com",
  messagingSenderId: "814265216795",
};

// Initialisation via CDN
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, getDocs, query, orderBy, limit } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

export { db, auth, collection, getDocs, query, orderBy, limit, signInAnonymously, onAuthStateChanged, googleProvider, signInWithPopup };
