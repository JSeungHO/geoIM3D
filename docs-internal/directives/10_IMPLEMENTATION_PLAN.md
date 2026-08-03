# geoIM3D Rebranding 및 Customizing 개발 계획

> 현재 진행 상태, 다음 Sprint, 재개 절차는 Repository Root의 [`PLAN.md`](../../PLAN.md)를 Source of Truth로 사용한다.

## Phase 0 — Baseline과 Inventory

상태: **완료** — 실행 결과와 Windows Runtime 증거는 [`docs/rebranding/00_PHASE0_CLOSURE.md`](../rebranding/00_PHASE0_CLOSURE.md)를 따른다.

목표:

- Source/Build/Package의 GeoLibre Brand 문자열 전수 분류
- 현재 Test/Build/Windows 실행 Baseline 확보
- 원본 License와 Third-party Attribution 목록 고정

산출물:

- [x] Brand Inventory
- [x] 금지 문자열 검사 Script
- [x] Baseline Test Report
- [x] Private Repository Snapshot 절차

DoD:

- 변경 가능 표시명과 유지할 내부 식별자가 구분됨
- 현재 전체 Gate의 통과/실패/Skip이 기록됨

## Phase 1 — Brand Foundation

목표:

- 중앙 Brand Config와 Design Token 구축
- favicon을 Local Asset으로 반영
- Page/Window/About/PWA 표시를 geoIM3D로 변경

DoD:

- About/License 외 사용자 화면에 GeoLibre 미노출
- Light Theme와 Brand Color 접근성 통과
- `geoIM3D 1.0.0` 및 JBT Copyright 표시

## Phase 2 — Feature Profile과 기본 UX

목표:

- 한국어 전용 UI
- 3D Globe 기본 시작
- Splash/Welcome/Sample 제거
- Jupyter/Collaboration/Field Collection 숨김

DoD:

- Menu, Shortcut, Command Palette, Deep Link 우회 노출 없음
- 기존 필수 기능 회귀 없음

## Phase 3 — Project Identity

목표:

- `.geoim3d.json` Open/Save/Recent/Drag-and-drop/File Association
- 내부 Schema와 Plugin 호환 유지

DoD:

- Round-trip과 Invalid Project Test 통과
- Project 파일에 Credential 없음
- Windows Explorer에서 연결 실행 성공

## Phase 4 — Credential 및 Settings

목표:

- Desktop OS Credential Store
- Web Memory-only Settings
- VWorld/AI Provider Settings

DoD:

- 저장/조회/삭제 Test
- Source, 로그, Project, Local Storage Secret 0건
- Web Reload 후 Key 제거 확인

## Phase 5 — VWorld Built-in Plugin

순서:

1. 공식 API Contract 조사
2. 공통 Client/Auth/Error Adapter
3. 2D 지도
4. 검색
5. 주소/좌표 변환
6. 지적도·건물·용도지역
7. 허용 범위 Offline Cache

DoD:

- API Key Redaction
- Mock Contract와 오류 Test
- 좌표계 검증
- VWorld 장애 시 App 지속 동작
- Attribution과 이용약관 준수

## Phase 6 — Windows/Web Packaging

목표:

- Windows `com.ejbt.geoim3d`
- Product/Installer/Icon/File Association
- 자동 업데이트 제거
- Docker `geoim3d.docker`
- Offline Runtime 검증

DoD:

- Windows Install/Run/Save/Open/Uninstall 통과
- Web PWA Offline 통과
- Update UI/Background Check 미동작

## Phase 7 — 3D 업무 기능 강화

우선 검토:

- BIM/IFC Import Adapter
- CAD와 GIS 좌표 정합
- 토공량/절성토 분석
- 경사·가시권·안전 분석
- 3D Scene Project Preset
- 환경·재난 Data Dashboard

각 기능은 별도 요구사항과 Acceptance를 승인받아 진행한다.

## Phase 8 — Release 1.0

필수:

- Lint/Build/Frontend Coverage/Backend Full Coverage
- Worker/Python/Rust/E2E
- Windows Package 실제 Smoke
- Offline Test
- License/Attribution Audit
- Brand 문자열 Audit
- npm/pip/cargo Security Audit

Release 표기:

```text
geoIM3D 1.0.0
Copyright © 2026 JBT. All Rights Reserved
```
