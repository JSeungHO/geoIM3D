# VWorld OpenAPI 연동 Directive

## Source of Truth

개발 시작 시 반드시 공식 문서를 다시 확인한다.

- `https://www.vworld.kr/dev/v4apiRefer.do`

기억이나 비공식 Blog의 Endpoint, Parameter, Error Code를 사용하지 않는다.

## 1차 범위

1. VWorld 2D 지도 Layer
2. 통합 검색
3. 주소 → 좌표 변환
4. 좌표 → 주소 변환
5. 지적도
6. 건물 정보
7. 용도지역

## 구현 구조

```text
VWorld Plugin UI
      ↓
VWorld Client Interface
      ↓
Auth/RateLimit/Retry Adapter
      ↓
Official OpenAPI
```

- API Client, DTO, Map Layer Adapter, Search UI, Cache를 분리한다.
- 좌표계(EPSG)를 Request/Response DTO에 명시하고 Map Store 입력 전 변환한다.
- Network Timeout, Rate Limit, Invalid Key, No Result를 구분한다.
- 오류에 API Key나 전체 Request URL을 포함하지 않는다.

## Credential

- Settings에서 사용자가 입력한다.
- Desktop은 OS Credential Store에 저장한다.
- Web은 Memory에서만 유지한다.
- Project JSON, Plugin Project State, Local Storage, IndexedDB에 저장하지 않는다.
- Diagnostic Export에서 Key를 Redact한다.

## Offline Cache

공식 이용약관과 데이터 재배포 정책을 확인하기 전에는 영구 Tile 다운로드를 구현하지 않는다.

허용되는 경우 Cache에 포함:

- 데이터 출처와 Attribution
- 영역, Zoom, Layer
- 생성 시각과 만료
- 예상 크기와 실제 크기
- 사용자 삭제/전체 삭제
- Quota 초과 처리

온라인 VWorld가 없어도 기존 Basemap과 로컬 Project는 정상 동작해야 한다.
