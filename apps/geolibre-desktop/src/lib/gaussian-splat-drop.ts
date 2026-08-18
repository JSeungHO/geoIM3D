import { strFromU8, Unzip, UnzipInflate } from "fflate";

export interface NamedFile {
  name: string;
}

export interface ReadableNamedFile extends NamedFile {
  stream(): ReadableStream<Uint8Array>;
}

export type GaussianSplatPathReader = (path: string, name: string) => Promise<File>;
export type GaussianSplatZipInspector = (path: string, name: string) => Promise<boolean>;

export interface GaussianSplatPlacement {
  longitude: number;
  latitude: number;
}

const MAX_SOG_META_BYTES = 1024 * 1024;
const MAX_SOG_ZIP_INSPECTION_BYTES = 64 * 1024 * 1024;
export const MAX_NATIVE_GAUSSIAN_SPLAT_BYTES = 2 * 1024 * 1024 * 1024;

/** Translate the shared map camera center into the splat control's coordinates. */
export function gaussianSplatPlacementAtMapCenter(
  center: readonly [number, number],
): GaussianSplatPlacement {
  return { longitude: center[0], latitude: center[1] };
}

/** Keep local splats on the renderer that owns the Gaussian custom layer. */
export function selectGaussianSplatRenderingWorkspace(
  splatFileCount: number,
  selectTab: (tab: "maplibre") => void,
): boolean {
  if (splatFileCount <= 0) return false;
  selectTab("maplibre");
  return true;
}

export function isGaussianSplatPlyFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".ply");
}

export function isGaussianSplatSogFileName(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".sog");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasStringFiles(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Array.isArray(value.files) &&
    value.files.length > 0 &&
    value.files.every((file) => typeof file === "string" && file.length > 0)
  );
}

export function isGaussianSplatSogMetadata(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const means = value.means;
  const scales = value.scales;
  const quats = value.quats;
  const sh0 = value.sh0;
  if (![means, scales, quats, sh0].every(hasStringFiles)) return false;

  if (value.version === 2) {
    return (
      Array.isArray((means as Record<string, unknown>).mins) &&
      Array.isArray((means as Record<string, unknown>).maxs) &&
      Array.isArray((scales as Record<string, unknown>).codebook) &&
      Array.isArray((sh0 as Record<string, unknown>).codebook)
    );
  }

  return [means, scales, quats, sh0].every((part, index) => {
    const record = part as Record<string, unknown>;
    return (
      Array.isArray(record.shape) &&
      (index === 2 || (Array.isArray(record.mins) && Array.isArray(record.maxs)))
    );
  });
}

/**
 * Inspect only a bounded `meta.json` entry so ordinary ZIP datasets are not
 * routed into the SOG renderer. Other archive entries are not decompressed.
 */
export async function isGaussianSplatSogZip(file: ReadableNamedFile): Promise<boolean> {
  if (!file.name.trim().toLowerCase().endsWith(".zip")) return false;

  let validMetadata = false;
  let archiveError = false;
  let inspectedBytes = 0;
  const unzip = new Unzip((entry) => {
    const baseName = entry.name.split(/[\\/]/).pop()?.toLowerCase();
    if (
      baseName !== "meta.json" ||
      (typeof entry.originalSize === "number" && entry.originalSize > MAX_SOG_META_BYTES)
    ) {
      return;
    }

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    entry.ondata = (error, chunk, final) => {
      if (error) {
        archiveError = true;
        return;
      }
      totalBytes += chunk.length;
      if (totalBytes > MAX_SOG_META_BYTES) {
        archiveError = true;
        return;
      }
      chunks.push(chunk);
      if (!final) return;

      try {
        const metadataBytes = new Uint8Array(totalBytes);
        let offset = 0;
        for (const part of chunks) {
          metadataBytes.set(part, offset);
          offset += part.length;
        }
        validMetadata = isGaussianSplatSogMetadata(
          JSON.parse(strFromU8(metadataBytes)) as unknown,
        );
      } catch {
        archiveError = true;
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);

  const reader = file.stream().getReader();
  try {
    while (!validMetadata && !archiveError) {
      const { value, done } = await reader.read();
      inspectedBytes += value?.byteLength ?? 0;
      if (inspectedBytes > MAX_SOG_ZIP_INSPECTION_BYTES) {
        archiveError = true;
        break;
      }
      unzip.push(value ?? new Uint8Array(), done);
      if (done) break;
    }
    return validMetadata && !archiveError;
  } catch {
    return false;
  } finally {
    if (validMetadata || archiveError) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function partitionGaussianSplatPlyFiles<T extends NamedFile>(files: readonly T[]): {
  splatFiles: T[];
  otherFiles: T[];
} {
  const splatFiles: T[] = [];
  const otherFiles: T[] = [];

  for (const file of files) {
    (isGaussianSplatPlyFileName(file.name) ? splatFiles : otherFiles).push(file);
  }

  return { splatFiles, otherFiles };
}

export async function partitionGaussianSplatFiles<T extends ReadableNamedFile>(
  files: readonly T[],
): Promise<{ splatFiles: T[]; otherFiles: T[] }> {
  const splatFiles: T[] = [];
  const otherFiles: T[] = [];

  for (const file of files) {
    const isSplat =
      isGaussianSplatPlyFileName(file.name) ||
      isGaussianSplatSogFileName(file.name) ||
      (await isGaussianSplatSogZip(file));
    (isSplat ? splatFiles : otherFiles).push(file);
  }

  return { splatFiles, otherFiles };
}

function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop()?.trim() || "local-splat";
}

/**
 * Partition Tauri's native path-only drop payload before the generic
 * vector/raster path. Direct PLY/SOG names are authoritative; generic ZIPs are
 * read only to perform the same bounded SOG meta.json inspection as browser
 * File drops. Returned Files remain session-only and never expose the absolute
 * source path to the renderer or project document.
 */
export async function partitionGaussianSplatPaths(
  paths: readonly string[],
  readPath: GaussianSplatPathReader,
  inspectZipPath: GaussianSplatZipInspector,
): Promise<{
  splatFiles: File[];
  otherPaths: string[];
  splatFailures: Array<{ path: string; error: unknown }>;
}> {
  const splatFiles: File[] = [];
  const otherPaths: string[] = [];
  const splatFailures: Array<{ path: string; error: unknown }> = [];

  for (const path of paths) {
    const name = fileNameFromPath(path);
    const directSplat =
      isGaussianSplatPlyFileName(name) || isGaussianSplatSogFileName(name);
    const zipCandidate = name.toLowerCase().endsWith(".zip");
    if (!directSplat && !zipCandidate) {
      otherPaths.push(path);
      continue;
    }

    try {
      if (zipCandidate && !(await inspectZipPath(path, name))) {
        otherPaths.push(path);
        continue;
      }

      // Read the full payload exactly once, and only after a ZIP passed the
      // streaming metadata inspection supplied by the native host.
      splatFiles.push(await readPath(path, name));
    } catch (error) {
      splatFailures.push({ path, error });
    }
  }

  return { splatFiles, otherPaths, splatFailures };
}
