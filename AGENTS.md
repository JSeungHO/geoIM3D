# geoIM3D Codex Directives

## 1. 지침 우선순위

이 저장소는 GeoLibre 2.1.0을 기반으로 하는 JBT의 비공개 제품 특화 Fork **지오아임3D(geoIM3D)** 이다.

작업 시 지침 우선순위는 다음과 같다.

1. 현재 작업 디렉터리에서 가장 가까운 `AGENTS.md`
2. 루트 `AGENTS.md`
3. `docs-internal/directives/*.md`의 승인된 제품 결정
4. 기존 `CLAUDE.md`의 GeoLibre 기술·아키텍처 지침
5. 일반적인 개발 관례

충돌 시 더 구체적이고 최신인 지침을 따른다. 제품 결정을 임의로 변경하지 않는다.

## 2. 제품 Identity

- 제품명: **지오아임3D / geoIM3D**
- 회사: **JBT**
- 슬로건: **실감형 3D 플랫폼**
- 사용자 노출 버전: `geoIM3D 1.0.0` 형식
- Copyright: `Copyright © 2026 JBT. All Rights Reserved`
- 회사 URL: `https://www.ejbt.co.kr/`
- 대표색: `#0B365F`, `#33CC27`, `#FFFFFF`, `#1039BD`
- 사용자 화면에서 `GeoLibre` 이름은 About, License, Third-party Attribution 이외에는 표시하지 않는다.
- 원본 GeoLibre의 MIT License, `Copyright (c) 2026 Qiusheng Wu`,
  `https://github.com/opengeos/GeoLibre` 링크를 유지한다.

상세 결정은 `docs-internal/directives/00_PRODUCT_VISION.md`와 `01_REBRANDING_SCOPE.md`를 따른다.

## 3. 변경 범위

- 제품 특화 Fork이며 단순 문자열 치환 프로젝트가 아니다.
- 사용자 노출 Brand, Windows/Web Packaging Identity, Project 확장자와 Feature Profile을 변경한다.
- 내부 npm Namespace `@geolibre/*`, Project Schema 구조, 기존 Plugin API는 초기 버전에서 유지한다.
- 기존 Git 이력을 현재 작업 폴더에서 삭제하지 않는다. 별도 비공개 저장소 이전은 Snapshot Import 절차로 수행한다.
- Upstream Merge를 전제로 설계할 필요는 없지만, 대형 중앙 파일의 추가 비대화는 금지한다.

## 4. 아키텍처 불변조건

- `@geolibre/core`의 Zustand Store가 Domain State의 단일 진실 공급원이다.
- UI에서 MapLibre를 임의 조작하지 말고 Store 변경 후 `MapCanvas`/`MapController` 동기화 경로를 사용한다.
- 기존 `@geolibre/*` Package 이름과 External Plugin API 호환성을 깨지 않는다.
- VWorld 기능은 Built-in Plugin으로 구현한다.
- 공통 Brand, Feature Profile, Project 파일 기능은 App/Core에 구현한다.
- Jupyter/Python Console, Collaboration/Chat, Field Collection은 삭제하지 않고 기본 UI Profile에서 숨긴다.
- 새 기능은 가능하면 작은 Adapter, Service, Hook, Plugin으로 분리한다.

## 5. 보안·개인정보

- API Key, Token, Password를 Source, Project 파일, URL, 로그, Local Storage에 저장하지 않는다.
- Windows Desktop Credential은 OS Credential Store를 사용한다.
- Web Credential은 Memory에만 보관하고 새로고침 시 제거한다.
- 외부 AI 전송은 허용되지만 Provider와 전송 데이터 범위를 사용자에게 명시한다.
- External Plugin ZIP/URL 설치는 허용하되 Trust 경고, 출처 표시, 명시적 사용자 동의를 유지한다.
- Telemetry, Crash Report, 사용 통계를 추가하지 않는다.
- Sidecar Token, Trusted Host, CORS, Conversion Root, Tauri Capability, CSP를 약화하지 않는다.
- VWorld Offline Cache는 공식 약관과 API 정책이 허용하는 범위에서만 구현한다.

보안 관련 변경은 Agent가 임의 진행하지 말고 계획과 위험을 먼저 보고한다.

## 6. 개발 절차

1. 가장 가까운 `AGENTS.md`와 관련 Directive를 읽는다.
2. 관련 Source, Test, Build/Packaging 결합 지점을 감사한다.
3. 기존 동작과 실패 Baseline을 기록한다.
4. 회귀 Test 또는 Contract Test를 먼저 추가한다.
5. 최소 변경으로 구현한다.
6. 관련 Test를 실행한 뒤 필수 Gate를 실행한다.
7. 실제 Windows Desktop 실행/Package Smoke를 각 Phase 완료 전에 수행한다.
8. 변경 파일, 실행 결과, 잔여 위험을 보고한다.

Agent는 작업 규모에 따라 계획 승인 필요성을 판단한다. 다음은 항상 사전 확인한다.

- Credential 저장·전송 방식 변경
- License/Copyright 삭제 또는 변경
- Project Schema 비호환 변경
- Plugin API 비호환 변경
- 데이터 삭제·Migration
- `.git` 삭제, History 재작성, Release/배포

## 7. Git 규칙

- `main`에 직접 Commit하지 않는다.
- 작업별 Branch를 생성한다.
- Agent는 Branch, Commit, PR을 생성할 수 있다.
- Commit은 기능 단위로 작게 나누고 목적과 검증 결과를 메시지에 반영한다.
- 새 비공개 저장소 생성이나 현재 Git History 제거는 명시적 승인 후 수행한다.

## 8. Dependency 규칙

npm/pip/cargo Dependency는 사전 승인 없이 추가할 수 있으나 다음을 지킨다.

- 기존 Dependency로 해결 가능한지 먼저 확인한다.
- 추가 이유, License, Bundle/설치 크기, 보안 영향, 대안을 보고한다.
- Lockfile을 함께 갱신한다.
- Browser Bundle에 Node 전용 모듈이 포함되지 않도록 검증한다.
- 미사용 Dependency를 남기지 않는다.

## 9. 필수 품질 Gate

기본 필수 Gate:

```bash
npm run lint
npm run build
npm run test:frontend:coverage
npm run test:backend:coverage
```

- 기존 실패는 Baseline으로 기록할 수 있지만 새 실패를 추가하면 안 된다.
- 관련 Worker, Python, Rust, E2E는 변경 영역에 따라 추가 실행한다.
- Windows Desktop 관련 변경은 `npm run tauri:dev` 또는 Package Smoke로 실제 검증한다.
- 문서와 CHANGELOG는 매 변경에 필수는 아니지만 사용법·보안·호환성·Release 동작이 바뀌면 갱신한다.

## 10. 관련 문서

- `docs-internal/directives/00_PRODUCT_VISION.md`
- `docs-internal/directives/01_REBRANDING_SCOPE.md`
- `docs-internal/directives/02_ARCHITECTURE_BOUNDARIES.md`
- `docs-internal/directives/03_UI_BRAND_SYSTEM.md`
- `docs-internal/directives/04_FEATURE_PROFILE.md`
- `docs-internal/directives/05_VWORLD_INTEGRATION.md`
- `docs-internal/directives/06_PLATFORM_PACKAGING.md`
- `docs-internal/directives/07_SECURITY_PRIVACY.md`
- `docs-internal/directives/08_TESTING_RELEASE.md`
- `docs-internal/directives/09_GIT_AGENT_WORKFLOW.md`
- `docs-internal/directives/10_IMPLEMENTATION_PLAN.md`
