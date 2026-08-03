import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  KMA_STATION_NETWORKS,
  KmaError,
  compassIndex,
  displayableValues,
  groupForecastSlots,
  hasKmaApiKey,
  httpErrorKind,
  isMissingValue,
  isWithinKmaGrid,
  kmaBaseDateTime,
  kmaCurrentConditions,
  kmaErrorKind,
  kmaStations,
  kmaStationsToGeoJson,
  kmaTyphoons,
  kmaVillageForecast,
  kmaWarnings,
  latLonToGrid,
  normalizeServiceKey,
  setKmaApiKey,
  setKmaTransport,
  ultraShortNowcastBase,
  verifyKmaApiKey,
  gatewayErrorKind,
  villageForecastBase,
} from "../packages/plugins/src/plugins/kma-api";

const TEST_KEY = "test-kma-service-key";

function stubFetch(payload: unknown, options: { ok?: boolean; status?: number } = {}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return {
      ok: options.ok ?? true,
      status: options.status ?? 200,
      text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload)),
    } as Response;
  }) as typeof fetch;
  return calls;
}

/** A successful portal envelope around `items`. */
function envelope(items: unknown) {
  return {
    response: {
      header: { resultCode: "00" },
      body: { items: { item: items } },
    },
  };
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  setKmaApiKey(TEST_KEY);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setKmaApiKey("");
});

describe("KMA forecast grid", () => {
  it("matches the agency's published grid cells", () => {
    // These are the KMA's own worked values for the metropolitan city halls. The
    // projection has several constants that each look plausible when wrong, and
    // a wrong one shifts every forecast by tens of kilometres without erroring.
    const expected: Array<[string, number, number, number, number]> = [
      ["Seoul", 126.978, 37.5665, 60, 127],
      ["Busan", 129.0756, 35.1796, 98, 76],
      ["Daegu", 128.6014, 35.8714, 89, 91],
      ["Incheon", 126.7052, 37.4563, 55, 124],
      ["Gwangju", 126.8526, 35.1595, 58, 74],
      ["Daejeon", 127.3845, 36.3504, 67, 100],
      ["Jeju", 126.5312, 33.4996, 53, 38],
    ];
    for (const [name, lon, lat, nx, ny] of expected) {
      assert.deepEqual(latLonToGrid(lon, lat), { nx, ny }, `${name} grid cell`);
    }
  });

  it("accepts cells inside the published domain and rejects those outside", () => {
    assert.equal(isWithinKmaGrid({ nx: 1, ny: 1 }), true);
    assert.equal(isWithinKmaGrid({ nx: 149, ny: 253 }), true);
    assert.equal(isWithinKmaGrid({ nx: 0, ny: 100 }), false);
    assert.equal(isWithinKmaGrid({ nx: 150, ny: 100 }), false);
    assert.equal(isWithinKmaGrid({ nx: 60, ny: 254 }), false);
  });

  it("rejects non-finite coordinates", () => {
    assert.throws(
      () => latLonToGrid(Number.NaN, 37.5),
      (error: KmaError) => error.kind === "invalid-request",
    );
  });
});

describe("missing values", () => {
  it("recognizes the agency's +-900 sentinel", () => {
    // The guide: "+900 이상, -900 이하 값은 Missing 값으로 처리" — an ocean cell
    // with no instrument, or an outage. Rendered raw it reads as -999 degrees.
    assert.equal(isMissingValue("-999"), true);
    assert.equal(isMissingValue("900"), true);
    assert.equal(isMissingValue("-900"), true);
    assert.equal(isMissingValue("899.9"), false);
    assert.equal(isMissingValue("27.3"), false);
    assert.equal(isMissingValue("0"), false);
  });

  it("leaves non-numeric category values alone", () => {
    // PCP and SNO are served as strings such as "강수없음" or "30.0~50.0mm".
    assert.equal(isMissingValue("강수없음"), false);
    assert.equal(isMissingValue(""), false);
  });
});

describe("base times", () => {
  it("formats in KST, not the host time zone", () => {
    // 2026-07-28T20:30Z is 2026-07-29 05:30 KST — a different calendar day.
    assert.deepEqual(kmaBaseDateTime(new Date("2026-07-28T20:30:00Z")), {
      baseDate: "20260729",
      baseTime: "0530",
    });
  });

  it("serves the current hour's nowcast from 10 past, per the official guide", () => {
    // The agency's guide (§2 예보 발표시각) publishes each hourly observation at
    // HH:10. An earlier draft assumed HH:40 and so requested an hour-old base
    // for half of every hour.
    // 00:05Z = 09:05 KST — before 09:10, so the newest run is 08:00.
    assert.deepEqual(ultraShortNowcastBase(new Date("2026-07-29T00:05:00Z")), {
      baseDate: "20260729",
      baseTime: "0800",
    });
    // 00:12Z = 09:12 KST — 09:00 is now available.
    assert.deepEqual(ultraShortNowcastBase(new Date("2026-07-29T00:12:00Z")), {
      baseDate: "20260729",
      baseTime: "0900",
    });
    assert.deepEqual(ultraShortNowcastBase(new Date("2026-07-29T00:50:00Z")), {
      baseDate: "20260729",
      baseTime: "0900",
    });
  });

  it("crosses midnight KST when the hour rolls back", () => {
    // 15:05Z = 00:05 KST — before 00:10, so the newest run is 23:00 yesterday.
    assert.deepEqual(ultraShortNowcastBase(new Date("2026-07-28T15:05:00Z")), {
      baseDate: "20260728",
      baseTime: "2300",
    });
  });

  it("uses the newest published village-forecast run", () => {
    // Runs are 02/05/08/11/14/17/20/23 KST, available ~10 past the hour.
    assert.deepEqual(villageForecastBase(new Date("2026-07-29T00:05:00Z")), {
      baseDate: "20260729",
      baseTime: "0800",
    });
    // 01:30 KST is before the day's first run, so the newest is 23:00 yesterday.
    assert.deepEqual(villageForecastBase(new Date("2026-07-28T16:30:00Z")), {
      baseDate: "20260728",
      baseTime: "2300",
    });
  });

  it("steps back through earlier village-forecast runs", () => {
    // 09:05 KST: the newest run is 08:00, and stepping back walks 05, then 02.
    const now = new Date("2026-07-29T00:05:00Z");
    assert.deepEqual(villageForecastBase(now, 1), {
      baseDate: "20260729",
      baseTime: "0500",
    });
    assert.deepEqual(villageForecastBase(now, 2), {
      baseDate: "20260729",
      baseTime: "0200",
    });
  });

  it("crosses midnight when stepping back past the day's first run", () => {
    // 03:05 KST: only the 02:00 run exists today, so one step back is
    // yesterday's last run rather than a slot that was never published.
    const now = new Date("2026-07-28T18:05:00Z");
    assert.deepEqual(villageForecastBase(now, 0), {
      baseDate: "20260729",
      baseTime: "0200",
    });
    assert.deepEqual(villageForecastBase(now, 1), {
      baseDate: "20260728",
      baseTime: "2300",
    });
    assert.deepEqual(villageForecastBase(now, 2), {
      baseDate: "20260728",
      baseTime: "2000",
    });
  });
});

describe("kmaErrorKind", () => {
  it("separates the portal's documented result codes", () => {
    assert.equal(kmaErrorKind("03"), "no-data");
    assert.equal(kmaErrorKind("22"), "rate-limit");
    // A key that was never registered, expired, or is called from an
    // unregistered IP all need the same user action: fix the key registration.
    for (const code of ["21", "30", "31", "32", "33"]) {
      assert.equal(kmaErrorKind(code), "invalid-key", `code ${code}`);
    }
    for (const code of ["10", "11", "12"]) {
      assert.equal(kmaErrorKind(code), "invalid-request", `code ${code}`);
    }
    assert.equal(kmaErrorKind("01"), "server");
    assert.equal(kmaErrorKind("99"), "unknown");
  });
});

describe("httpErrorKind", () => {
  it("reads the gateway's auth statuses as a key problem", () => {
    // Verified against the live gateway: an unregistered key is answered with
    // 403 and `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` (returnReasonCode 30), not
    // the 401 the status alone would suggest. Treating 403 as a permissions
    // problem sent users to check a subscription when the key was the issue.
    assert.equal(httpErrorKind(401), "invalid-key");
    assert.equal(httpErrorKind(403), "invalid-key");
    assert.equal(httpErrorKind(429), "rate-limit");
    assert.equal(httpErrorKind(500), "server");
    assert.equal(httpErrorKind(502), "server");
    assert.equal(httpErrorKind(404), "network");
  });

  it("still separates a licensing refusal reported in the body", () => {
    // The body-level code is the reliable signal, and it does distinguish the
    // two: 20 is "subscribed to nothing here", 30 is "who are you".
    assert.equal(kmaErrorKind("20"), "access-denied");
    assert.equal(kmaErrorKind("30"), "invalid-key");
  });
});

describe("service key normalization", () => {
  it("accepts the portal's encoded key spelling", () => {
    // data.go.kr issues the same key twice: decoded (base64) and "Encoding"
    // (percent-escaped). Users copy either. The request builder escapes what it
    // is given, so an already-escaped key would go out double-encoded
    // (%2F -> %252F) and the gateway would never see the real key.
    const decoded = "abc+def/ghi==";
    const encoded = "abc%2Bdef%2Fghi%3D%3D";
    assert.equal(normalizeServiceKey(encoded), decoded);
    assert.equal(normalizeServiceKey(decoded), decoded);
  });

  it("unwinds a value that was pasted through two encode steps", () => {
    assert.equal(normalizeServiceKey("abc%252Fdef%253D"), "abc/def=");
  });

  it("leaves a malformed percent sequence alone rather than mangling it", () => {
    // A stray '%' is not proof of encoding; decoding would throw and dropping
    // the key would be worse than sending it verbatim.
    assert.equal(normalizeServiceKey("abc%zz"), "abc%zz");
  });

  it("trims surrounding whitespace from a pasted key", () => {
    assert.equal(normalizeServiceKey("  abc123  "), "abc123");
  });

  it("sends the decoded key exactly once through the query builder", async () => {
    setKmaApiKey("abc%2Bdef%2Fghi%3D%3D");
    const calls = stubFetch(envelope([{ tmFc: "202607300600", title: "x" }]));
    await kmaWarnings();
    // The raw query string must carry a single level of escaping.
    const query = calls[0].split("?")[1];
    assert.ok(query.includes("serviceKey=abc%2Bdef%2Fghi%3D%3D"), query);
    assert.ok(!query.includes("%25"), "the key went out double-encoded");
    // And the value the server will parse is the decoded key.
    assert.equal(new URL(calls[0]).searchParams.get("serviceKey"), "abc+def/ghi==");
  });
});

describe("key handling", () => {
  it("reports configured state without exposing the value", () => {
    setKmaApiKey("  spaced  ");
    assert.equal(hasKmaApiKey(), true);
    setKmaApiKey("");
    assert.equal(hasKmaApiKey(), false);
  });

  it("refuses every request when no key is set", async () => {
    setKmaApiKey("");
    await assert.rejects(
      () => kmaCurrentConditions(126.978, 37.5665),
      (error: KmaError) => error.kind === "no-key",
    );
    await assert.rejects(
      () => kmaWarnings(),
      (error: KmaError) => error.kind === "no-key",
    );
    await assert.rejects(
      () => kmaStations("aws"),
      (error: KmaError) => error.kind === "no-key",
    );
  });

  it("keeps the key out of the error", async () => {
    stubFetch({ response: { header: { resultCode: "30" } } });
    await assert.rejects(
      () => kmaWarnings(),
      (error: KmaError) => {
        assert.equal(error.kind, "invalid-key");
        assert.ok(!error.message.includes(TEST_KEY));
        assert.ok(!error.message.includes("data.go.kr"));
        return true;
      },
    );
  });

  it("reads the reason out of a non-JSON authentication fault", async () => {
    // The portal answers an auth failure with an XML fault even when JSON was
    // requested. Reason 30 is reported both for a key that does not exist and
    // for one this API was never approved for; the app checks the key when it
    // is entered, so the latter is what a per-service refusal usually means.
    stubFetch(
      "<OpenAPI_ServiceResponse><returnReasonCode>30</returnReasonCode>SERVICE KEY IS NOT REGISTERED ERROR</OpenAPI_ServiceResponse>",
    );
    await assert.rejects(
      () => kmaWarnings(),
      (error: KmaError) => error.kind === "access-denied",
    );
  });

  it("classifies a 403 from the gateway body, not the status alone", async () => {
    stubFetch(
      JSON.stringify({
        OpenAPI_ServiceResponse: {
          cmmMsgHeader: {
            errMsg: "SERVICE_KEY_IS_NOT_REGISTERED_ERROR",
            returnReasonCode: "30",
          },
        },
      }),
      { ok: false, status: 403 },
    );
    await assert.rejects(
      () => kmaWarnings(),
      (error: KmaError) => error.kind === "access-denied",
    );
  });
});

describe("kmaCurrentConditions", () => {
  it("requests the containing grid cell and normalizes the values", async () => {
    const calls = stubFetch(
      envelope([
        {
          category: "T1H",
          obsrValue: "27.3",
          baseDate: "20260729",
          baseTime: "0800",
        },
        {
          category: "PTY",
          obsrValue: "0",
          baseDate: "20260729",
          baseTime: "0800",
        },
      ]),
    );

    const result = await kmaCurrentConditions(126.978, 37.5665, new Date("2026-07-29T00:50:00Z"));
    const url = new URL(calls[0]);
    assert.equal(
      url.origin + url.pathname,
      "https://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst",
    );
    assert.equal(url.searchParams.get("nx"), "60");
    assert.equal(url.searchParams.get("ny"), "127");
    assert.equal(url.searchParams.get("dataType"), "JSON");
    assert.equal(url.searchParams.get("serviceKey"), TEST_KEY);

    assert.equal(result.grid.nx, 60);
    assert.equal(result.crs, "EPSG:4326");
    assert.equal(result.values.length, 2);
    assert.equal(result.values[0].category, "T1H");
    assert.equal(result.values[0].value, "27.3");
  });

  it("refuses a point outside the forecast domain before spending a request", async () => {
    const calls = stubFetch(envelope([]));
    // Somewhere in the Pacific, far outside the Korean peninsula grid.
    await assert.rejects(
      () => kmaCurrentConditions(-120, 35),
      (error: KmaError) => error.kind === "no-data",
    );
    assert.equal(calls.length, 0);
  });

  it("treats a NODATA result code as no-data", async () => {
    stubFetch({ response: { header: { resultCode: "03" } } });
    await assert.rejects(
      () => kmaCurrentConditions(126.978, 37.5665),
      (error: KmaError) => error.kind === "no-data",
    );
  });
});

describe("kmaVillageForecast", () => {
  it("requests the forecast operation with the newest published base time", async () => {
    const calls = stubFetch(
      envelope([
        {
          category: "TMP",
          fcstValue: "29",
          fcstDate: "20260729",
          fcstTime: "1200",
        },
      ]),
    );
    const result = await kmaVillageForecast(126.978, 37.5665, new Date("2026-07-29T00:05:00Z"));
    const url = new URL(calls[0]);
    assert.ok(url.pathname.endsWith("/getVilageFcst"));
    assert.equal(url.searchParams.get("base_time"), "0800");
    assert.equal(url.searchParams.get("numOfRows"), "1000");
    assert.equal(result.values[0].value, "29");
    assert.equal(result.values[0].time, "1200");
  });
});

describe("kmaWarnings and kmaTyphoons", () => {
  it("unwraps a single-object item into a one-element list", async () => {
    // The portal collapses a one-element list into a bare object; assuming an
    // array would silently drop the only warning there is.
    stubFetch(
      envelope({
        tmFc: "202607290600",
        t6: "서울",
        title: "폭염주의보",
        stnId: "108",
      }),
    );
    const warnings = await kmaWarnings();
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].regions, "서울");
  });

  it("drops typhoon rows with no usable position", async () => {
    stubFetch(
      envelope([
        {
          typName: "카눈",
          typTm: "202607290600",
          typLon: "127.5",
          typLat: "30.2",
          typPs: "970",
        },
        { typName: "좌표없음", typTm: "202607290600" },
      ]),
    );
    const typhoons = await kmaTyphoons();
    assert.equal(typhoons.length, 1);
    assert.equal(typhoons[0].lon, 127.5);
    assert.equal(typhoons[0].pressure, 970);
    assert.equal(typhoons[0].windSpeed, null);
    assert.equal(typhoons[0].crs, "EPSG:4326");
  });

  it("reports an empty warning list as no-data", async () => {
    stubFetch(envelope([]));
    await assert.rejects(
      () => kmaWarnings(),
      (error: KmaError) => error.kind === "no-data",
    );
  });
});

describe("kmaStations", () => {
  it("requests the network's own operation", async () => {
    const calls = stubFetch(envelope([{ stnId: "108", stnKo: "서울", lon: "126.9", lat: "37.5" }]));
    await kmaStations("aws");
    assert.ok(
      new URL(calls[0]).pathname.endsWith("/1360000/WethrBasicInfoService/getAwsObsStn"),
      "AWS stations must use the AWS operation",
    );
  });

  it("rejects an unknown network before spending a request", async () => {
    const calls = stubFetch(envelope([]));
    await assert.rejects(
      () => kmaStations("not-a-network"),
      (error: KmaError) => error.kind === "invalid-request",
    );
    assert.equal(calls.length, 0);
  });

  it("drops stations with no usable position", async () => {
    stubFetch(
      envelope([
        { stnId: "108", stnKo: "서울", lon: "126.9", lat: "37.5" },
        { stnId: "999", stnKo: "좌표없음", lon: "", lat: "" },
      ]),
    );
    const stations = await kmaStations("aws");
    assert.equal(stations.length, 1);
    assert.equal(stations[0].id, "108");
  });

  it("converts stations to point features", () => {
    const geojson = kmaStationsToGeoJson([
      { id: "108", name: "서울", lon: 126.9, lat: 37.5, crs: "EPSG:4326" },
    ]);
    assert.equal(geojson.type, "FeatureCollection");
    assert.deepEqual(geojson.features[0].geometry, {
      type: "Point",
      coordinates: [126.9, 37.5],
    });
    assert.deepEqual(geojson.features[0].properties, {
      stationId: "108",
      name: "서울",
    });
  });
});

describe("verifyKmaApiKey", () => {
  it("passes when the service answers normally", async () => {
    stubFetch(envelope([{ category: "T1H", obsrValue: "27.3" }]));
    assert.deepEqual(await verifyKmaApiKey(new Date("2026-07-30T00:50:00Z")), {
      ok: true,
    });
  });

  it("passes when the service authenticates but has no data for the cell", async () => {
    // NODATA proves the key was accepted; failing the check there would send
    // the user hunting a key problem that does not exist.
    stubFetch({ response: { header: { resultCode: "03" } } });
    assert.deepEqual(await verifyKmaApiKey(new Date("2026-07-30T00:50:00Z")), {
      ok: true,
    });
  });

  it("reports a rejected key with the service's own reason", async () => {
    stubFetch({ response: { header: { resultCode: "30" } } });
    assert.deepEqual(await verifyKmaApiKey(new Date("2026-07-30T00:50:00Z")), {
      ok: false,
      kind: "invalid-key",
      readable: true,
    });
  });

  it("marks a blocked answer as unreadable rather than blaming the key", async () => {
    // The portal omits CORS headers on errors, so a browser sees a bare fetch
    // failure. Claiming "bad key" there would be a guess.
    globalThis.fetch = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    assert.deepEqual(await verifyKmaApiKey(new Date("2026-07-30T00:50:00Z")), {
      ok: false,
      kind: "network",
      readable: false,
    });
  });

  it("reports the missing key without making a request", async () => {
    setKmaApiKey("");
    const calls = stubFetch(envelope([]));
    assert.deepEqual(await verifyKmaApiKey(), {
      ok: false,
      kind: "no-key",
      readable: true,
    });
    assert.equal(calls.length, 0);
  });
});

describe("KMA transport injection", () => {
  it("routes requests through the installed transport instead of fetch", async () => {
    // The portal answers 403 to any request carrying an `Origin` header — the
    // identical request without one returns data. A browser always sends one,
    // so the host substitutes a native or proxied transport.
    setKmaApiKey("test-key");
    globalThis.fetch = (() => {
      throw new Error("fetch must not be used once a transport is installed");
    }) as typeof fetch;

    const urls: string[] = [];
    setKmaTransport(async (url) => {
      urls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(envelope([{ category: "T1H", obsrValue: "27.3" }])),
      };
    });

    const result = await kmaCurrentConditions(126.978, 37.5665, new Date("2026-07-30T00:50:00Z"));
    assert.equal(result.values[0].value, "27.3");
    assert.equal(urls.length, 1);
    assert.ok(urls[0].includes("/getUltraSrtNcst"), urls[0]);
    // The transport is a pipe, not a URL builder: the key and parameters are
    // already in place so a proxy needs no knowledge of the service.
    assert.equal(new URL(urls[0]).searchParams.get("serviceKey"), "test-key");
    setKmaTransport(null);
  });

  it("maps a transport failure to a network error", async () => {
    setKmaApiKey("test-key");
    setKmaTransport(async () => {
      throw new TypeError("Failed to fetch");
    });
    await assert.rejects(
      () => kmaWarnings(),
      (error: KmaError) => error.kind === "network",
    );
    setKmaTransport(null);
  });
});

describe("forecast presentation", () => {
  it("pivots the flat list into one slot per forecast time", () => {
    // The service repeats every category for every hour. Rendered in that order
    // the panel showed the same labels over and over with no time attached.
    const values = [
      { category: "TMP", value: "34", date: "20260803", time: "1500" },
      { category: "SKY", value: "3", date: "20260803", time: "1500" },
      { category: "TMP", value: "35", date: "20260803", time: "1600" },
      { category: "SKY", value: "1", date: "20260803", time: "1600" },
      { category: "TMP", value: "28", date: "20260804", time: "0600" },
    ];
    const slots = groupForecastSlots(values);
    assert.equal(slots.length, 3);
    assert.deepEqual(slots[0], {
      date: "20260803",
      time: "1500",
      values: { TMP: "34", SKY: "3" },
    });
    assert.equal(slots[1].values.TMP, "35");
    assert.equal(slots[2].date, "20260804");
  });

  it("orders slots chronologically across a date boundary", () => {
    const slots = groupForecastSlots([
      { category: "TMP", value: "1", date: "20260804", time: "0300" },
      { category: "TMP", value: "2", date: "20260803", time: "2300" },
    ]);
    assert.deepEqual(
      slots.map((slot) => `${slot.date}${slot.time}`),
      ["202608032300", "202608040300"],
    );
  });

  it("drops entries with no forecast time rather than bucketing them together", () => {
    const slots = groupForecastSlots([
      { category: "TMP", value: "1", date: "", time: "" },
      { category: "TMP", value: "2", date: "20260803", time: "1500" },
    ]);
    assert.equal(slots.length, 1);
  });

  it("hides the raw wind components the direction and speed already express", () => {
    // UUU/VVV are the east-west and north-south vector parts; showing them
    // alongside VEC/WSD is four numbers for one fact.
    const shown = displayableValues([
      { category: "UUU", value: "0", date: "", time: "" },
      { category: "VVV", value: "-0.8", date: "", time: "" },
      { category: "T1H", value: "33.6", date: "", time: "" },
      { category: "WSD", value: "1.5", date: "", time: "" },
    ]).map((entry) => entry.category);
    assert.deepEqual(shown, ["T1H", "WSD"]);
  });

  it("orders values for reading, not by arrival", () => {
    const shown = displayableValues([
      { category: "REH", value: "58", date: "", time: "" },
      { category: "SKY", value: "1", date: "", time: "" },
      { category: "T1H", value: "33.6", date: "", time: "" },
    ]).map((entry) => entry.category);
    // Temperature first, then sky, then the supporting detail.
    assert.deepEqual(shown, ["T1H", "SKY", "REH"]);
  });

  it("maps a bearing to the nearest of eight compass points", () => {
    assert.equal(compassIndex("0"), 0);
    assert.equal(compassIndex("176"), 4); // south
    assert.equal(compassIndex("350"), 0); // wraps back to north
    assert.equal(compassIndex("-45"), 7); // negative bearings normalize
    assert.equal(compassIndex("-999"), null); // missing sentinel
    assert.equal(compassIndex(""), null);
  });
});

describe("gatewayErrorKind", () => {
  it("reads the reason out of the live gateway's JSON fault", () => {
    // Captured verbatim from apis.data.go.kr for an unregistered key.
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

  it("reads the XML form the gateway uses for the same fault", () => {
    const fault =
      "<OpenAPI_ServiceResponse><cmmMsgHeader>" +
      "<errMsg>SERVICE_ERROR</errMsg><returnReasonCode>22</returnReasonCode>" +
      "</cmmMsgHeader></OpenAPI_ServiceResponse>";
    assert.equal(gatewayErrorKind(fault), "rate-limit");
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
