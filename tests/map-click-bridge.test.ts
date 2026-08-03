import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  setPrimaryCesiumViewer,
  subscribeMapClick,
} from "../apps/geolibre-desktop/src/lib/map-click-bridge";

/** A MapLibre map stand-in that records its click listeners. */
function fakeMap() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    on(type: string, handler: (event: unknown) => void) {
      (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(handler);
    },
    off(type: string, handler: (event: unknown) => void) {
      listeners.get(type)?.delete(handler);
    },
    click(lng: number, lat: number) {
      for (const handler of listeners.get("click") ?? []) handler({ lngLat: { lng, lat } });
    },
    listenerCount: () => listeners.get("click")?.size ?? 0,
  };
}

/** A Cesium viewer stand-in whose input action can be fired on demand. */
function fakeCesium() {
  let action: ((event: { position: unknown }) => void) | null = null;
  const viewer = {
    scene: { globe: { ellipsoid: {} } },
    camera: {
      // Echoes the screen point back as a "cartesian" the namespace decodes.
      pickEllipsoid: (position: unknown) => position,
    },
    screenSpaceEventHandler: {
      setInputAction: (next: (event: { position: unknown }) => void) => {
        action = next;
      },
      removeInputAction: () => {
        action = null;
      },
    },
    isDestroyed: () => false,
  };
  const namespace = {
    ScreenSpaceEventType: { LEFT_CLICK: 1 },
    Cartographic: {
      fromCartesian: (cartesian: unknown) => cartesian as { longitude: number; latitude: number },
    },
    // The bridge converts radians to degrees; the fixture passes them through.
    Math: { toDegrees: (radians: number) => radians },
  };
  return {
    viewer,
    namespace,
    click: (lng: number, lat: number) => action?.({ position: { longitude: lng, latitude: lat } }),
    attached: () => action !== null,
  };
}

afterEach(() => {
  setPrimaryCesiumViewer(null, null);
});

describe("subscribeMapClick", () => {
  it("delivers a click from the 2D map", () => {
    const map = fakeMap();
    const seen: Array<{ lng: number; lat: number }> = [];
    const stop = subscribeMapClick((p) => seen.push(p), () => map as never);
    map.click(126.97, 37.56);
    assert.deepEqual(seen, [{ lng: 126.97, lat: 37.56 }]);
    stop();
  });

  it("delivers a click from the globe", () => {
    // The bug this exists for: the 2D map is hidden and takes no pointer events
    // on the Cesium tab, so a handler attached there never fires.
    const cesium = fakeCesium();
    setPrimaryCesiumViewer(cesium.viewer, cesium.namespace);
    const seen: Array<{ lng: number; lat: number }> = [];
    const stop = subscribeMapClick((p) => seen.push(p), () => null);
    cesium.click(127.1, 37.4);
    assert.deepEqual(seen, [{ lng: 127.1, lat: 37.4 }]);
    stop();
  });

  it("attaches to a globe that appears after the subscription", () => {
    // Switching to the Cesium tab creates the viewer while a tool is already
    // armed; the tool must not have to be toggled off and on again.
    const seen: Array<{ lng: number; lat: number }> = [];
    const stop = subscribeMapClick((p) => seen.push(p), () => null);
    const cesium = fakeCesium();
    setPrimaryCesiumViewer(cesium.viewer, cesium.namespace);
    cesium.click(128, 36);
    assert.equal(seen.length, 1);
    stop();
  });

  it("ignores a click that misses the globe", () => {
    // Clicking the sky picks nothing; reporting a coordinate there would query
    // an arbitrary place.
    const cesium = fakeCesium();
    cesium.viewer.camera.pickEllipsoid = () => undefined as never;
    setPrimaryCesiumViewer(cesium.viewer, cesium.namespace);
    const seen: unknown[] = [];
    const stop = subscribeMapClick((p) => seen.push(p), () => null);
    cesium.click(0, 0);
    assert.deepEqual(seen, []);
    stop();
  });

  it("detaches both renderers when the last subscriber leaves", () => {
    const map = fakeMap();
    const cesium = fakeCesium();
    setPrimaryCesiumViewer(cesium.viewer, cesium.namespace);
    const stop = subscribeMapClick(() => {}, () => map as never);
    assert.equal(map.listenerCount(), 1);
    assert.equal(cesium.attached(), true);
    stop();
    assert.equal(map.listenerCount(), 0);
    assert.equal(cesium.attached(), false);
  });

  it("keeps the globe attached while another subscriber remains", () => {
    // The globe handler is shared, so releasing one tool must not silence the
    // other.
    const cesium = fakeCesium();
    setPrimaryCesiumViewer(cesium.viewer, cesium.namespace);
    const seen: unknown[] = [];
    const stopA = subscribeMapClick(() => seen.push("a"), () => null);
    const stopB = subscribeMapClick(() => seen.push("b"), () => null);
    stopA();
    cesium.click(127, 37);
    assert.deepEqual(seen, ["b"]);
    stopB();
  });

  it("survives a handler that unsubscribes itself mid-dispatch", () => {
    const cesium = fakeCesium();
    setPrimaryCesiumViewer(cesium.viewer, cesium.namespace);
    const seen: string[] = [];
    let stopA: () => void = () => {};
    stopA = subscribeMapClick(() => {
      seen.push("a");
      stopA();
    }, () => null);
    const stopB = subscribeMapClick(() => seen.push("b"), () => null);
    assert.doesNotThrow(() => cesium.click(127, 37));
    assert.deepEqual(seen, ["a", "b"]);
    stopB();
  });
});
