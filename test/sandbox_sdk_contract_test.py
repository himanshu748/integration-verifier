"""Pinned SDK contract checks. HTTP is intercepted; no provider calls are made.

Run with .venv-sandbox/bin/python -B test/sandbox_sdk_contract_test.py.
"""
import asyncio
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
from uuid import UUID

import httpx
from contree_sdk._internals.models.image_import import ImageImportRequest, PublicRegistryInfo
from contree_sdk._internals.models.instance import InstanceSpawnRequest
from contree_sdk.sdk.exceptions.api import ApiTimeoutError, TooManyRequestsError
from contree_sdk.sdk.objects.image._sync import ContreeImageSync
from contree_sdk.utils.models.stream import StreamDescription


spec = importlib.util.spec_from_file_location("sandbox_adapter", Path(__file__).parents[1] / "scripts/nebius_sandbox.py")
adapter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(adapter)
OPERATION_ID = "2258bffa-7ced-47f6-a476-23a085b09035"
IMAGE_ID = "baf54d52-4f12-4fc0-9ee2-6191312d8cee"


class PinnedSandboxSdkTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.clients = []
        # Any accidental use of a real HTTP transport fails before networking.
        self.network_guard = patch.object(httpx.AsyncHTTPTransport, "handle_async_request",
            side_effect=AssertionError("Live transport is forbidden in offline SDK tests"))
        self.network_guard.start()
        self.addCleanup(self.network_guard.stop)

    async def asyncTearDown(self):
        for client in self.clients:
            await client.aclose()

    def client(self, handler):
        with patch.dict(os.environ, {"NEBIUS_API_KEY": "offline-fixture-key", "NEBIUS_PROJECT_ID": "offline-fixture-project"}, clear=True), \
                patch("contree_sdk.auth.read_ini_profile", return_value=None):
            sdk, _ = adapter.sdk_factory()
        client = httpx.AsyncClient(base_url=sdk._api._client_base_url,
            headers=sdk._api._client_headers, transport=httpx.MockTransport(handler))
        self.clients.append(client)
        sdk._api._client_per_loop[asyncio.get_running_loop()] = client
        return sdk

    def requests(self):
        return [
            ImageImportRequest(registry=PublicRegistryInfo(url="docker://docker.io/library/node:22-bookworm")),
            InstanceSpawnRequest(command="true", image=IMAGE_ID, hostname="offline-fixture", cwd="/workspace",
                stdin=StreamDescription(value=""), truncate_output_at=65536, files={}),
        ]

    async def test_import_and_execution_timeout_are_never_replayed(self):
        for payload in self.requests():
            with self.subTest(operation=type(payload).__name__):
                calls = []
                def timeout(request):
                    calls.append(request)
                    raise httpx.ReadTimeout("offline timeout after submission", request=request)
                sdk = self.client(timeout)
                with self.assertRaises(ApiTimeoutError):
                    await asyncio.wait_for(sdk._start_operation(payload), timeout=1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(sdk.operation_ids, [])

    async def test_import_and_execution_rate_limits_are_never_replayed(self):
        for payload in self.requests():
            with self.subTest(operation=type(payload).__name__):
                calls = []
                def limited(request):
                    calls.append(request)
                    return httpx.Response(429, json={"status": 429, "error": "offline rate limit"})
                sdk = self.client(limited)
                with self.assertRaises(TooManyRequestsError):
                    await asyncio.wait_for(sdk._start_operation(payload), timeout=1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(sdk.operation_ids, [])

    async def test_success_preserves_recorded_operation_ids_and_auth_contract(self):
        calls = []
        def accepted(request):
            calls.append(request)
            return httpx.Response(200, json={"uuid": OPERATION_ID})
        sdk = self.client(accepted)
        for payload in self.requests():
            self.assertEqual(await sdk._start_operation(payload), UUID(OPERATION_ID))
        self.assertEqual(sdk.operation_ids, [OPERATION_ID, OPERATION_ID])
        self.assertEqual([request.url.path for request in calls],
            ["/sandboxes/v1/images/import", "/sandboxes/v1/instances"])
        for request in calls:
            self.assertEqual(request.headers["Authorization"], "Bearer offline-fixture-key")
            self.assertEqual(request.headers["Project"], "offline-fixture-project")
            self.assertNotIn("offline-fixture-key", request.content.decode())
        self.assertEqual(json.loads(calls[1].content)["command"], "true")

    async def test_run_parameters_remain_supported_without_submitting(self):
        def unexpected(_):
            self.fail("Preparing a run must not submit it")
        sdk = self.client(unexpected)
        prepared = ContreeImageSync(client=sdk, uuid=IMAGE_ID, tag=None).run(
            shell="true", files={"/workspace/fixture.txt": b"fixture"}, cwd="/workspace",
            stdin='{"fixture":true}', env={"PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright"},
            timeout=420, disposable=False, preserve_env=False, truncate_output_at=65536)
        self.assertEqual(prepared._request.timeout, 420)
        self.assertFalse(prepared._request.disposable)
        self.assertFalse(prepared._request.preserve_env)
        self.assertEqual(prepared._request.files[0].source, b"fixture")
        self.assertEqual(prepared._stdin.read(), '{"fixture":true}')
        self.assertEqual(sdk.operation_ids, [])


if __name__ == "__main__":
    unittest.main()
