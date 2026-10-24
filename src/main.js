import { summarizeGtfs, GtfsError } from './gtfs.js';
import { checkFeedAccess } from './feeds.js';

const form = document.querySelector('#feeds');
const statusEl = document.querySelector('#status');
const errorEl = document.querySelector('#error');
const resultEl = document.querySelector('#result');
const button = form.querySelector('button');

const RT_LABELS = {
  tripUpdates: 'Trip Updates',
  vehiclePositions: 'Vehicle Positions',
  serviceAlerts: 'Service Alerts',
};

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const urls = Object.fromEntries(new FormData(form));

  errorEl.hidden = true;
  resultEl.hidden = true;
  resultEl.replaceChildren();
  button.disabled = true;

  // The schedule and the realtime checks are independent: a failure of either never hides the
  // other. Blank realtime fields are neither checked nor warned about. Checks never reject.
  const accessChecks = Promise.all(
    Object.keys(RT_LABELS)
      .filter((key) => urls[key])
      .map(async (key) => [key, await checkFeedAccess(urls[key])]),
  );

  try {
    setStatus('Downloading GTFS Schedule…');
    const bytes = await download(urls.schedule);
    setStatus('Parsing GTFS Schedule…');
    // Let the status paint before the synchronous unzip/parse blocks the thread.
    await new Promise((resolve) => setTimeout(resolve));
    renderSummary(summarizeGtfs(bytes));
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }

  try {
    setStatus('Checking realtime feeds…');
    renderRealtime(urls, Object.fromEntries(await accessChecks));
  } finally {
    setStatus(null);
    button.disabled = false;
  }
});

async function download(url) {
  let response;
  try {
    response = await fetch(url);
  } catch {
    throw new GtfsError(
      'Could not download the schedule. The most likely cause is that the host does not allow ' +
        'cross-origin requests (CORS); other causes are a bad URL or no network connection.',
    );
  }
  if (!response.ok) {
    throw new GtfsError(`The server responded with HTTP ${response.status} ${response.statusText}.`.trim());
  }
  return new Uint8Array(await response.arrayBuffer());
}

function setStatus(text) {
  statusEl.textContent = text ?? '';
  statusEl.hidden = text == null;
}

function renderSummary(summary) {
  resultEl.append(el('h2', 'Schedule summary'));

  for (const agency of summary.agencies) {
    const details = [agency.url, agency.timezone].filter(Boolean).join(' · ');
    resultEl.append(row('Agency', [agency.name, details].filter(Boolean).join(' — ')));
  }
  resultEl.append(row('Routes', summary.routeCount.toLocaleString()));
  resultEl.append(row('Stops', summary.stopCount.toLocaleString()));
  resultEl.append(
    row('Service dates', summary.serviceStart ? `${summary.serviceStart} to ${summary.serviceEnd}` : 'unknown'),
  );
  resultEl.hidden = false;
}

function renderRealtime(urls, access) {
  const realtime = Object.entries(RT_LABELS).filter(([key]) => urls[key]);
  if (!realtime.length) return;

  resultEl.append(el('h2', 'Realtime feeds'), el('p', 'Contents are not read yet.', 'note'));
  for (const [key, label] of realtime) {
    resultEl.append(row(label, urls[key]));
    if (access[key] === false) {
      resultEl.append(
        el(
          'p',
          `${label}: could not reach this feed. The most likely cause is that the host does not allow ` +
            'cross-origin requests (CORS); other causes are a bad URL, no response within 10 seconds, ' +
            'or no network connection.',
          'warning',
        ),
      );
    }
  }
  resultEl.hidden = false;
}

function row(label, value) {
  const div = el('div', null, 'row');
  div.append(el('span', label, 'label'), el('span', value));
  return div;
}

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
}
