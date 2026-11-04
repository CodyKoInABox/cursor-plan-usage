(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById('app');

  let lastData;

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
      hour12: false,
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

  /**
   * Burn-rate line from the last hour (src/burnRate.ts). It is an estimate:
   * the rate can change quickly, so the copy says so.
   */
  function renderBurn(b) {
    if (!b || typeof b.ratePerHour !== 'number') return '';
    const rate = `+${Math.round(b.ratePerHour * 10) / 10}%/h`;
    const when = b.afterReset
      ? "won't reach 100% before reset at this rate"
      : `100% around ${fmtWhen(b.limitAtMs)}`;
    return (
      `<p class="projection projection-burn" tabindex="0" ` +
      `data-tip="Estimate from the last hour of usage. Bursty use makes it wrong.">` +
      `Estimate: ${esc(rate)} · ${esc(when)}` +
      `</p>`
    );
  }

  function renderUsageSection(title, subtitle, used, barClass, cyclePct, burn) {
    const projected = projectEndPct(used, cyclePct);
    const projClamp = projected != null ? clampPct(projected) : null;
    const over = projected != null && projected >= 100;
    const projHtml =
      projected != null
        ? `<p class="projection${over ? ' projection-over' : ''}" tabindex="0" data-tip="Estimation based on current usage and cycle progress">` +
          `~${esc(fmtPercent(projected))} by cycle end` +
          `</p>`
        : '';
    const burnHtml = renderBurn(burn);
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
      burnHtml +
      `</section>`
    );
  }

  function fmtDeltaPct(n) {
    const v = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    const rounded = Math.round(v * 10) / 10;
    return `+${rounded}%`;
  }

  /** Relative age of a timestamp, e.g. "just now" / "4m ago" / "2h ago". */
  function fmtRelative(value) {
    const d = parseWhen(value);
    if (!d) return '';
    const diffMs = Date.now() - d.getTime();
    if (diffMs < 45000) return 'just now';
    const mins = Math.round(diffMs / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return fmtWhen(value);
  }

  /** "in 42m" / "in 3h 5m" / "in 2d" until a Unix-ms expiry, or "expired". */
  function fmtExpiresIn(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
    const mins = Math.round((ms - Date.now()) / 60000);
    if (mins <= 0) return 'expired';
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h ${mins % 60}m`;
    return `in ${Math.floor(hours / 24)}d`;
  }

  /** "resets in 3d 4h" / "resets in 42m" / "reset pending" — mirrors src/billing.ts. */
  function fmtResetIn(value) {
    const d = parseWhen(value);
    if (!d) return '';
    const remaining = d.getTime() - Date.now();
    if (remaining <= 0) return 'reset pending';
    const mins = Math.floor(remaining / 60000);
    if (mins < 1) return 'resets in <1m';
    if (mins < 60) return `resets in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `resets in ${hours}h ${mins % 60}m`;
    return `resets in ${Math.floor(hours / 24)}d ${hours % 24}h`;
  }

  /** Footer row: where the session token came from, decrypted or not, and its expiry. */
  function renderToken(t) {
    if (!t) return '';
    const parts = [t.source === 'secret' ? 'Session token override' : 'Cursor local DB'];
    if (t.sealed) parts.push('decrypted');
    const exp = fmtExpiresIn(t.expiresAt);
    if (exp) parts.push(`expires ${exp}`);
    return (
      `<div class="meta meta-stack meta-token">` +
      `<span class="meta-label">Session token</span>` +
      `<span class="meta-value">${esc(parts.join(' · '))}</span>` +
      `</div>`
    );
  }

  /** `{ text, tip }` for a window's "since" line, or null when unknown. */
  function sinceInfo(w, kind) {
    if (!w || !w.since) return null;
    try {
      const d = new Date(w.since);
      if (Number.isNaN(d.getTime())) return null;
      const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60000));
      const clock = {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      };

      if (kind === 'hour') {
        if (w.outdated) {
          return {
            text: 'outdated sample',
            tip: 'Sampling paused while Cursor was closed or unfocused, so this covers more than the last hour.',
          };
        }
        if (w.partial) {
          return {
            text: mins < 60 ? `since ${mins}m ago` : 'since session start',
          };
        }
        return { text: 'rolling 1h' };
      }

      if (kind === 'session' || kind === 'custom') {
        const now = new Date();
        const sameDay =
          d.getFullYear() === now.getFullYear() &&
          d.getMonth() === now.getMonth() &&
          d.getDate() === now.getDate();
        if (sameDay) {
          return { text: `since ${d.toLocaleTimeString(undefined, clock)}` };
        }
        return {
          text: `since ${d.toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            ...clock,
          })}`,
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  function renderWindowRow(label, w, kind) {
    if (!w) return '';
    const since = sinceInfo(w, kind);
    const sinceHtml = since
      ? `<span class="window-since"${since.tip ? ` title="${esc(since.tip)}"` : ''}>${esc(since.text)}</span>`
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
    const since = sinceInfo(w, 'custom');
    return (
      `<hr class="divider" />` +
      `<section class="section section-usage-so-far">` +
      `<div class="section-head">` +
      `<h2 class="section-title">Usage so far</h2>` +
      `<button class="btn-reset" id="btn-reset-usage-so-far" type="button">Reset</button>` +
      `</div>` +
      (since
        ? `<p class="subtitle usage-so-far-since">${esc(since.text)}</p>`
        : '') +
      `<div class="window-stats window-stats-block">` +
      `<span class="window-stat window-stat-cm">CM ${esc(fmtDeltaPct(w.autoPercentDelta))}</span>` +
      `<span class="window-stat window-stat-om">OM ${esc(fmtDeltaPct(w.apiPercentDelta))}</span>` +
      `</div>` +
      `</section>`
    );
  }

  function sinceLastCommitSubtitle(w, git) {
    const tip =
      'Plan usage since your working tree went dirty at this HEAD. Not attributed to specific files.';
    if (git && (git.branch || git.dirtyFiles)) {
      const parts = [];
      if (git.branch) parts.push(String(git.branch));
      if (git.dirtyFiles) {
        const n = git.dirtyFiles;
        parts.push(`${n} file${n === 1 ? '' : 's'}`);
      }
      return { text: parts.join(' · '), tip };
    }
    const since = sinceInfo(w, 'custom');
    return since ? { text: since.text, tip } : { text: '', tip };
  }

  function renderSinceLastCommit(w, git) {
    if (!w) return '';
    const sub = sinceLastCommitSubtitle(w, git);
    return (
      `<hr class="divider" />` +
      `<section class="section section-since-last-commit">` +
      `<div class="section-head">` +
      `<h2 class="section-title" title="${esc(sub.tip)}">Since last commit</h2>` +
      `</div>` +
      (sub.text
        ? `<p class="subtitle usage-so-far-since" title="${esc(sub.tip)}">${esc(sub.text)}</p>`
        : '') +
      `<div class="window-stats window-stats-block">` +
      `<span class="window-stat window-stat-cm">CM ${esc(fmtDeltaPct(w.autoPercentDelta))}</span>` +
      `<span class="window-stat window-stat-om">OM ${esc(fmtDeltaPct(w.apiPercentDelta))}</span>` +
      `</div>` +
      `</section>`
    );
  }

  function thisBranchSubtitle(w, git) {
    const tip =
      'Plan usage while this branch was checked out (since we first saw it). Not attributed to commits or files.';
    const since = sinceInfo(w, 'custom');
    const parts = [];
    if (git && git.branch) parts.push(String(git.branch));
    if (since && since.text) parts.push(since.text);
    return { text: parts.join(' · '), tip };
  }

  function renderThisBranch(w, git) {
    if (!w) return '';
    const sub = thisBranchSubtitle(w, git);
    return (
      `<hr class="divider" />` +
      `<section class="section section-this-branch">` +
      `<div class="section-head">` +
      `<h2 class="section-title" title="${esc(sub.tip)}">This branch</h2>` +
      `</div>` +
      (sub.text
        ? `<p class="subtitle usage-so-far-since" title="${esc(sub.tip)}">${esc(sub.text)}</p>`
        : '') +
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

  /** `info` is an ErrorInfo: { kind, title, message, hint? }. */
  function renderError(info) {
    const title = info.title ? `<div class="state-error-title">${esc(info.title)}</div>` : '';
    const detail = esc(info.message || 'Unknown error');
    const hint = info.hint ? `<div class="state-error-hint">${esc(info.hint)}</div>` : '';
    app.innerHTML =
      '<div class="state state-error" data-kind="' + esc(info.kind || 'unknown') + '">' +
      title +
      `<div>${detail}</div>` +
      hint +
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
    const resetText = fmtResetIn(data.billingCycleEnd);
    const resetHtml = resetText
      ? ` <span class="meta-countdown" id="reset-countdown">· ${esc(resetText)}</span>`
      : '';
    const cycle = data.billingCycleEnd
      ? `<div class="meta meta-stack"><span class="meta-label">Billing cycle ends</span><span class="meta-value">${esc(fmtWhen(data.billingCycleEnd))}${resetHtml}</span>${cycleBar}</div>`
      : '';
    const refreshed = data.refreshedAt
      ? `<div class="meta meta-stack meta-refreshed"><span class="meta-label">Last refreshed</span><span class="meta-value" id="refreshed-value" title="${esc(fmtWhen(data.refreshedAt))}">${esc(fmtRelative(data.refreshedAt))}</span></div>`
      : '';

    const usageSoFar = renderUsageSoFar(data.usageSoFar);
    const sinceLastCommit = renderSinceLastCommit(
      data.sinceLastCommit,
      data.git
    );
    const thisBranch = renderThisBranch(data.thisBranch, data.git);

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

    const token = renderToken(data.tokenInfo);

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
        cyclePct,
        data.burn && data.burn.auto
      ) +
      `<hr class="divider" />` +
      renderUsageSection(
        'Other Models',
        'Third-party API models',
        api,
        'other',
        cyclePct,
        data.burn && data.burn.api
      ) +
      usageSoFar +
      sinceLastCommit +
      thisBranch +
      windows +
      `<hr class="divider" />` +
      `<div class="footer">` +
      cycle +
      refreshed +
      token +
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

  /** Keeps the "Last refreshed" age and the reset countdown honest between refreshes. */
  setInterval(() => {
    const refreshed = document.getElementById('refreshed-value');
    if (refreshed && lastData && lastData.refreshedAt) {
      refreshed.textContent = fmtRelative(lastData.refreshedAt);
    }
    const reset = document.getElementById('reset-countdown');
    if (reset && lastData) {
      reset.textContent = `· ${fmtResetIn(lastData.billingCycleEnd)}`;
    }
  }, 30000);

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'loading') {
      renderLoading();
    } else if (msg.type === 'error') {
      renderError(msg.error || { message: 'Unknown error' });
    } else if (msg.type === 'usageData') {
      lastData = msg.data || {};
      renderUsage(lastData);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
