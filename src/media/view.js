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

  function parseWhen(value) {
    if (value == null || value === '') return null;
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
      return Number.isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }

  function fmtWhen(value) {
    const d = parseWhen(value);
    if (!d) return value == null || value === '' ? '' : String(value);
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  /** 0–100 how far through [start, end]; null if dates missing/invalid. */
  function cycleProgressPct(start, end) {
    const s = parseWhen(start);
    const e = parseWhen(end);
    if (!s || !e) return null;
    const total = e.getTime() - s.getTime();
    if (total <= 0) return null;
    return clampPct(((Date.now() - s.getTime()) / total) * 100);
  }

  /**
   * Linear extrapolation: used / cycleElapsed → expected % at cycle end.
   * Returns null if cycle progress is unknown or too early (<1%) to trust.
   * Value may exceed 100.
   */
  function projectEndPct(usedPct, cyclePct) {
    if (cyclePct == null || cyclePct < 1) return null;
    const used = typeof usedPct === 'number' && Number.isFinite(usedPct) ? usedPct : 0;
    const projected = (used / cyclePct) * 100;
    if (!Number.isFinite(projected)) return null;
    return Math.max(0, projected);
  }

  function clampPct(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function renderUsageSection(title, subtitle, used, barClass, cyclePct) {
    const projected = projectEndPct(used, cyclePct);
    const projClamp = projected != null ? clampPct(projected) : null;
    const over = projected != null && projected >= 100;
    const projHtml =
      projected != null
        ? `<p class="projection${over ? ' projection-over' : ''}" tabindex="0" data-tip="Estimation based on current usage and cycle progress">` +
          `~${esc(fmtPercent(projected))} by cycle end` +
          `</p>`
        : '';
    const barHtml =
      projClamp != null
        ? `<div class="bar-stack" role="img" aria-label="${esc(title)}: ${esc(fmtPercent(used))} used, ~${esc(fmtPercent(projected))} projected">` +
          `<div class="bar-ghost bar-ghost-${esc(barClass)}" style="width:${projClamp}%"></div>` +
          `<progress class="bar bar-${esc(barClass)}" max="100" value="${used}">${esc(fmtPercent(used))}</progress>` +
          `</div>`
        : `<progress class="bar bar-${esc(barClass)}" max="100" value="${used}">${esc(fmtPercent(used))}</progress>`;

    return (
      `<section class="section">` +
      `<div class="section-head">` +
      `<h2 class="section-title">${esc(title)}</h2>` +
      `<span class="percent">${esc(fmtPercent(used))} used</span>` +
      `</div>` +
      `<p class="subtitle">${esc(subtitle)}</p>` +
      barHtml +
      projHtml +
      `</section>`
    );
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
      if (kind === 'custom') {
        const now = new Date();
        const sameDay =
          d.getFullYear() === now.getFullYear() &&
          d.getMonth() === now.getMonth() &&
          d.getDate() === now.getDate();
        if (sameDay) {
          return `since ${d.toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
          })}`;
        }
        return `since ${d.toLocaleString(undefined, {
          month: 'short',
          day: 'numeric',
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

  function renderUsageSoFar(w) {
    if (!w) return '';
    const since = fmtSinceLabel(w.since, w.partial, 'custom');
    return (
      `<hr class="divider" />` +
      `<section class="section section-usage-so-far">` +
      `<div class="section-head">` +
      `<h2 class="section-title">Usage so far</h2>` +
      `<button class="btn-reset" id="btn-reset-usage-so-far" type="button">Reset</button>` +
      `</div>` +
      (since ? `<p class="subtitle usage-so-far-since">${esc(since)}</p>` : '') +
      `<div class="window-stats window-stats-block">` +
      `<span class="window-stat window-stat-cm">CM ${esc(fmtDeltaPct(w.autoPercentDelta))}</span>` +
      `<span class="window-stat window-stat-om">OM ${esc(fmtDeltaPct(w.apiPercentDelta))}</span>` +
      `</div>` +
      `</section>`
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

  function planTitle(name) {
    const raw = String(name || 'Pro').trim() || 'Pro';
    const withPlan = /\bplan\b/i.test(raw) ? raw : `${raw} Plan`;
    if (/\busage\b/i.test(withPlan)) return withPlan;
    return `${withPlan} usage`;
  }

  function renderUsage(data) {
    const auto = clampPct(data.autoPercentUsed);
    const api = clampPct(data.apiPercentUsed);
    const plan = esc(planTitle(data.planName));
    const cyclePct = cycleProgressPct(data.billingCycleStart, data.billingCycleEnd);
    const cycleBar =
      cyclePct != null
        ? `<div class="cycle-progress">` +
          `<div class="cycle-progress-head">` +
          `<span class="cycle-progress-label">Cycle progress</span>` +
          `<span class="cycle-progress-pct">${esc(fmtPercent(cyclePct))}</span>` +
          `</div>` +
          `<progress class="bar bar-cycle" max="100" value="${cyclePct}" aria-label="Billing cycle progress">${esc(fmtPercent(cyclePct))}</progress>` +
          `</div>`
        : '';
    const cycle = data.billingCycleEnd
      ? `<div class="meta meta-stack"><span class="meta-label">Billing cycle ends</span><span class="meta-value">${esc(fmtWhen(data.billingCycleEnd))}</span>${cycleBar}</div>`
      : '';
    const refreshed = data.refreshedAt
      ? `<div class="meta meta-stack meta-refreshed"><span class="meta-label">Last refreshed</span><span class="meta-value">${esc(fmtWhen(data.refreshedAt))}</span></div>`
      : '';

    const usageSoFar = renderUsageSoFar(data.usageSoFar);

    const windows =
      data.lastHour || data.session
        ? `<hr class="divider" />` +
          `<section class="section section-windows">` +
          `<div class="section-head">` +
          `<h2 class="section-title">Recent usage</h2>` +
          `</div>` +
          `<div class="windows">` +
          renderWindowRow('Last hour', data.lastHour, 'hour') +
          renderWindowRow('IDE session', data.session, 'session') +
          `</div>` +
          `</section>`
        : '';

    app.innerHTML =
      `<div class="header">` +
      `<h1>${plan}</h1>` +
      `</div>` +
      `<hr class="divider" />` +
      renderUsageSection(
        'Cursor Models',
        "Auto mode and Cursor's models",
        auto,
        'cursor',
        cyclePct
      ) +
      `<hr class="divider" />` +
      renderUsageSection(
        'Other Models',
        'Third-party API models',
        api,
        'other',
        cyclePct
      ) +
      usageSoFar +
      windows +
      `<hr class="divider" />` +
      `<div class="footer">` +
      cycle +
      refreshed +
      `</div>`;
    bindResetUsageSoFar();
  }

  function bindRefresh() {
    const btn = document.getElementById('btn-refresh');
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      vscode.postMessage({ type: 'refresh' });
    });
  }

  function bindResetUsageSoFar() {
    const btn = document.getElementById('btn-reset-usage-so-far');
    if (!btn) return;
    btn.addEventListener('click', () => {
      btn.disabled = true;
      vscode.postMessage({ type: 'resetUsageSoFar' });
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
