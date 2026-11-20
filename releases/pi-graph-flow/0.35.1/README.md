# pi-graph-flow 0.35.1 — SDK 1.5.2 preview source

This directory is a curated source review snapshot for the `pi-graph-flow-v0.35.1` GitHub preview. It is separate from the repository root's legacy `pi-graph` npm package and is not an npm install tree.

`packages/` contains the shipped Flow, Teammate, Cockpit and internal package sources and resources from the verified Graph runtime. `SOURCE-MANIFEST.json` records source and published SHA-256 values and every exclusion. Dependency directories, third-party vendor bundles, native binaries, source maps, machine Python environments, credentials and private build evidence are excluded; use the accompanying runtime asset for the complete runnable graph.

`sdk152/flow/` and `sdk152/builder/` are the exact version-bound host shim inputs that produced the verified SDK 1.5.2. The package snapshot's historical host source is retained as shipped; apply the explicitly separate SDK 1.5.2 inputs when reproducing that SDK. `sdk152/BUILD-RECIPE.json` pins the official SDK metadata, seven patch leaves through PATCH-SPEC, source inputs, build tools and external entries. Resolve those inputs in a clean build directory before calling the exported `buildOwnedSdk(input)` API. No machine-specific build paths are distributed here. The recipe is source evidence, not a claim of a newly executed clean-room build.

Two compatibility metadata files match the portable runtime asset exactly: historical local paths were sanitized, and the derived manifest digest was updated. Code files remain byte-identical to their recorded runtime sources. A generic temporary-directory comment in one optional workflow helper is excluded under the strict path filter; the complete helper remains in the runtime distribution.

The verified scope is macOS arm64 with Node 24.14.0: normal private `pig` startup, loaded extensions and tool ownership, theme switching, successful reload, normal exit, and CodeMode result 42 with worker exit. This does not assert every platform, provider, or physical manual workflow has been tested.

This snapshot does not publish or replace upstream package names. Retain upstream copyright and license notices when redistributing. Existing package-level notices and the upstream Maestro and Pi Graph MIT notices are included. See `notices/` and the original package license declarations; the runtime asset's third-party notices cover its additional redistributed dependencies.
