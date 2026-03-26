// ============================================================
// FIREBASE CONFIGURATION
// Your Firebase project: ipl-auction-490a0
// ============================================================
// NOTE: If bids/rooms don't sync, check your Realtime Database URL below.
// Find it in Firebase Console → Realtime Database → copy the URL shown at the top.
// It looks like: https://ipl-auction-490a0-default-rtdb.firebaseio.com
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBSrF2F-Zb3HQPeXjHJheZx286z9MSV5dY",
  authDomain: "ipl-auction-490a0.firebaseapp.com",
  databaseURL: "https://ipl-auction-490a0-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ipl-auction-490a0",
  storageBucket: "ipl-auction-490a0.firebasestorage.app",
  messagingSenderId: "918714675977",
  appId: "1:918714675977:web:a0f5a9028ead763a4959d8",
  measurementId: "G-3J6XH8RBL7"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

// Quick connection check
db.ref(".info/connected").on("value", (snap) => {
  if (snap.val() === true) {
    console.log("✅ Firebase connected");
  } else {
    console.warn("⚠️ Firebase disconnected or connecting...");
  }
});
