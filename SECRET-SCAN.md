# Scoped release secret check

Checked October 22, 2026. This is a current-file review, not publication authorization.

- Result: **passed scoped text check** across 80 allowlisted text files, including new untracked release sources and documentation.
- 4 known image/font/audio files were hashed for the source manifest; their binary contents were not searched for secrets.
- Private `.env`, ignored account ledgers, dependencies and runtime records were not read. No Git history or unknown credential format coverage is claimed.
- The standard secret-scan skill also ran against tracked working files. It reported binary omissions; its standard verdict is incomplete, not a clean full-repository scan.
- The expanded allowlisted scan retained only redacted file/line findings. Its receipt and file hashes are local in `work/release-source-secret-scan-receipt.json`.

Reviewed findings:

- `test/deepgramNarration.test.js:11` — Credential assignment: reviewed synthetic test fixture. Synthetic narration credential used only with injected fixture transport and secret-redaction assertions.
- `test/deepgramNarration.test.js:11` — Quoted credential assignment: reviewed synthetic test fixture. Synthetic narration credential used only with injected fixture transport and secret-redaction assertions.
- `test/sandbox.test.js:18` — Credential assignment: reviewed synthetic test fixture. Offline Sandbox credential-isolation fixture; no real transport.
- `test/sandbox.test.js:18` — Quoted credential assignment: reviewed synthetic test fixture. Offline Sandbox credential-isolation fixture; no real transport.
- `test/sandbox.test.js:19` — Credential assignment: reviewed synthetic test fixture. Synthetic parent-secret exclusion fixture; tests prevent forwarding it.
- `test/sandbox.test.js:19` — Quoted credential assignment: reviewed synthetic test fixture. Synthetic parent-secret exclusion fixture; tests prevent forwarding it.
- `test/sandbox_sdk_contract_test.py:43` — Quoted credential assignment: reviewed synthetic test fixture. Offline fixture authentication for the pinned SDK with real HTTP transport forbidden.
