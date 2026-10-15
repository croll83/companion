// Guards of the dependency rule behind the embedded brain:
//
// 1. The brain core is not part of Companion: it lives in the brains project,
//    which builds the bundle Companion ships (brain-bundle/brain.js, copied to
//    dist/brain/brain.js) and runs as a separate process. Companion's server
//    talks to it only over HTTP.
// 2. No server file imports a package that is missing from `dependencies`.
//    The in-app updater and the deploy copy do not install dependencies: a
//    server import of a devDependency would make Companion fail to start for
//    everyone who updates from the app.
//
// The test walks the import statements of every non-test .ts file under
// server/ (type-only imports are erased at runtime and are skipped).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB = resolve(__dirname, "../..");
const SERVER = join(WEB, "server");
const pkg = JSON.parse(readFileSync(join(WEB, "package.json"), "utf-8")) as { dependencies: Record<string, string>; files: string[]; scripts: Record<string, string> };

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "node_modules" && e.name !== "__tests__") walk(full, out);
    } else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Runtime import specifiers of a source file (static, re-exports, side-effect and dynamic imports). */
export function runtimeImports(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const out: string[] = [];
  for (const m of code.matchAll(/(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([^;]*?)\s*from\s*["']([^"']+)["']/g)) {
    if (m[2]) continue;
    const braces = /^\{([\s\S]*)\}$/.exec(m[3].trim());
    if (braces && braces[1].split(",").map((s) => s.trim()).filter(Boolean).every((s) => s.startsWith("type "))) continue;
    out.push(m[4]);
  }
  for (const m of code.matchAll(/(?:^|[;\n])\s*import\s*["']([^"']+)["']/g)) out.push(m[1]);
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

/** "@scope/pkg/sub" → "@scope/pkg", "pkg/sub" → "pkg". */
function packageName(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

const BUILTINS = new Set(builtinModules);

function isRuntimeProvided(spec: string): boolean {
  return spec.startsWith("node:") || spec === "bun" || spec.startsWith("bun:") || BUILTINS.has(spec);
}

const files = walk(SERVER);

describe("import graph of web/server", () => {
  it("parses the import forms it must see", () => {
    // The parser itself: otherwise a missed form would make the guards pass vacuously.
    const src = [
      'import a from "pkg-a";',
      'import { b,\n  c } from "@scope/pkg-b/sub";',
      'import type { T } from "pkg-type";',
      'import { type U } from "pkg-type-only";',
      'export { d } from "./local.js";',
      'import "side-effect";',
      'const e = await import("pkg-dyn");',
      '// import x from "commented";',
    ].join("\n");
    expect(runtimeImports(src)).toEqual(["pkg-a", "@scope/pkg-b/sub", "./local.js", "side-effect", "pkg-dyn"]);
    expect(files.length).toBeGreaterThan(100);
  });

  it("the brain core is not in Companion: it comes bundled from brains", () => {
    expect(existsSync(join(SERVER, "brain", "core"))).toBe(false);
    const meta = JSON.parse(readFileSync(join(WEB, "brain-bundle", "bundle.json"), "utf-8")) as { brains_commit: string; protocol: number };
    expect(meta.brains_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(WEB, "brain-bundle", "brain.js"))).toBe(true);
  });

  it("every package a server file imports is in dependencies", () => {
    const deps = new Set(Object.keys(pkg.dependencies));
    const missing: string[] = [];
    for (const f of files) {
      for (const spec of runtimeImports(readFileSync(f, "utf-8"))) {
        if (spec.startsWith(".") || spec.startsWith("/") || isRuntimeProvided(spec)) continue;
        if (!deps.has(packageName(spec))) missing.push(`${relative(WEB, f)} → ${spec}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("the bundle is built after Vite and shipped in the package", () => {
    // Vite empties dist/ when it builds: the brain bundle must come after it, inside dist/ (in "files").
    expect(pkg.scripts.build).toMatch(/^vite build && bun run build:brain$/);
    expect(pkg.scripts["build:brain"]).toContain("cp brain-bundle/brain.js");
    expect(pkg.scripts["build:brain"]).toContain("dist/brain/");
    expect(pkg.files).toContain("dist/");
  });
});
