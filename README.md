# True Size Map Demo (OpenLayers + Vite)

Web Mercator(`EPSG:3857`) 지도를 유지한 상태에서, 국가 폴리곤을 드래그해 위도에 따라 크기가 변하는 True Size 스타일을 보여주는 최소 데모입니다.

## 핵심 아이디어

- 지도 투영은 **EPSG:3857** 유지
- 원본 폴리곤은 **EPSG:4326**으로 보관
- 드래그 시 원본을 직접 변경하지 않고, 렌더링 시점에 표시용 geometry를 생성
- 스케일 계산식:

```txt
scale = cos(originalLat) / cos(targetLat)
```

## 프로젝트 구조

```txt
.
├── index.html
├── package.json
├── vite.config.js
└── src
    ├── data
    │   └── country.geojson
    ├── main.js
    └── style.css
```

## 실행 방법

```bash
npm install
npm run dev -- --host
```

브라우저에서 표시된 주소(또는 `http://localhost:5173`)로 접속합니다.

## 구현 요약

- Feature 상태값
  - `sourceGeometry4326`: 원본 geometry (불변)
  - `originCenter4326`: 원래 중심
  - `displayCenter4326`: 현재 이동 중심
- 렌더링 파이프라인
  1. 원본 clone
  2. origin → display center translate (4326)
  3. 3857 transform
  4. display center 기준 scale 적용
- 인터랙션
  - pointerdown/move/up으로 직접 드래그 구현
  - 드래그 중 `displayCenter4326`만 변경
  - `feature.changed()`로 재렌더링

## 제한사항

- `cos` 기반 단일 스케일은 근사치이므로 고위도/대형 폴리곤에서 오차가 커질 수 있습니다.
- 향후 정확도 개선을 위해 vertex 단위 보정 또는 지오데식 기반 보정을 고려할 수 있습니다.
