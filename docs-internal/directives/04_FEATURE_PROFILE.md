# geoIM3D Feature Profile

## 필수 기능

- MapLibre 2D 지도
- Cesium 3D Globe 및 Multi-map
- 3D Tiles / I3S / glTF / Gaussian Splat / LiDAR
- CAD(DXF/DWG), BIM/IFC 연계
- Terrain/DEM, 토공, 경사, 가시권 분석
- 일반 Vector/Raster 편집·분석
- DuckDB SQL / PGlite / Sedona
- Whitebox 및 Python Sidecar 처리
- AI Assistant / GeoAgent / Object Detection / Segmentation
- Story Map / Dashboard / Print / Video
- External Plugin 설치와 Marketplace
- 날씨·환경·재난 데이터
- VWorld OpenAPI 연동

## 기본 UI 숨김

- Jupyter Notebook
- Python Console
- Collaboration/Chat
- Field Collection

숨김 요구사항:

- Menu, Toolbar, Panel, Shortcut, Command Palette, Deep Link에서 노출하지 않는다.
- 구현 코드와 Project 호환 필드는 삭제하지 않는다.
- 향후 Feature Profile 변경으로 복원 가능해야 한다.

## Plugin 정책

- 기존 GeoLibre Plugin API 호환 유지
- 사용자 ZIP/URL 설치 허용
- 출처와 위험을 알리고 명시적 승인 후 설치
- Built-in VWorld Plugin은 기본 활성화하되 API Key가 없으면 안전한 안내 상태를 표시
