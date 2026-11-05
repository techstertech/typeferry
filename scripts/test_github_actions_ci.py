from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "ci.yml"
FORGEJO_WORKFLOW = ROOT / ".forgejo" / "workflows" / "ci.yml"


def load_workflow() -> dict[str, object]:
    with WORKFLOW.open(encoding="utf-8") as workflow_file:
        loaded = yaml.load(workflow_file, Loader=yaml.BaseLoader)

    assert isinstance(loaded, dict)
    return loaded


def test_workflow_is_github_native() -> None:
    assert WORKFLOW.is_file()
    assert not FORGEJO_WORKFLOW.exists()

    content = WORKFLOW.read_text(encoding="utf-8")
    assert "forgejo" not in content.casefold()
    assert "data.forgejo.org" not in content
    assert "${{ github.ref }}" in content
    assert "actions/checkout@v6" in content
    assert "actions/setup-node@v7" in content
    assert "actions/cache@v5" in content


def test_workflow_preserves_ci_contract() -> None:
    workflow = load_workflow()
    assert workflow["permissions"] == {"contents": "read"}

    triggers = workflow["on"]
    assert isinstance(triggers, dict)
    push = triggers["push"]
    assert isinstance(push, dict)
    assert push["branches"] == ["main"]

    required_paths = {
        "typeferry-ts/**",
        "typeferry-rb/**",
        "typeferry-go/**",
        "docs/conformance/**",
        "PROTOCOL.md",
        ".github/workflows/ci.yml",
        "scripts/verify-npm-package.mjs",
    }
    for event in ("push", "pull_request"):
        trigger = triggers[event]
        assert isinstance(trigger, dict)
        paths = trigger["paths"]
        assert isinstance(paths, list)
        assert required_paths <= set(paths)

    jobs = workflow["jobs"]
    assert isinstance(jobs, dict)
    ci_job = jobs["ci-ts"]
    assert isinstance(ci_job, dict)
    assert ci_job["runs-on"] == "ubuntu-24.04"
    assert ci_job["timeout-minutes"] == "35"

    steps = ci_job["steps"]
    assert isinstance(steps, list)
    step_names = {
        step["name"]
        for step in steps
        if isinstance(step, dict) and "name" in step
    }
    assert {
        "Pin npm",
        "Verify toolchain",
        "Security audit",
        "Lint",
        "TypeScript",
        "Unit tests",
        "Start integration services",
        "Integration tests",
        "Stop integration services",
        "Browser tests",
        "Build",
        "Verify npm package",
    } <= step_names

    workflow_text = WORKFLOW.read_text(encoding="utf-8")
    assert "verify-npm-package.mjs" in workflow_text
