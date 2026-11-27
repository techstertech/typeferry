set shell := ['bash', '-euo', 'pipefail', '-c']

package_dir := 'typeferry-ts'

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

# Replay shared fixtures across all four backends using their native consumers.
verify-shared-fixtures:
    cd {{ package_dir }} && mise exec -- node "$(mise which npm)" run test:unit -- src/test/conformance/ejson-fixtures.unit.spec.ts
    cd {{ package_dir }} && mise exec -- node "$(mise which npm)" run test:integration -- src/test/conformance/http-fixtures.integration.spec.ts src/test/conformance/ws-fixtures.integration.spec.ts
    cd typeferry-py && .venv/bin/python -m pytest tests/conformance
    cd typeferry-rs && cargo test --locked -p typeferry-conformance
    cd typeferry-go && go test -count=1 ./ejson ./httptransport ./websocket ./redistransport

# Run the complete release verification and tarball package gate.
verify-release: install-npm-toolchain
    #!/usr/bin/env bash
    set -euo pipefail

    node_path="$(mise which node)"
    npm_path="$(mise which npm)"

    # Pin shebangs and nested npm commands as well as the parent interpreter.
    export PATH="$(dirname "$npm_path"):$(dirname "$node_path"):$PATH"

    test "$("$node_path" --version)" = "v24.19.0"
    test "$("$node_path" "$npm_path" --version)" = "11.17.0"

    cd {{ package_dir }}
    "$node_path" "$npm_path" ci --no-audit --no-fund
    "$node_path" "$npm_path" run lint
    "$node_path" "$npm_path" run typecheck
    ../scripts/run-with-mongodb.sh ../scripts/run-with-redis.sh "$node_path" "$npm_path" test
    "$node_path" "$npm_path" run build
    "$node_path" "$npm_path" run verify:consumer
    "$node_path" ../scripts/verify-release-package.mjs
