/**
 * Placement override for a 3D Tiles layer on the globe, for a tileset built
 * from a scan that was never georeferenced. Plain-number matrix math (not
 * Cesium's `Matrix4`) so it's testable without a globe.
 */

/** Where a tileset should sit. Every field is absolute, not relative to a preset. */
export interface TilesetPlacement {
  longitude: number;
  latitude: number;
  /** Degrees: tilt about east, turn about up (heading), tilt about north. */
  rotation: [number, number, number];
  /** Uniform scale applied to the tileset's own units. */
  scale: number;
  /** Ellipsoidal height of the tileset's origin, in metres. */
  height: number;
}

// WGS84, the ellipsoid 3D Tiles positions are expressed on.
const SEMI_MAJOR_AXIS = 6378137.0;
const FLATTENING = 1 / 298.257223563;
const ECCENTRICITY_SQUARED = FLATTENING * (2 - FLATTENING);
const DEG_TO_RAD = Math.PI / 180;

/** Reads a placement off a layer's source; null unless every field is finite. */
export function readTilesetPlacement(source: Record<string, unknown>): TilesetPlacement | null {
  const placement = source.placement as Partial<TilesetPlacement> | undefined;
  if (!placement) return null;
  const { longitude, latitude, rotation, scale, height } = placement;
  const values = [longitude, latitude, scale, height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  if (scale === 0) return null;
  if (!Array.isArray(rotation) || rotation.length !== 3) return null;
  if (!rotation.every((angle) => typeof angle === "number" && Number.isFinite(angle))) return null;
  return {
    longitude: longitude as number,
    latitude: latitude as number,
    rotation: [rotation[0], rotation[1], rotation[2]],
    scale: scale as number,
    height: height as number,
  };
}

/** Earth-centred, earth-fixed `[x, y, z]` (metres) of a geodetic coordinate. */
export function geodeticToEcef(
  longitude: number,
  latitude: number,
  height: number,
): [number, number, number] {
  const lon = longitude * DEG_TO_RAD;
  const lat = latitude * DEG_TO_RAD;
  const primeVertical = SEMI_MAJOR_AXIS / Math.sqrt(1 - ECCENTRICITY_SQUARED * Math.sin(lat) ** 2);
  return [
    (primeVertical + height) * Math.cos(lat) * Math.cos(lon),
    (primeVertical + height) * Math.cos(lat) * Math.sin(lon),
    (primeVertical * (1 - ECCENTRICITY_SQUARED) + height) * Math.sin(lat),
  ];
}

/** The 4x4 column-major matrix (ECEF from the tileset's own frame) for a placement. */
export function tilesetPlacementMatrix(placement: TilesetPlacement): number[] {
  const lon = placement.longitude * DEG_TO_RAD;
  const lat = placement.latitude * DEG_TO_RAD;
  // Columns of the frame the tileset is placed into, in ECEF.
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  const north = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
  const up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];

  const [tiltEast, heading, tiltNorth] = placement.rotation.map((angle) => angle * DEG_TO_RAD);
  // Heading outermost so a tilt doesn't swing the building off its bearing.
  const rotated = multiply3(
    multiply3(rotation3(2, heading), rotation3(0, tiltEast)),
    rotation3(1, tiltNorth),
  );

  const { scale } = placement;
  const axis = (column: number) =>
    [0, 1, 2].map(
      (row) =>
        scale *
        (east[row] * rotated[column * 3] +
          north[row] * rotated[column * 3 + 1] +
          up[row] * rotated[column * 3 + 2]),
    );
  const origin = geodeticToEcef(placement.longitude, placement.latitude, placement.height);
  return [...axis(0), 0, ...axis(1), 0, ...axis(2), 0, ...origin, 1];
}

/** A rotation about one local axis (0=x, 1=y, 2=z), as a column-major 3x3. */
function rotation3(axis: 0 | 1 | 2, angle: number): number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  if (axis === 0) return [1, 0, 0, 0, c, s, 0, -s, c];
  if (axis === 1) return [c, 0, -s, 0, 1, 0, s, 0, c];
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** Column-major 3x3 product, `a` then `b` applied to a vector. */
function multiply3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9).fill(0);
  for (let column = 0; column < 3; column += 1) {
    for (let row = 0; row < 3; row += 1) {
      out[column * 3 + row] =
        a[row] * b[column * 3] + a[3 + row] * b[column * 3 + 1] + a[6 + row] * b[column * 3 + 2];
    }
  }
  return out;
}
