import { realpathSync } from "node:fs";
import * as path from "node:path";
import type { PermissionPathPort } from "pi-graph-permission-core";
export const permissionPathPort: PermissionPathPort = {
  posix: path.posix, win32: path.win32,
  nativeFlavor: process.platform === "win32" ? "win32" : "posix",
  realpathNative: (value) => realpathSync.native(value),
};
