import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const rootDir = process.cwd();
const distDir = path.join(rootDir, "dist");

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });
await cp(path.join(rootDir, "apps"), path.join(distDir, "apps"), { recursive: true });
await cp(path.join(rootDir, "packages"), path.join(distDir, "packages"), {
  recursive: true
});

console.log(`Build artifacts copied to ${distDir}`);
