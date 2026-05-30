// ============================================================
// AUTH.JS - Firebase Authentication (Email/Password + Google)
// ============================================================

let authMode = 'login';
let authReadyResolved = false;
let authReadyResolver = null;
let currentAuthUser = null;

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
  const profileBtn = document.getElementById('authProfileBtn');
  const logoutBtn = document.getElementById('authLogoutBtn');

  if (userLabel) {
    const verifiedLabel = user && !isUserVerified(user) ? ' (verify email)' : '';
    userLabel.textContent = user ? `Hi, ${getAuthDisplayName(user)}${verifiedLabel}` : 'Not logged in';
  }
  if (loginBtn) loginBtn.style.display = user ? 'none' : 'inline-flex';
  if (signupBtn) signupBtn.style.display = user ? 'none' : 'inline-flex';
  if (profileBtn) profileBtn.style.display = user ? 'inline-flex' : 'none';
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

  updateAdminDashboardLinks(user);
}

function updateAdminDashboardLinks(user = null) {
  const adminEmails = Array.isArray(window.ADMIN_DASHBOARD_EMAILS) ? window.ADMIN_DASHBOARD_EMAILS : [];
  const currentEmail = String(user?.email || localStorage.getItem('ipl_auth_email') || '').trim().toLowerCase();
  const allowed = !!currentEmail && adminEmails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean).includes(currentEmail);

  document.querySelectorAll('[data-admin-dashboard-link="1"]').forEach((el) => {
    el.style.display = allowed ? 'inline-flex' : 'none';
  });
}

function switchAuthMode(mode) {
  authMode = mode === 'signup' ? 'signup' : 'login';
  const title = document.getElementById('authModalTitle');
  const submit = document.getElementById('authSubmitBtn');
  const nameWrap = document.getElementById('authNameWrap');
  const toggleText = document.getElementById('authToggleText');
  const toggleLink = document.getElementById('authToggleLink');

  if (title) title.textContent = authMode === 'signup' ? 'Create Account' : 'Login';
  if (submit) submit.textContent = authMode === 'signup' ? 'Create Account' : 'Login';
  if (nameWrap) nameWrap.style.display = authMode === 'signup' ? 'block' : 'none';
  
  if (toggleText && toggleLink) {
    if (authMode === 'signup') {
      toggleText.textContent = 'Already have an account?';
      toggleLink.textContent = 'Login here';
    } else {
      toggleText.textContent = 'New to MyAuction?';
      toggleLink.textContent = 'Register here';
    }
  }
  setAuthError('');
}

function openAuthModal(mode = 'login') {
  switchAuthMode(mode);
  const overlay = document.getElementById('authModalOverlay');
  if (overlay) overlay.classList.add('visible');
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
window.togglePassword = function() { const pwdInput = document.getElementById('authPassword'); if (pwdInput.type === 'password') { pwdInput.type = 'text'; } else { pwdInput.type = 'password'; } };
