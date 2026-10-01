#!/usr/bin/env bash
set -euo pipefail

# Validate aggregate cgroup limits before launching any test descendants.
cgroup_path=$(awk -F: '$1 == "0" { print $3; exit }' /proc/self/cgroup)
memory_max=$(<"/sys/fs/cgroup${cgroup_path}/memory.max")
swap_max=$(<"/sys/fs/cgroup${cgroup_path}/memory.swap.max")
if [[ ! "$memory_max" =~ ^[0-9]+$ ]] || (( memory_max > 4294967296 )) || [[ "$swap_max" != 0 ]]; then
  echo "Test resource containment unavailable: memory.max=$memory_max memory.swap.max=$swap_max" >&2
  exit 125
fi
exec "$@"
