import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import path from "node:path";

export async function ensureDirectory(targetPath) {
  await mkdir(targetPath, { recursive: true });
}

export async function readJsonFile(filePath, fallbackValue) {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }

    throw error;
  }
}

export async function writeJsonFile(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), "utf8");
  await rename(tempPath, filePath);
}

export async function writeTextFile(filePath, value) {
  await ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, value, "utf8");
  await rename(tempPath, filePath);
}

export async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

export async function listDirectories(rootPath) {
  try {
    const entries = await readdir(rootPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}
