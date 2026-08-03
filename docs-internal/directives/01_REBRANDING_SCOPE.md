# Rebranding 범위와 호환 정책

## 사용자 노출 변경

다음 영역의 GeoLibre Identity를 geoIM3D로 변경한다.

- Window/Page Title
- Header, Menu, Welcome, About
- PWA Manifest, Icon, Favicon
- Installer, Shortcut, File Association
- Windows Product Name, Publisher Display
- Docker Image/Container 안내
- Documentation과 Screenshot
- Error/Diagnostic의 제품 표시명
- Project File Dialog와 기본 확장자

## 유지 항목

- 원본 GeoLibre MIT License와 `Copyright (c) 2026 Qiusheng Wu`
- About/License의 원본 프로젝트 링크 `https://github.com/opengeos/GeoLibre`
- Third-party License/Attribution
- 내부 npm Namespace `@geolibre/*`
- 기존 Plugin API/Manifest
- 내부 Project Schema의 호환 가능한 구조

## 제거·변경 금지

- 현재 작업 저장소의 `.git`를 Agent가 삭제하지 않는다.
- GeoLibre License Header와 Attribution을 제거하지 않는다.
- 단순 전역 문자열 치환으로 Package Import, API Route, Storage Key를 깨지 않는다.

## 비공개 저장소 이전

현재 Git 이력은 geoIM3D 비공개 저장소에 유지하지 않는다. 이전은 다음 별도 절차로 수행한다.

1. 승인된 Source Snapshot 생성
2. `LICENSE`, Third-party Notice, 원본 Attribution 포함 확인
3. 새 비공개 저장소 초기화
4. `geoIM3D initial import` Commit 생성
5. 원본 Source URL과 기준 Version/Commit을 내부 문서에 기록

실행 절차와 승인 Gate는 [`docs/rebranding/PRIVATE_REPOSITORY_SNAPSHOT.md`](../rebranding/PRIVATE_REPOSITORY_SNAPSHOT.md)를 따른다.

현재 저장소 History Rewriting이나 `.git` 삭제로 대체하지 않는다.

## Copyright

사용자 노출 문구:

```text
Copyright © 2026 JBT. All Rights Reserved
```

MIT License가 허용하는 범위에서 JBT의 추가 저작권을 표시하되 원 저작권 고지를 보존한다.
