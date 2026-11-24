import assert from "node:assert/strict";
import test from "node:test";
import { getPiFeatureOwner, getPiHostMode } from "pi-graph-shared-settings/v1";

const supportedVersions = [
  ["0.87.0", "legacy"],
  ["0.87.1", "legacy"],
  ["0.98.999", "legacy"],
  ["0.87.0+build.001", "legacy"],
  ["0.99.0", "native"],
  ["0.99.1", "native"],
  ["0.100.0", "native"],
  ["0.100.0+build.001", "native"],
  ["0.99.0+sha.abc-123", "native"],
  ["0.99.0+build-", "native"],
  ["1.0.0", "native"],
  ["10.2.3", "native"],
] as const;

const unknownVersions: readonly unknown[] = [
  undefined, null, false, true, 0.99, NaN, {}, [], new String("0.99.0"),
  "", "unknown", "0.86.999", "0.9.99", "0.0.0",
  "0.87.0-rc.1", "0.98.0-beta", "0.99.0-rc", "0.99.0-rc.1",
  "0.100.0-rc", "0.100.0-rc.1+build.001", "1.0.0-alpha",
  "v0.99.0", " 0.99.0", "0.99.0 ", "0.99.0\n", "0.99.0\r\n",
  "0.99", "0.99.0.1", "00.99.0", "0.099.0", "0.99.00", "-1.99.0",
  "0.99.x", "0.99.0+", "0.99.0+build..1", "0.99.0+build_1",
  "0.99.0-", "0.99.0-01", "0.99.0-rc..1",
  "9007199254740992.0.0", "0.9007199254740992.0", "0.99.9007199254740992",
];

test("host mode compares numeric stable semver at the supported boundaries", () => {
  for (const [version, expected] of supportedVersions) {
    assert.equal(getPiHostMode(version), expected, version);
  }
});

test("host mode rejects unknown, unsupported, malformed, and prerelease versions", () => {
  for (const version of unknownVersions) {
    assert.equal(getPiHostMode(version), "unknown", String(version));
  }
});

test("feature ownership never falls back when native APIs are absent", () => {
  for (const [version, mode] of supportedVersions) {
    for (const apiAvailable of [false, true]) {
      const expected = mode === "legacy" ? "legacy" : apiAvailable ? "native" : "unavailable";
      assert.equal(getPiFeatureOwner(version, apiAvailable), expected, `${version}: ${apiAvailable}`);
    }
  }
  for (const version of unknownVersions) {
    assert.equal(getPiFeatureOwner(version, false), "unavailable", String(version));
    assert.equal(getPiFeatureOwner(version, true), "unavailable", String(version));
  }
});
