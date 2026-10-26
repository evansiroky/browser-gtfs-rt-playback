#!/usr/bin/env bash
# Tests for scripts/container-smoke.sh against a fake docker (test/fake-bin/docker) that runs an app
# natively instead of a container: the built server for the passing case, and test/fake-app.mjs, a
# stub with switchable defects, for every way the script must fail. Needs the built packages first:
#   npm run build -w shared -w server -w web
# Usage: scripts/test/container-smoke-tests.sh
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPTS=$(dirname "$HERE")
REPO=$(dirname "$SCRIPTS")
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/container-smoke-tests.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

# The image's /app layout: server/dist and web/dist (plus node_modules, found by walking up).
APP=$ROOT/app
mkdir -p "$APP/server" "$APP/web"
if [[ ! -f $REPO/server/dist/main.js || ! -f $REPO/web/dist/index.html ]]; then
  echo "build first: npm run build -w shared -w server -w web" >&2
  exit 2
fi
cp -R "$REPO/server/dist" "$APP/server/dist"
cp -R "$REPO/web/dist" "$APP/web/dist"
ln -s "$REPO/node_modules" "$APP/node_modules"
mkdir "$ROOT/empty-web"

# The marker strings container-smoke.sh puts in its fake feed URLs (written out on purpose: the
# tests fail if the script's contract changes).
SECRET_KEY=smoke-secret-key-7f3a91
SECRET_PATH=smoke-secret-path-2b8c40

free_port() {
  node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

OUT=$ROOT/out
STATE=$ROOT/state
RC=0
PORT=0

# smoke [VAR=value ...]: runs the script with the fake docker first on PATH, on a free port, in
# a fresh fake-docker state. FAKE_DOCKER_APP=stub is the default; FAKE_DOCKER_APP=real runs the server.
smoke() {
  local envs=()
  while [[ ${1:-} == *=* ]]; do
    envs+=("$1")
    shift
  done
  PORT=$(free_port)
  rm -rf "$STATE"
  mkdir -p "$STATE"
  RC=0
  env "FAKE_DOCKER_STATE=$STATE" "FAKE_DOCKER_SERVER_DIR=$APP" "PATH=$HERE/fake-bin:$PATH" \
    FAKE_DOCKER_APP=stub SMOKE_READY_TIMEOUT_S=4 \
    ${envs[@]+"${envs[@]}"} "$SCRIPTS/container-smoke.sh" img --port "$PORT" "$@" >"$OUT" 2>&1 || RC=$?
}

fail() {
  printf '    FAIL: %s\n    --- output ---\n' "$*"
  sed 's/^/    | /' "$OUT"
  if [[ -f $STATE/calls.log ]]; then
    printf '    --- docker calls ---\n'
    sed 's/^/    | /' "$STATE/calls.log"
  fi
  exit 1
}
assert_rc() { [[ $RC == "$1" ]] || fail "exit code $RC, expected $1"; }
assert_out() { grep -Fq -- "$1" "$OUT" || fail "output lacks: $1"; }
assert_not_out() { ! grep -Fq -- "$1" "$OUT" || fail "output unexpectedly has: $1"; }
assert_call() { grep -Fq -- "$1" "$STATE/calls.log" || fail "no docker call: $1"; }
# assert_only_failed <check text...>: the run failed, and exactly these checks did.
assert_only_failed() {
  local expected actual
  expected=$(printf 'FAIL %s\n' "$@" | sort)
  actual=$(grep '^FAIL ' "$OUT" | sort || true)
  [[ $actual == "$expected" ]] || fail "failed checks:
$actual
expected exactly:
$expected"
  assert_rc 1
}
# assert_clean_up: no container left behind, and no app process still alive.
assert_clean_up() {
  [[ -z $(ls -A "$STATE/containers") ]] || fail "containers left: $(ls "$STATE/containers")"
  local pid
  while read -r pid; do
    ! kill -0 "$pid" 2>/dev/null || fail "app process $pid is still running"
  done <"$STATE/pids.log"
}

test_passes_against_the_real_server() {
  smoke FAKE_DOCKER_APP=real
  assert_rc 0
  assert_out "ok   GET / carries a Content-Security-Policy"
  assert_out "ok   GET /trips/x returns the same HTML as /"
  assert_out "ok   GET /assets/<missing> returns 404 (got 404)"
  assert_out "ok   POST /api/v1/session/start reports state active"
  assert_out "ok   SIGTERM exits with code 0 (got 0)"
  assert_out "All checks passed."
  assert_clean_up
}

test_passes_and_uses_the_documented_docker_calls() {
  smoke
  assert_rc 0
  assert_not_out "FAIL"
  # Published on loopback only, to the container's port 8080; stopped with the 10 s grace period.
  assert_call "-p 127.0.0.1:$PORT:8080"
  assert_call "docker stop -t 10 "
  assert_call "docker exec "
  assert_clean_up
}

test_fails_when_the_root_page_is_not_200() {
  smoke FAKE_APP_BREAK=root-404
  assert_only_failed "GET / returns 200"
}

test_fails_when_the_root_page_is_not_the_web_app() {
  # /trips/x still serves the app, so it also differs from /.
  smoke FAKE_APP_BREAK=root-not-html
  assert_only_failed "GET / returns the web app HTML" "GET /trips/x returns the same HTML as /"
}

test_fails_without_a_content_security_policy() {
  smoke FAKE_APP_BREAK=no-csp
  assert_only_failed "GET / carries a Content-Security-Policy"
  smoke FAKE_APP_BREAK=empty-csp
  assert_only_failed "GET / carries a Content-Security-Policy"
}

test_fails_when_client_routes_do_not_fall_back_to_the_app() {
  smoke FAKE_APP_BREAK=trip-differs
  assert_only_failed "GET /trips/x returns the same HTML as /"
}

test_fails_when_a_missing_asset_is_not_404() {
  smoke FAKE_APP_BREAK=asset-200
  assert_only_failed "GET /assets/<missing> returns 404 (got 200)"
}

test_fails_when_the_session_does_not_start_active() {
  smoke FAKE_APP_BREAK=start-dormant
  assert_only_failed "POST /api/v1/session/start reports state active"
  smoke FAKE_APP_BREAK=start-no-state
  assert_only_failed "POST /api/v1/session/start reports state active"
}

test_fails_when_running_as_root() {
  smoke FAKE_DOCKER_UID=0
  assert_only_failed "the container does not run as root (uid 0)"
}

test_fails_when_the_user_cannot_be_determined() {
  smoke FAKE_DOCKER_UID=fail
  assert_only_failed "the container does not run as root (uid unknown)"
  smoke FAKE_DOCKER_UID=not-a-number
  assert_only_failed "the container does not run as root (uid not-a-number)"
}

test_fails_when_sigterm_does_not_exit_zero() {
  smoke FAKE_APP_BREAK=term-exit-1
  assert_only_failed "SIGTERM exits with code 0 (got 1)"
}

test_fails_when_shutdown_is_slower_than_the_drain_bound() {
  # Exits 0, but only after 9 s: past the 8 s bound and still inside the 10 s grace period.
  # (The script counts whole seconds, so the reported time is 9 or 10.)
  smoke FAKE_APP_STOP_DELAY_MS=9000
  assert_rc 1
  assert_out "FAIL SIGTERM exits within 8 s (took "
  [[ $(grep -c '^FAIL ' "$OUT") == 1 ]] || fail "expected exactly one failed check"
}

test_fails_when_the_log_shows_any_part_of_a_feed_url() {
  local leak
  for leak in "$SECRET_KEY" "$SECRET_PATH" "schedule.invalid" "vehicles.invalid" \
    "https://schedule.invalid/$SECRET_PATH/schedule.zip?key=$SECRET_KEY"; do
    smoke "FAKE_APP_LOG=fetching $leak"
    assert_only_failed "no feed URL or secret fragment in the container log"
  done
}

test_fails_when_the_log_is_empty() {
  smoke FAKE_APP_BREAK=silent
  assert_only_failed "the container log is not empty"
}

test_fails_when_the_container_port_is_not_8080() {
  # The app listens on 9999, so the script's mapping to 8080 reaches nothing.
  smoke FAKE_DOCKER_APP_PORT=9999
  assert_only_failed "the container answers on http://127.0.0.1:$PORT within 4 s"
  assert_clean_up
}

test_cleans_up_when_the_container_dies_at_start() {
  smoke FAKE_DOCKER_DIE=1
  assert_only_failed "the container answers on http://127.0.0.1:$PORT within 4 s"
  assert_out "cannot start"
  assert_clean_up
}

test_cleans_up_after_a_failed_run() {
  smoke FAKE_APP_BREAK=no-csp
  assert_rc 1
  assert_clean_up
}

test_fails_when_the_web_app_is_not_served() {
  smoke FAKE_DOCKER_APP=real "FAKE_DOCKER_WEB_DIST_DIR=$ROOT/empty-web"
  assert_rc 1
  assert_out "FAIL GET / returns 200"
  assert_out "FAIL GET / returns the web app HTML"
}

test_usage() {
  RC=0
  PATH=$HERE/fake-bin:$PATH "$SCRIPTS/container-smoke.sh" >"$OUT" 2>&1 || RC=$?
  assert_rc 2
  assert_out "Usage: scripts/container-smoke.sh"
  RC=0
  PATH=$HERE/fake-bin:$PATH "$SCRIPTS/container-smoke.sh" --help >"$OUT" 2>&1 || RC=$?
  assert_rc 0
  RC=0
  PATH=$HERE/fake-bin:$PATH "$SCRIPTS/container-smoke.sh" img --port nope >"$OUT" 2>&1 || RC=$?
  assert_rc 2
  RC=0
  PATH=$HERE/fake-bin:$PATH "$SCRIPTS/container-smoke.sh" --bogus >"$OUT" 2>&1 || RC=$?
  assert_rc 2
}

passed=0
failed=0
for test in $(declare -F | sed -n 's/^declare -f \(test_.*\)/\1/p'); do
  set +e
  (
    set -Eeuo pipefail
    trap 'printf "    FAIL: line %s: %s exited %s\n" "$LINENO" "$BASH_COMMAND" "$?"' ERR
    "$test"
  )
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    printf 'ok   %s\n' "$test"
    passed=$((passed + 1))
  else
    printf 'FAIL %s\n' "$test"
    failed=$((failed + 1))
  fi
done

printf '\n%d passed, %d failed\n' "$passed" "$failed"
[[ $failed -eq 0 ]]
