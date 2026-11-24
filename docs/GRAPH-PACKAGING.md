# Pi Graph packaging and provenance

Pi Graph starts from upstream [`catlog22/pi-maestro-flow`](https://github.com/catlog22/pi-maestro-flow) at `7a0daa75cf137c6907b037b5f38fc2496497f591`. The upstream repository, [release history](../RELEASE.md), native-provider provenance files, and licenses are historical references, not Graph distribution or release destinations.

## Install and verify a source checkout

The Graph npm names below are release targets for [`HeathHe/pi-graph`](https://github.com/HeathHe/pi-graph); a source checkout does not imply that the packages are available on npm. In a checkout, use the npm workspace links instead of installing the unpublished packages individually:

```sh
npm ci --ignore-scripts --no-audit --no-fund
node --test scripts/workspace-identities.test.mjs
```

Use `npm run dev:pi` for the repository's sandboxed launch workflow. To verify package contents for release, use a separate Pi home, npm cache and temporary directory. Pack extensions serially: their npm lifecycle scripts stage `pi-graph-shared-settings` and the main extension stages canonical `.pi` resources. Once available on the configured registry, the suite's Pi install entrypoint is `pi install npm:pi-graph@0.2.7`; the plugin registers `pi-graph-agent-runtime` and `pi-graph-dashboard` as companion extensions. The Pi host SDK remains host-provided.

## Workspace names by responsibility

These categories describe what the packages do, not where they live. Every workspace is a direct child of `packages/` and its directory basename matches its npm name.

| Category | Upstream workspace directory | Upstream npm identity | Previous Graph name | Current Graph name |
|---|---|---|---|---|
| Task orchestration | `pi-maestro-flow` | `pi-maestro-flow` | `pi-graph` | `pi-graph` |
| Task orchestration | `pi-maestro-teammate` | `pi-maestro-teammate` | `pi-graph-teammate` | `pi-graph-agent-runtime` |
| UI | `pi-cockpit` | `pi-cockpit` | `pi-graph-cockpit` | `pi-graph-dashboard` |
| UI | `pi-fluent-tui` | `pi-fluent-tui` | `pi-graph-fluent-tui` | `pi-graph-terminal-ui` |
| Task execution | `pi-maestro-backend-core` | `pi-maestro-backend-core` | `pi-graph-backend-core` | `pi-graph-execution-api` |
| Task execution | `pi-maestro-backends` | `pi-maestro-backends` | `pi-graph-backends` | `pi-graph-executors` |
| Cross-device communication | `pi-maestro-fabric-core` | `pi-maestro-fabric-core` | `pi-graph-fabric-core` | `pi-graph-device-api` |
| Cross-device communication | `pi-maestro-fabric` | `pi-maestro-fabric` | `pi-graph-fabric` | `pi-graph-device-network` |
| Desktop automation | `maestro-active-win` | `@dyw1234/active-win` | `pi-graph-active-win` | `pi-graph-window-info` |
| Desktop automation | `maestro-nut-js` | `@dyw1234/nut-js` | `pi-graph-nut-js` | `pi-graph-desktop-automation` |
| Desktop automation | `maestro-nut-provider-interfaces` | `@dyw1234/nut-provider-interfaces` | `pi-graph-nut-provider-interfaces` | `pi-graph-desktop-provider-api` |
| Desktop automation | `maestro-nut-shared` | `@dyw1234/nut-shared` | `pi-graph-nut-shared` | `pi-graph-desktop-shared` |
| Shared foundation | `pi-maestro-settings-core` | `pi-maestro-settings-core` | `pi-graph-settings-core` | `pi-graph-shared-settings` |

The terminal UI generates five platform packages inside `packages/pi-graph-terminal-ui/platforms/`, outside the root npm workspace glob: `pi-graph-terminal-ui-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}`. The launcher pins all five to its own version. Existing platform tarballs cannot be used under new names. The release workflow builds and publishes the platform packages before the launcher at tag `pi-graph-terminal-ui-v<version>`; publishing requires credentials authorized for the new npm names. Pages deploys to the current repository's configured Pages site.

## Compatibility names that stay

- `maestro-flow` and the `maestro` executable are external. Their workflow/knowledge commands, `.maestro` data, skill references and related `MAESTRO_*` settings stay compatible. Actual third-party `@nut-tree-fork` providers such as `libnut` and `default-clipboard-provider` also stay unchanged.
- Tool and skill names, established protocol identifiers (including Gateway v1 server identity, fixed SSH commands, IPC, and Fabric domains), persisted IDs, and environment settings are not npm package identities. The new human-facing executable is `pi-graph-gateway`; `pi-maestro-gateway` remains an executable alias for existing SSH policies and clients.
- Teammate and Cockpit keep their existing settings provider IDs (`pi-graph-teammate` and `pi-graph-cockpit`), runtime symbol keys, and protocol identifiers. The terminal UI keeps the `pi-f` and `pi-graph-fluent-tui` CLI commands and the `pi-graph-fluent-tui` Rust crate/native executable basename.
- Runtime APIs keep their export subpaths, e.g. `pi-graph/gateway/v1` and `pi-graph-agent-runtime/v1/execution`. Update package specifiers in custom imports or saved backend `module` declarations, e.g. `pi-graph-teammate/v1/acp-cli` → `pi-graph-agent-runtime/v1/acp-cli` and `pi-graph-backends/dsh` → `pi-graph-executors/dsh`. This does not require changing backend registration names or configuration keys.
- Companion registration replaces sources owned by the existing `pi-maestro-flow-companions.json` sidecar or backed by a matching package manifest directly under an older Pi Graph install's `node_modules`. It migrates the managed sidecar entries to the current names and preserves manually managed legacy/local overrides; update those overrides explicitly.
- The original Node SDK, third-party dependency pins and companion package versions carry over. The dashboard's development-only agent runtime pin remains `2.10.2`; the upstream stale `2.10.1` requested an unavailable separate registry copy. Its optional peer range is unchanged.
