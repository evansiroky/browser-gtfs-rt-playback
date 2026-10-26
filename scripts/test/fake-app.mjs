// A minimal stand-in for the app inside the container, used by scripts/test/fake-bin/docker to make
// scripts/container-smoke.sh fail in controlled ways. Listens on PORT (default 8080, like the real
// image). FAKE_APP_BREAK is a comma-separated list of defects:
//   root-404          GET / answers 404 (with the HTML)
//   root-not-html     GET / answers 200 with something that is not the web app
//   no-csp            no Content-Security-Policy header
//   empty-csp         an empty Content-Security-Policy header
//   trip-differs      GET /trips/x serves a different body than /
//   asset-200         a missing /assets/ file answers 200
//   start-dormant     POST /api/v1/session/start reports "dormant"
//   start-no-state    POST /api/v1/session/start has no "state" field
//   term-exit-1       exits 1 on SIGTERM
//   silent            writes nothing to the log
// FAKE_APP_STOP_DELAY_MS delays the exit on SIGTERM; FAKE_APP_LOG is one extra log line.
import http from 'node:http';

const defects = new Set((process.env.FAKE_APP_BREAK ?? '').split(',').filter(Boolean));
const log = (line) => {
  if (!defects.has('silent')) console.log(line);
};
const html = '<!doctype html><html><body><div id="root"></div></body></html>';

const server = http.createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const send = (status, body, type = 'text/html; charset=utf-8') => {
    const headers = { 'content-type': type };
    if (!defects.has('no-csp')) {
      headers['content-security-policy'] = defects.has('empty-csp') ? '' : "default-src 'self'";
    }
    response.writeHead(status, headers);
    response.end(body);
  };

  if (request.method === 'POST' && path === '/api/v1/session/start') {
    if (defects.has('start-no-state')) return send(200, '{"status":"active"}', 'application/json');
    const state = defects.has('start-dormant') ? 'dormant' : 'active';
    return send(200, JSON.stringify({ state }), 'application/json');
  }
  if (path.startsWith('/assets/')) {
    return defects.has('asset-200') ? send(200, '// asset', 'text/javascript') : send(404, 'nope');
  }
  if (path === '/') {
    if (defects.has('root-not-html')) return send(200, 'ok', 'text/plain');
    return send(defects.has('root-404') ? 404 : 200, html);
  }
  return send(200, defects.has('trip-differs') ? `${html}<!-- other -->` : html);
});

process.on('SIGTERM', () => {
  const code = defects.has('term-exit-1') ? 1 : 0;
  setTimeout(() => process.exit(code), Number(process.env.FAKE_APP_STOP_DELAY_MS ?? 0));
});

server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () => {
  log('listening');
  if (process.env.FAKE_APP_LOG) log(process.env.FAKE_APP_LOG);
});
