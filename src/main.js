import 'ol/ol.css';
import './style.css';
import GeoJSON from 'ol/format/GeoJSON';
import OLMap from 'ol/Map';
import View from 'ol/View';
import { OSM, Vector as VectorSource } from 'ol/source';
import { Tile as TileLayer, Vector as VectorLayer } from 'ol/layer';
import DragPan from 'ol/interaction/DragPan';
import Feature from 'ol/Feature';
import { Fill, Stroke, Style } from 'ol/style';
import { fromLonLat, transform } from 'ol/proj';
import { getCenter } from 'ol/extent';

const originLatEl = document.getElementById('origin-lat');
const currentLatEl = document.getElementById('current-lat');
const scaleValueEl = document.getElementById('scale-value');
const countrySearchInputEl = document.getElementById('country-search-input');
const countrySearchButtonEl = document.getElementById('country-search-button');
const countrySearchStatusEl = document.getElementById('country-search-status');

const vectorSource = new VectorSource();
const countryFeatureMap = new Map();

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
  if (!sourceGeometry4326 || !originCenter4326 || !displayCenter4326) {
    console.warn('[TrueSize] Missing geometry metadata for feature:', feature.getId?.(), feature.getProperties?.());
    return { geometry: null, scale: 1 };
  }

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
  if (!originCenter || !displayCenter) return;
  const originalLatRad = (originCenter[1] * Math.PI) / 180;
  const targetLatRad = (displayCenter[1] * Math.PI) / 180;
  const scale = Math.cos(originalLatRad) / Math.max(Math.cos(targetLatRad), 1e-6);

  originLatEl.textContent = `${originCenter[1].toFixed(4)}°`;
  currentLatEl.textContent = `${displayCenter[1].toFixed(4)}°`;
  scaleValueEl.textContent = scale.toFixed(4);
}

function normalizeCountryText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function getCountrySearchKeys(properties = {}) {
  const candidateKeys = ['name', 'NAME', 'ADMIN', 'admin', 'sovereignt', 'SOVEREIGNT', 'ISO3166-1-Alpha-2', 'ISO3166-1-Alpha-3'];
  const values = candidateKeys.map((key) => properties[key]).filter((value) => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(values.map(normalizeCountryText).filter(Boolean))];
}

function buildRenderableCountryFeature(parsedFeature) {
  const sourceGeometry4326 = parsedFeature.getGeometry();
  if (!sourceGeometry4326) return null;

  const geometryType = sourceGeometry4326.getType();
  let originCenter4326 = null;
  if (geometryType === 'Polygon') {
    originCenter4326 = sourceGeometry4326.getInteriorPoint().getCoordinates();
  } else if (geometryType === 'MultiPolygon') {
    originCenter4326 = getCenter(sourceGeometry4326.getExtent());
  } else {
    return null;
  }

  if (!originCenter4326 || !Number.isFinite(originCenter4326[0]) || !Number.isFinite(originCenter4326[1])) {
    return null;
  }

  const initialGeometry3857 = sourceGeometry4326.clone().transform('EPSG:4326', 'EPSG:3857');
  return new Feature({
    geometry: initialGeometry3857,
    sourceGeometry4326,
    originCenter4326,
    displayCenter4326: originCenter4326.slice(),
    name: parsedFeature.get('name') ?? parsedFeature.get('NAME') ?? parsedFeature.get('ADMIN') ?? 'Unknown Country',
  });
}

function showCountryOnMap(parsedFeature) {
  const countryFeature = buildRenderableCountryFeature(parsedFeature);
  if (!countryFeature) return null;

  vectorSource.clear();
  vectorSource.addFeature(countryFeature);

  const renderGeometry3857 = countryFeature.get('geometry');
  if (renderGeometry3857) {
    map.getView().fit(renderGeometry3857.getExtent(), {
      padding: [48, 48, 48, 48],
      maxZoom: 6,
      duration: 250,
    });
  }

  updateInfoPanel(countryFeature);
  return countryFeature;
}

const vectorLayer = new VectorLayer({
  source: vectorSource,
  style: (feature) => {
    try {
      const { geometry } = createRenderGeometry(feature);
      if (!geometry) {
        return null;
      }
      countryStyle.setGeometry(geometry);
    } catch (error) {
      console.error('[TrueSize] Failed to build render geometry:', error, feature.getProperties?.());
      return null;
    }
    return countryStyle;
  },
});

const map = new OLMap({
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

function registerCountrySearch(parsedFeature) {
  const searchKeys = getCountrySearchKeys(parsedFeature.getProperties?.() ?? {});
  for (const key of searchKeys) {
    if (!countryFeatureMap.has(key)) {
      countryFeatureMap.set(key, parsedFeature);
    }
  }
}

function findCountryFeatureByName(query) {
  const normalizedQuery = normalizeCountryText(query);
  if (!normalizedQuery) return null;
  if (countryFeatureMap.has(normalizedQuery)) {
    return countryFeatureMap.get(normalizedQuery);
  }

  for (const [countryKey, countryFeature] of countryFeatureMap.entries()) {
    if (countryKey.includes(normalizedQuery)) {
      return countryFeature;
    }
  }
  return null;
}

async function loadCountryFeature() {
  const response = await fetch('/src/data/countries.geojson');
  const geojson = await response.json();

  const format = new GeoJSON();
  const parsedFeatures = format.readFeatures(geojson, {
    dataProjection: 'EPSG:4326',
    featureProjection: 'EPSG:4326',
  });
  console.info(`[TrueSize] Loaded GeoJSON features: ${parsedFeatures.length}`);

  for (const parsedFeature of parsedFeatures) {
    registerCountrySearch(parsedFeature);
  }

  const koreaFeature = findCountryFeatureByName('south korea') ?? findCountryFeatureByName('korea republic');
  if (!koreaFeature) {
    console.warn('[TrueSize] South Korea feature not found.');
    return;
  }
  showCountryOnMap(koreaFeature);
}

function handleCountrySearch() {
  const query = countrySearchInputEl.value;
  const matchedFeature = findCountryFeatureByName(query);
  if (!matchedFeature) {
    countrySearchStatusEl.textContent = '국가를 찾을 수 없습니다.';
    return;
  }

  showCountryOnMap(matchedFeature);
  const countryName = matchedFeature.get('name') ?? matchedFeature.get('NAME') ?? matchedFeature.get('ADMIN') ?? query;
  countrySearchStatusEl.textContent = `${countryName} 표시 완료`;
}

countrySearchButtonEl.addEventListener('click', handleCountrySearch);
countrySearchInputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    handleCountrySearch();
  }
});

loadCountryFeature();
