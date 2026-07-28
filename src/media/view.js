(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

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

  function fmtWhen(value) {
    if (value == null || value === '') return '';
    try {
      let d;
      if (typeof value === 'number') {
        d = new Date(value < 1e12 ? value * 1000 : value);
      } else {
        const s = String(value).trim();
        // API often sends epoch ms/sec as a numeric string — Date("1786…") is Invalid
        if (/^\d+$/.test(s)) {
          const n = Number(s);
          d = new Date(n < 1e12 ? n * 1000 : n);
        } else {
          d = new Date(s);
        }
      }
      if (Number.isNaN(d.getTime())) return String(value);
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return String(value);
    }
  }

  function clampPct(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function fmtDeltaPct(n) {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    const rounded = Math.round(v * 10) / 10;
    return `+${rounded}%`;
  }

  function fmtSinceLabel(iso, partial, kind) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return '';
      const agoMs = Date.now() - d.getTime();
      const mins = Math.max(0, Math.round(agoMs / 60000));
      if (kind === 'hour' && partial) {
        if (mins < 60) return `since ${mins}m ago`;
        return 'since session start';
      }
      if (kind === 'session') {
        return `since ${d.toLocaleTimeString(undefined, {
          hour: '2-digit',
          minute: '2-digit',
        })}`;
      }
      return partial ? 'partial hour' : 'rolling 1h';
    } catch {
      return '';
    }
  }

  function renderWindowRow(label, w, kind) {
    if (!w) return '';
    const since = fmtSinceLabel(w.since, w.partial, kind);
    const sinceHtml = since
      ? `<span class="window-since">${esc(since)}</span>`
      : '';
    return (
      `<div class="window-row">` +
      `<div class="window-label-col">` +
      `<span class="window-label">${esc(label)}</span>` +
      sinceHtml +
      `</div>` +
      `<div class="window-stats">` +
      `<span class="window-stat window-stat-cm">CM ${esc(fmtDeltaPct(w.autoPercentDelta))}</span>` +
      `<span class="window-stat window-stat-om">OM ${esc(fmtDeltaPct(w.apiPercentDelta))}</span>` +
      `</div>` +
      `</div>`
    );
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
      ? `<div class="meta meta-stack"><span class="meta-label">Billing cycle ends</span><span class="meta-value">${esc(fmtWhen(data.billingCycleEnd))}</span></div>`
      : '';
    const refreshed = data.refreshedAt
      ? `<div class="meta meta-stack"><span class="meta-label">Last refreshed</span><span class="meta-value">${esc(fmtWhen(data.refreshedAt))}</span></div>`
      : '';

    const windows =
      data.lastHour || data.session
        ? `<hr class="divider" />` +
          `<section class="section section-windows">` +
          `<div class="section-head">` +
          `<h2 class="section-title">Windows</h2>` +
          `</div>` +
          `<p class="subtitle">Account usage while this extension has been sampling</p>` +
          `<div class="windows">` +
          renderWindowRow('Last hour', data.lastHour, 'hour') +
          renderWindowRow('IDE session', data.session, 'session') +
          `</div>` +
          `</section>`
        : '';

    app.innerHTML =
      `<div class="header">` +
      `<h1>Included in ${plan}</h1>` +
      email +
      `</div>` +
      `<hr class="divider" />` +
      `<section class="section">` +
      `<div class="section-head">` +
      `<h2 class="section-title">Cursor Models</h2>` +
      `<span class="percent">${esc(fmtPercent(auto))} used</span>` +
      `</div>` +
      `<p class="subtitle">Auto mode and Cursor's models</p>` +
      `<progress class="bar bar-cursor" max="100" value="${auto}">${esc(fmtPercent(auto))}</progress>` +
      `</section>` +
      `<hr class="divider" />` +
      `<section class="section">` +
      `<div class="section-head">` +
      `<h2 class="section-title">Other Models</h2>` +
      `<span class="percent">${esc(fmtPercent(api))} used</span>` +
      `</div>` +
      `<p class="subtitle">Third-party API models</p>` +
      `<progress class="bar bar-other" max="100" value="${api}">${esc(fmtPercent(api))}</progress>` +
      `</section>` +
      windows +
      `<hr class="divider" />` +
      `<div class="footer">` +
      cycle +
      refreshed +
      `</div>`;
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
