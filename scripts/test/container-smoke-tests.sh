#!/usr/bin/env bash
# Tests for scripts/container-smoke.sh against a fake docker (test/fake-bin/docker) that runs the
# built server natively instead of a container. Needs the built packages first:
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

free_port() {
  node -e "const s=require('node:net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"
}

OUT=$ROOT/out
RC=0

# smoke [VAR=value ...] [script args...]: runs the script with the fake docker first on PATH.
smoke() {
  local envs=()
  while [[ ${1:-} == *=* ]]; do
    envs+=("$1")
    shift
  done
  RC=0
  env "FAKE_DOCKER_STATE=$ROOT/state" "FAKE_DOCKER_SERVER_DIR=$APP" "PATH=$HERE/fake-bin:$PATH" \
    ${envs[@]+"${envs[@]}"} "$SCRIPTS/container-smoke.sh" "$@" >"$OUT" 2>&1 || RC=$?
}

fail() {
  printf '    FAIL: %s\n    --- output ---\n' "$*"
  sed 's/^/    | /' "$OUT"
  exit 1
}
assert_rc() { [[ $RC == "$1" ]] || fail "exit code $RC, expected $1"; }
assert_out() { grep -Fq -- "$1" "$OUT" || fail "output lacks: $1"; }

test_passes_against_a_conforming_server() {
  smoke img --port "$(free_port)"
  assert_rc 0
  assert_out "ok   GET / carries a Content-Security-Policy"
  assert_out "ok   GET /trips/x returns the same HTML as /"
  assert_out "ok   GET /assets/<missing> returns 404 (got 404)"
  assert_out "ok   POST /api/v1/session/start reports state active"
  assert_out "ok   SIGTERM exits with code 0 (got 0)"
  assert_out "All checks passed."
}

test_fails_when_running_as_root() {
  smoke FAKE_DOCKER_UID=0 img --port "$(free_port)"
  assert_rc 1
  assert_out "FAIL the container does not run as root (uid 0)"
}

test_fails_when_the_log_shows_a_feed_url() {
  smoke FAKE_DOCKER_LEAK=1 img --port "$(free_port)"
  assert_rc 1
  assert_out "FAIL no feed URL or secret fragment in the container log"
}

test_fails_when_sigterm_does_not_exit_zero() {
  smoke FAKE_DOCKER_STOP_CODE=137 img --port "$(free_port)"
  assert_rc 1
  assert_out "FAIL SIGTERM exits with code 0 (got 137)"
}

test_fails_when_the_web_app_is_not_served() {
  smoke "FAKE_DOCKER_WEB_DIST_DIR=$ROOT/empty-web" img --port "$(free_port)"
  assert_rc 1
  assert_out "FAIL GET / returns the web app HTML"
}

test_fails_when_the_container_exits_at_start() {
  smoke FAKE_DOCKER_DIE=1 img --port "$(free_port)"
  assert_rc 1
  assert_out "FAIL the container answers on"
  assert_out "cannot start"
}

test_usage() {
  smoke
  assert_rc 2
  assert_out "Usage: scripts/container-smoke.sh"
  smoke --help
  assert_rc 0
  smoke img --port nope
  assert_rc 2
  smoke --bogus
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
