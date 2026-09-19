#!/bin/bash
# Verifies write_through: by driving dist/main.cjs directly, without the real
# action wrapper -- see test-e2e.yml's test_sandbox_enforcement for the one
# case that does exercise the real action. Covers an existing path, a missing
# one (created with the parent's ownership, then given back only if the
# command left it empty), `/` on its own (which disables the read-only
# restriction entirely), and the deprecated writable: spelling.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/helpers.sh"

: "${BUILDCAGE_LOCAL_IMAGE_REF:?BUILDCAGE_LOCAL_IMAGE_REF must be set to the locally built proxy image}"

WORKDIR=$(mktemp -d)
# Outside every always-writable path ($GITHUB_WORKSPACE/$HOME/tmp/$RUNNER_TEMP),
# so writing under it proves write_through did something -- but runner-owned,
# so a directory created under it inherits an ownership the sandbox can use.
PARENT=/opt/buildcage-write-through-test
sudo -n mkdir -p "$PARENT"
sudo -n chown "$(id -u):$(id -g)" "$PARENT"
cleanup() {
  sudo -n rm -rf "$PARENT"
  rm -rf "$WORKDIR"
}
trap cleanup EXIT
touch "$WORKDIR/state.env" "$WORKDIR/summary.md"


GITHUB_WORKSPACE="$WORKDIR" \
GITHUB_STATE="$WORKDIR/state.env" \
GITHUB_STEP_SUMMARY="$WORKDIR/summary.md" \
BUILDCAGE_BUILD_TEST_HOOKS=1 \
BUILDCAGE_LOCAL_IMAGE_REF="$BUILDCAGE_LOCAL_IMAGE_REF" \
INPUT_WRITE_THROUGH="/opt
${PARENT}/created-kept
${PARENT}/created-empty" \
INPUT_RUN="touch /opt/.buildcage-writable-test
rm -f /opt/.buildcage-writable-test
echo built > ${PARENT}/created-kept/marker" \
  node dist/main.cjs
CODE=$?

echo ""
echo "=== Sandbox write_through: Assertions ==="
echo ""

if [ "$CODE" = "0" ]; then
  pass "listed paths were writable (existing /opt and a created directory)"
else
  fail "a listed path was not writable (exit $CODE)"
fi

if [ -f "${PARENT}/created-kept/marker" ]; then
  pass "a created directory the command wrote to is kept"
else
  fail "${PARENT}/created-kept/marker is missing"
fi

OWNER=$(stat -c '%u:%g' "${PARENT}/created-kept" 2>/dev/null)
if [ "$OWNER" = "$(id -u):$(id -g)" ]; then
  pass "the created directory inherited its parent's ownership"
else
  fail "expected owner $(id -u):$(id -g) on ${PARENT}/created-kept, got ${OWNER:-<none>}"
fi

if [ -e "${PARENT}/created-empty" ]; then
  fail "${PARENT}/created-empty was left behind despite being empty"
else
  pass "a created directory left empty is removed again"
fi

# `/` names the root of every mount there is, which leaves nothing for the
# read-only policy to apply to.
GITHUB_WORKSPACE="$WORKDIR" \
GITHUB_STATE="$WORKDIR/state.env" \
GITHUB_STEP_SUMMARY="$WORKDIR/summary.md" \
BUILDCAGE_BUILD_TEST_HOOKS=1 \
BUILDCAGE_LOCAL_IMAGE_REF="$BUILDCAGE_LOCAL_IMAGE_REF" \
INPUT_WRITE_THROUGH="/" \
INPUT_RUN="touch /opt/.buildcage-writable-test
rm -f /opt/.buildcage-writable-test" \
  node dist/main.cjs
ROOT_CODE=$?

if [ "$ROOT_CODE" = "0" ]; then
  pass "/ is fully writable when write_through: / is set"
else
  fail "/ was not fully writable when write_through: / is set (exit $ROOT_CODE)"
fi

# The pre-rename spelling has to keep working (see resolveWriteThroughInput).
GITHUB_WORKSPACE="$WORKDIR" \
GITHUB_STATE="$WORKDIR/state.env" \
GITHUB_STEP_SUMMARY="$WORKDIR/summary.md" \
BUILDCAGE_BUILD_TEST_HOOKS=1 \
BUILDCAGE_LOCAL_IMAGE_REF="$BUILDCAGE_LOCAL_IMAGE_REF" \
INPUT_WRITABLE="/opt" \
INPUT_RUN="touch /opt/.buildcage-writable-test
rm -f /opt/.buildcage-writable-test" \
  node dist/main.cjs
ALIAS_CODE=$?

if [ "$ALIAS_CODE" = "0" ]; then
  pass "the deprecated writable: spelling still works"
else
  fail "writable: no longer works as an alias (exit $ALIAS_CODE)"
fi

assert_results
