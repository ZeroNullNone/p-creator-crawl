/* Batch jobs belong to the server; this page only starts and observes them. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const labels = { scanning: 'Reading archive', running: 'Crawling', retrying: 'Retrying', stopping: 'Stopping',
    stopped: 'Stopped', checked: 'List checked', completed: 'Completed', completed_with_errors: 'Has failures',
    completed_with_warnings: 'Images pending', needs_login: 'Cookies needed', interrupted: 'Interrupted',
    failed: 'Failed', saved: 'Saved', skipped: 'Already saved', pending: 'To save' };
  let data = { sources: [], types: [], runs: [] };
  let sourceId = null;
  let runId = null;
  let run = null;
  let editId = null;
  let fetching = false;
  let mutating = false;
  let connected = false;
  let runMarkup = '';
  let articleFilter = 'all';

  function html(id, value) { if ($(id).innerHTML !== value) $(id).innerHTML = value; }
  function error(message, id = 'batchError') { $(id).textContent = message || ''; $(id).hidden = !message; }
  function selectedSource() { return data.sources.find(s => s.id === sourceId); }
  function status(value) { return `<span class="batch-status ${escape(value)}">${escape(labels[value] || value)}</span>`; }
  function date(value) { return value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
  function relevantRuns() { const s = selectedSource(); return data.runs.filter(r => !s || r.source?.id === s.id || r.archiveUrl === s.url); }
  async function api(url, body, method = 'POST') {
    const response = await fetch(url, body === undefined ? { cache: 'no-store' } : {
      method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed.');
    return result;
  }

  function renderSources() {
    html('batchSources', data.sources.map(s => `<button type="button" class="batch-source" data-source="${escape(s.id)}" aria-current="${s.id === sourceId}"><strong>${escape(s.name)}</strong><small>${escape(new URL(s.url).hostname)}</small></button>`).join('') || '<p class="batch-muted">No saved sources yet.</p>');
    const source = selectedSource();
    $('batchSourcePanel').hidden = !source;
    $('batchNoSource').hidden = !!source;
    if (source) {
      const type = data.types.find(t => t.id === source.type);
      $('batchSourceName').textContent = source.name;
      $('batchSourceType').textContent = type?.label || 'Crawler unavailable';
      $('batchSourceUrl').textContent = source.url;
      $('batchSourceUrl').href = source.url;
      const verified = relevantRuns().find(r => r.accessVerifiedAt);
      $('batchCookieStatus').textContent = !source.cookiesSaved ? 'No cookies saved. Paid articles may need them.'
        : verified ? `Cookies saved · Paid access last verified ${date(verified.accessVerifiedAt)}`
          : 'Cookies saved · Paid access not yet verified';
    }
    const busy = !!data.activeId;
    $('batchStart').disabled = !source || !connected || busy || mutating;
    $('batchCheck').disabled = !source || !connected || busy || mutating;
    $('batchScope').disabled = busy || mutating;
    $('batchBusy').hidden = !busy;
    const active = data.runs.find(r => r.id === data.activeId);
    $('batchBusy').textContent = data.activeId === 'single' ? 'Claw is saving an article. Batch actions will be available when it finishes.'
      : busy ? `${active?.source?.name || 'A batch'} is running on the server. You can leave this page and keep reading in Library.` : '';
  }

  function renderHistory() {
    html('batchHistory', relevantRuns().map(r => `<button type="button" class="batch-history-row" data-run="${escape(r.id)}" aria-current="${r.id === runId}"><span><strong>${escape(r.source?.name)} · ${r.mode === 'check' ? 'List check' : r.scope === 'oldest5' || r.limit === 5 ? 'Oldest 5' : 'Archive crawl'}</strong><small>${escape(date(r.startedAt))} · ${r.summary.saved} saved · ${r.summary.skipped} skipped · ${r.summary.failed} failed${r.legacy ? ' · CLI run' : ''}</small></span>${status(r.status)}</button>`).join('') || '<p class="batch-muted">Your checks and crawls will appear here.</p>');
  }

  function renderRun() {
    if (!run) {
      html('batchRunPanel', '<p class="batch-empty">Ready when you are. <strong>Check list</strong> previews missing articles.<br><strong>Start crawl</strong> scans and saves them automatically.</p>');
      runMarkup = '';
      return;
    }
    const s = run.summary;
    const total = run.articles.length;
    const done = s.saved + s.skipped + s.failed;
    const percent = total ? Math.round(done / total * 100) : 0;
    const editable = !run.legacy && run.mode !== 'check';
    const disabled = data.activeId || mutating || !connected ? 'disabled' : '';
    const retry = editable && (s.failed || s.pending || ['stopped', 'interrupted', 'needs_login', 'failed'].includes(run.status));
    const visible = run.articles.filter(a => articleFilter === 'all' || (articleFilter === 'images' ? a.imagesPending > 0 : a.status === articleFilter));
    const rows = visible.map(a => `<tr><td><span class="batch-article-title">${escape(a.title || a.url)}</span>${a.error ? `<span class="batch-article-note">${escape(a.error)}</span>` : ''}${a.mediaError ? `<span class="batch-article-note">${escape(a.mediaError)}</span>` : ''}</td><td>${escape(a.postDate ? new Date(a.postDate).toLocaleDateString() : '—')}</td><td>${status(a.status)}${a.imagesPending ? `<span class="batch-article-note">${a.imagesPending} images pending</span>` : ''}</td><td>${a.available ? `<a href="#library/${encodeURIComponent(a.filename)}" data-read="${escape(a.filename)}">Read</a>` : ['saved', 'skipped'].includes(a.status) ? '<span class="batch-muted">Not in Library</span>' : '<span class="batch-muted">—</span>'}</td></tr>`).join('');
    const markup = `<div class="batch-section-title"><div class="batch-run-title"><h2>${run.mode === 'check' ? 'List check' : 'Crawl progress'}</h2>${status(run.status)}</div><span id="batchElapsed" class="batch-muted"></span></div>
      <div class="batch-stats">${[[run.scanComplete ? run.archiveCount ?? total : run.discovered, 'Discovered'], [s.saved, 'Saved'], [s.skipped, 'Skipped'], [s.failed, 'Failed'], [run.legacy ? '—' : s.imagesPending, 'Images pending']].map(([n, label]) => `<div class="batch-stat"><strong>${n || 0}</strong><span>${label}</span></div>`).join('')}</div>
      ${run.scanComplete && run.mode !== 'check' ? `<div class="batch-progress" role="progressbar" aria-label="Articles processed" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${total || 1}"><span style="width:${percent}%"></span></div>` : ''}
      <div class="batch-run-meta"><p class="batch-muted">${!run.scanComplete ? 'Reading archive pages… Total is not known yet.' : run.mode === 'check' ? `${total} selected · ${s.pending} to save · No articles downloaded` : `${done} / ${total} processed · ${s.pending + s.running} remaining`}</p><span class="batch-muted">${escape(date(run.startedAt))}</span></div>
      ${run.message ? `<p class="batch-notice">${escape(run.message)}</p>` : ''}
      ${run.legacy ? '<p class="batch-muted">Image status was not recorded for this CLI run.</p>' : ''}
      ${s.imagesPending ? '<p class="batch-muted">Article text is saved. Some images are not available offline yet.</p>' : ''}
      <div class="batch-run-actions">${run.active ? `<button type="button" class="batch-button" data-action="stop" ${run.stopRequested || mutating ? 'disabled' : ''}>${run.stopRequested ? 'Stopping after current article…' : 'Stop after current article'}</button>` : ''}${retry ? `<button type="button" class="batch-button" data-action="retry" ${disabled}>${s.pending || !run.scanComplete ? 'Resume crawl' : 'Retry failed'}</button>` : ''}${editable && s.imagesPending ? `<button type="button" class="batch-button" data-action="images" ${disabled}>Repair images</button>` : ''}${run.status === 'needs_login' ? '<button type="button" class="batch-link" data-action="cookies">Update cookies</button>' : ''}</div>
      ${total ? `<label class="batch-table-filter" for="batchArticleFilter">Show<select id="batchArticleFilter">${[['all', 'All results'], ['pending', 'To save'], ['failed', 'Failed'], ['images', 'Images pending']].map(([value, label]) => `<option value="${value}" ${value === articleFilter ? 'selected' : ''}>${label}</option>`).join('')}</select><span>${visible.length} articles</span></label><div class="batch-table-wrap"><table class="batch-table"><thead><tr><th scope="col">Article</th><th scope="col">Published</th><th scope="col">Status</th><th scope="col">Library</th></tr></thead><tbody>${rows || '<tr><td colspan="4" class="batch-muted">No articles match this filter.</td></tr>'}</tbody></table></div>` : ''}`;
    if (markup !== runMarkup) {
      const scroll = $('batchRunPanel').querySelector('.batch-table-wrap')?.scrollTop || 0;
      const focusedAction = document.activeElement?.dataset.action;
      html('batchRunPanel', markup);
      const table = $('batchRunPanel').querySelector('.batch-table-wrap');
      if (table) table.scrollTop = scroll;
      if (focusedAction) $('batchRunPanel').querySelector(`[data-action="${focusedAction}"]`)?.focus({ preventScroll: true });
      runMarkup = markup;
    }
    const elapsed = Math.max(0, Math.floor(((run.finishedAt ? new Date(run.finishedAt) : Date.now()) - new Date(run.startedAt)) / 1000));
    $('batchElapsed').textContent = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s elapsed`;
  }

  async function refresh() {
    if (fetching || mutating) return;
    fetching = true;
    try {
      const previousActive = data.activeId;
      data = await api('/batches/state');
      connected = true;
      if (!data.sources.some(s => s.id === sourceId)) sourceId = data.runs.find(r => r.id === data.activeId)?.source.id || data.sources[0]?.id || null;
      if (!runId || !data.runs.some(r => r.id === runId)) runId = relevantRuns().find(r => r.active)?.id || relevantRuns()[0]?.id || null;
      const requestedId = runId;
      const detail = requestedId ? await api(`/batches/runs/${encodeURIComponent(requestedId)}`) : null;
      if (runId !== requestedId) return;
      run = detail;
      error('');
      if (previousActive && !data.activeId) loadLibraryPosts();
    } catch (e) {
      connected = false;
      error(`Could not refresh crawl status: ${e.message} Reconnecting automatically.`);
    } finally {
      fetching = false;
      renderSources(); renderHistory(); renderRun();
    }
  }

  async function change(work, errorId = 'batchError') {
    if (mutating) return;
    mutating = true; error('', errorId); renderSources(); renderRun();
    try { await work(); }
    catch (e) { error(e.message, errorId); }
    finally {
      mutating = false;
      // Refresh without clearing a failed action's useful error message.
      const message = $(errorId).textContent;
      await refresh();
      if (message) error(message, errorId);
    }
  }

  function openEditor(id) {
    editId = id || null;
    const s = data.sources.find(s => s.id === id);
    $('batchDialogTitle').textContent = s ? 'Edit source' : 'Add source';
    $('batchInputName').value = s?.name || '';
    html('batchInputType', data.types.map(t => `<option value="${escape(t.id)}">${escape(t.label)}</option>`).join(''));
    $('batchInputType').value = s?.type || data.types[0]?.id || '';
    $('batchInputUrl').value = s?.url || '';
    $('batchRemoveSource').hidden = !s;
    $('batchRemoveSource').disabled = data.runs.some(r => r.active && r.source?.id === id);
    error('', 'batchFormError'); typeHint(); $('batchSourceDialog').showModal();
  }
  function typeHint() {
    const type = data.types.find(t => t.id === $('batchInputType').value);
    $('batchTypeDescription').textContent = type?.description || '';
    $('batchInputUrl').placeholder = type?.placeholder || '';
  }
  $('batchAddSource').onclick = () => openEditor();
  $('batchEditSource').onclick = () => openEditor(sourceId);
  $('batchCloseDialog').onclick = () => $('batchSourceDialog').close();
  $('batchInputType').onchange = typeHint;
  $('batchCookies').onclick = () => openCookieModal(data.types.find(t => t.id === selectedSource()?.type)?.cookieSource || 'substack');
  $('batchScope').onchange = () => {
    $('batchScopeHint').textContent = $('batchScope').value === 'oldest5'
      ? 'Selects the five oldest articles, then skips saved ones. Later articles do not fill their places.'
      : 'Scans the full archive and saves articles missing from your Library.';
  };
  $('batchSources').onclick = e => {
    const button = e.target.closest('[data-source]');
    if (!button) return;
    sourceId = button.dataset.source; runId = null; run = null; articleFilter = 'all';
    renderSources(); renderRun(); refresh();
  };
  $('batchHistory').onclick = e => {
    const button = e.target.closest('[data-run]');
    if (button) { runId = button.dataset.run; articleFilter = 'all'; refresh(); }
  };
  for (const [id, mode] of [['batchCheck', 'check'], ['batchStart', 'crawl']]) {
    $(id).onclick = () => change(async () => {
      run = await api('/batches/runs', { sourceId, mode, scope: $('batchScope').value });
      runId = run.id; articleFilter = 'all';
    });
  }
  $('batchRunPanel').onchange = e => {
    if (e.target.id === 'batchArticleFilter') { articleFilter = e.target.value; renderRun(); $('batchArticleFilter').focus(); }
  };
  $('batchRunPanel').onclick = e => {
    const read = e.target.closest('[data-read]');
    if (read) { e.preventDefault(); navigateTo(`#library/${encodeURIComponent(read.dataset.read)}`); return; }
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action || !run) return;
    if (action === 'cookies') { openCookieModal(data.types.find(t => t.id === run.source.type)?.cookieSource || 'substack'); return; }
    change(async () => { run = await api(`/batches/runs/${encodeURIComponent(run.id)}/${action === 'stop' ? 'stop' : 'retry'}`, { action }); });
  };
  $('batchSourceForm').onsubmit = e => {
    e.preventDefault();
    change(async () => {
      const saved = await api(`/batches/sources${editId ? `/${encodeURIComponent(editId)}` : ''}`, {
        name: $('batchInputName').value, type: $('batchInputType').value, url: $('batchInputUrl').value,
      }, editId ? 'PUT' : 'POST');
      sourceId = saved.id; runId = null; run = null; $('batchSourceDialog').close();
    }, 'batchFormError');
  };
  $('batchRemoveSource').onclick = () => change(async () => {
    await api(`/batches/sources/${encodeURIComponent(editId)}`, {}, 'DELETE');
    sourceId = null; runId = null; run = null; $('batchSourceDialog').close();
  }, 'batchFormError');
  window.batchPage = { enter: refresh };
  setInterval(() => { if ($('viewBatch').classList.contains('active') || data.activeId) refresh(); }, 2000);
  refresh();
})();
