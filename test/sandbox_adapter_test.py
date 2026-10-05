"""Offline SDK contract fixtures. No provider SDK import, network, or shell execution."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("sandbox_adapter", Path(__file__).parents[1] / "scripts/nebius_sandbox.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)


class MissingFixtureImage(Exception):
    pass


class FixtureImage:
    def __init__(self, sdk, kind):
        self.sdk = sdk
        self.kind = kind
        self.uuid = "offline-fixture-" + kind
        self.exit_code = 0

    def run(self, **kwargs):
        # The command is recorded as text only; this fake never runs any process.
        self.sdk.calls.append((self.kind, kwargs))
        result = FixtureImage(self.sdk, "runtime" if self.kind == "base" else "result")
        self.sdk.operation_ids.append("offline-fixture-operation-" + result.kind)
        result.exit_code = self.sdk.setup_exit if self.kind == "base" else 2
        return result

    def wait(self):
        return self

    def tag_as(self, tag):
        self.sdk.tags.append(tag)
        return self

    def ls(self, directory):
        entries = []
        for name, content in self.sdk.artifacts.items():
            full_path = PurePosixPath("/output") / name
            if str(full_path.parent) == directory:
                entries.append(SimpleNamespace(name=full_path.name, size=len(content),
                    is_file=True, is_regular=True, is_symlink=False))
        entries.extend(self.sdk.extra_entries.get(directory, []))
        if not entries:
            raise MissingFixtureImage()
        return entries

    def read(self, name):
        self.sdk.reads.append(name)
        return self.sdk.artifacts[name.removeprefix("/output/")]


class FixtureSdk:
    def __init__(self, cached=False):
        self.cached = cached
        self.calls, self.imports, self.tags, self.reads, self.operation_ids = [], [], [], [], []
        self.artifacts = {"evidence.json": b'{"scope":"offline fixture"}', "app.log": b'offline log',
                          ".env": b'must not download', "before/marker/evidence.json": b'{}'}
        self.extra_entries = {}
        self.images = self
        self.setup_exit = 0

    def use(self, tag, strict):
        if not strict:
            raise AssertionError("cache must be resolved, not guessed")
        if not self.cached:
            raise MissingFixtureImage()
        return FixtureImage(self, "runtime")

    def oci(self, image, timeout):
        self.imports.append((image, timeout))
        return FixtureImage(self, "base")


def fixture_payload(output):
    files = []
    for name in sorted(adapter.SOURCE_FILES):
        content = ("offline fixture for " + name).encode()
        files.append({"path": name, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
                      "content": base64.b64encode(content).decode()})
    return {"version": 1, "image": "docker://docker.io/library/node:22-bookworm",
            "artifacts": sorted(adapter.ARTIFACTS), "files": files, "outputDir": str(output),
            "request": {"type": "verify", "app": "fake-fallback", "scenario": "provider-fail"}}


class SandboxOfflineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sandbox-python-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.output = Path(self.temp.name) / "output"
        self.output.mkdir()
        self.payload = fixture_payload(self.output)
        self.sdk = FixtureSdk()

    def run_fixture(self, payload=None):
        return adapter.run(payload or self.payload, factory=lambda: (self.sdk, MissingFixtureImage))

    def test_cold_setup_checkpoints_runtime_and_records_actual_execution_operation(self):
        receipt = self.run_fixture()
        self.assertEqual(len(self.sdk.calls), 2)
        setup, execution = [options for _, options in self.sdk.calls]
        self.assertIn("npm ci --ignore-scripts", setup["shell"])
        self.assertIn("playwright install --with-deps chromium", setup["shell"])
        self.assertEqual(set(setup["files"]), {"/workspace/package.json", "/workspace/package-lock.json"})
        for options in [setup, execution]:
            self.assertFalse(options["disposable"])
            self.assertFalse(options["preserve_env"])
            self.assertLessEqual(options["timeout"], 600)
            self.assertNotIn("NEBIUS_API_KEY", options["env"])
            self.assertNotIn("NEBIUS_PROJECT_ID", options["env"])
        self.assertTrue(execution["shell"].startswith("set -eu;"))
        self.assertIn('test "$(id -u)" -eq 0', execution["shell"])
        self.assertIn("chown -R 0:0 /workspace", execution["shell"])
        self.assertIn("chmod -R a+rX,go-w /workspace", execution["shell"])
        self.assertEqual(execution["env"], {"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"})
        self.assertEqual(set(execution["files"]), {"/workspace/" + name for name in adapter.SOURCE_FILES} | {"/workspace/bundle-manifest.json"})
        self.assertEqual(receipt["executionId"], "offline-fixture-operation-result")
        self.assertEqual(receipt["image"], "offline-fixture-result")
        self.assertEqual(receipt["setupImage"], "offline-fixture-runtime")
        self.assertEqual(len(self.sdk.tags), 1)
        self.assertEqual((self.output / "evidence.json").read_bytes(), self.sdk.artifacts["evidence.json"])
        self.assertFalse((self.output / ".env").exists())
        self.assertNotIn("/output/.env", self.sdk.reads)
        self.assertIn("before/marker/evidence.json", receipt["downloaded"])

    def test_cached_runtime_skips_import_and_install(self):
        self.sdk.cached = True
        self.run_fixture()
        self.assertEqual(len(self.sdk.calls), 1)
        self.assertEqual(self.sdk.imports, [])
        self.assertNotIn("npm ci", self.sdk.calls[0][1]["shell"])

    def test_candidate_uploaded_only_as_separate_file_not_command_or_request(self):
        candidate = "process.exit(99); // offline candidate never executed"
        self.payload["request"] = {"type": "repair", "candidateSource": candidate}
        self.run_fixture()
        execution = self.sdk.calls[-1][1]
        self.assertEqual(execution["files"]["/candidate/server.js"], candidate.encode())
        self.assertEqual(execution["files"]["/candidate/package.json"], b'{"type":"module"}\n')
        self.assertNotIn(candidate, execution["shell"])
        self.assertNotIn(candidate, execution["stdin"])
        self.assertEqual(json.loads(execution["stdin"]), {"type": "repair", "hasCandidate": True})
        original = next(x for x in self.payload["files"] if x["path"] == "src/sample-apps/server.js")
        self.assertEqual(execution["files"]["/workspace/src/sample-apps/server.js"], base64.b64decode(original["content"]))

    def test_source_bundle_injection_or_hash_corruption_fails_before_sdk_factory(self):
        bad = []
        source = copy.deepcopy(self.payload)
        source["files"][0]["path"] = ".env"
        bad.append(source)
        source = copy.deepcopy(self.payload)
        source["files"][0]["sha256"] = "0" * 64
        bad.append(source)
        source = copy.deepcopy(self.payload)
        source["artifacts"].append("../../secret")
        bad.append(source)
        for payload in bad:
            with self.subTest(payload=payload["files"][0]["path"]):
                with self.assertRaises(ValueError):
                    adapter.run(payload, factory=lambda: self.fail("invalid bundle reached SDK"))

    def test_failed_dependency_setup_does_not_execute_job(self):
        self.sdk.setup_exit = 1
        with self.assertRaisesRegex(RuntimeError, "preparation"):
            self.run_fixture()
        self.assertEqual(len(self.sdk.calls), 1)
        self.assertEqual(self.sdk.reads, [])

    def test_symlink_and_oversized_remote_artifacts_rejected_before_read(self):
        self.sdk.artifacts = {}
        for symlink, size, regular in [(True, 0, True), (False, adapter.MAX_FILE + 1, True), (False, 0, False), (False, -1, True)]:
            with self.subTest(symlink=symlink, size=size, regular=regular):
                self.sdk.extra_entries = {"/output": [SimpleNamespace(name="evidence.json", size=size,
                    is_file=True, is_regular=regular, is_symlink=symlink)]}
                with self.assertRaises(ValueError):
                    self.run_fixture()
        self.assertEqual(self.sdk.reads, [])

    def test_existing_artifact_is_never_overwritten(self):
        (self.output / "evidence.json").write_text("previous evidence")
        with self.assertRaises(FileExistsError):
            self.run_fixture()
        self.assertEqual((self.output / "evidence.json").read_text(), "previous evidence")

    def test_local_artifact_directory_symlink_cannot_escape(self):
        outside = Path(self.temp.name) / "outside"
        outside.mkdir()
        (self.output / "before").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Unsafe local"):
            self.run_fixture()
        self.assertFalse((outside / "marker/evidence.json").exists())
        self.assertEqual(list(outside.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
