// ============================================================
// AUTH.JS - Firebase Authentication (Email/Password + Google)
// ============================================================

let authMode = 'login';
let authReadyResolved = false;
let authReadyResolver = null;
let currentAuthUser = null;
let phoneRecaptchaVerifier = null;
let phoneConfirmationResult = null;
let phoneOtpInProgress = false;

const authReadyPromise = new Promise((resolve) => {
  authReadyResolver = resolve;
});

function isUserVerified(user) {
  if (!user) return false;
  const providers = Array.isArray(user.providerData) ? user.providerData : [];
  const hasPasswordProvider = providers.some((p) => p?.providerId === 'password');
  if (hasPasswordProvider) return !!user.emailVerified;
  return true;
}

function setAuthCache(user) {
  if (user) {
    localStorage.setItem('ipl_auth_uid', user.uid || '');
    localStorage.setItem('ipl_auth_email', user.email || '');
    localStorage.setItem('ipl_auth_name', user.displayName || '');
    localStorage.setItem('ipl_auth_verified', isUserVerified(user) ? '1' : '0');
  } else {
    localStorage.removeItem('ipl_auth_uid');
    localStorage.removeItem('ipl_auth_email');
    localStorage.removeItem('ipl_auth_name');
    localStorage.removeItem('ipl_auth_verified');
  }
}

function getAuthDisplayName(user) {
  if (!user) return 'Guest';
  const name = String(user.displayName || '').trim();
  if (name) return name;
  const email = String(user.email || '').trim();
  if (!email) return 'User';
  return email.split('@')[0];
}

async function upsertUserProfile(user, explicitName = '') {
  if (!user?.uid) return;
  const profileName = String(explicitName || user.displayName || '').trim();
  await db.ref(`users/${user.uid}`).transaction((curr) => {
    const current = curr || {};
    return {
      ...current,
      name: profileName || current.name || getAuthDisplayName(user),
      email: user.email || current.email || '',
      lastLoginAt: Date.now(),
      createdAt: current.createdAt || Date.now()
    };
  });
}

function setGoogleButtonLoading(isLoading) {
  const btn = document.getElementById('authGoogleBtn');
  if (!btn) return;
  btn.disabled = !!isLoading;
  if (isLoading) {
    btn.textContent = 'Connecting to Google...';
    return;
  }
  btn.innerHTML = '<span class="auth-google-mark" aria-hidden="true">G</span><span>Continue with Google</span>';
}

function setAuthError(message) {
  const el = document.getElementById('authError');
  if (!el) return;
  if (!message) {
    el.textContent = '';
    el.style.display = 'none';
    return;
  }
  el.textContent = message;
  el.style.display = 'block';
}

function applyAuthUi(user) {
  const userLabel = document.getElementById('authUserLabel');
  const loginBtn = document.getElementById('authLoginBtn');
  const signupBtn = document.getElementById('authSignupBtn');
  const logoutBtn = document.getElementById('authLogoutBtn');

  if (userLabel) {
    const verifiedLabel = user && !isUserVerified(user) ? ' (verify email)' : '';
    userLabel.textContent = user ? `Hi, ${getAuthDisplayName(user)}${verifiedLabel}` : 'Not logged in';
  }
  if (loginBtn) loginBtn.style.display = user ? 'none' : 'inline-flex';
  if (signupBtn) signupBtn.style.display = user ? 'none' : 'inline-flex';
  if (logoutBtn) logoutBtn.style.display = user ? 'inline-flex' : 'none';

  if (user) {
    const suggested = getAuthDisplayName(user);
    const createName = document.getElementById('createName');
    const joinName = document.getElementById('joinName');
    const hostName = document.getElementById('hostName');
    if (createName && !createName.value.trim()) createName.value = suggested;
    if (joinName && !joinName.value.trim()) joinName.value = suggested;
    if (hostName && !hostName.value.trim()) hostName.value = suggested;
  }
}

function switchAuthMode(mode) {
  authMode = mode === 'signup' ? 'signup' : 'login';
  const title = document.getElementById('authModalTitle');
  const submit = document.getElementById('authSubmitBtn');
  const nameWrap = document.getElementById('authNameWrap');
  const loginTab = document.getElementById('authTabLogin');
  const signupTab = document.getElementById('authTabSignup');

  if (title) title.textContent = authMode === 'signup' ? 'Create Account' : 'Login';
  if (submit) submit.textContent = authMode === 'signup' ? 'Create Account' : 'Login';
  if (nameWrap) nameWrap.style.display = authMode === 'signup' ? 'block' : 'none';
  if (loginTab) loginTab.classList.toggle('active', authMode === 'login');
  if (signupTab) signupTab.classList.toggle('active', authMode === 'signup');
  setAuthError('');
}

function openAuthModal(mode = 'login') {
  switchAuthMode(mode);
  const overlay = document.getElementById('authModalOverlay');
  if (overlay) overlay.classList.add('visible');
  // reset phone UI when opening
  const phoneWrap = document.getElementById('authPhoneWrap');
  const otpWrap = document.getElementById('authOtpWrap');
  if (phoneWrap) phoneWrap.style.display = 'block';
  if (otpWrap) otpWrap.style.display = 'none';
}

function closeAuthModal() {
  const overlay = document.getElementById('authModalOverlay');
  if (overlay) overlay.classList.remove('visible');
  setAuthError('');
}

function getAuthFriendlyError(code) {
  const map = {
    'auth/invalid-email': 'Please enter a valid email address.',
    'auth/missing-password': 'Please enter your password.',
    'auth/weak-password': 'Password should be at least 6 characters.',
    'auth/email-already-in-use': 'This email is already registered. Please login.',
    'auth/user-not-found': 'Account not found. Please sign up first.',
    'auth/wrong-password': 'Incorrect password. Try again.',
    'auth/invalid-credential': 'Invalid email or password.',
    'auth/too-many-requests': 'Too many attempts. Please try again later.',
    'auth/popup-closed-by-user': 'Google sign-in popup was closed.',
    'auth/cancelled-popup-request': 'Google sign-in was cancelled.',
    'auth/popup-blocked': 'Popup was blocked by browser. Please allow popups and try again.'
  };
  return map[code] || 'Authentication failed. Please try again.';
}

function initPhoneRecaptcha() {
  if (phoneRecaptchaVerifier) return;
  if (!window.firebase || !firebase.auth) {
    console.error('Firebase auth not loaded; cannot init recaptcha');
    setAuthError('Firebase Auth not loaded. Ensure firebase-auth script is included.');
    return;
  }
  if (typeof firebase.auth.RecaptchaVerifier !== 'function') {
    console.error('RecaptchaVerifier unavailable on firebase.auth');
    setAuthError('reCAPTCHA not available. Check Firebase SDK version.');
    return;
  }
  try {
    phoneRecaptchaVerifier = new firebase.auth.RecaptchaVerifier('authRecaptcha', {
      size: 'invisible'
    });
    // render quietly; ignore render errors
    phoneRecaptchaVerifier.render().catch((e) => { console.debug('Recaptcha render warning', e); });
  } catch (err) {
    console.warn('Recaptcha init failed', err);
    setAuthError('Could not initialize reCAPTCHA.');
  }
}

async function sendPhoneOtp() {
  setAuthError('');
  const phoneEl = document.getElementById('authPhone');
  const sendBtn = document.getElementById('authPhoneSendBtn');
  let phone = String(phoneEl?.value || '').trim();
  // normalize common user input: remove spaces and non-digit/+ characters
  let normalized = phone.replace(/\s+/g, '').replace(/[^+\d]/g, '');
  // if user entered 10-digit local number, assume India (+91)
  if (/^\d{10}$/.test(normalized)) {
    normalized = '+91' + normalized;
  } else if (/^0\d{10}$/.test(normalized)) {
    // leading 0 -> drop and prefix +91
    normalized = '+91' + normalized.slice(1);
  }
  phone = normalized;
  if (!phone) {
    setAuthError('Please enter your phone number.');
    return;
  }
  if (phoneOtpInProgress) {
    console.debug('OTP send already in progress, ignoring duplicate request');
    return;
  }
  phoneOtpInProgress = true;
  if (sendBtn) sendBtn.disabled = true;
  try {
    initPhoneRecaptcha();
    if (!phoneRecaptchaVerifier) {
      throw new Error('Recaptcha verifier not initialized');
    }
    console.log('Attempting phone OTP send to', phone);
    if (!firebase || !firebase.auth) throw new Error('Firebase auth missing');
    phoneConfirmationResult = await firebase.auth().signInWithPhoneNumber(phone, phoneRecaptchaVerifier);
    const otpWrap = document.getElementById('authOtpWrap');
    const phoneWrap = document.getElementById('authPhoneWrap');
    if (otpWrap) otpWrap.style.display = 'block';
    if (phoneWrap) phoneWrap.style.display = 'none';
    setAuthError('OTP sent to your phone.');
  } catch (err) {
    console.error('Phone OTP send failed:', err);
    const message = err?.message || String(err || 'Could not send OTP');
    // Provide actionable hint for common origin/domain problems
    let hint = '';
    if (/authorize|origin|domain/i.test(message)) {
      hint = ' Check Firebase Console -> Authentication -> Authorized domains.';
    }
    setAuthError((getAuthFriendlyError(err?.code) || message) + hint);
    if (phoneRecaptchaVerifier && typeof phoneRecaptchaVerifier.clear === 'function') {
      try { phoneRecaptchaVerifier.clear(); } catch (e) {}
      phoneRecaptchaVerifier = null;
    }
  } finally {
    if (sendBtn) sendBtn.disabled = false;
    phoneOtpInProgress = false;
  }
}

// Ensure buttons are bound in case inline handlers fail
document.addEventListener('DOMContentLoaded', () => {
  try {
    const sendBtn = document.getElementById('authPhoneSendBtn');
    const verifyBtn = document.getElementById('authOtpVerifyBtn');
    const cancelBtn = document.querySelector('#authOtpWrap .btn-ghost') || document.querySelector('#authPhoneWrap .btn-ghost');
    if (sendBtn) {
      // remove any inline onclick to avoid double-calls
      sendBtn.removeAttribute('onclick');
      sendBtn.addEventListener('click', (e) => { e.preventDefault(); sendPhoneOtp(); });
    }
    if (verifyBtn) {
      verifyBtn.removeAttribute('onclick');
      verifyBtn.addEventListener('click', (e) => { e.preventDefault(); verifyPhoneOtp(); });
    }
    if (cancelBtn) {
      cancelBtn.removeAttribute('onclick');
      cancelBtn.addEventListener('click', (e) => { e.preventDefault(); cancelPhoneAuth(); });
    }
  } catch (e) {
    console.debug('Auth phone button binding skipped:', e);
  }
});

async function verifyPhoneOtp() {
  setAuthError('');
  const code = String(document.getElementById('authOtp')?.value || '').trim();
  const verifyBtn = document.getElementById('authOtpVerifyBtn');
  if (!code) {
    setAuthError('Please enter the OTP.');
    return;
  }
  if (verifyBtn) verifyBtn.disabled = true;
  try {
    if (!phoneConfirmationResult) throw new Error('No OTP request in progress');
    const cred = await phoneConfirmationResult.confirm(code);
    const user = cred.user || firebase.auth().currentUser;
    await upsertUserProfile(user);
    setAuthCache(user);
    applyAuthUi(user);
    closeAuthModal();
  } catch (err) {
    console.error('OTP verify failed:', err);
    setAuthError(getAuthFriendlyError(err?.code) || 'OTP verification failed.');
  } finally {
    if (verifyBtn) verifyBtn.disabled = false;
  }
}

function cancelPhoneAuth() {
  const otpWrap = document.getElementById('authOtpWrap');
  const phoneWrap = document.getElementById('authPhoneWrap');
  if (otpWrap) otpWrap.style.display = 'none';
  if (phoneWrap) phoneWrap.style.display = 'block';
  setAuthError('');
  if (phoneRecaptchaVerifier && typeof phoneRecaptchaVerifier.clear === 'function') {
    try { phoneRecaptchaVerifier.clear(); } catch (e) {}
    phoneRecaptchaVerifier = null;
  }
  phoneConfirmationResult = null;
}

async function sendVerificationIfPossible(user) {
  if (!user || isUserVerified(user)) return;
  if (typeof user.sendEmailVerification !== 'function') return;
  try {
    await user.sendEmailVerification();
  } catch (err) {
    console.warn('Could not send verification email:', err);
  }
}

async function submitAuthForm() {
  const emailEl = document.getElementById('authEmail');
  const passEl = document.getElementById('authPassword');
  const nameEl = document.getElementById('authName');
  const submitBtn = document.getElementById('authSubmitBtn');

  const email = String(emailEl?.value || '').trim();
  const password = String(passEl?.value || '');
  const fullName = String(nameEl?.value || '').trim();

  if (!email) {
    setAuthError('Email is required.');
    return;
  }
  if (!password || password.length < 6) {
    setAuthError('Password must be at least 6 characters.');
    return;
  }
  if (authMode === 'signup' && !fullName) {
    setAuthError('Name is required for signup.');
    return;
  }

  setAuthError('');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = authMode === 'signup' ? 'Creating...' : 'Logging in...';
  }

  try {
    let cred;
    if (authMode === 'signup') {
      cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
      if (fullName) {
        await cred.user.updateProfile({ displayName: fullName });
      }
      await upsertUserProfile(cred.user, fullName);
      await sendVerificationIfPossible(cred.user);

      await firebase.auth().signOut();
      setAuthError('Verification email sent. Please verify your email, then login.');
      switchAuthMode('login');
      return;
    } else {
      cred = await firebase.auth().signInWithEmailAndPassword(email, password);
      if (!isUserVerified(cred.user)) {
        await sendVerificationIfPossible(cred.user);
        await firebase.auth().signOut();
        setAuthError('Please verify your email first. We sent a verification link to your inbox or spam folder.');
        return;
      }
      await upsertUserProfile(cred.user);
    }

    setAuthCache(cred.user);
    applyAuthUi(cred.user);
    closeAuthModal();
  } catch (err) {
    console.error('Auth failed:', err);
    setAuthError(getAuthFriendlyError(err?.code));
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = authMode === 'signup' ? 'Create Account' : 'Login';
    }
  }
}

async function signInWithGoogle() {
  setAuthError('');
  setGoogleButtonLoading(true);

  try {
    const provider = new firebase.auth.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    const cred = await firebase.auth().signInWithPopup(provider);
    await upsertUserProfile(cred.user);

    setAuthCache(cred.user);
    applyAuthUi(cred.user);
    closeAuthModal();
  } catch (err) {
    console.error('Google sign-in failed:', err);
    setAuthError(getAuthFriendlyError(err?.code));
  } finally {
    setGoogleButtonLoading(false);
  }
}

async function logoutUser() {
  try {
    await firebase.auth().signOut();
  } catch (err) {
    console.error('Logout failed:', err);
  }
  setAuthCache(null);
  if (typeof clearSession === 'function') clearSession();
  if (!window.location.pathname.endsWith('index.html')) {
    window.location.href = 'index.html';
  }
}

function requireAuthForAction(message = 'Please login to continue.') {
  const uid = localStorage.getItem('ipl_auth_uid');
  const verified = localStorage.getItem('ipl_auth_verified') === '1';
  if (uid && verified) return true;
  if (typeof showToast === 'function') {
    showToast(uid ? 'Please verify your email before continuing.' : message, 'error');
  }
  openAuthModal(uid ? 'login' : 'login');
  return false;
}

function enforceAuthPage(redirectTo = 'index.html') {
  if (localStorage.getItem('ipl_auth_uid')) return;
  waitForAuthReady().then((user) => {
    if (!user) {
      if (typeof clearSession === 'function') clearSession();
      window.location.href = redirectTo;
    }
  });
}

function waitForAuthReady() {
  return authReadyPromise;
}

firebase.auth().onAuthStateChanged((user) => {
  currentAuthUser = user || null;
  setAuthCache(currentAuthUser);
  applyAuthUi(currentAuthUser);

  if (!authReadyResolved) {
    authReadyResolved = true;
    authReadyResolver(currentAuthUser);
  }
});

window.openAuthModal = openAuthModal;
window.closeAuthModal = closeAuthModal;
window.switchAuthMode = switchAuthMode;
window.submitAuthForm = submitAuthForm;
window.logoutUser = logoutUser;
window.requireAuthForAction = requireAuthForAction;
window.enforceAuthPage = enforceAuthPage;
window.waitForAuthReady = waitForAuthReady;
window.getCurrentAuthUser = () => currentAuthUser;
window.signInWithGoogle = signInWithGoogle;
window.sendPhoneOtp = sendPhoneOtp;
window.verifyPhoneOtp = verifyPhoneOtp;
window.cancelPhoneAuth = cancelPhoneAuth;
