/**
 * geoIM3D 3D object upload.
 *
 * Puts local files and plain-`http://` URLs on the map, which Add Data could
 * not do: the desktop CSP allows `connect-src` to `https:` and localhost only,
 * so a webview request to any other plain-HTTP host is blocked before it is
 * sent, and there was no entry point for a file on disk at all.
 *
 * Nothing here renders anything. `maplibre-gl-splat` already loads `.splat`,
 * `.ply`, `.spz`, `.ksplat`, `.sog` and glTF/GLB, and already places them by
 * longitude/latitude/altitude with a scale and an XYZ rotation — this file is
 * the way in, plus the two shells that a webview cannot reach on its own:
 *
 * - **http URLs** go through {@link setObjectFetcher}, which the desktop app
 *   backs with a native request and hands back a `blob:` URL. That leaves the
 *   CSP untouched, so `tauri.conf.json` — an upstream file — needs no edit and
 *   cannot conflict on a merge.
 * - **local files** go through {@link setLocalObjectPicker}: a native dialog on
 *   the desktop (streamed from disk through the asset protocol) and a file
 *   input in the browser.
 *
 * `https:` skips both and is handed to the loader as-is; there is no reason to
 * pull a few hundred megabytes through memory when the webview can stream it.
 *
 * 3D Tiles are deliberately *not* handled here — a tileset carries its own
 * georeferencing, so position/scale/rotation do not apply to it. The menu
 * points at the existing 3D Tiles panel instead.
 */

import type { GeoLibreAppAPI, GeoLibrePlugin } from "../types";
import { openThreeDTilesLayerPanel } from "./maplibre-3d-tiles";

export const GEOIM3D_OBJECTS_PLUGIN_ID = "geoim3d-objects";
const PANEL_ID = "geoim3d-objects-panel";
const FLOATING_PANEL_ID = `${PANEL_ID}-floating`;
const MENU_ID = "geoim3d-objects-menu";

/* -------------------------------------------------------------------------- */
/* Formats                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What the loader treats a file as. It routes glTF/GLB through its model path
 * and everything else through its splat path, and the two want different
 * default rotations, so the distinction has to survive up here too.
 */
export type ObjectKind = "splat" | "model";

/** Extensions the splat loader accepts, by kind. */
const SPLAT_EXTENSIONS = ["splat", "ply", "spz", "ksplat", "sog"];
const MODEL_EXTENSIONS = ["glb", "gltf"];

/** Every extension this plugin offers, for a file dialog's filter. */
export const OBJECT_EXTENSIONS: readonly string[] = [...SPLAT_EXTENSIONS, ...MODEL_EXTENSIONS];

/**
 * Classifies a source by its file extension.
 *
 * Parsed off the **path**, not the whole string: a signed URL
 * (`scene.glb?X-Amz-Signature=…`) or a fragment would otherwise make the
 * extension unrecognizable, and the loader would refuse a file it can read.
 * Falls back to splitting on the raw string for a bare Windows path, which is
 * not a URL at all.
 *
 * @param source - A URL or a filesystem path.
 * @returns The kind, or null when the extension is not one this plugin loads.
 */
export function objectKind(source: string): ObjectKind | null {
  const path = source.split(/[?#]/, 1)[0] ?? "";
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (MODEL_EXTENSIONS.includes(extension)) return "model";
  if (SPLAT_EXTENSIONS.includes(extension)) return "splat";
  return null;
}

/**
 * The loader's own default orientation for a kind.
 *
 * Splats and glTF models are authored in different axis conventions, so a
 * single default lays one of them on its side. These mirror the defaults
 * `maplibre-gl-splat` documents for `defaultRotation` and
 * `defaultModelRotation`.
 *
 * @param kind - What the file is.
 * @returns Rotation in degrees, `[x, y, z]`.
 */
export function defaultRotation(kind: ObjectKind): [number, number, number] {
  return kind === "model" ? [90, 0, 0] : [-90, 90, 0];
}

/**
 * A readable name for a source, for the panel's list.
 *
 * @param source - A URL or a filesystem path.
 * @returns The final path segment, or the source itself when it has none.
 */
export function objectName(source: string): string {
  const path = source.split(/[?#]/, 1)[0] ?? source;
  const segment = path.split(/[/\\]/).pop();
  return segment && segment.length > 0 ? decodeURIComponent(segment) : source;
}

/* -------------------------------------------------------------------------- */
/* Host-provided shells                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Fetches a URL the webview may not request itself and returns a URL it can.
 * The desktop app reads the bytes natively and hands back a `blob:` URL.
 */
export type ObjectFetcher = (url: string) => Promise<string>;

/** A file the user picked, already addressable by the loader. */
export interface PickedObject {
  /** A URL the loader can read: an `asset:` URL on the desktop, `blob:` in a browser. */
  url: string;
  /** What to show in the list — the file's own name, not the opaque URL. */
  name: string;
  /** True when `url` is a `blob:` URL this plugin has to revoke. */
  revocable: boolean;
}

/** Opens a file dialog and resolves what the user chose (empty when cancelled). */
export type LocalObjectPicker = () => Promise<PickedObject[]>;

let objectFetcher: ObjectFetcher | null = null;
let localObjectPicker: LocalObjectPicker | null = null;

/**
 * Registers (or clears) the native fetcher used for plain-HTTP URLs.
 *
 * @param fetcher - The fetcher, or null to unregister.
 */
export function setObjectFetcher(fetcher: ObjectFetcher | null): void {
  objectFetcher = fetcher;
  rerenderPanel();
}

/**
 * Registers (or clears) the local file picker.
 *
 * @param picker - The picker, or null to unregister.
 */
export function setLocalObjectPicker(picker: LocalObjectPicker | null): void {
  localObjectPicker = picker;
  rerenderPanel();
}

/**
 * Whether a source has to go through the native fetcher to be loadable.
 *
 * Only plain HTTP does. `https:` streams straight from the webview, and
 * `blob:`/`asset:`/`file:` are already local.
 *
 * @param source - The URL to load.
 * @returns True when the webview cannot request it directly.
 */
export function needsNativeFetch(source: string): boolean {
  return /^http:\/\//i.test(source);
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * User-facing strings. This package is framework-agnostic and cannot call
 * react-i18next's `t()`, so the host pushes translations through
 * {@link setGeoim3dObjectLabels}, as the VWorld and KMA plugins do. Defaults
 * are English.
 */
export interface Geoim3dObjectLabels {
  title: string;
  getTitle?: () => string;
  menuLabel: string;
  openPanel: string;
  openPanelFloating: string;
  addFromUrl: string;
  addFromFile: string;
  threeDTiles: string;
  urlPlaceholder: string;
  load: string;
  loading: string;
  browse: string;
  loaded: string;
  empty: string;
  longitude: string;
  latitude: string;
  altitude: string;
  scale: string;
  rotation: string;
  apply: string;
  remove: string;
  errorUnsupported: string;
  errorHttpUnavailable: string;
  errorPickerUnavailable: string;
  errorLoadFailed: string;
  errorRendererUnavailable: string;
}

let labels: Geoim3dObjectLabels = {
  title: "3D objects",
  menuLabel: "3D objects",
  openPanel: "Object upload…",
  openPanelFloating: "Object upload (detached)…",
  addFromUrl: "Add from URL…",
  addFromFile: "Add from a file…",
  threeDTiles: "3D Tiles…",
  urlPlaceholder: "https:// or http:// address of a .splat, .ply, .sog or .glb",
  load: "Load",
  loading: "Loading…",
  browse: "Choose a file…",
  loaded: "Loaded objects",
  empty: "Nothing loaded yet.",
  longitude: "Longitude",
  latitude: "Latitude",
  altitude: "Altitude (m)",
  scale: "Scale",
  rotation: "Rotation (°)",
  apply: "Apply",
  remove: "Remove",
  errorUnsupported:
    "Not a format this plugin loads (.splat, .ply, .spz, .ksplat, .sog, .glb, .gltf).",
  errorHttpUnavailable:
    "Plain http:// addresses can only be read by the desktop app. Use https, or a local file.",
  errorPickerUnavailable: "Choosing a file is not available in this build.",
  errorLoadFailed: "The object could not be loaded.",
  errorRendererUnavailable: "The 3D object renderer could not be loaded.",
};

/**
 * Replaces some or all of the user-facing strings.
 *
 * @param next - The strings to override.
 */
export function setGeoim3dObjectLabels(next: Partial<Geoim3dObjectLabels>): void {
  labels = { ...labels, ...next };
  rerenderPanel();
  // The menu copies its labels when it is built, so a language change has to
  // rebuild it or it sits in the old one.
  if (state.app) buildToolbarMenu(state.app);
}

/* -------------------------------------------------------------------------- */
/* State                                                                        */
/* -------------------------------------------------------------------------- */

/** Where an object sits and how it is oriented. */
export interface ObjectTransform {
  longitude: number;
  latitude: number;
  altitude: number;
  scale: number;
  rotation: [number, number, number];
}

interface LoadedObject {
  /** The loader's own id, which changes on every reload. */
  loaderId: string;
  name: string;
  kind: ObjectKind;
  /** What the loader is actually reading: the original URL, or a blob of it. */
  readableUrl: string;
  /** True when `readableUrl` must be revoked once the object is gone. */
  revocable: boolean;
  transform: ObjectTransform;
}

interface PanelState {
  app: GeoLibreAppAPI | null;
  container: HTMLElement | null;
  /** The `maplibre-gl-splat` control, which does the actual rendering. */
  control: SplatControlLike | null;
  objects: LoadedObject[];
  urlDraft: string;
  busy: boolean;
  status: string;
}

const state: PanelState = {
  app: null,
  container: null,
  control: null,
  objects: [],
  urlDraft: "",
  busy: false,
  status: "",
};

/**
 * The part of `maplibre-gl-splat`'s control this plugin drives. Typed
 * structurally because the module is imported dynamically — pulling its types
 * in statically would put the whole renderer in the boot graph.
 */
interface SplatControlLike {
  load(
    url: string,
    options?: {
      longitude?: number;
      latitude?: number;
      altitude?: number;
      rotation?: [number, number, number];
      scale?: number;
    },
  ): Promise<string>;
  removeSplat(layerId: string): void;
  removeModel(layerId: string): void;
  collapse(): void;
}

function setStatus(message: string): void {
  state.status = message;
}

function rerenderPanel(): void {
  if (state.container) renderPanel(state.container);
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Resolves the renderer, loading it on first use.
 *
 * Imported dynamically and added collapsed: this panel is the interface, and
 * the control is here only to draw. A failure is reported rather than thrown,
 * so a missing chunk does not take the plugin down with it.
 *
 * @param app - The host API.
 * @returns The control, or null when it could not be loaded.
 */
async function ensureControl(app: GeoLibreAppAPI): Promise<SplatControlLike | null> {
  if (state.control) return state.control;
  try {
    const module = (await import("maplibre-gl-splat")) as {
      GaussianSplatControl: new (options?: Record<string, unknown>) => SplatControlLike;
    };
    const control = new module.GaussianSplatControl({ flyTo: true });
    app.addMapControl(control as never, "top-left");
    control.collapse();
    state.control = control;
    return control;
  } catch (error) {
    console.warn("geoim3d-objects: the splat renderer failed to load", error);
    return null;
  }
}

/**
 * Turns a source into something the webview is allowed to read.
 *
 * @param source - The URL the user gave.
 * @returns The readable URL and whether it has to be revoked afterwards.
 * @throws When plain HTTP is used without a native fetcher to read it.
 */
async function resolveReadableUrl(source: string): Promise<{ url: string; revocable: boolean }> {
  if (!needsNativeFetch(source)) return { url: source, revocable: false };
  if (!objectFetcher) throw new Error("http-unavailable");
  return { url: await objectFetcher(source), revocable: true };
}

/**
 * Loads an object and adds it to the panel's list.
 *
 * @param app - The host API.
 * @param source - The URL or path the user gave.
 * @param name - What to call it in the list.
 * @param prepared - An already-readable URL (a picked local file), if any.
 */
async function loadObject(
  app: GeoLibreAppAPI,
  source: string,
  name: string,
  prepared?: { url: string; revocable: boolean },
): Promise<void> {
  const kind = objectKind(source);
  if (!kind) {
    setStatus(labels.errorUnsupported);
    rerenderPanel();
    return;
  }

  state.busy = true;
  setStatus("");
  rerenderPanel();

  let readable: { url: string; revocable: boolean } | null = null;
  try {
    const control = await ensureControl(app);
    if (!control) throw new Error("renderer-unavailable");

    readable = prepared ?? (await resolveReadableUrl(source));
    // Start where the user is looking. Without this an object with no
    // coordinates of its own lands at (0, 0), in the Atlantic.
    const center = app.getMap?.()?.getCenter();
    const transform: ObjectTransform = {
      longitude: center?.lng ?? 0,
      latitude: center?.lat ?? 0,
      altitude: 0,
      scale: 1,
      rotation: defaultRotation(kind),
    };
    const loaderId = await control.load(readable.url, {
      longitude: transform.longitude,
      latitude: transform.latitude,
      altitude: transform.altitude,
      rotation: transform.rotation,
      scale: transform.scale,
    });
    state.objects.push({
      loaderId,
      name,
      kind,
      readableUrl: readable.url,
      revocable: readable.revocable,
      transform,
    });
    state.urlDraft = "";
  } catch (error) {
    // A blob made for a load that then failed would otherwise be held until
    // the tab closes, and these are hundreds of megabytes.
    if (readable?.revocable) URL.revokeObjectURL(readable.url);
    setStatus(loadErrorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

/**
 * Maps a load failure to a message that says what to do about it.
 *
 * @param error - The thrown value.
 * @returns The message to show.
 */
function loadErrorMessage(error: unknown): string {
  const reason = error instanceof Error ? error.message : "";
  if (reason === "http-unavailable") return labels.errorHttpUnavailable;
  if (reason === "renderer-unavailable") return labels.errorRendererUnavailable;
  return labels.errorLoadFailed;
}

/**
 * Removes an object from the map and the list.
 *
 * @param object - The object to remove.
 */
function removeObject(object: LoadedObject): void {
  removeFromRenderer(object);
  if (object.revocable) URL.revokeObjectURL(object.readableUrl);
  state.objects = state.objects.filter((entry) => entry !== object);
  rerenderPanel();
}

function removeFromRenderer(object: LoadedObject): void {
  const control = state.control;
  if (!control) return;
  if (object.kind === "model") control.removeModel(object.loaderId);
  else control.removeSplat(object.loaderId);
}

/**
 * Re-places an object with an edited transform.
 *
 * The renderer has no way to move something it has already loaded — only
 * `load` and `remove` — so this drops it and loads it again. The readable URL
 * is reused rather than re-fetched, which matters for an http object that
 * would otherwise cross the network on every nudge.
 *
 * @param object - The object being edited.
 * @param transform - The values from the form.
 */
async function applyTransform(object: LoadedObject, transform: ObjectTransform): Promise<void> {
  const control = state.control;
  if (!control) return;

  state.busy = true;
  setStatus("");
  rerenderPanel();
  try {
    removeFromRenderer(object);
    // The loader mints a new id per load; keeping the old one would leave the
    // next remove pointing at something that is no longer there.
    object.loaderId = await control.load(object.readableUrl, {
      longitude: transform.longitude,
      latitude: transform.latitude,
      altitude: transform.altitude,
      rotation: transform.rotation,
      scale: transform.scale,
    });
    object.transform = transform;
  } catch (error) {
    setStatus(loadErrorMessage(error));
  } finally {
    state.busy = false;
    rerenderPanel();
  }
}

async function pickAndLoad(app: GeoLibreAppAPI): Promise<void> {
  if (!localObjectPicker) {
    setStatus(labels.errorPickerUnavailable);
    rerenderPanel();
    return;
  }
  const picked = await localObjectPicker();
  for (const file of picked) {
    await loadObject(app, file.name, file.name, {
      url: file.url,
      revocable: file.revocable,
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Panel                                                                        */
/* -------------------------------------------------------------------------- */

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function sectionTitle(text: string): HTMLElement {
  return element("h3", "geolibre-plugin-panel__section-title", text);
}

/**
 * A labelled number box for one transform field.
 *
 * @param labelText - The field's label.
 * @param value - Its current value.
 * @param step - The input's step, which also sets how fine the spinner is.
 * @returns The row and its input.
 */
function numberField(
  labelText: string,
  value: number,
  step: number,
): { row: HTMLElement; input: HTMLInputElement } {
  const row = element("label", "geoim3d-object__field");
  row.appendChild(element("span", "geoim3d-object__field-label", labelText));
  const input = element("input", "geolibre-plugin-panel__input");
  input.type = "number";
  input.step = String(step);
  input.value = String(value);
  row.appendChild(input);
  return { row, input };
}

/**
 * One loaded object: what it is, where it sits, and the controls to change it.
 *
 * @param object - The object to render.
 * @returns The block.
 */
function objectBlock(object: LoadedObject): HTMLElement {
  const wrapper = element("div", "geoim3d-object");
  wrapper.appendChild(element("p", "geoim3d-object__name", object.name));

  const { transform } = object;
  const lon = numberField(labels.longitude, transform.longitude, 0.0001);
  const lat = numberField(labels.latitude, transform.latitude, 0.0001);
  const alt = numberField(labels.altitude, transform.altitude, 1);
  const scale = numberField(labels.scale, transform.scale, 0.1);
  for (const field of [lon, lat, alt, scale]) wrapper.appendChild(field.row);

  wrapper.appendChild(element("span", "geoim3d-object__field-label", labels.rotation));
  const rotationRow = element("div", "geoim3d-object__rotation");
  const rotationInputs = (["x", "y", "z"] as const).map((axis, index) => {
    const input = element("input", "geolibre-plugin-panel__input");
    input.type = "number";
    input.step = "1";
    input.value = String(transform.rotation[index]);
    input.setAttribute("aria-label", `${labels.rotation} ${axis.toUpperCase()}`);
    rotationRow.appendChild(input);
    return input;
  });
  wrapper.appendChild(rotationRow);

  const actions = element("div", "geoim3d-object__actions");
  const apply = element("button", "geolibre-plugin-panel__button", labels.apply);
  apply.type = "button";
  apply.disabled = state.busy;
  // Applied on the button, not on input: a reload re-parses the whole file, so
  // reacting to every keystroke would stall the map on a large object.
  apply.addEventListener("click", () => {
    void applyTransform(object, {
      longitude: Number(lon.input.value),
      latitude: Number(lat.input.value),
      altitude: Number(alt.input.value),
      scale: Number(scale.input.value),
      rotation: rotationInputs.map((input) => Number(input.value)) as [number, number, number],
    });
  });
  actions.appendChild(apply);

  const remove = element("button", "geolibre-plugin-panel__button", labels.remove);
  remove.type = "button";
  remove.addEventListener("click", () => removeObject(object));
  actions.appendChild(remove);
  wrapper.appendChild(actions);

  return wrapper;
}

function renderPanel(container: HTMLElement): void {
  const app = state.app;
  if (!app) return;
  container.textContent = "";
  container.className = "geolibre-plugin-panel";

  // Add from a URL.
  container.appendChild(sectionTitle(labels.addFromUrl));
  const form = element("form", "geolibre-plugin-panel__form");
  const urlInput = element("input", "geolibre-plugin-panel__input");
  urlInput.type = "text";
  urlInput.placeholder = labels.urlPlaceholder;
  urlInput.value = state.urlDraft;
  urlInput.addEventListener("input", () => {
    state.urlDraft = urlInput.value;
  });
  form.appendChild(urlInput);
  const submit = element(
    "button",
    "geolibre-plugin-panel__button",
    state.busy ? labels.loading : labels.load,
  );
  submit.type = "submit";
  submit.disabled = state.busy;
  form.appendChild(submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const source = state.urlDraft.trim();
    if (source) void loadObject(app, source, objectName(source));
  });
  container.appendChild(form);

  // Add from a file.
  const browse = element(
    "button",
    "geolibre-plugin-panel__button geolibre-plugin-panel__button--wide",
    labels.browse,
  );
  browse.type = "button";
  browse.disabled = state.busy || !localObjectPicker;
  browse.addEventListener("click", () => void pickAndLoad(app));
  container.appendChild(browse);

  if (state.status) {
    container.appendChild(element("p", "geolibre-plugin-panel__notice", state.status));
  }

  // What is on the map.
  container.appendChild(sectionTitle(labels.loaded));
  if (state.objects.length === 0) {
    container.appendChild(element("p", "geolibre-plugin-panel__status", labels.empty));
    return;
  }
  for (const object of state.objects) container.appendChild(objectBlock(object));
}

/**
 * Mounts the panel body into whichever shell asked for it — docked or floating.
 *
 * @param container - The host-provided element.
 * @returns The cleanup the host runs when that shell closes.
 */
function mountPanel(container: HTMLElement): () => void {
  state.container = container;
  renderPanel(container);
  return () => {
    if (state.container === container) state.container = null;
  };
}

/**
 * Shows the panel docked in the right sidebar, closing the detached card.
 *
 * @param app - The host API.
 */
function showDockedPanel(app: GeoLibreAppAPI): void {
  app.closeFloatingPanel?.(FLOATING_PANEL_ID);
  app.openRightPanel?.(PANEL_ID);
}

/**
 * Shows the panel as a floating card, closing the docked one.
 *
 * @param app - The host API.
 */
function showFloatingPanel(app: GeoLibreAppAPI): void {
  app.closeRightPanel?.(PANEL_ID);
  app.openFloatingPanel?.(FLOATING_PANEL_ID);
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                         */
/* -------------------------------------------------------------------------- */

let unregisterMenu: (() => void) | null = null;

function buildToolbarMenu(app: GeoLibreAppAPI): void {
  unregisterMenu?.();
  unregisterMenu =
    app.registerToolbarMenu?.({
      id: MENU_ID,
      label: labels.menuLabel,
      items: [
        {
          id: `${MENU_ID}-url`,
          label: labels.addFromUrl,
          onSelect: () => showDockedPanel(app),
        },
        {
          id: `${MENU_ID}-file`,
          label: labels.addFromFile,
          disabled: !localObjectPicker,
          onSelect: () => {
            showDockedPanel(app);
            void pickAndLoad(app);
          },
        },
        { type: "separator" },
        {
          // A tileset is georeferenced, so the transform editor above does not
          // apply to it; the existing 3D Tiles panel owns that flow.
          id: `${MENU_ID}-3d-tiles`,
          label: labels.threeDTiles,
          onSelect: () => openThreeDTilesLayerPanel(app),
        },
        { type: "separator" },
        {
          id: `${MENU_ID}-panel`,
          label: labels.openPanel,
          onSelect: () => showDockedPanel(app),
        },
        {
          id: `${MENU_ID}-panel-floating`,
          label: labels.openPanelFloating,
          onSelect: () => showFloatingPanel(app),
        },
      ],
    }) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Plugin                                                                       */
/* -------------------------------------------------------------------------- */

export const geoim3dObjectsPlugin: GeoLibrePlugin = {
  id: GEOIM3D_OBJECTS_PLUGIN_ID,
  name: "3D objects",
  version: "0.1.0",

  activate(app: GeoLibreAppAPI) {
    state.app = app;
    buildToolbarMenu(app);
    app.registerRightPanel?.({
      id: PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      defaultWidth: 340,
      render: mountPanel,
    });
    app.registerFloatingPanel?.({
      id: FLOATING_PANEL_ID,
      title: () => labels.getTitle?.() ?? labels.title,
      defaultWidth: 340,
      render: mountPanel,
    });
  },

  deactivate(app: GeoLibreAppAPI) {
    unregisterMenu?.();
    unregisterMenu = null;
    app.closeRightPanel?.(PANEL_ID);
    app.unregisterRightPanel?.(PANEL_ID);
    app.closeFloatingPanel?.(FLOATING_PANEL_ID);
    app.unregisterFloatingPanel?.(FLOATING_PANEL_ID);

    // Every object goes with the plugin, and every blob made for one is
    // released — they are the largest thing this plugin holds.
    for (const object of state.objects) {
      removeFromRenderer(object);
      if (object.revocable) URL.revokeObjectURL(object.readableUrl);
    }
    state.objects = [];
    if (state.control) {
      app.removeMapControl(state.control as never);
      state.control = null;
    }
    state.container = null;
    state.app = null;
    state.urlDraft = "";
    state.status = "";
  },
};
