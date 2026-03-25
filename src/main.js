import './style.css';
import GeoJSON from 'ol/format/GeoJSON';
import Map from 'ol/Map';
import View from 'ol/View';
import { OSM, Vector as VectorSource } from 'ol/source';
import { Tile as TileLayer, Vector as VectorLayer } from 'ol/layer';
import DragPan from 'ol/interaction/DragPan';
import Feature from 'ol/Feature';
import { Fill, Stroke, Style } from 'ol/style';
import { fromLonLat, transform } from 'ol/proj';

const originLatEl = document.getElementById('origin-lat');
const currentLatEl = document.getElementById('current-lat');
const scaleValueEl = document.getElementById('scale-value');

const vectorSource = new VectorSource();

const countryStyle = new Style({
  fill: new Fill({ color: 'rgba(255, 87, 34, 0.45)' }),
  stroke: new Stroke({ color: '#ff3d00', width: 2 }),
});

/**
 * True Size 렌더링용 geometry 생성
 * - 원본 4326 geometry를 clone
 * - originCenter -> displayCenter 이동
 * - 3857 변환
 * - displayCenter 기준 scale 적용
 */
function createRenderGeometry(feature) {
  const sourceGeometry4326 = feature.get('sourceGeometry4326');
  const originCenter4326 = feature.get('originCenter4326');
  const displayCenter4326 = feature.get('displayCenter4326');

  const renderGeometry4326 = sourceGeometry4326.clone();
  const dx = displayCenter4326[0] - originCenter4326[0];
  const dy = displayCenter4326[1] - originCenter4326[1];
  renderGeometry4326.translate(dx, dy);

  const renderGeometry3857 = renderGeometry4326.clone().transform('EPSG:4326', 'EPSG:3857');

  const originalLatRad = (originCenter4326[1] * Math.PI) / 180;
  const targetLatRad = (displayCenter4326[1] * Math.PI) / 180;

  const cosTarget = Math.cos(targetLatRad);
  const safeCosTarget = Math.max(cosTarget, 1e-6); // 극지방 분모 0 방지
  const scale = Math.cos(originalLatRad) / safeCosTarget;

  const displayCenter3857 = fromLonLat(displayCenter4326);
  renderGeometry3857.scale(scale, scale, displayCenter3857);

  return { geometry: renderGeometry3857, scale };
}

function updateInfoPanel(feature) {
  const originCenter = feature.get('originCenter4326');
  const displayCenter = feature.get('displayCenter4326');
  const originalLatRad = (originCenter[1] * Math.PI) / 180;
  const targetLatRad = (displayCenter[1] * Math.PI) / 180;
  const scale = Math.cos(originalLatRad) / Math.max(Math.cos(targetLatRad), 1e-6);

  originLatEl.textContent = `${originCenter[1].toFixed(4)}°`;
  currentLatEl.textContent = `${displayCenter[1].toFixed(4)}°`;
  scaleValueEl.textContent = scale.toFixed(4);
}

const vectorLayer = new VectorLayer({
  source: vectorSource,
  style: (feature) => {
    const { geometry } = createRenderGeometry(feature);
    countryStyle.setGeometry(geometry);
    return countryStyle;
  },
});

const map = new Map({
  target: 'map',
  layers: [
    new TileLayer({ source: new OSM() }),
    vectorLayer,
  ],
  view: new View({
    center: fromLonLat([0, 5]),
    zoom: 2,
  }),
});

function clampLatitude(lat) {
  return Math.max(-80, Math.min(80, lat));
}

// pointer 이벤트로 직접 드래그 구현
const dragState = {
  activeFeature: null,
  startPointer4326: null,
  startDisplayCenter4326: null,
  draggingFeature: false,
};

map.on('pointerdown', (event) => {
  const feature = map.forEachFeatureAtPixel(event.pixel, (hitFeature) => hitFeature);
  dragState.draggingFeature = Boolean(feature);

  map.getInteractions().forEach((interaction) => {
    if (interaction instanceof DragPan) {
      interaction.setActive(!dragState.draggingFeature);
    }
  });

  if (!feature) return;

  dragState.activeFeature = feature;
  dragState.startPointer4326 = transform(event.coordinate, 'EPSG:3857', 'EPSG:4326');
  dragState.startDisplayCenter4326 = feature.get('displayCenter4326').slice();

  event.preventDefault();
  event.stopPropagation();
});

map.on('pointerdrag', (event) => {
  if (!dragState.activeFeature || !dragState.startPointer4326) return;

  const currentPointer4326 = transform(event.coordinate, 'EPSG:3857', 'EPSG:4326');
  const lonDelta = currentPointer4326[0] - dragState.startPointer4326[0];
  const latDelta = currentPointer4326[1] - dragState.startPointer4326[1];

  const nextCenter = [
    dragState.startDisplayCenter4326[0] + lonDelta,
    clampLatitude(dragState.startDisplayCenter4326[1] + latDelta),
  ];

  dragState.activeFeature.set('displayCenter4326', nextCenter);
  dragState.activeFeature.changed();
  updateInfoPanel(dragState.activeFeature);

  event.preventDefault();
  event.stopPropagation();
});

map.on('pointerup', () => {
  dragState.activeFeature = null;
  dragState.startPointer4326 = null;
  dragState.startDisplayCenter4326 = null;
  dragState.draggingFeature = false;

  map.getInteractions().forEach((interaction) => {
    if (interaction instanceof DragPan) {
      interaction.setActive(true);
    }
  });
});

map.getViewport().addEventListener('mouseleave', () => {
  dragState.activeFeature = null;
  dragState.startPointer4326 = null;
  dragState.startDisplayCenter4326 = null;
  dragState.draggingFeature = false;

  map.getInteractions().forEach((interaction) => {
    if (interaction instanceof DragPan) {
      interaction.setActive(true);
    }
  });
});

async function loadCountryFeature() {
  const response = await fetch('/src/data/country.geojson');
  const geojson = await response.json();

  const format = new GeoJSON();
  const parsedFeature = format.readFeature(geojson.features[0], {
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:4326',
  });

  const sourceGeometry4326 = parsedFeature.getGeometry();
  const originCenter4326 = sourceGeometry4326.getInteriorPoint().getCoordinates();

  // 지도 hit-detection 기본 geometry(초기 렌더 상태)
  const initialGeometry3857 = sourceGeometry4326.clone().transform('EPSG:4326', 'EPSG:3857');

  const feature = new Feature({
    geometry: initialGeometry3857,
    sourceGeometry4326,
    originCenter4326,
    displayCenter4326: originCenter4326.slice(),
    name: parsedFeature.get('name'),
  });

  vectorSource.addFeature(feature);
  updateInfoPanel(feature);
}

loadCountryFeature();
