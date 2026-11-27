"""Repository-level contracts for the clean TypeFerry rebrand."""

from __future__ import annotations

import json
import re
import subprocess
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
LEGACY_BRAND = "bi" + "frost"
PUBLIC_TYPESCRIPT_NAME = "typeferry"
PUBLIC_TYPESCRIPT_RANGE = "^0.8.0"
TEMPORARY_PYTHON_NAME = "typeferry-py"


class TypeFerryRebrandTest(unittest.TestCase):
    def test_tracked_paths_and_text_exclude_legacy_brand(self) -> None:
        tracked_paths = _git("ls-files").splitlines()
        legacy_paths = [path for path in tracked_paths if LEGACY_BRAND in path.lower()]

        self.assertEqual([], legacy_paths)

        search = subprocess.run(
            ["git", "grep", "-I", "-i", "--", LEGACY_BRAND],
            cwd=REPO_ROOT,
            capture_output=True,
            check=False,
            text=True,
        )
        self.assertEqual(1, search.returncode, search.stdout)
        self.assertEqual("", search.stdout)

    def test_typescript_package_guards_against_npm_publication_while_other_packages_are_guarded(
        self,
    ) -> None:
        package_json = json.loads(
            (REPO_ROOT / "typeferry-ts/package.json").read_text(encoding="utf-8")
        )
        self.assertEqual(PUBLIC_TYPESCRIPT_NAME, package_json["name"])
        self.assertEqual(">=24.19.0 <27", package_json["engines"]["node"])
        self.assertIs(True, package_json.get("private"))
        self.assertNotIn("publishConfig", package_json)
        self.assertEqual(
            "git+https://github.com/techstertech/typeferry.git",
            package_json["repository"]["url"],
        )

        pyproject = tomllib.loads(
            (REPO_ROOT / "typeferry-py/pyproject.toml").read_text(encoding="utf-8")
        )
        self.assertEqual(TEMPORARY_PYTHON_NAME, pyproject["project"]["name"])

        cargo = tomllib.loads(
            (REPO_ROOT / "typeferry-rs/Cargo.toml").read_text(encoding="utf-8")
        )
        self.assertIs(False, cargo["workspace"]["package"]["publish"])

    def test_npm_publish_workflows_are_absent(self) -> None:
        workflows = REPO_ROOT / ".github/workflows"
        publish_workflows = sorted(workflows.glob("publish-*.yml"))

        self.assertEqual([], publish_workflows)
        self.assertFalse((workflows / "release-bump.yml").exists())
        self.assertTrue((workflows / "release.yml").is_file())

        for workflow_file in sorted(workflows.glob("*.yml")):
            workflow_text = workflow_file.read_text(encoding="utf-8")
            self.assertNotIn("npm publish", workflow_text)
            self.assertNotIn("publish-ts:", workflow_text)

    def test_protocol_v2_uses_typeferry_wire_identifiers(self) -> None:
        protocol = (REPO_ROOT / "PROTOCOL.md").read_text(encoding="utf-8")

        self.assertIn("**Version:** 2", protocol)
        self.assertIn("`/typeferry-ws`", protocol)
        self.assertIn("`typeferry:servers`", protocol)

    def test_template_uses_published_package(self) -> None:
        package_json = json.loads(
            (REPO_ROOT / "template/package.json").read_text(encoding="utf-8")
        )
        package_lock = json.loads(
            (REPO_ROOT / "template/package-lock.json").read_text(encoding="utf-8")
        )
        tarball_url = package_json["dependencies"][PUBLIC_TYPESCRIPT_NAME]

        self.assertRegex(
            tarball_url,
            r"^https://github\.com/techstertech/typeferry/releases/download/v\d+\.\d+\.\d+/typeferry-\d+\.\d+\.\d+\.tgz$",
        )
        installed = package_lock["packages"]["node_modules/typeferry"]
        self.assertEqual(tarball_url, installed["resolved"])
        self.assertFalse(installed["resolved"].startswith("https://registry.npmjs.org/"))
        self.assertTrue(str(installed["integrity"]).startswith("sha512-"))

def _git(*arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments],
        cwd=REPO_ROOT,
        capture_output=True,
        check=True,
        text=True,
    )
    return result.stdout


if __name__ == "__main__":
    unittest.main()
