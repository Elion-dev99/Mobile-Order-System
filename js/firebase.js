import { initializeApp } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.15.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyBDe3aI2F-W9wSFxHtcaplYs5-U2MdrNI8",
  authDomain: "mobile-order-system-c7c70.firebaseapp.com",
  projectId: "mobile-order-system-c7c70",
  storageBucket: "mobile-order-system-c7c70.firebasestorage.app",
  messagingSenderId: "282739212785",
  appId: "1:282739212785:web:cfede54f79e0b47169c450",
  measurementId: "G-2NQDZLJW5Z"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
