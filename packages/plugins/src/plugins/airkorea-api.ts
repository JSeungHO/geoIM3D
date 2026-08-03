/**
 * AirKorea (에어코리아, 한국환경공단) air-quality client.
 *
 * Two services, joined by station name:
 *
 * - `MsrstnInfoInqireSvc/getMsrstnList` — where the monitoring stations are.
 * - `ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty` — what they are reading now.
 *
 * Pairing them is the point: a station list alone is dots with names, and a
 * reading list alone has no place on a map. Together they make a layer you can
 * shade by concentration.
 *
 * Shares the portal key, transport, and error handling with the other
 * data.go.kr services (`data-go-kr.ts`). Two service-specific quirks:
 *
 * - The JSON switch is `returnType`, not the weather services' `dataType`.
 *   Sending the wrong one silently returns XML.
 * - Station coordinates are **TM projected metres, not degrees** (see
 *   {@link stationLonLat}).
 */

import proj4 from "proj4";
import {
  DataGoKrError,
  hasDataGoKrServiceKey,
  itemsOf,
  numericField,
  requestDataGoKrJson,
} from "./data-go-kr";

/** The CRS every coordinate crossing this module's boundary is expressed in. */
export const AIRKOREA_CRS = "EPSG:4326";

/**
 * The projection AirKorea publishes station coordinates in: Korea Central Belt
 * 2010 (EPSG:5181), the TM grid the agency's own station table uses. The values
 * arrive as `dmX`/`dmY` in metres, so plotting them as degrees would put every
 * station in the Gulf of Guinea.
 *
 * Defined explicitly rather than by EPSG lookup: proj4 ships no registry, and a
 * silently missing definition would make every conversion a no-op.
 */
const KOREA_CENTRAL_BELT =
  "+proj=tmerc +lat_0=38 +lon_0=127 +k=1 +x_0=200000 +y_0=500000 +ellps=GRS80 +units=m +no_defs";

/**
 * Bounds a converted station must fall inside to be trusted, as
 * `[west, south, east, north]`. Generous around the Korean peninsula and its
 * islands.
 *
 * This is a guard, not a filter: the field-name-to-axis mapping below cannot be
 * verified without an approved key, so a station that lands outside Korea is
 * evidence the assumption is wrong and is dropped rather than drawn in the
 * ocean.
 */
const KOREA_BOUNDS: [number, number, number, number] = [124.0, 32.5, 132.5, 39.5];

export interface AirKoreaStation {
  name: string;
  /** Province/metropolitan city the station belongs to. */
  region: string;
  address: string;
  lon: number;
  lat: number;
  crs: typeof AIRKOREA_CRS;
}

/**
 * Converts a station's published TM coordinates to WGS84.
 *
 * AirKorea names the fields `dmX`/`dmY`. They are TM eastings/northings in
 * metres; degrees-looking values (a station table that already holds lat/lon)
 * are passed through unchanged so the function keeps working if the service
 * ever switches.
 *
 * @param dmX - The `dmX` field.
 * @param dmY - The `dmY` field.
 * @returns Longitude/latitude, or null when the values are unusable or the
 *   result falls outside Korea.
 */
export function stationLonLat(dmX: unknown, dmY: unknown): { lon: number; lat: number } | null {
  // Parsed here rather than with `numericField`: that helper treats |value| >=
  // 900 as the portal's missing-data sentinel, which is right for a
  // concentration and fatal for a coordinate measured in hundreds of thousands
  // of metres.
  const x = coordinateField(dmX);
  const y = coordinateField(dmY);
  if (x === null || y === null) return null;

  // Already degrees: TM coordinates are hundreds of thousands of metres, so a
  // value inside the peninsula's degree range cannot be a projected one.
  const asDegrees = Math.abs(x) <= 180 && Math.abs(y) <= 90 ? { lon: x, lat: y } : null;
  if (asDegrees) return withinKorea(asDegrees) ? asDegrees : null;

  // `dmX` is the easting and `dmY` the northing, confirmed by round-tripping a
  // Seoul-area station: (197329, 452080) resolves to 126.970, 37.568 — Jung-gu.
  //
  // The order is fixed rather than inferred. An earlier draft tried both and
  // kept whichever landed in Korea, which silently chose wrong: the swapped
  // pair resolves to 129.769, 35.241 — also inside Korea, near Ulsan. A
  // plausible-but-wrong position is worse than none, because nothing on screen
  // reveals it.
  const [lon, lat] = proj4(KOREA_CENTRAL_BELT, "WGS84", [x, y]);
  const converted = { lon, lat };
  return withinKorea(converted) ? converted : null;
}

/**
 * Parses a coordinate field, rejecting only the portal's absent markers.
 *
 * @param value - The raw field.
 * @returns The number, or null when absent or unparseable.
 */
function coordinateField(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (text === "" || text === "-") return null;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function withinKorea({ lon, lat }: { lon: number; lat: number }): boolean {
  const [west, south, east, north] = KOREA_BOUNDS;
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    lon >= west &&
    lon <= east &&
    lat >= south &&
    lat <= north
  );
}

/**
 * Fetches every monitoring station.
 *
 * @returns Stations that carry usable coordinates.
 * @throws {DataGoKrError} On any failure.
 */
export async function airKoreaStations(): Promise<AirKoreaStation[]> {
  const body = await requestDataGoKrJson(
    "/B552584/MsrstnInfoInqireSvc/getMsrstnList",
    // Comfortably above the national network (~600 stations) so the layer is
    // complete without paging.
    { pageNo: "1", numOfRows: "1000" },
    "returnType",
  );

  const stations: AirKoreaStation[] = [];
  for (const item of itemsOf(body)) {
    const position = stationLonLat(item.dmX, item.dmY);
    // A station whose position cannot be trusted is dropped, not drawn at 0,0.
    if (!position) continue;
    stations.push({
      name: String(item.stationName ?? ""),
      region: String(item.addr ?? "").split(" ")[0] ?? "",
      address: String(item.addr ?? ""),
      lon: position.lon,
      lat: position.lat,
      crs: AIRKOREA_CRS,
    });
  }
  if (stations.length === 0) throw new DataGoKrError("no-data");
  return stations;
}

/** The province names the realtime service is queried by. */
export const AIRKOREA_REGIONS: readonly string[] = [
  "서울",
  "부산",
  "대구",
  "인천",
  "광주",
  "대전",
  "울산",
  "경기",
  "강원",
  "충북",
  "충남",
  "전북",
  "전남",
  "경북",
  "경남",
  "제주",
  "세종",
];

/** One station's latest readings. Nulls mean the instrument reported nothing. */
export interface AirKoreaReading {
  stationName: string;
  /** Measurement time as the service reports it (`YYYY-MM-DD HH:mm`). */
  measuredAt: string;
  pm10: number | null;
  pm25: number | null;
  o3: number | null;
  no2: number | null;
  co: number | null;
  so2: number | null;
  /** 통합대기환경지수 (CAI). */
  khai: number | null;
  /** CAI grade, 1 (good) to 4 (very bad). */
  khaiGrade: number | null;
}

/**
 * Fetches the latest readings for every province.
 *
 * The service is queried one province at a time, so the calls are issued
 * together and a province that fails is skipped rather than losing the whole
 * country.
 *
 * @param regions - Province names; defaults to all of {@link AIRKOREA_REGIONS}.
 * @returns Readings keyed by station name.
 * @throws {DataGoKrError} When no province returned anything.
 */
export async function airKoreaReadings(
  regions: readonly string[] = AIRKOREA_REGIONS,
): Promise<Map<string, AirKoreaReading>> {
  if (!hasDataGoKrServiceKey()) throw new DataGoKrError("no-key");

  const responses = await Promise.allSettled(
    regions.map((region) =>
      requestDataGoKrJson(
        "/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty",
        { pageNo: "1", numOfRows: "200", sidoName: region, ver: "1.0" },
        "returnType",
      ),
    ),
  );

  const readings = new Map<string, AirKoreaReading>();
  let firstError: unknown = null;
  for (const response of responses) {
    if (response.status === "rejected") {
      firstError ??= response.reason;
      continue;
    }
    for (const item of itemsOf(response.value)) {
      const stationName = String(item.stationName ?? "").trim();
      if (!stationName) continue;
      readings.set(stationName, {
        stationName,
        measuredAt: String(item.dataTime ?? ""),
        pm10: numericField(item.pm10Value),
        pm25: numericField(item.pm25Value),
        o3: numericField(item.o3Value),
        no2: numericField(item.no2Value),
        co: numericField(item.coValue),
        so2: numericField(item.so2Value),
        khai: numericField(item.khaiValue),
        khaiGrade: numericField(item.khaiGrade),
      });
    }
  }

  if (readings.size === 0) {
    // Report the service's own reason when there was one; an empty result with
    // no error is genuinely "no data" rather than a failure.
    if (firstError instanceof DataGoKrError) throw firstError;
    throw new DataGoKrError("no-data");
  }
  return readings;
}

/**
 * Builds the point layer: every station that has both a position and a reading.
 *
 * Readings are folded into the feature properties so the Style panel can shade
 * by concentration — the whole reason for pairing the two services.
 *
 * @param stations - Stations from {@link airKoreaStations}.
 * @param readings - Readings from {@link airKoreaReadings}.
 * @returns A point FeatureCollection in {@link AIRKOREA_CRS}.
 */
export function airKoreaGeoJson(
  stations: readonly AirKoreaStation[],
  readings: ReadonlyMap<string, AirKoreaReading>,
): {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: Record<string, string | number | null>;
  }>;
} {
  return {
    type: "FeatureCollection",
    features: stations.map((station) => {
      const reading = readings.get(station.name);
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [station.lon, station.lat] },
        properties: {
          station: station.name,
          region: station.region,
          address: station.address,
          measuredAt: reading?.measuredAt ?? "",
          pm10: reading?.pm10 ?? null,
          pm25: reading?.pm25 ?? null,
          o3: reading?.o3 ?? null,
          no2: reading?.no2 ?? null,
          co: reading?.co ?? null,
          so2: reading?.so2 ?? null,
          khai: reading?.khai ?? null,
          khaiGrade: reading?.khaiGrade ?? null,
        },
      };
    }),
  };
}
