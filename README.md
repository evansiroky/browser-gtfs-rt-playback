# browser-gtfs-rt-playback

A browser-based tool for playing back GTFS Realtime data. Proof of concept: enter a GTFS
Schedule URL and three GTFS-RT URLs; the schedule is downloaded and parsed in your browser and
a summary (agency, routes, stops, service dates) is shown. The realtime URLs are not fetched yet.

There is no build step: the repo root is the site. It must be served over HTTP; opening
`index.html` directly (`file://`) does not work because browsers block ES modules there.

```bash
npm start        # serve the site at http://localhost:8000 (PORT=3000 npm start to change it)
npm test         # unit tests (Node 20+)
```

The schedule host must allow cross-origin requests (CORS), since there is no proxy.

## Deployment

GitHub Pages serves the root of the `main` branch (Settings → Pages → Deploy from a branch),
so merging to `main` deploys. `.github/workflows/test.yml` runs the unit tests on pushes and
pull requests.

`src/vendor/fflate.js` is the vendored browser build of [fflate](https://github.com/101arrowz/fflate) (MIT).

Behavior is specified in [`specs/`](specs/); work history is in [`plans/`](plans/).
