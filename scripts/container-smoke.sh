#!/usr/bin/env bash
# Smoke test for the container image: starts it with placeholder feed URLs on a reserved
# `.invalid` host and checks that it serves, behaves and shuts down as the specs require.
# Needs only docker and curl. See scripts/README.md.
set -euo pipefail

DEFAULT_PORT=8080
# The server's own drain bound is 5 s; docker stop's grace period is longer, so a server that
# ignores SIGTERM shows up as exit code 137, and a slow one as a stop that takes too long.
STOP_GRACE_S=10
STOP_BOUND_S=8
READY_TIMEOUT_S=30

# Marker strings inside the fake feed URLs: none of them may ever reach the container log.
SECRET_KEY="smoke-secret-key-7f3a91"
SECRET_PATH="smoke-secret-path-2b8c40"
SCHEDULE_URL="https://schedule.invalid/$SECRET_PATH/schedule.zip?key=$SECRET_KEY"
VEHICLE_POSITIONS_URL="https://vehicles.invalid/$SECRET_PATH/vehicle-positions?key=$SECRET_KEY"

usage() {
  cat <<USAGE
Usage: scripts/container-smoke.sh <image> [--port <host-port>]

Runs <image> with fake feed URLs (unreachable .invalid hosts; the server must still start and
answer) and asserts:
  - GET / returns the web app HTML with a Content-Security-Policy header
  - GET /trips/x returns the same HTML (client-side routes)
  - GET /assets/<missing> returns 404
  - POST /api/v1/session/start returns JSON whose state is "active"
  - the process does not run as root
  - docker stop (SIGTERM) exits 0 within ${STOP_BOUND_S} s
  - no feed URL or secret fragment appears in the container log

Options:
  --port <host-port>  Host port mapped to the container's port 8080 (default: $DEFAULT_PORT).
  -h, --help          Show this help.
USAGE
}

IMAGE=""
PORT=$DEFAULT_PORT
while [[ $# -gt 0 ]]; do
  case $1 in
    -h | --help)
      usage
      exit 0
      ;;
    --port)
      [[ $# -ge 2 ]] || {
        usage >&2
        exit 2
      }
      PORT=$2
      shift 2
      ;;
    -*)
      printf 'unknown option: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
    *)
      [[ -z $IMAGE ]] || {
        usage >&2
        exit 2
      }
      IMAGE=$1
      shift
      ;;
  esac
done
[[ -n $IMAGE ]] || {
  usage >&2
  exit 2
}
[[ $PORT =~ ^[0-9]+$ ]] || {
  printf 'invalid --port: %s\n' "$PORT" >&2
  exit 2
}

BASE="http://127.0.0.1:$PORT"
NAME="gtfs-rt-debugger-smoke-$$"
WORK=$(mktemp -d "${TMPDIR:-/tmp}/container-smoke.XXXXXX")
FAILURES=0

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { printf 'ok   %s\n' "$1"; }
fail() {
  printf 'FAIL %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}
check() {
  # check <description> <command...>: passes when the command succeeds.
  local description=$1
  shift
  if "$@"; then pass "$description"; else fail "$description"; fi
}

not_root() { [[ $1 =~ ^[0-9]+$ && $1 != 0 ]]; }

log_is_clean() { ! grep -Eqi "schedule\.invalid|vehicles\.invalid|$SECRET_KEY|$SECRET_PATH" "$1"; }

running() {
  [[ $(docker inspect --format '{{.State.Running}}' "$NAME" 2>/dev/null) == true ]]
}

echo "Starting $IMAGE as $NAME on $BASE"
docker run -d --name "$NAME" -p "$PORT:8080" \
  -e "SCHEDULE_URL=$SCHEDULE_URL" \
  -e "VEHICLE_POSITIONS_URL=$VEHICLE_POSITIONS_URL" \
  "$IMAGE" >/dev/null

ready=0
for ((i = 0; i < READY_TIMEOUT_S * 2; i++)); do
  if ! running; then
    break
  fi
  if curl -s -o /dev/null --max-time 2 "$BASE/"; then
    ready=1
    break
  fi
  sleep 0.5
done
if [[ $ready -ne 1 ]]; then
  fail "the container answers on $BASE within ${READY_TIMEOUT_S} s"
  docker logs "$NAME" 2>&1 | tail -n 20 || true
  exit 1
fi
pass "the container answers on $BASE"

# --- Static serving ---------------------------------------------------------------------

curl -s -D "$WORK/root.headers" -o "$WORK/root.body" --max-time 5 "$BASE/" || true
check "GET / returns 200" grep -Eiq '^HTTP/[0-9.]+ 200' "$WORK/root.headers"
check "GET / returns the web app HTML" grep -Eiq '<div id="root">' "$WORK/root.body"
check "GET / carries a Content-Security-Policy" grep -Eiq '^content-security-policy:[[:space:]]*[^[:space:]]' "$WORK/root.headers"

curl -s -D "$WORK/trip.headers" -o "$WORK/trip.body" --max-time 5 "$BASE/trips/x" || true
check "GET /trips/x returns 200" grep -Eiq '^HTTP/[0-9.]+ 200' "$WORK/trip.headers"
check "GET /trips/x returns the same HTML as /" cmp -s "$WORK/root.body" "$WORK/trip.body"

missing=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/assets/does-not-exist.js" || true)
check "GET /assets/<missing> returns 404 (got $missing)" test "$missing" = 404

# --- API --------------------------------------------------------------------------------

curl -s -X POST -o "$WORK/start.body" --max-time 10 "$BASE/api/v1/session/start" || true
check "POST /api/v1/session/start reports state active" grep -Eq '"state" *: *"active"' "$WORK/start.body"

# --- Process ----------------------------------------------------------------------------

uid=$(docker exec "$NAME" id -u 2>/dev/null || echo unknown)
check "the container does not run as root (uid $uid)" not_root "$uid"

# --- Shutdown ---------------------------------------------------------------------------

SECONDS=0
docker stop -t "$STOP_GRACE_S" "$NAME" >/dev/null 2>&1 || true
stopped_in=$SECONDS
exit_code=$(docker inspect --format '{{.State.ExitCode}}' "$NAME" 2>/dev/null || echo unknown)
check "SIGTERM exits with code 0 (got $exit_code)" test "$exit_code" = 0
check "SIGTERM exits within ${STOP_BOUND_S} s (took ${stopped_in} s)" test "$stopped_in" -le "$STOP_BOUND_S"

# --- No secrets in the log ----------------------------------------------------------------

docker logs "$NAME" >"$WORK/container.log" 2>&1 || true
check "the container log is not empty" test -s "$WORK/container.log"
check "no feed URL or secret fragment in the container log" log_is_clean "$WORK/container.log"

echo
if [[ $FAILURES -ne 0 ]]; then
  printf '%d check(s) failed. Container log:\n' "$FAILURES"
  sed 's/^/  | /' "$WORK/container.log" | tail -n 30
  exit 1
fi
echo "All checks passed."
