# Platform 및 Packaging Directive

## 대상

- 필수: Windows Desktop, Web
- 1차 우선: Windows Desktop
- Docker Image: `geoim3d.docker`
- Web 서비스 URL: 미정이므로 Source에 임의 Domain을 하드코딩하지 않는다.
- Android Application ID 예약: `com.ejbt.mob.geoim3d`
- Python/Jupyter Package: 사용자 UI에서 숨김

## Windows

- Product Name: `geoIM3D`
- Bundle ID: `com.ejbt.geoim3d`
- 자동 업데이트: 사용하지 않음
- Offline 실행: 필수
- File Extension: `.geoim3d.json`
- File Association, Open With, Icon, MIME/ProgID를 함께 검증
- API Key는 OS Credential Store 사용
- Installer와 Portable Package의 동작을 각각 검증

## Web

- API Key는 Memory-only
- PWA Offline Shell과 로컬 데이터 기능 유지
- URL은 Runtime/Build Config로 주입
- Telemetry/Crash Report Script를 포함하지 않음
- Desktop 전용 기능은 명확히 비활성 또는 안내

## Project 파일

Canonical 이름 예:

```text
my-project.geoim3d.json
```

- Open/Save/Save As/Recent Project/Drag-and-drop/Deep Link/CLI에서 동일 확장자 사용
- 내부 JSON에 Credential 포함 금지
- MIME, File Filter, Export 이름, 테스트 Fixture를 함께 갱신
- 기존 `.geolibre.json` Legacy Import는 별도 승인 전 제공하지 않음

## Release 표시

```text
geoIM3D 1.0.0
Copyright © 2026 JBT. All Rights Reserved
```
