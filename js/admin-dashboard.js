// ============================================================
// ADMIN-DASHBOARD.JS — Payment approvals for manual auctions
// ============================================================

const ADMIN_EMAILS = (window.ADMIN_DASHBOARD_EMAILS || [])
  .map((email) => String(email || '').trim().toLowerCase())
  .filter(Boolean);

function adminToast(message, type = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.className = `toast show ${type}`;
  setTimeout(() => { el.className = 'toast'; }, 2400);
}

function getAdminEmail() {
  return String(localStorage.getItem('ipl_auth_email') || '').trim().toLowerCase();
}

function isAdminAllowed(email) {
  return ADMIN_EMAILS.includes(String(email || '').trim().toLowerCase());
}

function formatAdminTime(ts) {
  const value = Number(ts || 0);
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString();
  } catch (_) {
    return '—';
  }
}

function renderRequestCard(request) {
  const requestId = String(request.requestId || '').trim();
  const status = String(request.status || 'pending').toLowerCase();
  const receiptUrl = String(request.receiptUrl || '').trim();
  const teamNames = Array.isArray(request.teamNames) ? request.teamNames.filter(Boolean) : [];
  const playerCount = Array.isArray(request.playerNames) ? request.playerNames.length : 0;

  return `
    <article class="admin-request">
      <div>
        <div class="admin-request-head">
          <div>
            <h3 style="font-size:1.1rem;margin-bottom:0.25rem;">${escapeHtml(request.auctionTitle || 'Manual Auction')}</h3>
            <div style="color:var(--text-dim);font-size:0.82rem;">Request ID: ${escapeHtml(requestId)}</div>
          </div>
          <span class="admin-status ${status}">${escapeHtml(status)}</span>
        </div>

        <div class="admin-meta" style="margin-top:0.85rem;">
          <div><b>Amount</b>: ${request.amount ? `₹${escapeHtml(String(request.amount))}` : 'Free'}</div>
          <div><b>Teams</b>: ${escapeHtml(String(request.teamCount || 0))}</div>
          <div><b>UTR</b>: ${escapeHtml(request.paymentTxnId || '—')}</div>
          <div><b>Payer</b>: ${escapeHtml(request.paymentPayerName || '—')}</div>
          <div><b>Passcode</b>: ${escapeHtml(request.passcode || '—')}</div>
          <div><b>Submitted</b>: ${escapeHtml(formatAdminTime(request.createdAt))}</div>
          <div><b>Players</b>: ${escapeHtml(String(playerCount))}</div>
          <div><b>Approval</b>: ${escapeHtml(formatAdminTime(request.approvedAt || request.rejectedAt || request.expiredAt || request.usedAt || 0))}</div>
        </div>

        <div style="margin-top:0.85rem;color:var(--text-sec);font-size:0.84rem;line-height:1.55;">
          <b style="color:var(--text);">Teams:</b> ${escapeHtml(teamNames.join(', ') || '—')}
        </div>

        <div class="admin-actions" style="margin-top:0.9rem;">
          <button class="btn btn-primary" onclick="approveRequest('${escapeHtml(requestId)}')">Approve</button>
          <button class="btn btn-secondary" onclick="rejectRequest('${escapeHtml(requestId)}')">Reject</button>
          <button class="btn btn-ghost" onclick="expireRequest('${escapeHtml(requestId)}')">Expire</button>
          <button class="btn btn-secondary" onclick="copyRequestId('${escapeHtml(requestId)}')">Copy ID</button>
        </div>
      </div>

      <div class="admin-proof">
        ${receiptUrl ? `<a href="${escapeHtml(receiptUrl)}" target="_blank" rel="noreferrer"><img src="${escapeHtml(receiptUrl)}" alt="Payment receipt" loading="lazy" /></a>` : '<div class="admin-empty" style="min-height:220px;display:flex;align-items:center;justify-content:center;">No receipt uploaded</div>'}
      </div>
    </article>
  `;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function loadPaymentRequests() {
  const listEl = document.getElementById('adminRequests');
  if (!listEl) return;

  try {
    const snap = await db.ref('paymentRequests').get();
    const requests = snap.exists() ? Object.values(snap.val() || {}) : [];
    const sorted = requests
      .filter((item) => item && item.requestId)
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

    const counts = {
      pending: 0,
      approved: 0,
      rejected: 0,
      expired: 0
    };
    sorted.forEach((item) => {
      const status = String(item.status || 'pending').toLowerCase();
      if (counts[status] !== undefined) counts[status] += 1;
    });

    const pending = document.getElementById('statPending');
    const approved = document.getElementById('statApproved');
    const rejected = document.getElementById('statRejected');
    const expired = document.getElementById('statExpired');
    if (pending) pending.textContent = String(counts.pending || 0);
    if (approved) approved.textContent = String(counts.approved || 0);
    if (rejected) rejected.textContent = String(counts.rejected || 0);
    if (expired) expired.textContent = String(counts.expired || 0);

    if (!sorted.length) {
      listEl.innerHTML = '<div class="admin-empty">No payment requests found.</div>';
      return;
    }

    listEl.innerHTML = sorted.map(renderRequestCard).join('');
  } catch (err) {
    console.error('Failed to load payment requests:', err);
    const detail = String(err?.message || err?.code || 'Unknown error');
    listEl.innerHTML = `<div class="admin-empty">Could not load payment requests.<br><span style="display:block;margin-top:0.45rem;font-size:0.82rem;">${escapeHtml(detail)}</span></div>`;
  }
}

async function updateRequestStatus(requestId, status, extra = {}) {
  if (!requestId) return;
  await db.ref(`paymentRequests/${requestId}`).update({
    status,
    updatedAt: Date.now(),
    ...extra
  });
  await loadPaymentRequests();
}

async function approveRequest(requestId) {
  await updateRequestStatus(requestId, 'approved', {
    approvedAt: Date.now(),
    approvedBy: getAdminEmail()
  });
  adminToast('Request approved.', 'success');
}

async function rejectRequest(requestId) {
  const reason = window.prompt('Optional rejection reason');
  await updateRequestStatus(requestId, 'rejected', {
    rejectedAt: Date.now(),
    rejectedBy: getAdminEmail(),
    rejectionReason: String(reason || '').trim() || ''
  });
  adminToast('Request rejected.', 'error');
}

async function expireRequest(requestId) {
  await updateRequestStatus(requestId, 'expired', {
    expiredAt: Date.now(),
    expiredBy: getAdminEmail()
  });
  adminToast('Request marked expired.', 'error');
}

async function copyRequestId(requestId) {
  try {
    await navigator.clipboard.writeText(String(requestId || ''));
    adminToast('Request ID copied.', 'success');
  } catch (_) {
    adminToast('Could not copy request ID.', 'error');
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (typeof waitForAuthReady === 'function') {
    await waitForAuthReady();
  }

  if (typeof requireAuth === 'function' && !requireAuth('index.html')) return;

  const email = getAdminEmail();
  if (!isAdminAllowed(email)) {
    const listEl = document.getElementById('adminRequests');
    if (listEl) {
      listEl.innerHTML = '<div class="admin-empty">You do not have admin access.</div>';
    }
    return;
  }

  await loadPaymentRequests();
});

window.loadPaymentRequests = loadPaymentRequests;
window.approveRequest = approveRequest;
window.rejectRequest = rejectRequest;
window.expireRequest = expireRequest;
window.copyRequestId = copyRequestId;
