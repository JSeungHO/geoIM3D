# geoIM3D Plugin Directives

이 파일은 `packages/plugins` 아래 작업에 적용된다.

## Plugin 호환성

- 기존 GeoLibre Plugin API와 Manifest 형식을 유지한다.
- External ZIP/URL Plugin 설치를 허용한다.
- 설치 전에 출처, Plugin ID, Version, 요청 기능을 표시하고 사용자 승인을 받는다.
- Plugin 오류는 전체 App을 중단하지 않고 Error Boundary/Diagnostics로 격리한다.

## VWorld Built-in Plugin

VWorld 기능은 App/Core에 흩어 넣지 말고 Built-in Plugin으로 구현한다.

우선 범위:

- 2D 지도
- 통합 검색
- 주소 ↔ 좌표 변환
- 지적도
- 건물 정보
- 용도지역

원칙:

- `https://www.vworld.kr/dev/v4apiRefer.do`의 공식 최신 Contract를 Source of Truth로 사용한다.
- API Key는 App의 Credential Provider에서 주입받고 Plugin State, URL 로그, Project 파일에 저장하지 않는다.
- Request/Response DTO, 오류 코드, Rate Limit, 좌표계 변환을 Adapter 계층에 캡슐화한다.
- Mock Fixture와 Contract Test를 작성한다.
- Offline Cache는 공식 이용약관과 재배포 정책을 확인한 뒤 허용 범위만 구현한다.
- Cache에는 출처, 생성시각, 만료, 영역, Zoom, 삭제 기능을 포함한다.
- VWorld 장애 시 기존 Basemap과 로컬 데이터 기능이 계속 동작해야 한다.
