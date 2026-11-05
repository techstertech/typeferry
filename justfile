set shell := ['bash', '-euo', 'pipefail', '-c']

package_dir := 'typeferry-ts'
registry := 'https://registry.npmjs.org/'

# List repository-level release recipes.
default:
    @just --list --unsorted

# Install the exact Node.js and npm versions used by release recipes.
[private]
install-npm-toolchain:
    mise install

# Audit both independent npm lockfiles, including development dependencies.
audit-npm-dependencies:
    # Invoke npm through pinned Node; nested shells can select a host Node.
    cd {{ package_dir }} && mise exec -- node "$(mise which npm)" audit --audit-level=low
    cd template && mise exec -- node "$(mise which npm)" audit --audit-level=low

# Replay shared fixtures across all five backends using their native consumers.
verify-shared-fixtures:
    cd {{ package_dir }} && mise exec -- node "$(mise which npm)" run test:unit -- src/test/conformance/ejson-fixtures.unit.spec.ts
    cd {{ package_dir }} && mise exec -- node "$(mise which npm)" run test:integration -- src/test/conformance/http-fixtures.integration.spec.ts src/test/conformance/ws-fixtures.integration.spec.ts
    cd typeferry-py && .venv/bin/python -m pytest tests/conformance
    cd typeferry-rs && cargo test --locked -p typeferry-conformance
    cd typeferry-rb && mise exec -- ruby "$(mise which bundle)" exec "$(mise which ruby)" -S rake test:conformance
    cd typeferry-go && go test ./ejson ./httptransport ./websocket ./redistransport

# Run the complete non-uploading npm release and artifact gate.
verify-npm-release: install-npm-toolchain
    test "$(mise exec -- node --version)" = "v24.19.0"
    test "$(mise exec -- npm --version)" = "11.17.0"
    cd {{ package_dir }} && mise exec -- npm ci --no-audit --no-fund
    cd {{ package_dir }} && mise exec -- npm run lint
    cd {{ package_dir }} && mise exec -- npm run typecheck
    cd {{ package_dir }} && ../scripts/run-with-mongodb.sh ../scripts/run-with-redis.sh mise exec -- npm test
    cd {{ package_dir }} && mise exec -- npm run build
    cd {{ package_dir }} && mise exec -- npm run verify:consumer
    mise exec -- node scripts/verify-npm-package.mjs

# Validate irreversible publish preconditions before running the longer gate.
[private]
assert-npm-publish-state: install-npm-toolchain
    test "$(git symbolic-ref --quiet HEAD)" = "refs/heads/main"
    git diff --quiet
    git diff --cached --quiet
    test -z "$(git status --porcelain)"
    mise exec -- npm whoami --registry={{ registry }} >/dev/null
    mise exec -- node scripts/verify-npm-package.mjs --check-version-available

# Publish the verified TypeScript package to the public npm registry.
publish-npm: assert-npm-publish-state verify-npm-release
    cd {{ package_dir }} && mise exec -- npm publish --access public --registry={{ registry }}
