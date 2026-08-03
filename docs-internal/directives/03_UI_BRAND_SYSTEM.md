# UI Brand System

## 기본 경험

- 기본 언어: 한국어
- 추가 언어 UI: 노출하지 않음
- 기본 Theme: Light
- 기본 View: Cesium 3D Globe
- 기존 Basemap: 유지
- 기존 Sidebar/Menu 구조: 유지
- Splash: 없음
- Welcome Wizard: 없음
- Sample Project: 없음
- Support 이메일: 표시하지 않음

## Color Token

| 역할 | 값 |
|---|---|
| Primary Navy | `#0B365F` |
| Accent Green | `#33CC27` |
| Surface White | `#FFFFFF` |
| Secondary Blue | `#1039BD` |

접근성 기준:

- 일반 텍스트 WCAG AA Contrast 준수
- Focus Ring을 색상만으로 구분하지 않음
- Green은 성공/활성 또는 Brand Accent로 제한적으로 사용
- 3D 지도 위 Overlay는 명도 대비와 반투명 배경을 함께 사용

## Logo와 Icon

- 제공된 favicon Source: `https://www.ejbt.co.kr/images/fs/favicon.ico`
- Build 시 Local Asset으로 포함하고 Runtime Remote Fetch 금지
- 가로형 Logo가 없으므로 텍스트 Wordmark `geoIM3D` 사용
- 임의로 JBT Logo를 새로 디자인하지 않는다.
- Installer/PWA/MSIX Icon 변환 시 원본 비율과 투명 배경을 보존한다.

## About

반드시 표시:

- `geoIM3D 1.0.0`
- `실감형 3D 플랫폼`
- `Copyright © 2026 JBT. All Rights Reserved`
- `https://www.ejbt.co.kr/`
- Based on GeoLibre: `https://github.com/opengeos/GeoLibre`
- GeoLibre MIT License와 Third-party Attribution 링크
