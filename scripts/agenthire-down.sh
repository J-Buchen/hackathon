#!/usr/bin/env bash
# Stop an AgentHire started by scripts/agenthire-up.sh (same PORT / AGENTHIRE_HOME).
#
#   bash scripts/agenthire-down.sh             # port 5301 (the default everywhere)
#   PORT=5201 bash scripts/agenthire-down.sh
set -euo pipefail

PORT="${PORT:-5301}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE="${AGENTHIRE_HOME:-$ROOT/.agenthire}"
PIDFILE="$STATE/agenthire-$PORT.pid"

if [ ! -f "$PIDFILE" ]; then
  echo "agenthire-down: not running on port $PORT (no $PIDFILE)" >&2
  # Point at any instance this state dir did start, so a wrong PORT does not
  # silently leave AgentHire (and its unauthenticated routes) running.
  for other in "$STATE"/agenthire-*.pid; do
    [ -f "$other" ] || continue
    p="${other##*/agenthire-}"; p="${p%.pid}"
    if kill -0 "$(cat "$other")" 2>/dev/null; then
      echo "agenthire-down: still running on port $p: PORT=$p bash scripts/agenthire-down.sh" >&2
    fi
  done
  exit 0
fi
pid="$(cat "$PIDFILE")"
if ! kill -0 "$pid" 2>/dev/null; then
  echo "agenthire-down: stale pidfile (pid $pid is gone); removing it" >&2
  rm -f "$PIDFILE"
  exit 0
fi

kill -TERM "$pid"
for _ in $(seq 1 40); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.25
done
if kill -0 "$pid" 2>/dev/null; then
  echo "agenthire-down: pid $pid ignored SIGTERM; sending SIGKILL" >&2
  kill -KILL "$pid" 2>/dev/null || true
  # gunicorn's worker is a child of the master; take it down too.
  pkill -KILL -P "$pid" 2>/dev/null || true
fi
rm -f "$PIDFILE"
echo "agenthire-down: stopped pid $pid (port $PORT)" >&2
