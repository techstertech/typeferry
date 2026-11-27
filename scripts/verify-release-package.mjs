import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXPECTED_NAME = "typeferry";
const REPOSITORY_URL = "git+https://github.com/techstertech/typeferry.git";
const HOMEPAGE_URL = "https://github.com/techstertech/typeferry#readme";
const BUGS_URL = "https://github.com/techstertech/typeferry/issues";
const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PACKAGE_DIR = path.join(ROOT_DIR, "typeferry-ts");
const SOURCE_DIR = path.join(PACKAGE_DIR, "src");
const PACKAGE_JSON_PATH = path.join(PACKAGE_DIR, "package.json");
const ALLOWED_ROOT_FILES = new Set(["README.md", "package.json"]);
const REQUIRED_DIST_ASSETS = new Set([
  "dist/minimongo/NOTICE.md",
  "dist/minimongo/README.md",
]);
const ALLOWED_DIST_FILE = /^dist\/.+\.(?:d\.ts|js|js\.map)$/;
const RETIRED_PATH_PREFIX = "dist/lit/";

async function main() {
  const manifest = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
  validateManifest(manifest);

  const packageResult = spawnSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: PACKAGE_DIR,
    encoding: "utf8",
  });

  if (packageResult.status !== 0) {
    throw new Error(
      `npm pack dry-run failed:\n${packageResult.stderr || packageResult.stdout}`,
    );
  }

  const report = parsePackageReport(packageResult.stdout, manifest.version);
  await validatePackageFiles(manifest, report.files);

  console.log(
    `Verified ${manifest.name}@${manifest.version}: ${report.files.length} allowed package files (${report.size} bytes packed).`,
  );
}

function validateManifest(manifest) {
  assert(
    manifest.name === EXPECTED_NAME,
    `package name must be ${EXPECTED_NAME}`,
  );
  assert(typeof manifest.version === "string", "package version is required");
  assert(
    manifest.private === true,
    "package must be marked private to prevent npm registry publication",
  );
  assert(manifest.license === "MIT", "package license must be MIT");
  assert(
    manifest.publishConfig === undefined,
    "publishConfig must not be configured",
  );
  assert(manifest.repository?.type === "git", "repository.type must be git");
  assert(
    manifest.repository?.url === REPOSITORY_URL,
    `repository.url must target ${REPOSITORY_URL}`,
  );
  assert(
    manifest.repository?.directory === "typeferry-ts",
    "repository.directory must identify the TypeScript package root",
  );
  assert(
    manifest.homepage === HOMEPAGE_URL,
    `homepage must target ${HOMEPAGE_URL}`,
  );
  assert(
    manifest.bugs?.url === BUGS_URL,
    `bugs.url must target ${BUGS_URL}`,
  );
  assert(Array.isArray(manifest.files), "files allowlist is required");
  assert(
    manifest.files.length === 1 && manifest.files[0] === "dist",
    "manifest files allowlist must contain only dist",
  );
  assert(
    manifest.bin?.typeferry === "dist/cli/index.js",
    "typeferry CLI binary target is required",
  );
}

function parsePackageReport(stdout, manifestVersion) {
  let parsed;

  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack dry-run did not return JSON: ${error.message}`);
  }

  const report = Array.isArray(parsed)
    ? parsed[0]
    : (parsed[EXPECTED_NAME] ?? parsed);
  assert(
    report && Array.isArray(report.files),
    "package report has no file list",
  );
  assert(
    report.name === EXPECTED_NAME,
    "package report has the wrong package name",
  );
  assert(
    report.version === manifestVersion,
    "package report version must match the manifest",
  );

  return report;
}

async function validatePackageFiles(manifest, fileEntries) {
  const packageFiles = new Set(fileEntries.map((entry) => entry.path));
  const expectedFiles = await collectExpectedPackageFiles();

  for (const packagePath of packageFiles) {
    const isAllowed =
      ALLOWED_ROOT_FILES.has(packagePath) ||
      REQUIRED_DIST_ASSETS.has(packagePath) ||
      ALLOWED_DIST_FILE.test(packagePath);

    assert(isAllowed, `unexpected package file: ${packagePath}`);
    assert(
      !packagePath.startsWith(RETIRED_PATH_PREFIX),
      `retired Lit output is forbidden: ${packagePath}`,
    );
    assert(
      !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(packagePath),
      `test file is forbidden: ${packagePath}`,
    );
  }

  for (const requiredFile of ALLOWED_ROOT_FILES) {
    assert(
      packageFiles.has(requiredFile),
      `required package file is missing: ${requiredFile}`,
    );
  }

  for (const expectedFile of expectedFiles) {
    assert(
      packageFiles.has(expectedFile),
      `expected package file is missing: ${expectedFile}`,
    );
  }

  for (const packageFile of packageFiles) {
    assert(
      expectedFiles.has(packageFile),
      `package file has no source contract: ${packageFile}`,
    );
  }

  for (const exportTarget of collectExportTargets(manifest.exports)) {
    const packagePath = exportTarget.replace(/^\.\//, "");
    assert(
      packageFiles.has(packagePath),
      `export target is missing: ${packagePath}`,
    );
  }

  const javascriptFiles = [...packageFiles].filter((file) =>
    file.endsWith(".js"),
  );
  assert(javascriptFiles.length > 0, "package has no compiled JavaScript");

  for (const javascriptFile of javascriptFiles) {
    const basePath = javascriptFile.slice(0, -".js".length);
    assert(
      packageFiles.has(`${basePath}.d.ts`),
      `declaration is missing for ${javascriptFile}`,
    );
    assert(
      packageFiles.has(`${javascriptFile}.map`),
      `source map is missing for ${javascriptFile}`,
    );
  }
}

async function collectExpectedPackageFiles() {
  const expectedFiles = new Set([
    ...ALLOWED_ROOT_FILES,
    ...REQUIRED_DIST_ASSETS,
  ]);
  const sourcePaths = await readdir(SOURCE_DIR, { recursive: true });

  for (const sourcePath of sourcePaths) {
    const normalizedPath = sourcePath.split(path.sep).join("/");
    if (!/\.tsx?$/.test(normalizedPath) || isBuildExcluded(normalizedPath))
      continue;

    const outputBase = `dist/${normalizedPath.replace(/\.tsx?$/, "")}`;
    expectedFiles.add(`${outputBase}.d.ts`);
    expectedFiles.add(`${outputBase}.js`);
    expectedFiles.add(`${outputBase}.js.map`);
  }

  return expectedFiles;
}

function isBuildExcluded(sourcePath) {
  return (
    sourcePath.startsWith("test/") ||
    sourcePath.includes("/test/") ||
    /\.(?:unit\.spec|integration\.spec|browser\.spec|test)\.tsx?$/.test(
      sourcePath,
    )
  );
}

function collectExportTargets(exports) {
  assert(
    exports && typeof exports === "object",
    "package exports are required",
  );

  const targets = [];
  for (const conditions of Object.values(exports)) {
    if (typeof conditions === "string") targets.push(conditions);
    else if (conditions && typeof conditions === "object") {
      targets.push(
        ...Object.values(conditions).filter(
          (value) => typeof value === "string",
        ),
      );
    }
  }

  return targets.filter((target) => !target.includes("*"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
