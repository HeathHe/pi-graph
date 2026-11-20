# Provenance — candidate, not installed

Upstream https://github.com/catlog22/pi-maestro-flow commit 7a0daa75cf137c6907b037b5f38fc2496497f591; license is exact archive root LICENSE.
Source paths: packages/pi-maestro-flow/src/permissions/{policy,settings,types}.ts. Actual migration baseline is current rebuild files recorded in ../before snapshots and SOURCE-MAP.json, not an assertion that all current bytes equal upstream.

policy: whole algorithm retained, enclosed in createPermissionPolicy; Node fs/path imports replaced by PermissionPathPort; path structural type substituted; realpathNative and nativeFlavor replace native Node accesses. The four exports become returned functions. Reasons, shell/file matching and precedence unchanged.
settings: validatePermissions/mergePermissions/restrictUntrustedProjectPermissions moved verbatim except export modifier. File reads/JSON parse/atomic writes/locks/queues remain Host.
types: complete unchanged byte copy. New index/package/config/path-port are integration scaffolding; no runtime dependencies. DOM lib supplies existing URL type, not permission to run browser/network APIs. Core noEmit excludes tests; test compilation needs separate exact Node type closure review.
