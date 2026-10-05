# Selected validation — Integration Verifier

Verified on 5 October 2026 using macOS, Node.js v24.9.0 and installed Chromium 153.0.8010.12. The standalone extraction received separate read-only code review.

| Check | Passed |
| --- | ---: |
| Standalone HTTP/browser checks | 2 |
| Selected unit/service checks | 83 |
| Actual local product browser flows | 1 |
| JavaScript syntax files | 40 |

The selected final test runs had zero failures and zero cancellations. This is selected extraction verification, not a claim that every retained test in `npm test` was rerun. Shared runtime checks occur independently in each repository.

The new standalone checks exercise the home-to-app path, actual evidence assets, missing sibling routes/APIs, unconfigured inference, session tokens, Host/Origin rejection, request size/content type, and the explicit static allowlist. Product-specific browser cases exercise real local workflows.

```sh
npm run check
npm run test:smoke
# All retained tests, including additional regression cases:
npm test
```

No live provider credentials, paid API calls, cloud jobs or physical hardware were used. Synthetic/controlled evidence must not be described as live Nebius or NVIDIA execution. Live sponsor proof and competition eligibility remain unverified.

The source was extracted from reviewed suite checkpoint `ebd0707`; original product logic was preserved except the necessary standalone routing/navigation and shared-file import changes. Credentials, raw runtime data, historical private logs and old Git history are excluded. The MIT license and bundled font license are retained.

The retained browser test initially finished its real local repair checks and then failed an obsolete four-project hub assertion. Only that cross-product tail was changed; the full corrected failure/marker/repair test was rerun successfully.
