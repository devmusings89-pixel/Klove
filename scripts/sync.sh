#!/usr/bin/env bash
#
# Build-gated GitHub sync.
# Builds the backend + iOS app; ONLY if everything is green does it commit all local
# changes and push to origin. A red build never reaches GitHub.
#
#   ./scripts/sync.sh                 # auto commit message
#   ./scripts/sync.sh "your message"  # custom commit message
#   ./scripts/sync.sh --watch         # rebuild+sync automatically whenever files change
#
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

GREEN='\033[0;32m'; RED='\033[0;31m'; DIM='\033[2m'; NC='\033[0m'
say()  { printf "${DIM}▶ %s${NC}\n" "$1"; }
ok()   { printf "${GREEN}✓ %s${NC}\n" "$1"; }
fail() { printf "${RED}✗ %s${NC}\n" "$1"; }

build() {
  # 1) Backend typecheck (no DB needed).
  say "Backend typecheck…"
  if ! ( cd backend && npm run --silent typecheck ); then fail "Backend typecheck failed — not syncing."; return 1; fi

  # 2) Backend tests run INFORMATIONALLY only — they need a live DB, so a failure here
  #    (e.g. DB down / creds wrong) must NOT block syncing compiling code. Set SYNC_RUN_TESTS=1
  #    to see them; they never gate the push.
  if [ "${SYNC_RUN_TESTS:-0}" = "1" ] && grep -qE '^DATABASE_URL=.+' backend/.env 2>/dev/null; then
    say "Backend tests (informational)…"
    ( cd backend && npm test --silent ) && ok "Tests passed." || fail "Tests failed (not blocking sync)."
  fi

  # 3) iOS build (regenerate the xcodeproj first — it's gitignored/generated).
  if command -v xcodegen >/dev/null 2>&1; then ( cd ios && xcodegen generate >/dev/null ); fi
  say "iOS build…"
  if ! DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcodebuild \
        -project ios/Klove.xcodeproj -scheme Klove \
        -destination 'platform=iOS Simulator,name=iPhone 17' -quiet build; then
    fail "iOS build failed — not syncing."; return 1
  fi
  ok "Build green."
}

sync_once() {
  if [ -z "$(git status --porcelain)" ]; then ok "Working tree clean — nothing to sync."; return 0; fi
  build || return 1
  local msg="${1:-chore: sync $(date '+%Y-%m-%d %H:%M:%S')}"
  git add -A
  git commit -q -m "$msg" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
  say "Pushing to origin…"
  if git push -q; then ok "Synced to GitHub: $(git rev-parse --short HEAD)  ($msg)"; else fail "Push failed (auth/remote?)."; return 1; fi
}

if [ "${1:-}" = "--watch" ]; then
  command -v fswatch >/dev/null 2>&1 || { fail "Watch mode needs fswatch:  brew install fswatch"; exit 1; }
  ok "Watching for changes (Ctrl-C to stop). Builds + syncs on save."
  sync_once "chore: sync $(date '+%Y-%m-%d %H:%M:%S')" || true
  # Debounce: collect changes, then sync. Ignore generated/vendored paths.
  fswatch -o -l 2 \
    --exclude '/\.git/' --exclude 'node_modules' --exclude '/ios/build/' \
    --exclude 'DerivedData' --exclude '\.uploads/' --exclude '/dist/' \
    backend/src backend/prisma ios/Klove ios/project.yml | while read -r _; do
    printf "\n"; say "Change detected…"
    sync_once || true
  done
else
  sync_once "${1:-}"
fi
