# browser-gtfs-rt-playback

A browser-based tool for playing back GTFS Realtime data. Proof of concept: enter a GTFS
Schedule URL and three GTFS-RT URLs; the schedule is downloaded and parsed in your browser and
a summary (agency, routes, stops, service dates) is shown. The realtime URLs are not fetched yet.

```bash
npm install
npm run dev      # local dev server
npm test         # unit tests
npm run build    # static site in dist/
```

The schedule host must allow cross-origin requests (CORS), since there is no proxy.

## Deployment

`.github/workflows/deploy.yml` builds on every push and pull request and deploys to GitHub
Pages from the default branch. Once, in the repo settings, set **Pages → Source** to
**GitHub Actions**.

Behavior is specified in [`specs/`](specs/); work history is in [`plans/`](plans/).
