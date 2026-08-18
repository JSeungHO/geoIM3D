import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { OBJECT_EXTENSIONS, objectName, type PickedObject } from "@geolibre/plugins";
import i18next from "i18next";
import { isTauri } from "./is-tauri";
import { fetchUrlBytes } from "./native-http";

/**
 * The two shells the 3D object plugin cannot provide for itself: reading a
 * plain-`http://` URL, and reading a file off disk.
 *
 * Both exist because the webview is fenced in, and each is fenced differently:
 *
 * - **http URLs.** The desktop CSP's `connect-src` allows `https:` and
 *   localhost only, so a request to any other plain-HTTP host never leaves the
 *   webview. Rather than widen the CSP — `tauri.conf.json` is an upstream file,
 *   and opening it would relax the whole app, not just this feature — the bytes
 *   are fetched natively and handed back as a `blob:` URL, which the CSP
 *   already allows. In a browser there is nothing to do: mixed content is the
 *   browser's own rule and no code here can get around it.
 * - **local files.** Tauri keeps the filesystem and asset scopes separate, so a
 *   dialog pick has to be authorized for the asset protocol before it can be
 *   read through one. That path streams; the browser falls back to a `blob:`
 *   URL of the whole file, which is all a browser can offer.
 */

/**
 * Fetches a URL the webview may not request and returns one it may.
 *
 * @param url - The plain-HTTP address.
 * @returns A `blob:` URL the caller owns and must revoke.
 */
export async function fetchObjectAsBlobUrl(url: string): Promise<string> {
  const bytes = await fetchUrlBytes(url, { context: "3d-object" });
  // Tauri may hand back a plain number array rather than a typed array.
  const body = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  return URL.createObjectURL(new Blob([body as unknown as BlobPart]));
}

/**
 * Opens a file dialog and returns what the user chose, ready to load.
 *
 * On the desktop each pick is authorized for the asset protocol and addressed
 * through it, so the renderer streams from disk — a gaussian splat is routinely
 * hundreds of megabytes, and copying that through IPC into a blob would double
 * it in memory for no gain. In a browser a blob is the only option.
 *
 * @returns The picked files, or an empty array when the dialog was cancelled.
 */
export async function pickLocalObjects(): Promise<PickedObject[]> {
  if (!isTauri()) return pickLocalObjectsInBrowser();

  const selected = await open({
    multiple: true,
    filters: [
      {
        name: i18next.t("objects.filePickerLabel", { defaultValue: "3D objects" }),
        extensions: [...OBJECT_EXTENSIONS],
      },
    ],
  });
  if (!selected) return [];

  const paths = Array.isArray(selected) ? selected : [selected];
  const picked: PickedObject[] = [];
  for (const path of paths) {
    // One unreadable pick must not abandon the rest of the selection, matching
    // pickLocalRasterFiles.
    try {
      picked.push(await openLocalObject(path));
    } catch (error) {
      console.warn(`Could not open the selected 3D object "${path}".`, error);
    }
  }
  return picked;
}

/**
 * The browser fallback: a hidden file input, read into blob URLs.
 *
 * @returns The picked files, or an empty array when the dialog was dismissed.
 */
function pickLocalObjectsInBrowser(): Promise<PickedObject[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = OBJECT_EXTENSIONS.map((extension) => `.${extension}`).join(",");
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? []);
      resolve(
        files.map((file) => ({
          url: URL.createObjectURL(file),
          name: file.name,
          revocable: true,
        })),
      );
    });
    // A dismissed dialog fires no `change` event in most browsers, so the
    // promise would hang and leave the panel stuck on "loading". `cancel` is
    // widely supported now; where it is not, the user can simply pick again.
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

/**
 * Reopens a file a saved sample recorded by path.
 *
 * Works across restarts because Tauri's persisted-scope plugin keeps a file the
 * user once picked authorized; without that the path would be refused and a
 * saved sample would only ever load in the session that created it.
 *
 * @param path - The absolute path recorded with the sample.
 * @returns The reopened file, or null when it can no longer be read.
 */
export async function resolveLocalObject(path: string): Promise<PickedObject | null> {
  if (!isTauri()) return null;
  try {
    return await openLocalObject(path);
  } catch (error) {
    console.warn(`Could not reopen the saved 3D object "${path}".`, error);
    return null;
  }
}

/**
 * Authorizes one path for the asset protocol and addresses it.
 *
 * @param path - The absolute path.
 * @returns The file, ready for the loader.
 */
async function openLocalObject(path: string): Promise<PickedObject> {
  await invoke("allow_object_asset", { path });
  return { url: convertFileSrc(path), name: objectName(path), revocable: false, path };
}
