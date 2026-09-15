# 3D 객체 → 예시 파일

**3D 객체** 패널의 예시 파일 목록은 더 이상 앱에 번들되지 않습니다. 스플랫은
수백 MB가 예사라, 예전처럼 `apps/geolibre-desktop/public/objects/`에 넣으면
설치 파일·웹 번들이 그만큼 무거워졌습니다. 지금은 geoIM3D 자체 파일 서버
(`remote.ejbt.co.kr:45673`)에서 매니페스트와 파일을 함께 받아옵니다.

## 어디서 뭘 관리하나

- **매니페스트 위치**: `packages/plugins/src/plugins/geoim3d-object-presets.ts`의
  `BUNDLED_OBJECTS_MANIFEST` 상수. 지금은
  `http://remote.ejbt.co.kr:45673/files/objects/manifest.json`.
- **매니페스트 내용**과 실제 파일(`.sog`, `tileset.json` 등)은 이 저장소가 아니라
  원격 파일 서버 쪽에 있습니다. 새 예시를 추가/수정하려면 그 서버의
  `files/objects/` 아래를 직접 편집해야 합니다 — 이 저장소를 고쳐도 반영되지
  않습니다.

## manifest.json 형식

기존과 동일합니다. `baseUrl`이 실제 파일들의 위치를 정하고, `file`/`tileset`은
거기에 상대 경로로 붙습니다(절대 URL을 쓰면 그대로 존중됨 —
`packages/plugins/src/plugins/geoim3d-object-presets.ts`의 `parseBundledManifest`
참고).

```json
{
  "baseUrl": "http://remote.ejbt.co.kr:45673/files/objects/",
  "objects": [
    {
      "file": "3d_object/gogiri_park.sog",
      "name": "고기리 공원",
      "longitude": 127.07029,
      "latitude": 37.35718,
      "altitude": 1,
      "scale": 0.075,
      "rotation": [-90, 296, 0],
      "tileset": "3d_tiles/gogiri/tileset.json",
      "tilesetTransform": {
        "longitude": 127.07029,
        "latitude": 37.35711,
        "altitude": 0,
        "scale": 2.7,
        "rotation": [-90, -119, 0]
      }
    }
  ]
}
```

| 항목                       | 필수 | 설명                                                             |
| -------------------------- | ---- | ---------------------------------------------------------------- |
| `file`                      | 예   | `baseUrl` 기준 상대 경로, 또는 절대 URL                            |
| `name`                       | 아니오 | 메뉴에 보일 이름. 없으면 파일 이름                                 |
| `longitude` / `latitude`      | 예   | WGS84 십진도 (splat 배치)                                          |
| `altitude`                    | 아니오 | 지면으로부터의 높이(m). 기본 0                                     |
| `scale`                       | 아니오 | 배율. 기본 1                                                       |
| `rotation`                    | 예   | `[X, Y, Z]` 각도. **없으면 그 항목은 통째로 무시됨** (splat/glTF 축이 달라 잘못된 기본값을 넣느니 안 띄우는 편이 낫다는 설계) |
| `tileset`                     | 아니오 | globe(Cesium)에서 대신 보여줄 3D Tiles 짝. 없으면 globe에서는 안 보임 |
| `tilesetTransform`             | 아니오 | 타일셋 쪽 별도 배치. 없으면 splat과 같은 좌표 사용                   |

`tileset`이 왜 필요한지: 스플랫은 `maplibre-gl-splat`(MapLibre 전용 컨트롤)로
그려서 Cesium globe가 주 화면일 때는 아무것도 안 보입니다. 같은 현장을 3D
Tiles로도 함께 올려두면 globe에서는 그쪽이 대신 보입니다
(`packages/plugins/src/plugins/geoim3d-objects.ts`의 `TILESET_COMPANION_ENABLED`).

## 좌표를 구하는 가장 쉬운 방법

숫자를 손으로 맞추지 마세요.

1. 앱에서 **3D 객체 → URL로 올리기**로 원격 서버의 파일 URL을 직접 엽니다
2. 패널에서 경도·위도·고도·크기·회전을 눈으로 맞춥니다
3. **예시로 저장**을 누릅니다
4. 브라우저 개발자도구 → Application → Local Storage →
   `geoim3d.object-presets`에서 그 항목의 `transform` 값을 복사해 원격
   `manifest.json`에 옮깁니다

## 크로스 오리진 / 접속 제약

파일 서버가 `https`가 아닌 **`http`**라서 세 가지 배포 형태가 각각 다르게
동작합니다:

- **데스크톱(Tauri)**: 항상 동작합니다. `resolveReadableUrl`/`fetchManifestText`
  (`geoim3d-objects.ts`)가 크로스오리진 plain-http URL을 네이티브 Rust HTTP
  호출(`fetchUrlBytes`)로 우회하므로 웹뷰의 CORS·CSP·mixed-content 규칙을
  아예 타지 않습니다.
- **브라우저 개발 서버 / http로 서빙되는 내부 배포**: 앱 페이지 자체가
  `https`가 아니면 mixed-content 규칙이 없으므로 매니페스트·객체 파일 요청이
  그대로 나갑니다. 실제로 읽히려면 파일 서버가 CORS를 막지 않아야 하는데,
  Synology File Station 기본 정적 서빙은 보통 이를 막지 않아 지금까지는
  별문제 없이 동작해 왔습니다 — 서버 쪽 CORS 헤더가 바뀌면 이 가정이 깨질 수
  있습니다.
- **`https`로 서빙되는 프로덕션 웹 빌드**: 아직 해결 안 됨. 브라우저가
  `https` 페이지에서 `http` 리소스를 mixed-content로 통째로 막고, 이 저장소엔
  이걸 우회할 프록시가 없습니다(`docker/nginx.conf`엔 `/sidecar/`만 있음). 이
  배포 형태에서 예시 파일을 쓰려면 파일 서버를 `https`로 올리거나, nginx에
  전용 프록시 location을 추가해야 합니다 — 아직 손대지 않음.
