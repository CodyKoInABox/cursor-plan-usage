(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  const CURSOR_NOTE =
    'Requests beyond your included usage will use Extra Usage if available, otherwise charged at the API rate if on-demand is on.';
  const OTHER_NOTE =
    'At least $20 of on-demand usage is required before these models are available when over plan limits.';

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtPercent(n) {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    return `${Math.round(v * 10) / 10}%`;
  }

  function fmtWhen(iso) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return String(iso);
    }
  }

  function clampPct(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function renderLoading() {
    app.innerHTML = '<div class="state state-loading">Loading plan usage…</div>';
  }

  function renderError(message) {
    app.innerHTML =
      '<div class="state state-error">' +
      esc(message) +
      '</div>' +
      '<div class="actions"><button class="primary" id="btn-refresh" type="button">Refresh</button></div>';
    bindRefresh();
  }

  function renderUsage(data) {
    const auto = clampPct(data.autoPercentUsed);
    const api = clampPct(data.apiPercentUsed);
    const plan = esc(data.planName || 'Pro');
    const email = data.email
      ? `<div class="email">${esc(data.email)}</div>`
      : '';
    const cycle = data.billingCycleEnd
      ? `<div class="meta">Billing cycle ends ${esc(fmtWhen(data.billingCycleEnd))}</div>`
      : '';
    const refreshed = data.refreshedAt
      ? `<div class="meta">Last refreshed ${esc(fmtWhen(data.refreshedAt))}</div>`
      : '';

    app.innerHTML =
      `<div class="header">` +
      `<h1>Included in ${plan}</h1>` +
      email +
      `</div>` +
      `<section class="section">` +
      `<div class="section-head">` +
      `<h2 class="section-title">Cursor Models</h2>` +
      `<span class="percent">${esc(fmtPercent(auto))} used</span>` +
      `</div>` +
      `<p class="subtitle">Includes Cursor Grok 4.5 and Composer 2.5</p>` +
      `<div class="bar bar-cursor" role="progressbar" aria-valuenow="${auto}" aria-valuemin="0" aria-valuemax="100"><span style="width:${auto}%"></span></div>` +
      `<p class="note">${esc(CURSOR_NOTE)}</p>` +
      `</section>` +
      `<hr class="divider" />` +
      `<section class="section">` +
      `<div class="section-head">` +
      `<h2 class="section-title">Other Models</h2>` +
      `<span class="percent">${esc(fmtPercent(api))} used</span>` +
      `</div>` +
      `<p class="subtitle">Third-party API models</p>` +
      `<div class="bar bar-other" role="progressbar" aria-valuenow="${api}" aria-valuemin="0" aria-valuemax="100"><span style="width:${api}%"></span></div>` +
      `<p class="note">${esc(OTHER_NOTE)}</p>` +
      `</section>` +
      `<div class="footer">` +
      cycle +
      refreshed +
      `<div class="actions"><button class="primary" id="btn-refresh" type="button">Refresh</button></div>` +
      `</div>`;

    bindRefresh();
  }

  function bindRefresh() {
    const btn = document.getElementById('btn-refresh');
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      vscode.postMessage({ type: 'refresh' });
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'loading') {
      renderLoading();
    } else if (msg.type === 'error') {
      renderError(msg.message || 'Unknown error');
    } else if (msg.type === 'usageData') {
      renderUsage(msg.data || {});
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
