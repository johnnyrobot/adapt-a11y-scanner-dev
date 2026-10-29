# shellcheck shell=bash
# Sourced by the shipping harness. Keep the original failure and always collect
# final diagnostics, even when the read-only host observer exits unsuccessfully.
finish_observer() {
  local status=$1 observer=$2 evidence=$3 container=$4 result
  set +e
  trap - EXIT
  touch "$evidence/observer-stop"
  local stop_status=$?
  wait "$observer"
  local observer_status=$?
  docker inspect "$container" > "$evidence/container-final.json"
  local inspect_status=$?
  docker logs "$container" > "$evidence/test.log" 2>&1
  local log_status=$?
  for result in "$stop_status" "$observer_status" "$inspect_status" "$log_status"; do
    if (( status == 0 && result != 0 )); then status=$result; fi
  done
  exit "$status"
}
