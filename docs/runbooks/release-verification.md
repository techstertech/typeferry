# Release Verification Runbook

This runbook verifies release readiness; it does not authorize publication. Read [`RELEASING.md`](../../RELEASING.md) first because package publication remains disabled until registry identities and migration decisions are approved.

## Preconditions

- Confirm the target package and intended version.
- Confirm the worktree is clean and the release commit is identified.
- Confirm publication is authorized separately; verification alone must not change `private`, `publish`, registry, or workflow guards.
- Use clean, immutable dependency installation where the ecosystem supports it.

## TypeScript release surface

The repository-level release gate installs and selects Node.js `24.19.0` and npm `11.17.0` from the root `.mise.toml` before running package commands:

```sh
just verify-npm-release
```

The recipe resolves Node and npm paths before changing `PATH`. It invokes npm
through the selected Node interpreter. Child commands receive the selected npm
directory before the Node directory. This avoids host runtime selection through
script shebangs and Node's bundled npm wrapper.

The integration suite requires Redis. When `REDIS_URL` is set, the release gate
uses that service unchanged. Otherwise, it starts `redis:7-alpine` with Docker,
publishes Redis on a dynamically assigned `127.0.0.1` port, waits for readiness,
and removes the container after the tests. Docker must therefore be running when
an external Redis URL is not supplied.

To execute individual checks, first enter the pinned environment from the repository root, then run them from `typeferry-ts/`:

```sh
mise install
cd typeferry-ts
mise exec -- npm ci
mise exec -- npm audit --audit-level=low
mise exec -- npm run lint
mise exec -- npm run typecheck
mise exec -- npm test
mise exec -- npm run build
mise exec -- npm pack --dry-run
```

Inspect the dry-run archive list. It should expose built ESM and declarations through `dist/`, contain the intended license and metadata, and require no aliases into `src/`.

## Python release surface

From `typeferry-py/` in a clean environment:

```sh
python -m pip install -e '.[dev,all]'
python -m pytest
ruff check .
mypy
python -m build
```

Inspect the wheel and source distribution names and contents. Building requires the `build` frontend to be available in the verification environment.

## Rust release surface

From `typeferry-rs/`:

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo package --workspace --allow-dirty
```

The packaging command is expected to remain blocked or unsuitable while workspace publication is disabled. Treat that result as confirmation of the current guard, not permission to remove it.

## Cross-language gate

Protocol-facing releases also run shared fixture and cross-language commands from the [protocol-change runbook](protocol-changes.md). Confirm `PROTOCOL.md`, fixtures, and implementation versions describe the same behavior.

## Repository boundary

This runbook validates only tests and artifacts owned by TypeFerry. Never add a
consumer checkout path or invoke another repository's test suite here.
Downstream projects own their compatibility validation and may install the
packed TypeFerry artifact from their own release workflow.

## Acceptance criteria

- All executed checks and environmental limitations are reported separately.
- Package metadata, license, exports, and archive contents are intentional.
- No source alias, private registry credential, generated secret, or untracked release input is required.
- Publication guards remain unchanged unless a separately approved release-enablement decision modifies them.
- The release commit and artifact checksums are recorded before any authorized publication.

## Recovery

Do not publish a partially verified artifact. Fix the release surface in a normal commit and repeat verification from a clean checkout. If an artifact was published incorrectly, follow the registry's supported deprecation or yanking process rather than silently replacing immutable content.
