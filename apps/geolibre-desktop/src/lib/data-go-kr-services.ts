/**
 * The data.go.kr services this app calls, listed so a user knows what to apply
 * for.
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
 * **Names, not links.** A deep link into the portal is a URL we do not control:
 * when it moves it does not fail loudly, it lands somewhere wrong, and nothing
 * here would notice. The service names are what the portal's own search takes,
 * and they outlive its URL scheme.
 *
 * Adding an API later is one id here plus its two strings in
 * `locales-geoim3d/*.json`.
 */

/**
 * Service ids, in the order a user is most likely to want them. Each is also
 * the i18n key suffix for the service's name and for what it unlocks.
 */
export const DATA_GO_KR_SERVICES: readonly string[] = [
  // One approval covers 초단기실황, 초단기예보 and 단기예보 alike: they are
  // operations of a single service.
  "villageForecast",
  "weatherWarning",
  "typhoon",
  // Air quality needs both: one says where the stations are, the other what
  // they are reading. Either one alone renders nothing.
  "airQualityStations",
  "airQualityReadings",
];
