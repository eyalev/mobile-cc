#!/usr/bin/env bash
# provision-vm.sh — orchestrate the Mobile CC capture VM from your dev box.
#
# Wraps the gcloud lifecycle around `bootstrap.sh`. Run subcommands from
# this dir on your dev machine; the bootstrap itself runs on the VM
# (idempotent — safe to re-run).
#
# Quickstart:
#
#   ./provision-vm.sh create     # create VM + bootstrap (~5 min first time)
#   ./provision-vm.sh capture    # ssh in, npm run capture, scp dist back
#   ./provision-vm.sh stop       # idle the VM (preserves disk)
#   ./provision-vm.sh delete     # full teardown
#
# Override defaults via env (see usage()).
#
# Why a dedicated capture project: gives the VM blast-radius isolation
# from the user's other GCP work. The `guard()` function refuses to
# operate on a few known-shared project names. **You** should NOT use
# this against a project that holds production stuff.

set -euo pipefail

# --- knobs (override via env) -----------------------------------------------

PROJECT="${PROJECT:-mobile-cc-capture}"
ZONE="${ZONE:-us-central1-a}"
INSTANCE="${INSTANCE:-mobile-cc-capture-vm}"
MACHINE_TYPE="${MACHINE_TYPE:-e2-medium}"
IMAGE_FAMILY="${IMAGE_FAMILY:-debian-12}"
IMAGE_PROJECT="${IMAGE_PROJECT:-debian-cloud}"
DISK_SIZE="${DISK_SIZE:-30GB}"

# Some systems install gcloud via snap; honour that path if the user has it.
GCLOUD="${GCLOUD:-$(command -v gcloud || command -v /snap/bin/gcloud)}"
if [ -z "$GCLOUD" ]; then
  echo "ERROR: gcloud not found in PATH (override via GCLOUD=/path)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
DEMOS_ROOT="$(cd "$HERE/.." && pwd)"
DIST_LOCAL="$DEMOS_ROOT/dist"

cmd="${1:-help}"; shift || true

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

usage() {
  cat <<EOF
Usage: $0 <command>

Lifecycle:
  create     create the VM + run bootstrap (first time only)
  bootstrap  re-run bootstrap on an existing VM (idempotent — safe)
  start      start a stopped VM
  stop       stop the VM (preserves disk, ~\$0/mo idle)
  delete     delete the VM (no recovery, ~\$0/mo after)
  status     print instance state (RUNNING / TERMINATED / NOT FOUND)

Work:
  capture    ssh in, run \`npm run capture\`, scp dist/ back to:
             $DIST_LOCAL
  ssh        gcloud compute ssh into the VM (interactive)

Env vars + defaults:
  PROJECT=$PROJECT
  ZONE=$ZONE
  INSTANCE=$INSTANCE
  MACHINE_TYPE=$MACHINE_TYPE
  IMAGE_FAMILY=$IMAGE_FAMILY  IMAGE_PROJECT=$IMAGE_PROJECT
  DISK_SIZE=$DISK_SIZE
  GCLOUD=$GCLOUD
EOF
}

# Refuses to operate on a project name that looks shared / production.
guard() {
  case "$PROJECT" in
    ttyview-demo|shira-*|langush*|""|production|prod-*)
      echo "ERROR: refusing to operate on PROJECT='$PROJECT'." >&2
      echo "       Use a dedicated capture project (default: mobile-cc-capture)." >&2
      exit 1
      ;;
  esac
}

cmd_create() {
  guard
  log "create $INSTANCE in $PROJECT/$ZONE ($MACHINE_TYPE, $IMAGE_FAMILY)"
  "$GCLOUD" compute instances create "$INSTANCE" \
    --project="$PROJECT" --zone="$ZONE" \
    --machine-type="$MACHINE_TYPE" \
    --image-family="$IMAGE_FAMILY" --image-project="$IMAGE_PROJECT" \
    --boot-disk-size="$DISK_SIZE" \
    --metadata=enable-oslogin=TRUE
  wait_for_ssh
  cmd_bootstrap
}

cmd_bootstrap() {
  guard
  log "scp bootstrap.sh + fixtures"
  "$GCLOUD" compute scp --recurse \
    "$HERE/bootstrap.sh" \
    "$INSTANCE:~/bootstrap.sh" \
    --project="$PROJECT" --zone="$ZONE"
  log "run bootstrap (3–5 min first time; faster on re-run)"
  "$GCLOUD" compute ssh "$INSTANCE" \
    --project="$PROJECT" --zone="$ZONE" \
    --command='bash ~/bootstrap.sh'
}

cmd_start() {
  guard
  state="$(_describe_state)"
  if [ "$state" = "RUNNING" ]; then
    log "$INSTANCE already RUNNING"
    return
  fi
  log "start $INSTANCE"
  "$GCLOUD" compute instances start "$INSTANCE" --project="$PROJECT" --zone="$ZONE"
  wait_for_ssh
}

cmd_stop() {
  guard
  state="$(_describe_state)"
  if [ "$state" = "TERMINATED" ]; then
    log "$INSTANCE already TERMINATED"
    return
  fi
  log "stop $INSTANCE"
  "$GCLOUD" compute instances stop "$INSTANCE" --project="$PROJECT" --zone="$ZONE"
}

cmd_delete() {
  guard
  log "DELETE $INSTANCE in $PROJECT — this is destructive."
  read -r -p "Type the instance name to confirm: " confirm
  if [ "$confirm" != "$INSTANCE" ]; then
    echo "abort (got: $confirm)"
    exit 1
  fi
  "$GCLOUD" compute instances delete "$INSTANCE" \
    --project="$PROJECT" --zone="$ZONE" --quiet
}

cmd_capture() {
  guard
  log "run capture on VM"
  "$GCLOUD" compute ssh "$INSTANCE" \
    --project="$PROJECT" --zone="$ZONE" --command='
      set -euo pipefail
      cd ~/mobile-cc-demos/demos
      TTV_PANE=$(cat ~/.demo-pane-id) \
      MOBILE_CC_URL=http://127.0.0.1:7800/ \
        npm run capture
    '
  log "scp dist/ back to dev machine"
  rm -rf "$DIST_LOCAL"
  mkdir -p "$DIST_LOCAL"
  "$GCLOUD" compute scp --recurse \
    "$INSTANCE:mobile-cc-demos/demos/dist/*" "$DIST_LOCAL/" \
    --project="$PROJECT" --zone="$ZONE"
  log "dist ready at $DIST_LOCAL"
  log "next: wrangler pages deploy $DIST_LOCAL --project-name mobile-cc-demos"
}

cmd_ssh() {
  guard
  exec "$GCLOUD" compute ssh "$INSTANCE" --project="$PROJECT" --zone="$ZONE"
}

cmd_status() {
  state="$(_describe_state)"
  echo "$INSTANCE / $PROJECT / $ZONE → $state"
}

# --- helpers --------------------------------------------------------------

_describe_state() {
  "$GCLOUD" compute instances describe "$INSTANCE" \
    --project="$PROJECT" --zone="$ZONE" \
    --format='value(status)' 2>/dev/null || echo "NOT_FOUND"
}

wait_for_ssh() {
  log "wait for SSH (up to 2 min)"
  for i in $(seq 1 24); do
    if "$GCLOUD" compute ssh "$INSTANCE" \
        --project="$PROJECT" --zone="$ZONE" \
        --command='echo ok' &>/dev/null; then
      log "SSH up"
      return
    fi
    sleep 5
  done
  echo "ERROR: SSH never came up after 2 min" >&2
  exit 1
}

case "$cmd" in
  create)    cmd_create ;;
  bootstrap) cmd_bootstrap ;;
  start)     cmd_start ;;
  stop)      cmd_stop ;;
  delete)    cmd_delete ;;
  capture)   cmd_capture ;;
  ssh)       cmd_ssh ;;
  status)    cmd_status ;;
  help|--help|-h) usage ;;
  *) echo "unknown command: $cmd" >&2; usage; exit 1 ;;
esac
