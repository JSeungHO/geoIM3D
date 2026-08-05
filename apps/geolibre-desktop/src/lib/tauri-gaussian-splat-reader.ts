import { open } from "@tauri-apps/plugin-fs";
import {
  isGaussianSplatSogZip,
  MAX_NATIVE_GAUSSIAN_SPLAT_BYTES,
} from "./gaussian-splat-drop";

const PAYLOAD_CHUNK_BYTES = 1024 * 1024;
const ZIP_INSPECTION_CHUNK_BYTES = 64 * 1024;

export class NativeGaussianSplatTooLargeError extends Error {
  constructor(
    readonly fileName: string,
    readonly maxBytes: number,
  ) {
    super(`${fileName} exceeds the native Gaussian Splat import limit.`);
    this.name = "NativeGaussianSplatTooLargeError";
  }
}

/** Read one native Splat from one open handle while enforcing the byte ceiling. */
export async function readNativeGaussianSplatFile(
  path: string,
  name: string,
  maxBytes = MAX_NATIVE_GAUSSIAN_SPLAT_BYTES,
): Promise<File> {
  const handle = await open(path, { read: true });
  const chunks: ArrayBuffer[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const chunk = new Uint8Array(PAYLOAD_CHUNK_BYTES);
      const count = await handle.read(chunk);
      if (count === null) break;
      totalBytes += count;
      if (totalBytes > maxBytes) {
        throw new NativeGaussianSplatTooLargeError(name, maxBytes);
      }
      chunks.push(chunk.slice(0, count).buffer as ArrayBuffer);
    }
  } finally {
    await handle.close();
  }

  return new File(chunks, name, {
    type: name.toLowerCase().endsWith(".zip")
      ? "application/zip"
      : "application/octet-stream",
  });
}

/** Inspect a native ZIP through a bounded stream without materializing the archive. */
export async function inspectNativeGaussianSplatZip(
  path: string,
  name: string,
): Promise<boolean> {
  const handle = await open(path, { read: true });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await handle.close();
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = new Uint8Array(ZIP_INSPECTION_CHUNK_BYTES);
        const count = await handle.read(chunk);
        if (count === null) {
          await close();
          controller.close();
          return;
        }
        controller.enqueue(count === chunk.length ? chunk : chunk.slice(0, count));
      } catch (error) {
        await close().catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel() {
      await close();
    },
  });

  try {
    return await isGaussianSplatSogZip({ name, stream: () => stream });
  } finally {
    await close().catch(() => undefined);
  }
}
