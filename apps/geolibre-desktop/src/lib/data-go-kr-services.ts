/**
 * The data.go.kr services this app calls, and where to apply for each.
 *
 * The portal issues **one service key per account**, but that key is not enough
 * on its own: every OpenAPI needs its own 활용신청, and the gateway refuses an
 * otherwise-valid key for any service it was not approved for. Settings only
 * linked to the key-issuing page, so a user who had done everything the app
 * asked still saw features fail with no way to know an approval was missing —
 * the refusal arrives as a bare 403, indistinguishable at a glance from a bad
 * key.
 *
 * Approval also takes effect on a delay (about an hour), so "I just applied and
 * it still fails" is expected rather than a fault. Both facts are told to the
 * user next to the key field.
 *
 * Adding an API later is one row here plus its two strings in
 * `locales-geoim3d/*.json`.
 */

export interface DataGoKrService {
  /** Stable id; also the i18n key suffix. Must be unique. */
  id: string;
  /**
   * Where to apply. A dataset page when the numeric id is confirmed, otherwise
   * a portal search for the service name — the portal's search results are
   * rendered client-side, so a dataset id cannot be looked up programmatically
   * and guessing one would link the user to the wrong service.
   */
  url: string;
}

/**
 * Builds a portal search URL for a service whose dataset id is not confirmed.
 *
 * @param keyword - The service name as it appears on the portal.
 * @returns The search URL.
 */
function portalSearch(keyword: string): string {
  return `https://www.data.go.kr/tcs/dss/selectDataSetList.do?keyword=${encodeURIComponent(
    keyword,
  )}`;
}

/**
 * Builds a dataset page URL.
 *
 * @param datasetId - The portal's numeric dataset id, confirmed against the
 *   page's own title.
 * @returns The dataset URL.
 */
function portalDataset(datasetId: string): string {
  return `https://www.data.go.kr/data/${datasetId}/openapi.do`;
}

/** In the order a user is most likely to want them. */
export const DATA_GO_KR_SERVICES: readonly DataGoKrService[] = [
  // 15084084 → "기상청_단기예보 조회서비스". One approval covers 초단기실황,
  // 초단기예보 and 단기예보 alike: they are operations of one service.
  { id: "villageForecast", url: portalDataset("15084084") },
  { id: "weatherWarning", url: portalSearch("기상청_기상특보 조회서비스") },
  { id: "typhoon", url: portalSearch("기상청_태풍정보 조회서비스") },
  // Air quality needs both: one says where the stations are, the other what
  // they are reading. Either one alone renders nothing.
  { id: "airQualityStations", url: portalDataset("15073877") },
  { id: "airQualityReadings", url: portalDataset("15073861") },
];
