// MIT License - Copyright (c) 2026 kiritigowda
// See LICENSE file for details.

// @vitest-environment node

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageJson {
  bin?: Record<string, unknown>;
  publishConfig?: { access?: string };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
}

const packageJsonPath = path.join(process.cwd(), "package.json");
const parsed: PackageJson = JSON.parse(
  fs.readFileSync(packageJsonPath, "utf8")
);

describe("package manifest", () => {
  it("does not export local openclaw-rocclaw bin", () => {
    const hasOpenclawROCclawBin = Object.prototype.hasOwnProperty.call(
      parsed.bin ?? {},
      "openclaw-rocclaw"
    );
    expect(hasOpenclawROCclawBin).toBe(false);
  });

  it("publishConfig.access is public for scoped package", () => {
    expect(parsed.publishConfig?.access).toBe("public");
  });

  it("has no git dependencies", () => {
    const allDeps = {
      ...parsed.dependencies,
      ...parsed.devDependencies,
    };
    const gitDeps = Object.entries(allDeps).filter(([, v]) =>
      /^(github:|git(\+|:)|https?:\/\/github\.com)/.test(v)
    );
    expect(gitDeps).toEqual([]);
  });

  it("build script uses --webpack", () => {
    expect(parsed.scripts?.build).toContain("--webpack");
  });

  it("ships next.config.mjs in files array", () => {
    expect(parsed.files).toContain("next.config.mjs");
  });

  it("prepublishOnly runs build", () => {
    expect(parsed.scripts?.prepublishOnly).toContain("npm run build");
  });
});
