#!/usr/bin/env bash
set -euo pipefail
image=$1
evidence=$(realpath "$2")
source .github/scripts/observer-cleanup.sh
# Separate subshells ensure each EXIT handler completes before evidence checks.
(
  chmod 777 "$evidence"
  docker create --name scanner-proof --init --network none --cap-drop ALL \
    --security-opt no-new-privileges=true \
    --security-opt seccomp="$PWD/deploy/chromium-seccomp-amd64.json" \
    --shm-size 1g --stop-timeout 20 \
    --mount type=bind,src="$PWD/test",dst=/app/test,readonly \
    --mount type=bind,src="$PWD/node_modules/mathjax",dst=/app/node_modules/mathjax,readonly \
    --mount type=bind,src="$evidence",dst=/evidence \
    --env DOTENV_CONFIG_PATH=/dev/null --env SANDBOX_CONTAINER_REQUIRED=1 \
    --env SANDBOX_AUDIT_DIR=/evidence --env SANDBOX_EVIDENCE_PATH=/evidence/sandbox.json \
    --entrypoint node "$image" \
    --test --test-reporter=tap test/integration/renderer-sandbox.mjs test/integration/scan-contracts.mjs \
    test/integration/trustworthy-capture.mjs test/integration/job-lifecycle.mjs \
    test/integration/browser-startup.mjs
  docker inspect scanner-proof > "$evidence"/container.json
  # Host runner owns the log; elevation is read-only observation only.
  # shellcheck disable=SC2024
  sudo python3 test/integration/container-observer.py scanner-proof "$evidence" > "$evidence"/observer.log 2>&1 &
  observer=$!
  trap 'finish_observer "$?" "$observer" "$evidence" scanner-proof' EXIT
  timeout 240s docker start --attach scanner-proof
  test "$(docker inspect --format '{{.State.ExitCode}}' scanner-proof)" = 0
  test -s "$evidence"/sandbox.json
)
node test/integration/verify-container-evidence.mjs "$evidence"
(
  docker run --detach --name scanner-stop --init --network none --cap-drop ALL \
    --security-opt no-new-privileges=true \
    --security-opt seccomp="$PWD/deploy/chromium-seccomp-amd64.json" \
    --shm-size 1g --stop-timeout 20 \
    --mount type=bind,src="$PWD/test",dst=/app/test,readonly \
    --mount type=bind,src="$evidence",dst=/evidence \
    --env DOTENV_CONFIG_PATH=/dev/null --entrypoint node "$image" \
    --import /app/test/integration/container-stop-fixture.mjs dist/server.js
  trap 'docker logs scanner-stop > "$evidence"/stop-server.log 2>&1; docker inspect scanner-stop > "$evidence"/stop-container.json' EXIT
  for ((i=0; i<100; i++)); do
    test ! -e "$evidence"/stop-ready || break
    sleep 0.1
  done
  test -e "$evidence"/stop-ready
  started=$(date +%s%3N)
  docker stop --time 20 scanner-stop
  elapsed=$(( $(date +%s%3N) - started ))
  echo "$elapsed" > "$evidence"/docker-stop-ms.txt
  test "$elapsed" -lt 15000
  test "$(docker inspect --format '{{.State.ExitCode}}' scanner-stop)" = 0
  test -s "$evidence"/stop-client.json
)
