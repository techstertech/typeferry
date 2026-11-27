"""Contract tests for the GitHub Release workflow and package verification."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[1]
REDIS_HELPER = ROOT / "scripts" / "run-with-redis.sh"
MONGODB_HELPER = ROOT / "scripts" / "run-with-mongodb.sh"
RELEASE_WORKFLOW = ROOT / ".github" / "workflows" / "release.yml"


def test_root_justfile_has_safe_release_recipes() -> None:
    justfile = (ROOT / "justfile").read_text(encoding="utf-8")
    mise_config = (ROOT / ".mise.toml").read_text(encoding="utf-8")

    assert 'node = "24.19.0"' in mise_config
    assert 'npm = "11.17.0"' in mise_config
    assert "install-npm-toolchain:" in justfile
    assert "mise install" in justfile
    assert "verify-release:" in justfile
    assert "verify-release: install-npm-toolchain" in justfile
    assert '"$node_path" "$npm_path" ci --no-audit --no-fund' in justfile
    assert '"$node_path" ../scripts/verify-release-package.mjs' in justfile
    assert (
        'scripts/run-with-mongodb.sh ../scripts/run-with-redis.sh "$node_path" "$npm_path" test'
    ) in justfile

    assert "publish-npm" not in justfile
    assert "assert-npm-publish-state" not in justfile
    assert "npm publish" not in justfile
    assert "npm whoami" not in justfile
    assert "registry.npmjs.org" not in justfile


def test_release_workflow_publishes_verified_github_tarball() -> None:
    assert RELEASE_WORKFLOW.is_file()
    workflow_text = RELEASE_WORKFLOW.read_text(encoding="utf-8")
    workflow = yaml.load(workflow_text, Loader=yaml.BaseLoader)
    assert isinstance(workflow, dict)

    assert workflow["permissions"] == {"contents": "read"}

    triggers = workflow["on"]
    assert isinstance(triggers, dict)
    assert "pull_request" not in triggers
    push = triggers["push"]
    assert isinstance(push, dict)
    assert push["tags"] == ["v*"]

    concurrency = workflow["concurrency"]
    assert isinstance(concurrency, dict)
    assert concurrency["cancel-in-progress"] == "false"

    assert "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6" in workflow_text
    assert "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7" in workflow_text
    assert "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16 # v6" in workflow_text
    assert "actions/cache@caa296126883cff596d87d8935842f9db880ef25 # v5" in workflow_text

    jobs = workflow["jobs"]
    assert isinstance(jobs, dict)
    release_job = jobs["release"]
    assert isinstance(release_job, dict)
    assert release_job["permissions"] == {"contents": "write"}

    steps = release_job["steps"]
    assert isinstance(steps, list)
    step_names = {
        step["name"]
        for step in steps
        if isinstance(step, dict) and "name" in step
    }
    assert {
        "Pin npm",
        "Verify toolchain",
        "Verify tag matches package version",
        "Security audit",
        "Lint",
        "TypeScript",
        "Unit tests",
        "Start integration services",
        "Integration tests",
        "Stop integration services",
        "Browser tests",
        "Build",
        "Verify packed consumer",
        "Verify release package",
        "Pack release tarball",
        "Publish GitHub Release",
    } <= step_names

    assert "verify-release-package.mjs" in workflow_text
    assert "npm pack" in workflow_text
    assert "gh release create" in workflow_text
    assert "npm publish" not in workflow_text
    assert "registry.npmjs.org" not in workflow_text


def test_application_consumer_install_skips_implicit_network_checks() -> None:
    consumer_verifier = (
        ROOT / "scripts" / "verify-application-consumer.mjs"
    ).read_text(encoding="utf-8")

    assert "['install', '--no-audit', '--no-fund']" in consumer_verifier


def test_mongodb_helper_preserves_an_external_uri(tmp_path: Path) -> None:
    docker_log = tmp_path / "docker.log"
    fake_docker = tmp_path / "docker"
    fake_docker.write_text(
        f'#!/usr/bin/env bash\necho "$*" >> "{docker_log}"\nexit 99\n',
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)
    expected_uri = "mongodb://mongo.example.test:27017"
    environment = {
        **os.environ,
        "PATH": f"{tmp_path}:{os.environ['PATH']}",
        "TYPEFERRY_MONGODB_TEST_URI": expected_uri,
    }

    result = subprocess.run(
        [
            MONGODB_HELPER,
            "bash",
            "-c",
            f'test "$TYPEFERRY_MONGODB_TEST_URI" = "{expected_uri}"',
        ],
        cwd=ROOT,
        env=environment,
        check=False,
    )

    assert result.returncode == 0
    assert not docker_log.exists()


def test_redis_helper_preserves_an_external_redis_url(tmp_path: Path) -> None:
    docker_log = tmp_path / "docker.log"
    fake_docker = tmp_path / "docker"
    fake_docker.write_text(
        f'#!/usr/bin/env bash\necho "$*" >> "{docker_log}"\nexit 99\n',
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)
    expected_url = "redis://redis.example.test:16379"
    environment = {
        **os.environ,
        "PATH": f"{tmp_path}:{os.environ['PATH']}",
        "REDIS_URL": expected_url,
    }

    result = subprocess.run(
        [REDIS_HELPER, "bash", "-c", f'test "$REDIS_URL" = "{expected_url}"'],
        cwd=ROOT,
        env=environment,
        check=False,
    )

    assert result.returncode == 0
    assert not docker_log.exists()


def test_redis_helper_cleans_up_after_child_failure(tmp_path: Path) -> None:
    docker_log = tmp_path / "docker.log"
    fake_docker = tmp_path / "docker"
    fake_docker.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  run) printf '%s\\n' 'temporary-redis-id' ;;
  port) printf '%s\\n' '127.0.0.1:49153' ;;
  exec) printf '%s\\n' 'PONG' ;;
  stop) ;;
  *) exit 98 ;;
esac
""",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)
    environment = {
        key: value for key, value in os.environ.items() if key != "REDIS_URL"
    }
    environment.update(
        {
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "DOCKER_LOG": str(docker_log),
        }
    )

    result = subprocess.run(
        [
            REDIS_HELPER,
            "bash",
            "-c",
            'test "$REDIS_URL" = "redis://127.0.0.1:49153" && exit 23',
        ],
        cwd=ROOT,
        env=environment,
        check=False,
    )

    assert result.returncode == 23
    docker_calls = docker_log.read_text(encoding="utf-8").splitlines()
    assert docker_calls == [
        (
            "run --detach --rm --label typeferry.purpose=release-verification "
            "--publish 127.0.0.1::6379 redis:7-alpine"
        ),
        "port temporary-redis-id 6379/tcp",
        "exec temporary-redis-id redis-cli ping",
        "stop temporary-redis-id",
    ]


def test_redis_helper_cleans_up_after_interrupt(tmp_path: Path) -> None:
    docker_log = tmp_path / "docker.log"
    fake_docker = tmp_path / "docker"
    fake_docker.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_LOG"
case "$1" in
  run) printf '%s\n' 'temporary-redis-id' ;;
  port) printf '%s\n' '127.0.0.1:49153' ;;
  exec) printf '%s\n' 'PONG' ;;
  stop) ;;
  *) exit 98 ;;
esac
""",
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)
    environment = {
        key: value for key, value in os.environ.items() if key != "REDIS_URL"
    }
    environment.update(
        {
            "PATH": f"{tmp_path}:{os.environ['PATH']}",
            "DOCKER_LOG": str(docker_log),
        }
    )

    result = subprocess.run(
        [REDIS_HELPER, "bash", "-c", 'kill -TERM "$PPID"'],
        cwd=ROOT,
        env=environment,
        check=False,
    )

    assert result.returncode == 143
    assert docker_log.read_text(encoding="utf-8").splitlines()[-1] == (
        "stop temporary-redis-id"
    )


@pytest.mark.parametrize(
    ("mutation", "expected_error"),
    [
        (None, None),
        ("not-private", "package must be marked private"),
        ("has-publish-config", "publishConfig must not be configured"),
        ("missing-export", "export target is missing"),
        ("unexpected-file", "unexpected package file"),
        ("wrong-version", "package report version must match the manifest"),
    ],
)
def test_package_validator_checks_the_actual_pack_report(
    tmp_path: Path, mutation: str | None, expected_error: str | None
) -> None:
    """Exercise the shipped validator without publishing or contacting npm."""
    script = tmp_path / "scripts/verify-release-package.mjs"
    package = tmp_path / "typeferry-ts"
    binaries = tmp_path / "bin"

    script.parent.mkdir()
    binaries.mkdir()
    shutil.copyfile(ROOT / "scripts/verify-release-package.mjs", script)

    manifest: dict[str, object] = json.loads(
        (ROOT / "typeferry-ts/package.json").read_text(encoding="utf-8")
    )
    manifest["exports"] = {"./client": "./dist/client/index.js"}
    package.mkdir()
    (package / "package.json").write_text(json.dumps(manifest), encoding="utf-8")

    files = [
        "README.md",
        "package.json",
        "dist/minimongo/NOTICE.md",
        "dist/minimongo/README.md",
    ]
    for module in ("client/index", "cli/index"):
        source = package / f"src/{module}.ts"
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text("export {}\n", encoding="utf-8")
        files.extend(f"dist/{module}.{suffix}" for suffix in ("js", "d.ts", "js.map"))

    report_files = [{"path": name} for name in files]
    report_version = manifest["version"]

    if mutation == "not-private":
        manifest.pop("private", None)
        (package / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
    elif mutation == "has-publish-config":
        manifest["publishConfig"] = {
            "access": "public",
            "registry": "https://registry.npmjs.org/",
        }
        (package / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
    elif mutation == "missing-export":
        manifest["exports"] = {"./client": "./dist/missing.js"}
        (package / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
    elif mutation == "unexpected-file":
        report_files.append({"path": "dist/secret.json"})
    elif mutation == "wrong-version":
        report_version = f"{manifest['version']}-mismatch"

    report = {
        "name": manifest["name"],
        "version": report_version,
        "size": 100,
        "files": report_files,
    }

    report_path = tmp_path / "report.json"
    call_path = tmp_path / "npm-call.json"
    report_path.write_text(json.dumps([report]), encoding="utf-8")
    fake_npm = binaries / "npm"
    fake_npm.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "Path(os.environ['TYPEFERRY_TEST_NPM_CALL']).write_text(json.dumps(sys.argv[1:]))\n"
        "print(Path(os.environ['TYPEFERRY_TEST_NPM_REPORT']).read_text())\n",
        encoding="utf-8",
    )
    fake_npm.chmod(0o755)

    selected_node = subprocess.run(
        ["mise", "exec", "--", "node", "-p", "process.execPath"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    result = subprocess.run(
        [selected_node, script],
        env={
            **os.environ,
            "PATH": f"{binaries}:{os.environ['PATH']}",
            "TYPEFERRY_TEST_NPM_CALL": str(call_path),
            "TYPEFERRY_TEST_NPM_REPORT": str(report_path),
        },
        check=False,
        capture_output=True,
        text=True,
        timeout=15,
    )

    if mutation in {"not-private", "has-publish-config"}:
        assert not call_path.exists()
    else:
        assert json.loads(call_path.read_text(encoding="utf-8")) == [
            "pack",
            "--dry-run",
            "--json",
        ]
    if expected_error is None:
        assert result.returncode == 0, result.stderr
        assert f"Verified typeferry@{manifest['version']}" in result.stdout
    else:
        assert result.returncode != 0
        assert expected_error in result.stderr


def test_package_manifest_and_lock_guard_against_npm_publication() -> None:
    manifest = json.loads(
        (ROOT / "typeferry-ts/package.json").read_text(encoding="utf-8")
    )
    package_lock = json.loads(
        (ROOT / "typeferry-ts/package-lock.json").read_text(encoding="utf-8")
    )

    assert manifest["name"] == "typeferry"
    assert manifest["private"] is True
    assert "publishConfig" not in manifest
    assert (
        manifest["repository"]["url"]
        == "git+https://github.com/techstertech/typeferry.git"
    )
    assert package_lock["name"] == "typeferry"
    assert package_lock["version"] == manifest["version"]
    assert package_lock["packages"][""]["name"] == "typeferry"
    assert package_lock["packages"][""]["version"] == manifest["version"]
    assert package_lock["packages"][""]["engines"] == manifest["engines"]


def test_active_code_has_no_temporary_package_imports() -> None:
    roots = [
        ROOT / "typeferry-ts/src",
        ROOT / "template/client",
        ROOT / "template/server",
    ]
    stale_files: list[str] = []

    for source_root in roots:
        for source_file in source_root.rglob("*"):
            if not source_file.is_file() or source_file.suffix not in {".ts", ".tsx"}:
                continue
            if "typeferry-ts/" in source_file.read_text(encoding="utf-8"):
                stale_files.append(str(source_file.relative_to(ROOT)))

    assert stale_files == []
