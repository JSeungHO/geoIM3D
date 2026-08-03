# 테스트 및 Release Directive

## 필수 Gate

```bash
npm run lint
npm run build
npm run test:frontend:coverage
npm run test:backend:coverage
```

기존 실패는 Baseline으로 기록할 수 있으나 새 실패는 허용하지 않는다.

## 변경별 추가 Gate

| 변경 | 추가 검증 |
|---|---|
| UI/Brand/Profile | Playwright E2E, Accessibility |
| Map/3D | Worker Typecheck, WebGL/Cesium Browser Smoke |
| Tauri/Windows | Cargo Check, Tauri Dev, 실제 Package Smoke |
| Project Schema | Round-trip, Invalid Input, Migration Test |
| Plugin/VWorld | Mock Contract, Error/Rate Limit, Offline Test |
| Sidecar | 전체 `test` Extra Backend Suite |
| PWA/Offline | Service Worker Offline E2E |
| Packaging | Install, Upgrade, Uninstall, File Association |

## Windows Phase Gate

각 개발 Phase 완료 전에 실제 Windows Desktop에서 확인한다.

- 실행
- 2D/3D 지도 초기화
- Project Open/Save
- Offline 재실행
- Credential 저장/조회/삭제
- Plugin 설치
- 해당 Phase 신규 기능
- Console/Native 오류 없음

## Brand Acceptance

- 사용자 화면 금지 문자열 검사: About/License 이외 `GeoLibre` 노출 0건
- `geoIM3D`, JBT, Version, Copyright 정확성
- `.geoim3d.json` File Association
- 한국어 UI와 Light Theme
- 3D Globe 기본 시작
- 숨김 Feature의 우회 노출 없음

## Release Blocker

- Credential 평문 저장
- License/Attribution 누락
- Project 파일 손상
- Windows Package 실행 실패
- Offline 핵심 기능 실패
- 새 Critical/High 보안 취약점
