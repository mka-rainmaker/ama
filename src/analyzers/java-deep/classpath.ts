import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";
import type { GraphNode } from "../../graph/index.js";
import { parseClassFile } from "../java-bytecode/classfile.js";
import { parseMethodDescriptor } from "../java-bytecode/descriptors.js";
import type { JavaExternalSymbols } from "./source.js";

const SYNTHETIC = 0x1000;
const BRIDGE = 0x0040;
const DEFAULT_CLASS_LIMIT = 20_000;
const DEFAULT_ARCHIVE_BYTE_LIMIT = 128 * 1024 * 1024;
const DEFAULT_ENTRY_BYTE_LIMIT = 16 * 1024 * 1024;
const DEFAULT_CACHE_ENTRY_LIMIT = 6;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const UTF8_DECODER = new TextDecoder();

interface ClasspathCacheEntry {
  key: string;
  symbols: JavaExternalSymbols;
}

interface ZipClassEntry {
  name: string;
  bytes: Uint8Array;
}

const cache = new Map<string, ClasspathCacheEntry>();
let javaRuntimeCache: { key: string; entries: string[] } | undefined;

export function loadJavaClasspathSymbols(entries: readonly string[]): JavaExternalSymbols {
  const limits = classpathLimits();
  const key = classpathCacheKey(entries, limits);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.symbols;
  }

  const symbols: JavaExternalSymbols = { types: [], methods: [], hierarchy: [] };
  const seenTypes = new Set<string>();
  let scanned = 0;

  const visitClass = (origin: string, bytes: Uint8Array): void => {
    if (scanned >= limits.classCount) return;
    scanned++;
    try {
      const cls = parseClassFile(bytes);
      if (seenTypes.has(cls.thisClass)) return;
      seenTypes.add(cls.thisClass);
      const simpleName = lastSegment(cls.thisClass.replace(/\$/g, "."));
      const kind: Extract<GraphNode["kind"], "Class" | "Interface"> = cls.isInterface
        ? "Interface"
        : "Class";
      symbols.types.push({
        binaryName: cls.thisClass,
        simpleName,
        qualifiedName: cls.thisClass.replace(/\$/g, "."),
        file: `java:${cls.thisClass}`,
        id: `java:${cls.thisClass}`,
        kind,
      });
      if (cls.superClass) {
        symbols.hierarchy.push({
          fromBinaryName: cls.thisClass,
          toBinaryName: cls.superClass,
          kind: "Inherits",
        });
      }
      for (const iface of cls.interfaces) {
        symbols.hierarchy.push({
          fromBinaryName: cls.thisClass,
          toBinaryName: iface,
          kind: cls.isInterface ? "Inherits" : "Implements",
        });
      }
      for (const method of cls.methods) {
        if (method.name === "<clinit>" || (method.accessFlags & (SYNTHETIC | BRIDGE)) !== 0) {
          continue;
        }
        const sourceName = method.name === "<init>" ? simpleName : method.name;
        const descriptor = parseMethodDescriptor(method.descriptor);
        symbols.methods.push({
          ownerBinaryName: cls.thisClass,
          sourceName,
          descriptor: method.descriptor,
          params: descriptor.params,
          returnType: descriptor.returnType,
        });
      }
    } catch (err) {
      console.error(
        `[ama] Java dependency classfile parse failed for ${origin}; skipping it. ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  for (const entry of entries) {
    if (scanned >= limits.classCount) break;
    const stat = fs.statSync(entry, { throwIfNoEntry: false });
    if (!stat) continue;
    if (stat.isDirectory()) {
      for (const file of walkClassFiles(entry)) {
        if (scanned >= limits.classCount) break;
        const bytes = readClassFileBytes(file, limits.entryBytes);
        if (bytes) visitClass(file, bytes);
      }
    } else if (stat.isFile() && isJavaArchive(entry)) {
      if (stat.size > limits.archiveBytes) continue;
      for (const cls of readZipClassEntries(entry, limits.entryBytes)) {
        if (scanned >= limits.classCount) break;
        visitClass(`${entry}!${cls.name}`, cls.bytes);
      }
    } else if (stat.isFile() && entry.endsWith(".class")) {
      const bytes =
        stat.size <= limits.entryBytes ? new Uint8Array(fs.readFileSync(entry)) : undefined;
      if (bytes) visitClass(entry, bytes);
    }
  }

  cache.set(key, { key, symbols });
  pruneClasspathCache(limits.cacheEntries);
  return symbols;
}

export function inferJavaRuntimeClasspathEntries(): string[] {
  const envKey = JSON.stringify([process.env.AMA_JAVA_HOME ?? "", process.env.JAVA_HOME ?? ""]);
  if (javaRuntimeCache?.key === envKey) return javaRuntimeCache.entries;
  const homes = new Set<string>();
  for (const candidate of [process.env.AMA_JAVA_HOME, process.env.JAVA_HOME]) {
    if (candidate) homes.add(candidate);
  }
  const javaHome = spawnSync("/usr/libexec/java_home", [], { encoding: "utf8" });
  if (javaHome.status === 0 && javaHome.stdout.trim()) homes.add(javaHome.stdout.trim());

  const entries: string[] = [];
  for (const home of homes) {
    const javaBase = path.join(home, "jmods", "java.base.jmod");
    if (fs.existsSync(javaBase)) entries.push(javaBase);
    const rtJar = path.join(home, "jre", "lib", "rt.jar");
    if (fs.existsSync(rtJar)) entries.push(rtJar);
    const legacyRtJar = path.join(home, "lib", "rt.jar");
    if (fs.existsSync(legacyRtJar)) entries.push(legacyRtJar);
  }
  javaRuntimeCache = { key: envKey, entries };
  return entries;
}

interface ClasspathLimits {
  classCount: number;
  archiveBytes: number;
  entryBytes: number;
  cacheEntries: number;
}

function classpathLimits(): ClasspathLimits {
  return {
    classCount: positiveIntEnv("AMA_JAVA_CLASSPATH_CLASS_LIMIT", DEFAULT_CLASS_LIMIT),
    archiveBytes: positiveIntEnv(
      "AMA_JAVA_CLASSPATH_ARCHIVE_MAX_BYTES",
      DEFAULT_ARCHIVE_BYTE_LIMIT,
    ),
    entryBytes: positiveIntEnv("AMA_JAVA_CLASSPATH_ENTRY_MAX_BYTES", DEFAULT_ENTRY_BYTE_LIMIT),
    cacheEntries: positiveIntEnv("AMA_JAVA_CLASSPATH_CACHE_ENTRIES", DEFAULT_CACHE_ENTRY_LIMIT),
  };
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function classpathCacheKey(entries: readonly string[], limits: ClasspathLimits): string {
  return JSON.stringify([
    limits.classCount,
    limits.archiveBytes,
    limits.entryBytes,
    ...entries.map((entry) => {
      const stat = fs.statSync(entry, { throwIfNoEntry: false });
      return [entry, stat?.mtimeMs ?? 0, stat?.size ?? 0];
    }),
  ]);
}

function pruneClasspathCache(maxEntries: number): void {
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) return;
    cache.delete(oldest);
  }
}

function* walkClassFiles(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkClassFiles(full);
    else if (entry.isFile() && entry.name.endsWith(".class")) yield full;
  }
}

function isJavaArchive(file: string): boolean {
  return file.endsWith(".jar") || file.endsWith(".jmod");
}

function readClassFileBytes(file: string, maxBytes: number): Uint8Array | undefined {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > maxBytes) return undefined;
  return new Uint8Array(fs.readFileSync(file));
}

function readZipClassEntries(file: string, maxEntryBytes: number): ZipClassEntry[] {
  const bytes = new Uint8Array(fs.readFileSync(file));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd === undefined) return [];
  const entriesTotal = view.getUint16(eocd + 10, true);
  if (entriesTotal === 0xffff) {
    console.error(
      `[ama] Java dependency archive ${file} uses ZIP64; scanning first 65535 entries.`,
    );
  }
  let offset = view.getUint32(eocd + 16, true);
  const out: ZipClassEntry[] = [];
  for (let i = 0; i < entriesTotal; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
      break;
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (
      isClassArchiveEntry(name) &&
      compressedSize <= maxEntryBytes &&
      uncompressedSize <= maxEntryBytes
    ) {
      const data = readZipEntryData(
        bytes,
        view,
        localHeaderOffset,
        compressedSize,
        method,
        maxEntryBytes,
      );
      if (data) out.push({ name, bytes: data });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return out;
}

function findEndOfCentralDirectory(view: DataView): number | undefined {
  const min = Math.max(0, view.byteLength - 22 - 65_535);
  for (let offset = view.byteLength - 22; offset >= min; offset--) {
    if (view.getUint32(offset, true) === ZIP_EOCD_SIGNATURE) return offset;
  }
  return undefined;
}

function isClassArchiveEntry(name: string): boolean {
  if (!name.endsWith(".class")) return false;
  if (name.startsWith("META-INF/versions/")) return false;
  const normalized = name.startsWith("classes/") ? name.slice("classes/".length) : name;
  return normalized !== "module-info.class" && !normalized.endsWith("/package-info.class");
}

function readZipEntryData(
  bytes: Uint8Array,
  view: DataView,
  localHeaderOffset: number,
  compressedSize: number,
  method: number,
  maxEntryBytes: number,
): Uint8Array | undefined {
  if (
    localHeaderOffset + 30 > view.byteLength ||
    view.getUint32(localHeaderOffset, true) !== ZIP_LOCAL_SIGNATURE
  ) {
    return undefined;
  }
  const nameLength = view.getUint16(localHeaderOffset + 26, true);
  const extraLength = view.getUint16(localHeaderOffset + 28, true);
  const start = localHeaderOffset + 30 + nameLength + extraLength;
  if (start + compressedSize > bytes.byteLength) return undefined;
  const compressed = bytes.subarray(start, start + compressedSize);
  if (method === 0) return compressed;
  if (method === 8) {
    try {
      return new Uint8Array(inflateRawSync(compressed, { maxOutputLength: maxEntryBytes }));
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function decode(bytes: Uint8Array): string {
  return UTF8_DECODER.decode(bytes);
}

function lastSegment(name: string): string {
  return name.split(".").pop() ?? name;
}
