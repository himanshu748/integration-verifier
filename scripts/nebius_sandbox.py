"""Pinned ConTree 0.3.6 adapter. stdin/stdout are JSON; credentials stay in env.

Source: https://pypi.org/project/contree-sdk/0.3.6/
Uses the published 0.3.6 ContreeConfig/IAMAuth interfaces.
No network or SDK import happens until main() explicitly invokes run().
"""
import base64
import hashlib
import json
import logging
import os
from pathlib import Path, PurePosixPath
import sys

BASE_URL = "https://api.tokenfactory.nebius.com/sandboxes"
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024
SOURCE_FILES = {"package.json", "package-lock.json", "src/sample-apps/server.js", "scripts/sandbox_candidate_runner.mjs"}
SOURCE_FILES.update(f"src/verifier/{name}.js" for name in ["run", "replay", "judge", "contract", "repair", "boundary", "browserWorkflow", "sampleProcess", "regressionProcess"])
SCENARIOS = ["provider-fail", "malformed", "marker"]
ARTIFACTS = {"evidence.json", "summary.json", "failure.json", "repair.patch", "regression.test.mjs", "workflow.png", "browser-trace.zip", "app.log", "app.before.js", "app.after.js"}
for phase in ["before", "after"]:
    ARTIFACTS.add(f"{phase}/regression.log")
    ARTIFACTS.update(f"{phase}/{scenario}/{name}" for scenario in SCENARIOS for name in ["evidence.json", "workflow.png", "browser-trace.zip", "app.log", "repair.patch"])


def sdk_factory():
    from importlib.metadata import version
    if version("contree-sdk") != "0.3.6":
        raise RuntimeError("Install the pinned requirements-sandbox.txt dependency.")
    from contree_sdk import ContreeSync
    from contree_sdk.auth import IAMAuth
    from contree_sdk.config import ContreeConfig
    from contree_sdk.sdk.exceptions import NotFoundError

    class RecordingContree(ContreeSync):
        # The pinned SDK does not expose operation UUID on its public result.
        # This source-verified hook delegates unchanged and only records IDs.
        async def _start_operation(self, request):
            operation_id = await super()._start_operation(request)
            self.operation_ids.append(str(operation_id))
            return operation_id

    sdk = RecordingContree(ContreeConfig(
        auth=IAMAuth(token=os.environ["NEBIUS_API_KEY"], project_id=os.environ["NEBIUS_PROJECT_ID"], base_url=BASE_URL),
        transport_timeout=30, operation_timeout=600, operation_import_timeout=300,
        operation_run_timeout=600, default_truncate_output_at=65536,
    ))
    # A timed-out submission may already be running. The pinned SDK retries
    # operation starts by default; never replay one behind a single reservation.
    for _, retrier in sdk._operations.values():
        retrier.retry_max_amount = 0
    sdk.operation_ids = []
    return sdk, NotFoundError


def run(payload, factory=sdk_factory):
    if payload.get("version") != 1 or set(payload["artifacts"]) != ARTIFACTS:
        raise ValueError("Unsupported sandbox payload.")
    files = {}
    manifest = []
    for entry in payload["files"]:
        name = entry["path"]
        if name not in SOURCE_FILES or name in files:
            raise ValueError("Unsupported source bundle entry.")
        content = base64.b64decode(entry["content"], validate=True)
        if len(content) > 1024 * 1024 or len(content) != entry["bytes"] or hashlib.sha256(content).hexdigest() != entry["sha256"]:
            raise ValueError("Invalid source bundle content.")
        files[name] = content
        manifest.append({key: entry[key] for key in ["path", "bytes", "sha256"]})
    if set(files) != SOURCE_FILES:
        raise ValueError("Incomplete source bundle.")
    output = Path(payload["outputDir"])
    if not output.is_absolute() or output.is_symlink() or not output.is_dir():
        raise ValueError("Invalid local artifact destination.")
    image = payload["image"]
    request = dict(payload["request"])
    candidate = request.pop("candidateSource", None)
    if candidate is not None and (request.get("type") != "repair" or not isinstance(candidate, str) or len(candidate.encode()) > 256 * 1024):
        raise ValueError("Invalid candidate source.")
    request["hasCandidate"] = candidate is not None
    sdk, not_found = factory()
    cache_key = hashlib.sha256(image.encode() + files["package.json"] + files["package-lock.json"]).hexdigest()[:24]
    setup_tag = "project-desk-runtime-" + cache_key
    try:
        prepared = sdk.images.use(setup_tag, strict=True)
    except not_found:
        base = sdk.images.oci(image, timeout=300)
        prepared = base.run(
            shell="mkdir -p /workspace && cd /workspace && npm ci --ignore-scripts && ./node_modules/.bin/playwright install --with-deps chromium && command -v git",
            files={"/workspace/package.json": files["package.json"], "/workspace/package-lock.json": files["package-lock.json"]},
            env={"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright", "DEBIAN_FRONTEND": "noninteractive"},
            timeout=600, disposable=False, preserve_env=False, truncate_output_at=65536,
        ).wait()
        if prepared.exit_code != 0:
            raise RuntimeError("Sandbox runtime preparation failed.")
        prepared = prepared.tag_as(setup_tag)
    remote_files = {"/workspace/" + name: content for name, content in files.items()}
    remote_files["/workspace/bundle-manifest.json"] = json.dumps({"files": manifest}).encode()
    if candidate is not None:
        remote_files["/candidate/server.js"] = candidate.encode()
        remote_files["/candidate/package.json"] = b'{"type":"module"}\n'
    # UID 65534 cannot mutate the root-owned harness, snapshots or output.
    result = prepared.run(
        shell="set -eu; test \"$(id -u)\" -eq 0; chown -R 0:0 /workspace; chmod -R a+rX,go-w /workspace; if [ -d /candidate ]; then chown -R 0:0 /candidate; chmod 755 /candidate; chmod 444 /candidate/*; fi; umask 077; exec node /workspace/scripts/sandbox_candidate_runner.mjs",
        files=remote_files, cwd="/workspace", stdin=json.dumps(request),
        env={"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"}, timeout=420,
        disposable=False, preserve_env=False, truncate_output_at=65536,
    ).wait()
    if not sdk.operation_ids:
        raise RuntimeError("Remote execution identifier is unavailable.")
    execution_id = sdk.operation_ids[-1]
    total = 0
    downloaded = []
    for directory in sorted({str(PurePosixPath(name).parent) for name in ARTIFACTS}):
        remote_dir = "/output" if directory == "." else "/output/" + directory
        try:
            entries = result.ls(remote_dir)
        except not_found:
            continue
        for item in entries:
            name = item.name if directory == "." else directory + "/" + item.name
            if name not in ARTIFACTS:
                continue
            if not item.is_file or not item.is_regular or item.is_symlink or not isinstance(item.size, int) or item.size < 0 or item.size > MAX_FILE:
                raise ValueError("Unsafe or oversized remote artifact.")
            total += item.size
            if total > MAX_TOTAL:
                raise ValueError("Remote artifacts exceed the total download limit.")
            content = result.read("/output/" + name)
            if len(content) != item.size:
                raise ValueError("Remote artifact size changed.")
            target = output / name
            # Never follow symlink ancestors or overwrite a prior local file.
            for parent in target.parents:
                if parent == output.parent:
                    break
                if parent.is_symlink():
                    raise ValueError("Unsafe local artifact directory.")
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(content)
            downloaded.append(name)
    return {"executionId": execution_id, "image": str(result.uuid), "setupImage": str(prepared.uuid),
            "exitCode": result.exit_code, "downloaded": downloaded}


def main():
    logging.disable(logging.CRITICAL)
    try:
        raw = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024:
            raise ValueError("Request too large.")
        print(json.dumps(run(json.loads(raw))))
    except Exception:
        # Do not print provider exceptions: they may contain credentials or request data.
        print(json.dumps({"error": "Sandbox preparation, execution or retrieval failed."}))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
