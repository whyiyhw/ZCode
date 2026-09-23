# @zcode/zcode-cua

Computer Use client and runtime package: the broker wire-protocol client
(NDJSON over Windows named pipe / Unix domain socket, aligned with the official
0.6.3 Helper), the executor for the 14 model-facing tools, and the local Helper
runtime staging utilities. Helper binaries are never distributed with this
repository: the runtime is staged from a local official install
(`scripts/prepare-cua-helper.mjs`, or Windows first-run auto-staging into
`~/.zcode/cua-helper-runtime`), and public releases stay free of proprietary
binaries. Without a valid Helper runtime, every tool fails closed with an
explicit "Computer Use is not available" error instead of degrading silently.
Wire protocol, runtime contracts, and acceptance notes live in
`spec/computer-use-restore.md`.

License: Apache-2.0.
