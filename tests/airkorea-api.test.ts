import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AIRKOREA_REGIONS,
  airKoreaGeoJson,
  stationLonLat,
} from "../packages/plugins/src/plugins/airkorea-api";
import {
  gatewayErrorKind,
  itemsOf,
  numericField,
} from "../packages/plugins/src/plugins/data-go-kr";

describe("station coordinates", () => {
  it("converts the published TM metres to degrees inside Korea", () => {
    // AirKorea publishes dmX/dmY as Korea Central Belt metres. Treated as
    // degrees they would land off West Africa, so the conversion is the whole
    // difference between a usable layer and a scatter of dots in the Atlantic.
    const seoul = stationLonLat(197329, 452080);
    assert.ok(seoul, "a central-belt coordinate must convert");
    // Sanity, not precision: the point has to be somewhere in the Seoul area.
    assert.ok(seoul.lon > 126.5 && seoul.lon < 127.5, `lon ${seoul.lon}`);
    assert.ok(seoul.lat > 37.0 && seoul.lat < 38.0, `lat ${seoul.lat}`);
  });

  it("does not silently accept the swapped axis order", () => {
    // The regression this guards: an earlier draft tried both orders and kept
    // whichever landed in Korea. The swapped pair resolves to ~129.77, 35.24 —
    // also inside Korea, near Ulsan — so the guess was wrong and undetectable.
    const swapped = stationLonLat(452080, 197329);
    assert.ok(swapped, "the swapped pair still converts to a Korean coordinate");
    assert.ok(swapped.lon > 129, `a Seoul station must not resolve to ${swapped.lon}`);
    // Which is exactly why the axis order is fixed rather than inferred.
  });

  it("passes through coordinates that are already degrees", () => {
    // Keeps working if the service ever starts publishing lat/lon directly.
    assert.deepEqual(stationLonLat(126.978, 37.5665), {
      lon: 126.978,
      lat: 37.5665,
    });
  });

  it("rejects a coordinate that lands outside Korea", () => {
    // The axis-order assumption cannot be verified without an approved key, so
    // an implausible result is treated as evidence the assumption is wrong —
    // dropped rather than drawn somewhere meaningless.
    assert.equal(stationLonLat(0, 0), null);
    assert.equal(stationLonLat(-70.1, 40.2), null);
  });

  it("treats the portal's placeholders as absent, not as a position", () => {
    assert.equal(stationLonLat("-", "-"), null);
    assert.equal(stationLonLat("", ""), null);
    assert.equal(stationLonLat(null, null), null);
  });
});

describe("numericField", () => {
  it("reads a measurement", () => {
    assert.equal(numericField("38"), 38);
    assert.equal(numericField("0.003"), 0.003);
    assert.equal(numericField(12), 12);
  });

  it("treats offline and missing markers as absent", () => {
    // A station that is down reports "-"; parseFloat would make that NaN, and
    // -999 would render as a plausible concentration.
    assert.equal(numericField("-"), null);
    assert.equal(numericField("-999"), null);
    assert.equal(numericField(""), null);
    assert.equal(numericField(undefined), null);
    assert.equal(numericField("없음"), null);
  });
});

describe("itemsOf", () => {
  it("accepts both response shapes the portal uses", () => {
    // Some services nest under items.item, others put the array on items.
    assert.equal(itemsOf({ items: { item: [{ a: 1 }, { a: 2 }] } }).length, 2);
    assert.equal(itemsOf({ items: [{ a: 1 }] }).length, 1);
  });

  it("unwraps a single object into a one-element list", () => {
    // The portal collapses a one-element list into a bare object; assuming an
    // array would silently drop the only result there is.
    assert.deepEqual(itemsOf({ items: { item: { a: 1 } } }), [{ a: 1 }]);
  });

  it("returns an empty list for an empty body", () => {
    assert.deepEqual(itemsOf({}), []);
    assert.deepEqual(itemsOf({ items: null }), []);
  });
});

describe("airKoreaGeoJson", () => {
  const stations = [
    {
      name: "중구",
      region: "서울",
      address: "서울 중구",
      lon: 126.97,
      lat: 37.56,
      crs: "EPSG:4326" as const,
    },
    {
      name: "관측불가",
      region: "서울",
      address: "서울",
      lon: 127.0,
      lat: 37.5,
      crs: "EPSG:4326" as const,
    },
  ];

  it("folds the readings into the feature properties", () => {
    // The readings have to reach the properties or the Style panel has nothing
    // to shade by, which is the entire reason the two services are paired.
    const readings = new Map([
      [
        "중구",
        {
          stationName: "중구",
          measuredAt: "2026-08-03 12:00",
          pm10: 38,
          pm25: 21,
          o3: 0.03,
          no2: 0.02,
          co: 0.4,
          so2: 0.003,
          khai: 65,
          khaiGrade: 2,
        },
      ],
    ]);
    const geojson = airKoreaGeoJson(stations, readings);
    assert.equal(geojson.features.length, 2);
    const seoul = geojson.features[0];
    assert.deepEqual(seoul.geometry.coordinates, [126.97, 37.56]);
    assert.equal(seoul.properties.pm10, 38);
    assert.equal(seoul.properties.khaiGrade, 2);
    assert.equal(seoul.properties.measuredAt, "2026-08-03 12:00");
  });

  it("keeps a station with no reading, with null values", () => {
    // Dropping it would make the layer's station count change hour to hour;
    // nulls let the style show it as unmeasured instead.
    const geojson = airKoreaGeoJson(stations, new Map());
    assert.equal(geojson.features.length, 2);
    assert.equal(geojson.features[1].properties.pm10, null);
    assert.equal(geojson.features[1].properties.station, "관측불가");
  });
});

describe("region list", () => {
  it("covers every province the realtime service is queried by", () => {
    // The service takes one province per call, so a missing name is a silent
    // hole in the national layer.
    assert.equal(AIRKOREA_REGIONS.length, 17);
    for (const region of ["서울", "제주", "세종", "경기"]) {
      assert.ok(AIRKOREA_REGIONS.includes(region), `missing ${region}`);
    }
    assert.equal(new Set(AIRKOREA_REGIONS).size, AIRKOREA_REGIONS.length);
  });
});

describe("gatewayErrorKind", () => {
  it("reads the reason out of the live gateway's fault", () => {
    // Captured verbatim from apis.data.go.kr/B552584 for an unregistered key.
    const fault = JSON.stringify({
      OpenAPI_ServiceResponse: {
        cmmMsgHeader: {
          errMsg: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR",
          returnAuthMsg: "등록되지 않은 서비스키",
          returnReasonCode: "30",
        },
      },
    });
    // Not "invalid-key": the same key works for other services, so what this
    // tells the user is to check the 활용신청 for this one.
    assert.equal(gatewayErrorKind(fault), "access-denied");
  });

  it("separates a path this client got wrong from a key problem", () => {
    // A bogus service path answers 400 with reason 12, not a key error.
    assert.equal(gatewayErrorKind('{"returnReasonCode":"12"}'), "invalid-request");
    assert.equal(gatewayErrorKind('{"returnReasonCode":"32"}'), "invalid-key");
  });

  it("declines to classify a body that is not a gateway fault", () => {
    assert.equal(gatewayErrorKind('{"response":{"header":{"resultCode":"00"}}}'), null);
    assert.equal(gatewayErrorKind(""), null);
  });
});
