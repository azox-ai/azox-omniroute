#!/usr/bin/env bash
# Build locally with a persistent, serial, memory-bounded BuildKit worker.
# Usage: bash scripts/build/docker-image.sh IMAGE [runner-cli|runner-base|runner-web] [BUILDER]
# Optional: OMNIROUTE_NODE_IMAGE (digest), OMNIROUTE_DOCKER_MEMORY_GB (default 6),
# OMNIROUTE_BUILD_MEMORY_MB (V8 old-space only, default 4096), BUILD_LOG_DIR.
set -euo pipefail

if [[ ${1:-} == --help ]]; then
  sed -n '2,5p' "$0"
  exit 0
fi
image=${1:?Usage: docker-image.sh IMAGE [TARGET] [BUILDER]}
target=${2:-runner-cli}
budget=${OMNIROUTE_DOCKER_MEMORY_GB:-6}
heap=${OMNIROUTE_BUILD_MEMORY_MB:-4096}
[[ $budget =~ ^[1-9][0-9]*$ && $heap =~ ^[1-9][0-9]*$ ]] || { echo 'Memory values must be positive integers' >&2; exit 2; }
(( budget >= 4 && budget <= 128 && heap <= budget * 1024 - 2048 )) || { echo 'Leave at least 2 GiB outside the V8 heap; builder budget must be 4..128 GiB' >&2; exit 2; }
case "$target" in runner-base|runner-web|runner-cli) ;; *) echo "Unknown target: $target" >&2; exit 2;; esac
builder=${3:-omniroute-bounded-${budget}g}
[[ $builder =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || { echo 'Invalid builder name' >&2; exit 2; }
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"
logs=${BUILD_LOG_DIR:-$root/_tasks/docker-builds/$(date -u +%Y%m%dT%H%M%SZ)}
mkdir -p "$logs"
logs=$(cd "$logs" && pwd)
# The builder is shared across worktrees. Conservatively serialize this name
# across Docker contexts too; a lock in the checkout would not protect it.
lock_root=/tmp/omniroute-build-locks-$UID
mkdir -p -m 700 "$lock_root"
[[ -O $lock_root && ! -L $lock_root ]] || { echo 'Unsafe build lock directory' >&2; exit 1; }
exec 9>"$lock_root/$builder.lock"
flock -n 9 || { echo "Another build owns $builder" >&2; exit 1; }
printf '[worker.oci]\nmax-parallelism = 1\n' > "$logs/buildkitd.toml"

if ! docker buildx inspect "$builder" > /dev/null 2>&1; then
  docker buildx create --name "$builder" --driver docker-container \
    --driver-opt "memory=${budget}g,memory-swap=${budget}g,cpu-period=100000,cpu-quota=300000,env.GOMEMLIMIT=512MiB" \
    --buildkitd-config "$logs/buildkitd.toml"
fi
docker buildx inspect --bootstrap "$builder" > "$logs/builder.txt"
node_name=$(awk '/^Nodes:/{nodes=1; next} nodes && /^Name:/{print $2}' "$logs/builder.txt")
[[ -n $node_name && $node_name != *$'\n'* ]] || { echo 'Exactly one builder node is required' >&2; exit 1; }
container=buildx_buildkit_$node_name
limit=$(docker inspect "$container" --format '{{.HostConfig.Memory}} {{.HostConfig.MemorySwap}}')
expected=$((budget * 1024 * 1024 * 1024))
[[ $limit == "$expected $expected" ]] || { echo "Builder limits differ: $limit; expected $expected $expected. Use another builder name." >&2; exit 1; }
# Keep the long-lived Go daemon from retaining the compiler's headroom after
# earlier builds. This is a soft Go-runtime target, not an RSS/cgroup limit.
go_profile=$(docker inspect "$container" --format '{{range .Config.Env}}{{if eq . "GOMEMLIMIT=512MiB"}}bounded{{end}}{{end}}')
[[ $go_profile == bounded ]] || { echo 'Builder requires GOMEMLIMIT=512MiB. Recreate it with cache preserved or use another builder name.' >&2; exit 1; }
docker exec "$container" cat /etc/buildkit/buildkitd.toml > "$logs/builder-config.toml"
grep -Eq '^max-parallelism *= *1$' "$logs/builder-config.toml" || { echo 'Builder must have max-parallelism = 1' >&2; exit 1; }
docker exec "$container" cat /sys/fs/cgroup/memory.events > "$logs/memory-events-before.txt"

sample() {
  while :; do
    bytes=$(docker exec "$container" cat /sys/fs/cgroup/memory.current) || return
    printf '%s\t%s\n' "$(date -u +%FT%TZ)" "$bytes"
    sleep 5
  done
}
sample > "$logs/memory-samples.tsv" 9>&- &
sampler=$!
build_pid=
cancel() {
  trap '' INT TERM
  if [[ -n $build_pid ]]; then
    kill -TERM -- "-$build_pid" 2>/dev/null || true
    wait "$build_pid" 2>/dev/null || true
  fi
  exit "$1"
}
finish() {
  result=$?
  trap - EXIT
  kill "$sampler" 2>/dev/null || true
  wait "$sampler" 2>/dev/null || true
  docker exec "$container" cat /sys/fs/cgroup/memory.events > "$logs/memory-events-after.txt" || true
  printf 'Build exit=%s; diagnostics: %s\n' "$result" "$logs"
  exit "$result"
}
trap finish EXIT
trap 'cancel 130' INT
trap 'cancel 143' TERM
args=()
if [[ -n ${OMNIROUTE_NODE_IMAGE:-} ]]; then args+=(--build-arg "NODE_IMAGE=$OMNIROUTE_NODE_IMAGE"); fi
# A dedicated process group lets cancellation stop both buildx and tee, then
# wait before taking the final memory counters. Arguments remain an array.
export BUILD_OUTPUT_LOG="$logs/build.log"
setsid bash -o pipefail -c 'docker buildx build "$@" 2>&1 | tee "$BUILD_OUTPUT_LOG"' _ \
  --builder "$builder" --progress plain --load \
  --target "$target" --tag "$image" --metadata-file "$logs/metadata.json" \
  --build-arg OMNIROUTE_USE_TURBOPACK=0 \
  --build-arg OMNIROUTE_BUILD_LOW_MEMORY=1 \
  --build-arg "OMNIROUTE_BUILD_MEMORY_MB=$heap" \
  --build-arg OMNIROUTE_BUILD_WORKERS=2 \
  "${args[@]}" . &
build_pid=$!
wait "$build_pid"
