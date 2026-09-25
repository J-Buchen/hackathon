#!/usr/bin/env bash
# Boot an UNMODIFIED AgentHire (github.com/shalpate/agenthire, pinned) on
# 127.0.0.1 for the Allowance demos, in keyless mock mode.
#
#   bash scripts/agenthire-up.sh            # -> http://127.0.0.1:5301
#   PORT=5201 bash scripts/agenthire-up.sh  # any port; one instance per port
#   bash scripts/agenthire-down.sh          # stop it (same PORT)
#
# Environment (all optional):
#   PORT              listen port (default 5301, the demo's and the audit's
#                     default too). Always bound to 127.0.0.1: AgentHire's
#                     money routes are unauthenticated.
#   AGENTHIRE_SRC     use an existing AgentHire checkout instead of cloning.
#                     It is never modified (no bytecode is written into it).
#   AGENTHIRE_VENV    use an existing Python venv that already has AgentHire's
#                     requirements (default: .agenthire/venv, created on demand).
#   AGENTHIRE_HOME    state dir for clone/venv/db/log/pid (default: .agenthire).
#   AGENTHIRE_RESET=1 delete this port's database first (fresh seed).
#   AGENTHIRE_SIM=off do not start AgentHire's live simulation engine.
#
# What it does, and why:
#   1. Source: $AGENTHIRE_SRC, else a shallow fetch of the pinned commit into
#      .agenthire/src (verified by commit hash).
#   2. Scrubs every outbound key/URL variable (FACILITATOR_*, GATEKEEPER_*,
#      PRIVATE_KEY, LLM_*) and pins them to "" so a stray .env in the source
#      (which app.py loads with setdefault) cannot re-inject them. AgentHire then
#      runs keyless: no chain writes, no LLM calls, x402 answers in "mock" mode.
#      API_KEY is different: it is AgentHire's only INBOUND auth, and when it is
#      empty every /admin/* mutation route (payout release-all, moderation
#      suspend, verification approve, ...) is open (auth.py:38-41). So it is set
#      to a random per-boot value that is never printed or written anywhere:
#      nothing in these demos calls an admin route, and nobody else can.
#      CORS_ORIGINS is pinned to this instance's own origin, so pages from other
#      origins open in a local browser cannot make JSON requests to /api/*
#      (AgentHire's default is "*"). A browser can still send "simple" requests
#      (form or text/plain bodies, no custom headers): routes that need a JSON
#      body reject those, but routes that need none (e.g. /api/sim/start) act on
#      them. The loopback bind keeps other machines out; it does not stop local
#      browser pages.
#   3. Bootstraps the DB with `python -c 'import models, app'`: on a fresh
#      clone app.py calls db.create_all() before the models are imported, so a
#      plain boot creates no tables. Importing models first works around that
#      without touching AgentHire's code.
#   4. Serves with ONE gunicorn worker (the sim engine is per process; two
#      workers would run two diverging simulations) and waits for /api/health.
#   5. Asserts the seeded roster is there (GET /api/agents total >= 100).
set -euo pipefail

PIN="ab317f2b831a9a832898b88759b496c28a435ed4"
REPO_URL="https://github.com/shalpate/agenthire"
HOST="127.0.0.1"
PORT="${PORT:-5301}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${AGENTHIRE_HOME:-$ROOT/.agenthire}"
mkdir -p "$STATE"
STATE="$(cd "$STATE" && pwd)"
PIDFILE="$STATE/agenthire-$PORT.pid"
LOGFILE="$STATE/agenthire-$PORT.log"
DB="$STATE/agenthire-$PORT.db"
BASE="http://$HOST:$PORT"

die() { echo "agenthire-up: $*" >&2; exit 1; }
say() { echo "agenthire-up: $*" >&2; }

command -v curl >/dev/null || die "curl is required"

# ---- already running? ---------------------------------------------------------
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  if curl -fsS "$BASE/api/health" >/dev/null 2>&1; then
    say "already running (pid $(cat "$PIDFILE"))"
    echo "$BASE"
    exit 0
  fi
  die "pid $(cat "$PIDFILE") is alive but $BASE/api/health does not answer; run scripts/agenthire-down.sh"
fi
rm -f "$PIDFILE"
code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "$BASE/" 2>/dev/null || true)"
if [ -n "$code" ] && [ "$code" != "000" ]; then
  die "something else is already listening on $HOST:$PORT (HTTP $code; on macOS 5000 is often AirPlay Receiver) - choose another PORT"
fi

# ---- source -----------------------------------------------------------------
if [ -n "${AGENTHIRE_SRC:-}" ]; then
  SRC="$(cd "$AGENTHIRE_SRC" && pwd)"
  if head="$(git -C "$SRC" rev-parse HEAD 2>/dev/null)" && [ "$head" != "$PIN" ]; then
    say "warning: $SRC is at $head, not the pinned $PIN"
  fi
else
  SRC="$STATE/src"
  if [ ! -f "$SRC/app.py" ]; then
    command -v git >/dev/null || die "git is required to fetch AgentHire (or set AGENTHIRE_SRC)"
    say "fetching $REPO_URL @ ${PIN:0:7} into $SRC"
    rm -rf "$SRC"
    git init -q "$SRC"
    git -C "$SRC" remote add origin "$REPO_URL"
    git -C "$SRC" fetch -q --depth 1 origin "$PIN" || die "could not fetch $REPO_URL @ $PIN"
    git -C "$SRC" -c advice.detachedHead=false checkout -q FETCH_HEAD
  fi
  head="$(git -C "$SRC" rev-parse HEAD)"
  [ "$head" = "$PIN" ] || die "$SRC is at $head, expected $PIN (delete it to re-fetch)"
fi
for f in app.py models.py wsgi.py requirements.txt; do
  [ -f "$SRC/$f" ] || die "$SRC/$f missing: not an AgentHire checkout"
done

# ---- python venv ------------------------------------------------------------
VENV="${AGENTHIRE_VENV:-$STATE/venv}"
if [ ! -x "$VENV/bin/python" ]; then
  [ -n "${AGENTHIRE_VENV:-}" ] && die "AGENTHIRE_VENV=$VENV has no bin/python"
  PY="$(command -v python3 || command -v python || true)"
  [ -n "$PY" ] || die "python3 is required"
  say "creating venv $VENV and installing AgentHire requirements (one-time)"
  "$PY" -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q -r "$SRC/requirements.txt"
fi
if [ ! -x "$VENV/bin/gunicorn" ]; then
  [ -n "${AGENTHIRE_VENV:-}" ] && die "AGENTHIRE_VENV=$VENV has no gunicorn"
  "$VENV/bin/pip" install -q gunicorn
fi

# ---- scrubbed, keyless environment --------------------------------------------
# Start from an empty environment (env -i) so no key or URL leaks in from the
# caller's shell, then pin every outbound key/URL variable AgentHire reads to "".
KEYLESS=(
  FACILITATOR_URL= FACILITATOR_PRIVATE_KEY=
  GATEKEEPER_URL= GATEKEEPER_PRIVATE_KEY=
  PRIVATE_KEY=
  LLM_URL= LLM_API_KEY= LLM_MODEL=
  AGENTHIRE_LIVE_WRITES=0
)
# Inbound auth for AgentHire's /admin/* mutation routes: a random per-boot key,
# never echoed or stored, so those routes are closed to everyone (see above).
ADMIN_KEY="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
[ "${#ADMIN_KEY}" -eq 48 ] || die "could not generate a random API_KEY"
RUNENV=(
  env -i
  "PATH=$VENV/bin:/usr/local/bin:/usr/bin:/bin"
  "HOME=${HOME:-$STATE}"
  "LANG=${LANG:-C.UTF-8}"
  "TMPDIR=${TMPDIR:-/tmp}"
  "DATABASE_URL=sqlite:///$DB"
  "FLASK_ENV=development"
  "PYTHONDONTWRITEBYTECODE=1"
  "PYTHONUNBUFFERED=1"
  "API_KEY=$ADMIN_KEY"
  "CORS_ORIGINS=http://$HOST:$PORT"
  "${KEYLESS[@]}"
)
if [ -f "$SRC/.env" ]; then
  say "note: $SRC/.env exists; its key/URL variables are overridden (outbound keys empty, API_KEY random)"
fi

# ---- bootstrap the database ---------------------------------------------------
if [ "${AGENTHIRE_RESET:-0}" = "1" ]; then
  say "AGENTHIRE_RESET=1: removing $DB"
  rm -f "$DB"
fi
say "bootstrapping database $DB"
(cd "$SRC" && "${RUNENV[@]}" "$VENV/bin/python" -c 'import models, app' >>"$LOGFILE" 2>&1) \
  || die "bootstrap failed; see $LOGFILE"

# ---- serve ------------------------------------------------------------------
say "starting gunicorn (1 worker) on $HOST:$PORT"
(cd "$SRC" && "${RUNENV[@]}" "$VENV/bin/gunicorn" \
  --workers 1 --threads 4 --timeout 120 \
  --bind "$HOST:$PORT" \
  --chdir "$SRC" \
  --pid "$PIDFILE" \
  --daemon \
  --error-logfile "$LOGFILE" \
  --capture-output \
  wsgi:app) || die "gunicorn failed to start; see $LOGFILE"

ok=""
for _ in $(seq 1 120); do
  if curl -fsS "$BASE/api/health" 2>/dev/null | grep -q '"agenthire"'; then ok=1; break; fi
  if [ -f "$PIDFILE" ] && ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ -z "$ok" ]; then
  tail -n 30 "$LOGFILE" >&2 || true
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE")" 2>/dev/null || true
  rm -f "$PIDFILE"
  die "AgentHire did not come up on $BASE (see $LOGFILE)"
fi

total="$(curl -fsS "$BASE/api/agents?per_page=1" \
  | "$VENV/bin/python" -c 'import json,sys; print(json.load(sys.stdin).get("total", 0))')" \
  || die "GET /api/agents failed"
[ "${total:-0}" -ge 100 ] || die "expected >= 100 seeded agents, got ${total:-0} (see $LOGFILE)"

# Upstream only auto-starts the simulation under the Werkzeug reloader
# (app.py: WERKZEUG_RUN_MAIN or not debug); under gunicorn we start it
# explicitly so A2A hires keep flowing, exactly as `python app.py` would.
if [ "${AGENTHIRE_SIM:-on}" != "off" ]; then
  curl -fsS -X POST "$BASE/api/sim/start" >/dev/null || say "warning: could not start the sim engine"
fi

say "up: pid $(cat "$PIDFILE"), $total agents, log $LOGFILE"
echo "$BASE"
