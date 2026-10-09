# TypeFerry Release Status

The TypeScript implementation is configured for operator-controlled publication to the public npm registry. Python, Rust, Ruby, and Go publication remains disabled until their registry identities and workflows are approved separately.

## Registry Identities

| Implementation | Registry identity             |  Version | Status                                   |
| -------------- | ----------------------------- | -------: | ---------------------------------------- |
| TypeScript     | `typeferry`                   | `0.13.1` | Published                    |
| Python         | `typeferry-py`                |  `0.2.0` | Temporary identity; publication disabled |
| Rust           | `typeferry` and `typeferry-*` |  `0.2.0` | Workspace publication disabled           |
| Ruby           | `typeferry-rb`                |  `0.1.0` | Temporary identity; publication disabled |
| Go             | `github.com/leonardoventurini/typeferry/typeferry-go` | Untagged | Approved API; local and remote parity passed; no release tag |

## Go candidate review

The candidate implements the shared server protocol and interoperates with the
unchanged TypeScript client. Its [parity specification](specs/2026-09-29-go-server-parity.md)
records full Go unit/race/vet and Redis verification, 25 focused client cases,
and the complete TypeScript package checks. The user approved the public Go API,
import path and pinned adapter dependencies on 2026-09-30. All four jobs in
[CI run 36806767551](https://github.com/leonardoventurini/typeferry/actions/runs/36806767551)
pass on `32480dd`, including Go/Redis race/vet and real TypeScript client
interoperability. The server parity implementation is accepted. No Go tag,
registry upload or automated Go publication workflow has been created.

Review the import path above and the package boundaries in this order:

1. `ejson` ordered values, custom codecs and numeric spelling; `protocol` envelopes.
2. `runtime` typed registration, context, methods/events, presence and close ownership.
3. `httptransport` and `websocket` application-owned `net/http` attachment.
4. Optional `redistransport` cluster delivery and `auth` JWT/session/cookie/OAuth helpers.
5. `authoring.Group` declaration helpers and the runnable `examples/server` integration.

Core imports do not require the optional adapters. WebSocket callbacks must
honor cancellation; transport retirement joins them before application services
close. Runtime retirement rejects new work and clears presence but keeps already
admitted application callbacks under their caller's lifetime.

Go uses pinned `github.com/coder/websocket` and `github.com/redis/go-redis/v9`
adapter dependencies. MongoDB live views, a Go client and extra OAuth providers
are outside the accepted shared server scope.

## TypeScript release

TypeFerry is published publicly on npm at `0.13.0` (verified against the
registry on 2026-10-02). This release adds exact hostname allowlists for development proxies and
route-specific HTTP body ceilings selected before chunked request buffering.
These are additive TypeScript application/transport APIs; the wire protocol and
other language implementations are unchanged. See the
[implementation specification](specs/2026-10-02-host-aware-proxy-and-http-body-ceilings.md).

Published npm release: `typeferry@0.13.0`.

The `0.13.0` release passed `just verify-npm-release`: immutable install,
lint/typecheck, 1,660 unit cases, 77 integration cases, 10 browser cases, build,
packed consumer smoke and archive validation (565 allowed files). Three explicit
opt-in Ruby interoperability cases were skipped. Separate audit reported zero
vulnerabilities. Final focused transport/proxy regressions passed after cleanup.
No dependency or cross-language protocol behavior changed.

The public registry records `gitHead`
`62cb276e038daf750501a1738fbcd9064ab5f94a`. All 565 downloaded registry tarball
files match the locally packed verified source build byte for byte, including
both new declaration APIs. Publication was performed by the operator. A
subsequent guarded publish attempt refused the already-published immutable
version; no duplicate upload or version change was attempted.

The repository template consumes the public release through `^0.8.0`; its
lockfile resolves the package tarball from the npm registry.

## TypeScript patch release

`typeferry@0.13.1` is published (registry verified on 2026-10-09). It corrects browser
wake recovery without changing public APIs, wire envelopes, dependencies or
server authentication policy. Healthy sockets survive timer gaps when existing
server traffic arrives during a bounded grace; overlapping wake events share
one recovery through initialization. Changed tokens still require a matching
handshake, and close cancels pending recovery work.

See [the implementation and acceptance evidence](specs/2026-10-02-browser-wake-recovery.md).
The complete `just verify-npm-release` gate passed: immutable install,
lint/typecheck, 1,687 unit cases, 77 integration cases, 10 browser cases, build,
packed consumer smoke and archive validation (565 allowed files). Three explicit
opt-in Ruby interoperability cases were skipped. Audit reported zero
vulnerabilities; the specification records existing non-blocking install warnings
and local verification limits. The registry confirms this patch release is published.

## TypeScript streaming release

`typeferry@0.14.0` adds explicit `RequestBodySizeLimit.bodyMode: "streaming"`.
Default/buffered routes preserve their rejection behavior. Streaming routes can
reject unauthorized unfinished uploads, consume byte-limited chunks with
backpressure and cancel native input. Request observers survive disconnects
before authentication starts reading. No wire protocol or declared dependency
range changes. The lock updates the existing source-map-js resolution to patched
`1.2.2`; audit reports zero vulnerabilities.

See the [approved contract and acceptance evidence](specs/2026-10-09-opt-in-streaming-http-bodies.md).
The producer release gate passes 1,703 unit, 77 integration and 10 browser checks,
with three explicit opt-in Ruby cases skipped, plus lint/types/build, a generic
packed consumer and archive validation. The package contains 568 allowed files.
No consumer tests or paths are included in producer release tooling.

The user owns manual publication due to registry authentication. The agent must
not publish this candidate. After the clean signed implementation is prepared,
the operator runs the existing `just publish-npm` command from the repository
root; its authentication, immutable-version and full verification guards remain.
The user published `0.14.0` manually. Registry `gitHead` matches signed producer
commit `8bbb7ca`, and both package checksums match the tested candidate. The
downstream consumer adopted the registry release in its manifest/lock and passed
its own focused upload checks, strict/full types, lint and build. Producer tooling
continues to verify only its generic packed consumer.

## npm Release Gate

Run from the repository root with Mise installed:

```sh
just verify-npm-release
```

The recipe automatically installs and selects the exact Node.js `24.19.0` and npm `11.17.0` toolchain pinned in [`.mise.toml`](.mise.toml). It then installs the locked graph, lints, typechecks, runs all split test suites, builds the package, executes `npm pack --dry-run --json`, and validates every tarball path. The artifact may contain only `README.md`, `package.json`, and compiled JavaScript, declarations, and source maps beneath `dist/`. Every explicit export target must exist; tests, source, configuration, credentials, and retired Lit output are rejected. Pack verification remains repeatable after a version is published.

The integration suite requires Redis. The release recipe uses `REDIS_URL` unchanged when it is set. Otherwise, it starts a temporary `redis:7-alpine` Docker container on a dynamically assigned loopback port, waits for readiness, and removes it after the tests. Keep Docker running for the automatic fallback, or provide a reachable external Redis URL.

CI runs the same package-artifact validator after its complete TypeScript gate.

## Publish to npm

Authenticate with npm using the account and two-factor/trusted-publishing policy appropriate to the package, then run from a clean `main` checkout:

```sh
npm login --registry=https://registry.npmjs.org/
just publish-npm
```

The recipe requires:

- automatic installation and selection of the exact Node/npm versions through Mise;
- a clean tracked and untracked worktree on `main`;
- successful `npm whoami` against the public registry;
- a newly selected package version in the manifest and lockfile, with that
  exact version absent from the registry;
- the complete non-uploading release gate.

Only after those checks does it execute `npm publish --access public`. The
recipe does not bump versions, create Git tags, push commits, or store
credentials. After npm confirms the upload, create the annotated Git tag
`v<version>` (for this patch, `v0.13.1`) and push the release commit and tag. No GitHub release is created.

An npm version cannot be reused after publication. If a release is incorrect, deprecate it as appropriate, fix the repository, choose a higher semantic version, and rerun the gate.

## Other Implementations

- `typeferry-py/pyproject.toml` retains a temporary distribution identity and has no publication workflow.
- `typeferry-rs/Cargo.toml` keeps workspace publication set to `false`.
- `typeferry-rb/` builds a local gem for verification but has no RubyGems publication workflow.
- `typeferry-go/` is an in-repository Go module under parity review. Its
  example and Go/TypeScript interoperability suites compile and run locally;
  no version tag or Go module release has been approved.
- No GitHub workflow uploads packages or contains registry credentials.

Enabling PyPI or crates.io publication requires a separate identity, authentication, dependency-order, migration, and rollout decision.
