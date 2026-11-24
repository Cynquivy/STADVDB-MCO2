#!/usr/bin/env bash
# Deploy the last commit to the VMs. Run it from Git Bash (Windows) or any bash shell.
#
#   bash scripts/deploy.sh          # all three nodes
#   bash scripts/deploy.sh 2 3      # only Node 2 and Node 3
#
# How it works: `git archive HEAD` packs the committed code (never node_modules or .env), and ONE
# SSH session per node unpacks it into /opt/mco2, installs dependencies and (re)starts the app
# with pm2. So the VMs never need GitHub access, and only committed code is deployed.
# Each VM keeps its own /opt/mco2/.env (with its NODE_ID), which this script never touches.
set -euo pipefail

PUBLIC_IP="103.231.240.136"
APP_DIR="/opt/mco2"
declare -A SSH_PORT=([1]=20244 [2]=20245 [3]=20246)
declare -A APP_PORT=([1]=10244 [2]=10245 [3]=10246)

cd "$(git rev-parse --show-toplevel)"

commit="$(git rev-parse --short HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Note: you have uncommitted changes. Only the last commit ($commit) is deployed." >&2
fi

nodes=("$@")
[[ ${#nodes[@]} -eq 0 ]] && nodes=(1 2 3)

for n in "${nodes[@]}"; do
  port="${SSH_PORT[$n]:-}"
  if [[ -z "$port" ]]; then
    echo "Unknown node '$n' (use 1, 2 or 3)" >&2
    exit 1
  fi
  echo
  echo "=== Deploying $commit to Node $n (ssh port $port) ==="

  # The archive arrives on stdin; `tar -x` reads it, the rest of the commands run after.
  git archive --format=tar HEAD | ssh -p "$port" "root@$PUBLIC_IP" "
    set -e
    mkdir -p $APP_DIR
    if [ ! -f $APP_DIR/.env ]; then
      echo 'ERROR: $APP_DIR/.env is missing on Node $n. Create it first (see README, First-time setup).'
      exit 1
    fi
    grep -q '^NODE_ID=$n\b' $APP_DIR/.env || echo 'WARNING: NODE_ID in $APP_DIR/.env is not $n.'
    tar -x -C $APP_DIR
    cd $APP_DIR
    npm ci --omit=dev --no-audit --no-fund
    pm2 startOrReload ecosystem.config.cjs --update-env
    pm2 save
  "
  echo "Node $n done: http://$PUBLIC_IP:${APP_PORT[$n]}"
done
