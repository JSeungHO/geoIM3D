# geoIM3D

![JBT geoIM3D](apps/geolibre-desktop/public/logo-im3d.png)

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**JBT geoIM3D**는 3D 공간정보와 3DGS(3D Gaussian Splatting) 데이터를 웹 브라우저,
데스크톱, 모바일에서 함께 보고 분석하기 위한 클라우드 네이티브 GIS 플랫폼입니다.
데이터는 사용자의 환경에 그대로 두고, 브라우저 안에서 변환·분석합니다.

**Tauri v2**, **React**, **TypeScript**, **MapLibre GL JS**, **DuckDB-WASM Spatial**,
**deck.gl** 위에 구축되어 있으며, 하나의 코드베이스가 네이티브 데스크톱 앱, Android 앱,
웹 브라우저, Jupyter 노트북에서 동일하게 동작합니다.

> 이 저장소는 오픈소스 [GeoLibre](https://github.com/opengeos/GeoLibre)(MIT)를 포크하여
> ㈜제이비티의 geoIM3D 서비스에 맞게 리브랜딩한 것입니다. 원 저작자와 기여자에게 감사드립니다.

## 주요 기능

- **3D 시각화** — 3D Tiles, 지형, 건물 돌출, 포인트 클라우드, 3DGS 장면
- **클라우드 네이티브 포맷** — COG, PMTiles, GeoParquet, FlatGeobuf를 원격에서 직접 열람
- **브라우저 내 분석** — DuckDB-WASM Spatial 기반 공간 SQL, Turf.js 벡터 처리, 700+ WASM 지오프로세싱 도구
- **어디서나 실행** — 데스크톱(Windows/macOS/Linux), 웹, Android, Jupyter
- **플러그인** — 내장 플러그인과 외부 플러그인(zip / manifest URL) 로딩
- **다국어** — 한국어·영어를 포함한 UI 번역, `?locale` 파라미터로 임베드 언어 지정

## 시작하기

Node **22+**, npm 사용. 저장소 루트에서 한 번의 설치로 모든 워크스페이스가 연결됩니다.

```bash
npm install
npm run dev            # 웹 개발 서버 → http://localhost:5173
npm run tauri:dev      # 데스크톱 앱 (파일 대화상자, 로컬 MBTiles/래스터 읽기에 필요)
npm run build          # 웹 프로덕션 빌드 → apps/geolibre-desktop/dist/
npm run tauri:build    # 데스크톱 설치 파일
npm run ci             # 전체 검증 (빌드 + 프론트엔드/워커/백엔드 테스트 + rust check)
```

테스트, 커버리지 기준, 사전 커밋 훅 등 개발 관련 상세 내용은 [CLAUDE.md](CLAUDE.md)와
[docs/contributing.md](docs/contributing.md)를 참고하세요.

## 구조

npm workspaces 모노레포(`apps/*`, `packages/*`, `workers/*`)와, npm이 아닌 두 구성요소
(Python FastAPI 사이드카 `backend/geolibre_server`, Jupyter anywidget 패키지 `python/`)로
이루어져 있습니다.

| 패키지 | 역할 |
| --- | --- |
| `@geolibre/core` | 도메인 타입, 프로젝트 포맷, Zustand 스토어 (단일 진실 공급원) |
| `@geolibre/map` | MapLibre 생명주기와 레이어 동기화 |
| `@geolibre/ui` | UI 프리미티브 |
| `@geolibre/processing` | 클라이언트 사이드 알고리즘 레지스트리 |
| `@geolibre/plugins` | 플러그인 인터페이스 및 내장 플러그인 |
| `geolibre-desktop` | 셸 레이아웃, Tauri I/O, 조립 |

## 문서

- [아키텍처](docs/architecture.md)
- [프로젝트 파일 포맷](docs/project-format.md)
- [플러그인 API](docs/plugin-api.md)
- [UI 프로필](docs/ui-profiles.md)
- [국제화(i18n)](docs/i18n.md)
- [Python 패키지 (Jupyter)](docs/python.md)
- [Android](docs/android.md) · [iOS](docs/ios.md)
- [기여 가이드](docs/contributing.md)

## 문의

㈜제이비티 — <https://www.ejbt.co.kr> · <ks.jang@ejbt.co.kr>

## 라이선스

[MIT](LICENSE). 업스트림 GeoLibre 및 사용된 오픈소스 프로젝트(MapLibre GL JS, deck.gl,
DuckDB-WASM Spatial, Turf.js, Tauri, React 등)의 라이선스를 함께 따릅니다.
