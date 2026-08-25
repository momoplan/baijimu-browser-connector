#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <version> <connector-manifest> <artifact-url> <artifact-sha256>" >&2
  exit 2
fi

version="$1"
connector_manifest_path="$2"
artifact_url="$3"
artifact_sha256="$4"
status_file="${MARKET_PUBLICATION_STATUS_FILE:-$PWD/.local-app-publication-status}"

for name in LOCAL_APP_MARKET_PUBLISH_TOKEN LOCAL_APP_OWNER_WORKSPACE_ID BAIJIMU_CLI; do
  test -n "${!name:-}" || { echo "$name is required" >&2; exit 2; }
done
test -x "$BAIJIMU_CLI"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$artifact_url" == https://* ]]
[[ "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]]
[[ "$LOCAL_APP_OWNER_WORKSPACE_ID" =~ ^[1-9][0-9]*$ ]]

connector_manifest="$(jq -ce --arg version "$version" '
  select(.schemaVersion == "3.0.0")
  | select(.version == $version)
  | select(.appId | type == "string" and length > 0)
  | select(.source.type == "github")
  | select(.source.revision == ("v" + $version))
  | select(.hostRequirements.minimumVersion == "0.6.0")
  | select((.hostRequirements.capabilities // []) | index("connector.process.host-managed.v1") != null)
' "$connector_manifest_path")"
app_id="$(printf '%s' "$connector_manifest" | jq -er .appId)"
source_repo="$(printf '%s' "$connector_manifest" | jq -er .source.repo)"

market_manifest="$(jq -nc \
  --argjson connector "$connector_manifest" \
  --arg source "$artifact_url" \
  --arg checksum "sha256:$artifact_sha256" '
  $connector + {
    applicationType: "connector",
    artifacts: [
      {platform:"macos",arch:"universal",source:$source,checksum:$checksum},
      {platform:"windows",arch:"x86_64",source:$source,checksum:$checksum},
      {platform:"linux",arch:"x86_64",source:$source,checksum:$checksum}
    ]
  }')"
capabilities="$(printf '%s' "$connector_manifest" | jq -c '[.remoteCapabilities[]?.name]')"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/browser-connector-market.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
curl -fsSL --retry 6 --retry-all-errors --connect-timeout 15 --max-time 900 "$artifact_url" -o "$work_dir/artifact.zip"
test "$(sha256sum "$work_dir/artifact.zip" | awk '{print $1}')" = "$artifact_sha256"

jq -n \
  --arg version "$version" \
  --arg source "$artifact_url" \
  --arg repo "$source_repo" \
  --arg revision "v$version" \
  --arg checksum "$artifact_sha256" \
  --argjson capabilities "$capabilities" \
  --argjson manifest "$market_manifest" \
  '{version:$version,sourceType:"https",source:$source,repo:$repo,revision:$revision,checksum:$checksum,capabilities:$capabilities,manifest:$manifest}' \
  > "$work_dir/version.json"

auth_file="$work_dir/baijimu-auth.json"
BAIJIMU_AUTH_FILE="$auth_file" "$BAIJIMU_CLI" auth login \
  --token "$LOCAL_APP_MARKET_PUBLISH_TOKEN" \
  --workspace-id "$LOCAL_APP_OWNER_WORKSPACE_ID" \
  --no-browser --json >/dev/null

app_json="$(BAIJIMU_AUTH_FILE="$auth_file" "$BAIJIMU_CLI" local-app get "$app_id" --json)"
printf '%s' "$app_json" | jq -e \
  --arg appId "$app_id" \
  --argjson ownerWorkspaceId "$LOCAL_APP_OWNER_WORKSPACE_ID" '
  (.data // .).appId == $appId and (.data // .).ownerWorkspaceId == $ownerWorkspaceId' >/dev/null

existing="$(printf '%s' "$app_json" | jq -c --arg version "$version" 'first((.data // .).versions[]? | select(.version == $version)) // empty')"
if [ -n "$existing" ]; then
  printf '%s' "$existing" | jq -e \
    --arg source "$artifact_url" \
    --arg repo "$source_repo" \
    --arg revision "v$version" \
    --arg checksum "$artifact_sha256" \
    --argjson manifest "$market_manifest" '
    .source == $source and .repo == $repo and .revision == $revision and .checksum == $checksum and .manifest == $manifest' >/dev/null
else
  BAIJIMU_AUTH_FILE="$auth_file" "$BAIJIMU_CLI" local-app version create "$app_id" \
    --data "@$work_dir/version.json" --json | jq -e '.errorCode == "0"' >/dev/null
fi

read_publication() {
  BAIJIMU_AUTH_FILE="$auth_file" "$BAIJIMU_CLI" local-app publications --json \
    | jq -c --arg appId "$app_id" --arg version "$version" \
      'first((.data // .)[]? | select(.appId == $appId and .version == $version)) // empty'
}

status="$(read_publication | jq -r '.status // empty')"
case "$status" in
  PENDING_REVIEW|PUBLISHED) ;;
  "")
    BAIJIMU_AUTH_FILE="$auth_file" "$BAIJIMU_CLI" local-app submit "$app_id" "$version" --json \
      | jq -e '.errorCode == "0"' >/dev/null
    ;;
  *) echo "market publication is not retryable: $status" >&2; exit 1 ;;
esac

for _ in $(seq 1 20); do
  status="$(read_publication | jq -r '.status // empty')"
  case "$status" in
    PENDING_REVIEW|PUBLISHED)
      printf '%s\n' "$status" > "$status_file"
      echo "submitted $app_id $version; status=$status"
      exit 0
      ;;
  esac
  sleep 3
done
echo "market publication status did not become visible before timeout" >&2
exit 1
