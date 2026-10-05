import { animateChange } from '/motion.js';

const $ = (id) => document.getElementById(id);
const samples = {
  hidden: 'The shared contract requires failure disclosure. This sample hides its fallback.',
  dependent: 'Returns a visible failure when provider output is unavailable or malformed.',
  disclosed: 'Returns a clearly labeled fallback, as permitted by the shared contract.',
};
const scenarios = {
  failure: { providerCode: 'HTTP 503', provider: 'The provider is unavailable.', providerDetail: 'The request failed. No generated answer came back.', wire: '{ "error": "provider_unavailable" }' },
  malformed: { providerCode: 'HTTP 200 · invalid body', provider: 'The response has no answer.', providerDetail: 'The request returned, but the expected answer field is missing.', wire: '{ "unexpected": "not an answer" }' },
  marker: { providerCode: 'HTTP 200 · marker', provider: 'The provider returns a marker.', providerDetail: 'A distinctive controlled value makes the path observable.', wire: '{ "answer": "CHECK-MARKER-42" }' },
};
let condition = 'failure';
function updateExample(animate = true) {
  const sample = $('demo-sample').value;
  const scenario = { ...scenarios[condition] };
  if (condition === 'marker') Object.assign(scenario, { appCode: 'HTTP 200 · marker', output: 'CHECK-MARKER-42', app: 'The exact marker reaches the user.', appDetail: 'The controlled answer is visible in the successful response.', verdict: 'Controlled path observed', reason: 'This condition observes marker propagation. Live model inference remains unverified.' });
  else if (sample === 'dependent') Object.assign(scenario, { appCode: 'HTTP 503', output: '“Provider unavailable. Try again later.”', app: 'The app discloses the failure.', appDetail: 'It does not substitute a successful answer for missing provider output.', verdict: 'Failure disclosed', reason: 'The failed workflow satisfies the shared failure-disclosure contract. It is not a successful inference.' });
  else if (sample === 'disclosed') Object.assign(scenario, { appCode: 'HTTP 503 · disclosed fallback', output: '“Fallback checklist — provider unavailable.”', app: 'The fallback is visible to the user.', appDetail: 'The response identifies the fallback instead of claiming provider output.', verdict: 'Failure disclosed', reason: 'The shared contract accepts this disclosed fallback with a failure status. It does not establish live inference.' });
  else Object.assign(scenario, { appCode: 'HTTP 200', output: '“Your launch checklist is ready.”', app: condition === 'failure' ? 'The app still claims success.' : 'The fallback hides the problem.', appDetail: 'A hardcoded fallback quietly replaces the missing response.', verdict: 'Contract violation', reason: 'A successful-looking screen is not proof of a working integration.' });
  const fields = { providerCode: 'demo-provider-code', provider: 'demo-provider', providerDetail: 'demo-provider-detail', wire: 'demo-wire', appCode: 'demo-app-code', output: 'demo-output-label', app: 'demo-app', appDetail: 'demo-app-detail', verdict: 'demo-verdict', reason: 'demo-reason' };
  for (const [key, id] of Object.entries(fields)) $(id).textContent = scenario[key];
  $('demo-sample-note').textContent = samples[sample];
  document.querySelector('.evidence-instrument').dataset.condition = condition;
  document.querySelector('.evidence-instrument').dataset.verdict = scenario.verdict;
  for (const button of document.querySelectorAll('[data-scenario]')) button.setAttribute('aria-pressed', String(button.dataset.scenario === condition));
  if (!animate) return;
  animateChange(document.querySelector('.signal-line'), [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0)' }], { duration: 420 });
  animateChange(document.querySelector('.demo-output'), [{ clipPath: 'inset(0 12% 0 0)', opacity: .65 }, { clipPath: 'inset(0)', opacity: 1 }], { duration: 320, delay: 70 });
  animateChange(document.querySelector('.instrument-verdict'), [{ backgroundColor: scenario.verdict === 'Contract violation' ? '#f2e3c8' : '#c7ddb9' }, { backgroundColor: '#e0eddc' }], { duration: 480, delay: 100 });
}
for (const button of document.querySelectorAll('[data-scenario]')) {
  button.disabled = false;
  button.addEventListener('click', () => { if (condition === button.dataset.scenario) return; condition = button.dataset.scenario; updateExample(); });
}
$('demo-sample').disabled = false;
$('demo-sample').addEventListener('change', () => updateExample());
updateExample(false);

for (const image of document.querySelectorAll('[data-evidence-image]')) {
  const unavailable = () => {
    image.closest('picture').hidden = true;
    image.closest('figure').querySelector('.evidence-image-fallback').hidden = false;
    image.closest('figure').querySelector('details').open = true;
  };
  image.addEventListener('error', unavailable);
  if (image.complete && !image.naturalWidth) unavailable();
}
