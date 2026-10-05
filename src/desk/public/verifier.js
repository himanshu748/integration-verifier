import { api, notice, el, artifact, downloadBlob } from '/common.js';
import { animateChange } from '/motion.js';

const $ = (id) => document.getElementById(id);
const labels = {
  contract_violation: 'Contract violation', observed_controlled_path: 'Controlled path observed',
  observed_honest_failure: 'Failure disclosed', unverified: 'Unverified',
  verified_local_repair: 'Local repair verified', not_verified: 'Repair not verified',
};
let currentId = null;
let polling = null;
let pollingFailures = 0;
let imageUrl = null;
let activeId = null;
let sponsorReady = false;
let busy = false;
let renderedState = null;
let detailRequest = 0;
let listRequest = 0;
let starting = false;
let uncertainStart = false;
let completedId = null;
let historyState = null;
let pendingCompletion = null;
let screenshotLoaded = false;
let pageAvailable = true;

function runName(job) {
  return `${job.type === 'repair' ? 'Repair replay' : `${job.input.app} / ${job.input.scenario}`} · ${job.id.slice(0, 8)}`;
}
function verdictLabel(job, execution) {
  return job.verdict === 'verified_local_repair' && execution ? 'Controlled repair verified' : labels[job.verdict] ?? job.status;
}

function syncSelection() {
  for (const button of $('history').querySelectorAll('button[data-run-id]')) {
    if (button.dataset.runId === currentId) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  }
  $('open-active').hidden = !activeId || activeId === currentId;
}

function clearEvidence(label) {
  renderedState = null;
  screenshotLoaded = false;
  $('result-panel').hidden = false;
  $('jump-evidence').disabled = false;
  $('result-panel').dataset.runtime = 'loading';
  $('verdict').textContent = label;
  $('verdict').dataset.kind = 'unverified';
  $('run-identity').textContent = '';
  $('run-identity').removeAttribute('data-run-id');
  $('run-input').replaceChildren();
  $('result').replaceChildren();
  $('receipt').textContent = '';
  $('downloads').replaceChildren();
  $('artifact-picker').hidden = true;
  $('artifact-file').replaceChildren();
  $('workflow-image-slot').replaceChildren();
  if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
}

function workflowStep(current) {
  document.querySelectorAll('.work-steps li').forEach((step, index) => {
    step.dataset.state = index < current ? 'observed' : index === current ? 'current' : 'pending';
    if (index === current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  });
}

function controls() {
  const value = Boolean(starting || uncertainStart || activeId);
  const changed = busy !== value;
  busy = value;
  $('verify-form').setAttribute('aria-busy', String(busy));
  document.querySelector('.run-panel').dataset.running = String(busy);
  if (busy) workflowStep(1);
  else workflowStep($('result-panel').hidden ? 0 : $('result-panel').dataset.runtime === 'running' ? 1 : 2);
  if (changed && busy) animateChange(document.querySelector('.work-steps li:nth-child(2) span'), [
    { backgroundColor: '#dfedb4', transform: 'scale(.88)' },
    { backgroundColor: '#dfedb4', transform: 'scale(1)' },
  ], { duration: 240 });
  $('verify').disabled = busy; $('repair').disabled = busy;
  $('sandbox-verify').disabled = busy || !sponsorReady || !$('sponsor-consent').checked;
  $('nemotron-repair').disabled = busy || !sponsorReady || !$('sponsor-consent').checked;
}

function renderHistory(runs) {
  const history = $('history');
  if (!runs.length) {
    history.replaceChildren(el('li', { className: 'empty' }, 'No runs yet. Start a verification to retain its browser evidence.'));
    return;
  }
  const existing = new Map([...history.querySelectorAll('button[data-run-id]')].map((button) => [button.dataset.runId, button.parentElement]));
  for (const empty of history.querySelectorAll('.empty')) empty.remove();
  runs.forEach((run, index) => {
    let item = existing.get(run.id);
    if (!item) item = el('li', {}, el('button', { type: 'button', 'data-run-id': run.id,
      onclick: () => openEvidence(run.id).catch(fail) }, [runName(run), el('small')]));
    const subtitle = `${run.input.execution === 'sandbox' ? 'Sandbox requested · ' : ''}${run.status} · ${new Date(run.startedAt).toLocaleString()}`;
    if (item.querySelector('small').textContent !== subtitle) item.querySelector('small').textContent = subtitle;
    if (history.children[index] !== item) history.insertBefore(item, history.children[index] ?? null);
    existing.delete(run.id);
  });
  for (const item of existing.values()) item.remove();
}

async function refresh() {
  if (!pageAvailable) return null;
  const request = ++listRequest;
  const { runs, activeId: running } = await api('verifier', 'list');
  if (request !== listRequest || starting || !pageAvailable) return null;
  const previousActive = activeId;
  activeId = running;
  uncertainStart = false;
  controls();
  const state = JSON.stringify(runs);
  if (state !== historyState) renderHistory(runs);
  historyState = state;
  syncSelection();
  if (previousActive && previousActive !== running && runs.some((run) => run.id === previousActive)) pendingCompletion = previousActive;
  if (pendingCompletion && pendingCompletion !== running) {
    // A list is stored metadata; detail may downgrade changed primary evidence.
    const { job, execution } = await api('verifier', 'detail', { id: pendingCompletion });
    if (request !== listRequest || starting) return null;
    if (job.status !== 'running') {
      pendingCompletion = null;
      completedId = job.id;
      $('open-completed').hidden = currentId === job.id;
      const verdict = verdictLabel(job, execution);
      notice($('notice'), ['failed', 'interrupted'].includes(job.status)
        ? `${runName(job)} ${job.status}. No verified result: ${job.error}`
        : `${runName(job)} finished: ${verdict}. ${currentId === job.id ? 'Review its evidence below.' : 'Your selected evidence is still open. Use Open completed run to inspect this result.'}`,
      ['failed', 'interrupted'].includes(job.status));
      return { runs, completed: true };
    }
  }
  return { runs, completed: false };
}
function fail(error) { notice($('notice'), error.message, true); }

async function openEvidence(id) {
  const source = document.activeElement;
  await show(id);
  const ownHiddenControl = source?.hidden && document.activeElement === document.body;
  if (id !== currentId || document.hidden || (document.activeElement !== source && !ownHiddenControl)) return;
  $('evidence-heading').focus({ preventScroll: true });
  $('evidence-heading').scrollIntoView({ block: 'start', behavior: 'auto' });
}

async function show(id) {
  if (!pageAvailable) return;
  const request = ++detailRequest;
  const opening = currentId !== id;
  currentId = id;
  syncSelection();
  $('open-completed').hidden = !completedId || completedId === id;
  $('result-panel').hidden = false;
  if (opening) clearEvidence('Loading evidence');
  const data = await api('verifier', 'detail', { id });
  if (id !== currentId || request !== detailRequest || !pageAvailable) return;
  const { job, result, execution, artifacts } = data;
  const stateKey = JSON.stringify(data);
  if (stateKey === renderedState) {
    if (!screenshotLoaded) await loadScreenshot(id, artifacts, request);
    if (job.status === 'running') poll();
    return;
  }
  $('result-panel').hidden = false;
  $('result-panel').dataset.runtime = job.status;
  workflowStep(busy || job.status === 'running' ? 1 : 2);
  $('run-identity').dataset.runId = id;
  $('run-identity').textContent = `${runName(job)} · ${new Date(job.startedAt).toLocaleString()}`;
  $('run-input').replaceChildren(job.type === 'verify'
    ? el('p', {}, ['Requested workflow prompt: ', el('span', {}, job.input.prompt ?? 'Write a launch checklist')])
    : el('p', {}, 'Fixed bundled hidden fallback · provider unavailable, malformed response, and successful marker.'));
  $('verdict').textContent = verdictLabel(job, execution);
  $('verdict').dataset.kind = job.verdict ?? job.status;
  $('receipt').textContent = JSON.stringify({ job, result, execution }, null, 2);
  const content = [];
  if (execution) content.push(el('p', {}, execution.liveSandboxVerified ? `Nebius Sandbox execution: ${execution.executionId}.` : 'Sandbox transport fixture only. Live remote execution is not verified.'));
  if (job.status === 'finished' && job.primaryArtifactSha256 && result) content.push(el('p', { className: 'evidence-integrity' }, 'Receipt matches the primary evidence report. These local hashes detect changed report bytes; they are not provider attestation.'));
  if (job.inference) content.push(el('p', {}, `Repair generated by ${job.inference.inference.model}. Live inference verified: ${job.inference.inference.liveInferenceVerified ? 'yes' : 'no (test fixture)'}. ${job.inference.explanation}`));
  if (job.status === 'running') content.push(el('p', {}, 'The browser runner is working. This run has not produced a final verdict yet.'));
  else if (job.status === 'failed' || job.status === 'interrupted') content.push(el('p', {}, `No verified result: ${job.error}`));
  else if (job.type === 'verify' && result) {
    content.push(el('p', {}, result.verdict.reason ?? result.verdict.kind));
    content.push(el('p', { className: 'muted' }, `Workflow HTTP status: ${result.observations.workflowStatus}. Live inference verified: no.`));
    content.push(el('h3', {}, 'What the user saw'), el('pre', {}, JSON.stringify(result.observations.workflowBody, null, 2)));
    content.push(el('p', {}, `${result.observations.providerRequests.length} provider request(s) recorded. Source and contract hashes are retained in the receipt.`));
  } else if (result) {
    content.push(el('p', {}, 'The patch was applied to a temporary copy and evaluated against the unchanged regression.'));
    content.push(el('h3', {}, 'Same scenarios, before and after'), scenarioComparison(result.scenarios));
    content.push(el('ul', { className: 'check-list' }, Object.entries(result.checks).map(([key, passed]) => el('li', {}, `${passed ? 'Passed' : 'Failed'} — ${key.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}`))));
    content.push(el('p', { className: 'muted' }, `Before: exit ${result.before.exitCode}. After: exit ${result.after.exitCode}. Original source preserved: ${result.checks.originalSourceUnchanged ? 'yes' : 'no'}.`));
  }
  $('result').replaceChildren(...content);
  if (renderedState !== stateKey) {
    animateChange($('result'), [
      { clipPath: 'inset(0 0 10% 0)', opacity: .75 },
      { clipPath: 'inset(0)', opacity: 1 },
    ], { duration: 340 });
    if (job.status !== 'running') animateChange($('verdict'), [
      { outline: '5px solid #dfedb4' }, { outline: '0 solid transparent' },
    ], { duration: 420 });
    renderedState = stateKey;
  }
  $('downloads').replaceChildren(...artifacts.filter((file) => ['evidence.json', 'summary.json', 'repair.patch', 'browser-trace.zip', 'failure.json', 'sandbox.json', 'inference.json', 'bundle-manifest.json'].includes(file.name)).map((file) => el('button', {
    type: 'button', className: 'button secondary', onclick: async () => {
      try { downloadBlob(file.name, await artifact(id, file.name)); } catch (error) { fail(error); }
    },
  }, `Download ${file.name}`)));
  $('artifact-picker').hidden = !artifacts.length;
  const selectedArtifact = $('artifact-file').value;
  $('artifact-file').replaceChildren(...artifacts.map((file) => el('option', { value: file.name }, file.name)));
  if (artifacts.some((file) => file.name === selectedArtifact)) $('artifact-file').value = selectedArtifact;
  screenshotLoaded = false;
  await loadScreenshot(id, artifacts, request);
  if (job.status === 'running') poll();
}

async function loadScreenshot(id, artifacts, request) {
  $('workflow-image-slot').replaceChildren();
  if (imageUrl) { URL.revokeObjectURL(imageUrl); imageUrl = null; }
  const screenshot = artifacts.find((file) => file.name === 'workflow.png' || file.name === 'after/provider-fail/workflow.png');
  if (screenshot) {
    const blob = await artifact(id, screenshot.name);
    if (id !== currentId || request !== detailRequest || !pageAvailable) return;
    imageUrl = URL.createObjectURL(blob);
    $('workflow-image-slot').append(el('img', { src: imageUrl, className: 'evidence-image', alt: 'The actual sample application result captured by the browser runner' }));
  }
  screenshotLoaded = true;
}
function scenarioComparison(scenarios) {
  const headings = ['Provider condition', 'Before repair', 'After repair'];
  const names = { 'provider-fail': 'Provider unavailable', malformed: 'Malformed response', marker: 'Successful marker' };
  return el('div', { className: 'table-wrap verifier-comparison' }, el('table', { className: 'data-table', role: 'table' }, [
    el('caption', {}, 'Recorded outcomes from the unchanged regression'),
    el('thead', { role: 'rowgroup' }, el('tr', { role: 'row' }, headings.map((text) => el('th', { scope: 'col', role: 'columnheader' }, text)))),
    el('tbody', { role: 'rowgroup' }, scenarios.map((entry) => el('tr', { role: 'row' }, [
      el('th', { scope: 'row', role: 'rowheader' }, names[entry.scenario] ?? entry.scenario),
      ...['before', 'after'].map((phase) => el('td', { role: 'cell' }, [
        el('span', { className: 'comparison-phase', 'aria-hidden': 'true' }, phase === 'before' ? 'Before repair' : 'After repair'),
        el('strong', { 'data-kind': entry[phase].kind }, labels[entry[phase].kind] ?? entry[phase].kind),
        el('small', {}, entry[phase].reason),
      ])),
    ]))),
  ]));
}
function poll(delay = 900) {
  if (polling || !pageAvailable) return;
  polling = setTimeout(async () => {
    polling = null;
    try {
      const refreshed = await refresh();
      if (!refreshed) { if (activeId || uncertainStart) poll(); return; }
      if (currentId) await show(currentId);
      if (pollingFailures && !refreshed.completed) notice($('notice'), activeId ? 'Evidence refresh recovered. The saved run is still active.' : 'Saved evidence refreshed.');
      pollingFailures = 0;
      if (activeId) poll();
    } catch (error) {
      pollingFailures += 1;
      if (pollingFailures < 3) {
        notice($('notice'), `Evidence refresh interrupted. Retrying the saved run (${pollingFailures}/2); no new run will start.`, true);
        poll(1500);
      } else {
        fail(new Error(`${error.message} Automatic refresh paused. Use Refresh to reconnect to saved evidence; do not start a duplicate run.`));
      }
    }
  }, delay);
}
async function run(input) {
  if (busy || !pageAvailable) return;
  if (input.execution === 'sandbox') $('sponsor-consent').checked = false;
  if (polling) { clearTimeout(polling); polling = null; }
  pollingFailures = 0;
  starting = true;
  uncertainStart = true;
  completedId = null;
  pendingCompletion = null;
  $('open-completed').hidden = true;
  currentId = null;
  detailRequest += 1;
  listRequest += 1;
  clearEvidence('Starting run');
  syncSelection();
  controls();
  notice($('notice'), input.execution === 'sandbox' ? 'Preparing the requested Nebius run. Remote setup and browser checks can take several minutes; no result is verified yet.' : input.type === 'repair' ? 'Running the before/after repair regression. Evidence appears when execution finishes.' : 'Starting the browser and controlled provider…');
  try {
    const { job } = await api('verifier', 'run', input);
    listRequest += 1;
    activeId = job.id;
    starting = false;
    controls();
    if (!currentId) await show(job.id);
    await refresh();
    poll();
  } catch (error) {
    starting = false;
    controls();
    if (!pageAvailable) { fail(error); return; }
    try {
      await refresh();
      if (!currentId && activeId) await show(activeId);
      else if (!currentId) {
        clearEvidence('No active run');
        $('result').append(el('p', {}, 'No run receipt was returned for this request. Review saved history before starting another.'));
      }
      fail(new Error(`${error.message} Saved runs were checked; ${activeId ? 'the existing run is still active.' : 'no run is active. Review history before starting another.'}`));
      if (activeId) poll();
    } catch {
      controls();
      pollingFailures = 1;
      fail(new Error(`${error.message} Use Refresh to reconnect to the saved run before starting another.`));
    }
  }
}
$('verify-form').addEventListener('submit', (event) => { event.preventDefault(); run({ type: 'verify', ...Object.fromEntries(new FormData(event.currentTarget)) }); });
$('repair').addEventListener('click', () => run({ type: 'repair' }));
$('sponsor-consent').addEventListener('change', controls);
for (const event of ['input', 'change']) $('verify-form').addEventListener(event, () => {
  $('sponsor-consent').checked = false;
  controls();
});
$('review-bundle').addEventListener('click', async () => {
  try { $('bundle-list').textContent = JSON.stringify(await api('verifier', 'bundle'), null, 2); } catch (error) { fail(error); }
});
$('sandbox-verify').addEventListener('click', () => run({ type: 'verify', ...Object.fromEntries(new FormData($('verify-form'))), execution: 'sandbox', consent: $('sponsor-consent').checked }));
$('nemotron-repair').addEventListener('click', () => run({ type: 'repair', execution: 'sandbox', repairMode: 'nemotron', consent: $('sponsor-consent').checked }));
api('inference', 'status').then((status) => {
  sponsorReady = status.configured && status.sandboxConfigured;
  $('sponsor-status').textContent = sponsorReady ? `Server credentials configured. Model: ${status.model ?? 'discover available NVIDIA Nemotron'}. Live access is verified only after a successful run.` : 'Live access deferred or unconfigured. Set server credentials and a Sandbox project after account setup. Local checks remain available.';
  controls();
}).catch((error) => { $('sponsor-status').textContent = error.message; });
async function reconnect() {
  try {
    const refreshed = await refresh();
    if (!refreshed) return;
    const { runs } = refreshed;
    pollingFailures = 0;
    if (currentId && runs.some((run) => run.id === currentId)) await show(currentId);
    else if (activeId) await show(activeId);
    else if (currentId) {
      currentId = null;
      clearEvidence('Saved run unavailable');
      $('result').append(el('p', {}, 'The selected run is no longer in saved history. Its previous evidence was cleared.'));
      syncSelection();
    }
    if (activeId) poll();
    if (!refreshed.completed) notice($('notice'), activeId ? 'Reconnected to the saved run. Waiting for its evidence.' : 'Saved evidence refreshed.');
  } catch (error) { fail(error); }
}
$('refresh').addEventListener('click', reconnect);
window.addEventListener('pagehide', () => {
  pageAvailable = false;
  listRequest += 1;
  detailRequest += 1;
  if (polling) clearTimeout(polling);
  polling = null;
  if (imageUrl) URL.revokeObjectURL(imageUrl);
  imageUrl = null;
  screenshotLoaded = false;
  $('workflow-image-slot').replaceChildren();
});
window.addEventListener('pageshow', (event) => {
  pageAvailable = true;
  if (event.persisted) { pollingFailures = 0; reconnect(); }
});
$('open-active').addEventListener('click', () => { if (activeId) openEvidence(activeId).catch(fail); });
$('open-completed').addEventListener('click', () => { if (completedId) openEvidence(completedId).catch(fail); });
$('jump-evidence').addEventListener('click', () => {
  if (!$('result-panel').hidden) {
    $('evidence-heading').focus({ preventScroll: true });
    $('evidence-heading').scrollIntoView({ block: 'start', behavior: 'auto' });
  }
});
$('download-artifact').addEventListener('click', async () => {
  const id = currentId;
  const file = $('artifact-file').value;
  if (!id || !file) return;
  try { downloadBlob(file.replaceAll('/', '-'), await artifact(id, file)); }
  catch (error) { fail(error); }
});
refresh().then((refreshed) => { if (!refreshed) return; if (activeId) show(activeId).catch(fail); else if (refreshed.runs.length) show(refreshed.runs[0].id).catch(fail); }).catch(fail);
