import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { Manager, Utils as ParserUtils } from '@atmosx/event-product-parser';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const widgetsDir = path.join(publicDir, 'widgets');
const staticDir = path.join(publicDir, 'assets', 'static');
const distDir = path.join(rootDir, 'dist');
const configPath = path.join(rootDir, 'config', 'localoverlays.local.json');
const defaultConfigPath = path.join(rootDir, 'config', 'localoverlays.json');
const parserStorageDir = path.join(rootDir, 'storage', 'parser');
const parserDatabasePath = path.join(parserStorageDir, 'shapefiles.db');
const warnedCamerasPath = path.join(staticDir, 'warnedcams-traffic-cameras.json');
const atmosxCameraApiUrl = 'https://scriptkitty.cafe/relay/atmosx/cameras';

const defaultConfig = {
  server: {
    host: '127.0.0.1',
    port: 4318,
  },
  nwws: {
    enabled: true,
    username: '',
    password: '',
    nickname: 'TuftsWeather Overlays',
    reconnectIntervalSeconds: 60,
    backfillIntervalSeconds: 60,
  },
  nwsApi: {
    enabled: true,
    endpoint: 'https://api.weather.gov/alerts/active',
    pollIntervalSeconds: 30,
  },
  filters: {
    events: [],
    ignoredEvents: ['Xx', 'Test Message'],
    ignoredIcao: [],
    filteredIcao: [],
    ugcFilter: [],
    stateFilter: [],
    ignoreTestProducts: true,
    checkExpired: true,
  },
  customCameras: {
    enabled: false,
    items: [],
  },
};

function mergeConfig(base, incoming) {
  if (!incoming || typeof incoming !== 'object') {
    return base;
  }

  const merged = { ...base };

  for (const [key, value] of Object.entries(incoming)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged[key] = mergeConfig(base[key] ?? {}, value);
    } else {
      merged[key] = value;
    }
  }

  return merged;
}

function ensureConfigFile() {
  if (!fs.existsSync(configPath) && fs.existsSync(defaultConfigPath)) {
    fs.copyFileSync(defaultConfigPath, configPath);
  }
}

function loadConfig() {
  ensureConfigFile();

  if (!fs.existsSync(configPath)) {
    return defaultConfig;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Config file is invalid: ${configPath}\n${message}`);
  }
  return mergeConfig(defaultConfig, parsed);
}

function makeFeatureCollection(features = []) {
  return {
    type: 'FeatureCollection',
    features,
  };
}

const runtimeConfig = loadConfig();

function readConfigFile() {
  ensureConfigFile();
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  return JSON.parse(raw);
}

function writeConfigFile(config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

function toFiniteConfigNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sanitizeCustomCameraConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const items = Array.isArray(source.items) ? source.items : [];

  return {
    enabled: Boolean(source.enabled),
    items: items
      .slice(0, 100)
      .map((item) => {
        const value = item && typeof item === 'object' ? item : {};
        const latitude = toFiniteConfigNumber(value.latitude ?? value.lat);
        const longitude = toFiniteConfigNumber(value.longitude ?? value.lon ?? value.lng);
        return {
          enabled: value.enabled !== false,
          name: String(value.name || '').trim(),
          location: String(value.location || '').trim(),
          latitude,
          longitude,
          url: String(value.url || value.embedUrl || value.streamUrl || '').trim(),
          source: String(value.source || 'custom-chaser').trim(),
          widgets: {
            severe: value.widgets?.severe !== false,
            winter: Boolean(value.widgets?.winter),
            tropical: Boolean(value.widgets?.tropical),
          },
        };
      })
      .filter((item) => item.name || item.url || Number.isFinite(item.latitude) || Number.isFinite(item.longitude)),
  };
}

function sanitizeServiceConfig(input) {
  const source = input && typeof input === 'object' ? input : {};
  const nwws = source.nwws && typeof source.nwws === 'object' ? source.nwws : {};
  const nwsApi = source.nwsApi && typeof source.nwsApi === 'object' ? source.nwsApi : {};

  return {
    nwws: {
      enabled: Boolean(nwws.enabled),
      username: String(nwws.username || '').trim(),
      password: String(nwws.password || ''),
      nickname: String(nwws.nickname || 'TuftsWeather Overlays').trim() || 'TuftsWeather Overlays',
      reconnectIntervalSeconds: Math.max(15, Number(nwws.reconnectIntervalSeconds || 60)),
      backfillIntervalSeconds: Math.max(15, Number(nwws.backfillIntervalSeconds || 60)),
    },
    nwsApi: {
      enabled: nwsApi.enabled !== false,
      endpoint: String(nwsApi.endpoint || 'https://api.weather.gov/alerts/active').trim() || 'https://api.weather.gov/alerts/active',
      pollIntervalSeconds: Math.max(15, Number(nwsApi.pollIntervalSeconds || 30)),
    },
  };
}

fs.mkdirSync(parserStorageDir, { recursive: true });

const state = {
  startedAt: new Date().toISOString(),
  mode: 'booting',
  connected: false,
  nickname: runtimeConfig.nwws.nickname,
  lastError: '',
  lastMessage: 'Starting TuftsWeather Overlays service',
  lastEventAt: '',
  events: makeFeatureCollection(),
  manual: makeFeatureCollection(),
  summary: {
    activeCount: 0,
    tornadoWarningCount: 0,
    severeWarningCount: 0,
    highestKey: '',
    highestLabel: 'No severe alerts active currently',
    highestRank: 0,
    highestColor: '#006fd6',
    highestFill: '#006fd6',
    warningStripItems: [],
    tropicalCounts: {
      tornadoWarning: 0,
      hurricaneWarning: 0,
      hurricaneWatch: 0,
      tropicalStormWarning: 0,
      tropicalStormWatch: 0,
    },
    tropicalStripItems: [],
    winterCounts: {
      blizzardWarning: 0,
      blizzardWatch: 0,
      winterStormWarning: 0,
      winterStormWatch: 0,
    },
    winterHighestKey: '',
    winterHighestLabel: 'No winter alerts active currently',
    winterHighestRank: 0,
    winterHighestColor: '#006fd6',
    winterHighestFill: '#006fd6',
    winterStripItems: [],
  },
  tropicalTestSystem: null,
};

let cameraLiteCache = null;
let cameraLiteCacheMtime = 0;
let cameraApiCache = null;
let cameraApiCacheExpiresAt = 0;
let cameraApiCachePromise = null;

function normalizeCameraSource(value) {
  return String(value || '').trim();
}

function deriveCameraState(properties = {}) {
  const direct = String(properties.state || properties._state || '').trim().toUpperCase();
  if (/^[A-Z]{2,}$/.test(direct)) {
    return direct;
  }

  const rawId = String(properties.cameraId || properties.camera_id || properties.id || '').trim();
  const prefixMatch = rawId.match(/^([A-Z]{2,}):/i);
  if (prefixMatch) {
    return prefixMatch[1].toUpperCase();
  }

  const source = normalizeCameraSource(properties.source).toUpperCase();
  if (source === 'CHASERS' || source === 'LIVE-CHASERS') return 'CHASERS';
  if (source === 'HAZCAMS') return 'HAZCAMS';
  if (source === 'CYCLONEPORT') return 'CYCLONEPORT';
  return '';
}

function pickFirstString(values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (value !== null && value !== undefined && typeof value !== 'object') {
      return String(value).trim();
    }
  }
  return '';
}

function pickFirstUrl(values) {
  for (const value of values) {
    if (!value) {
      continue;
    }

    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }

    if (typeof value !== 'object') {
      const normalized = String(value).trim();
      if (normalized) {
        return normalized;
      }
      continue;
    }

    const nested = [
      value.url, value.hls, value.hlsUrl, value.m3u8, value.m3u8Url, value.m3u8_url,
      value.videoUrl, value.video_url, value.stream_url, value.streamUrl, value.playbackUrl, value.src,
    ];
    const found = nested.find((candidate) => typeof candidate === 'string' && candidate.trim());
    if (found) {
      return found.trim();
    }
  }
  return '';
}

function isLikelyVideoUrl(url) {
  const value = String(url || '').toLowerCase();
  return value.includes('.m3u8') ||
    value.includes('/playlist') ||
    value.includes('/manifest') ||
    value.includes('youtube.com/') ||
    value.includes('youtu.be/') ||
    value.includes('twitch.tv/');
}

function normalizeCustomCameraUrl(url) {
  const rawValue = String(url || '').trim();
  const srcMatch = rawValue.match(/\bsrc=(["'])(.*?)\1/i);
  const value = (srcMatch?.[2]?.trim() || rawValue).replace(/&amp;/g, '&');
  if (!value) {
    return '';
  }

  const youtubeWatch = value.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]{6,})/i);
  if (youtubeWatch) {
    return `https://www.youtube.com/embed/${youtubeWatch[1]}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&disablekb=1`;
  }

  if (value.includes('youtube.com/live/')) {
    const id = value.match(/youtube\.com\/live\/([A-Za-z0-9_-]{6,})/i)?.[1];
    if (id) {
      return `https://www.youtube.com/embed/${id}?autoplay=1&mute=1&controls=0&modestbranding=1&rel=0&iv_load_policy=3&playsinline=1&disablekb=1`;
    }
  }

  return value;
}

function getCustomCameraFeatures(widget = 'severe') {
  const custom = runtimeConfig.customCameras || {};
  if (!custom.enabled || !Array.isArray(custom.items)) {
    return [];
  }

  const features = [];
  for (const [index, item] of custom.items.entries()) {
    if (!item || item.enabled === false) {
      continue;
    }

    const widgets = item.widgets || {};
    if (widgets[widget] === false) {
      continue;
    }

    const lat = toFiniteConfigNumber(item.latitude ?? item.lat);
    const lon = toFiniteConfigNumber(item.longitude ?? item.lon ?? item.lng);
    const hasLocation = lat !== null && lon !== null;
    const streamUrl = normalizeCustomCameraUrl(item.embedUrl || item.streamUrl || item.url);
    if (!streamUrl) {
      continue;
    }

    features.push({
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: hasLocation ? [lon, lat] : [0, 0],
      },
      properties: {
        cameraId: `custom-${index}-${streamUrl}`,
        name: String(item.name || `Custom Camera ${index + 1}`).trim(),
        location: String(item.location || item.name || 'CUSTOM CAMERA').trim(),
        source: String(item.source || 'custom-chaser').trim(),
        state: String(item.state || 'CUSTOM').trim(),
        stream_url: streamUrl,
        embed_url: streamUrl,
        is_custom: true,
        has_location: hasLocation,
        widgets: {
          severe: widgets.severe !== false,
          winter: widgets.winter !== false,
          tropical: widgets.tropical !== false,
        },
      },
    });
  }
  return features;
}

function isBlockedCameraFeature(feature) {
  const properties = feature?.properties || {};
  const source = normalizeCameraSource(pickFirstString([properties.source, properties.provider, properties.sourceType, '']));
  const model = normalizeCameraSource(properties.model).toUpperCase();
  const name = pickFirstString([properties.name, properties.cameraName, properties.camera_title, properties.title]);
  const derivedState = deriveCameraState(properties);
  const combined = `${source} ${model} ${name} ${derivedState}`.toLowerCase();

  return model === 'USER' ||
    derivedState === 'CHASERS' ||
    combined.includes('chaser') ||
    combined.includes('live-chaser') ||
    combined.includes('stormrunner media') ||
    combined.includes('weather_wise');
}

function normalizeCameraFeature(feature) {
  const coordinates = feature?.geometry?.coordinates;
  const [lon, lat] = Array.isArray(coordinates) ? coordinates : [];
  if (!Number.isFinite(Number(lon)) || !Number.isFinite(Number(lat))) {
    return null;
  }

  const properties = feature?.properties ?? {};
  if (isBlockedCameraFeature(feature)) {
    return null;
  }

  const streamUrl = pickFirstUrl([
    properties.hls_url, properties.streamingURL, properties.streamingVideoURL, properties.m3u8Url,
    properties.m3u8_url, properties.m3u8, properties.url2, properties.URL2, properties.hls_stream_protected,
    properties.streamSrc, properties.httpsVideoUrl, properties.httpVideoUrl, properties.https_url,
    properties.ios_url, properties.stream_url, properties.video_url, properties.videoUrl, properties.url,
  ]);

  if (!isLikelyVideoUrl(streamUrl)) {
    return null;
  }

  const derivedState = deriveCameraState(properties);
  const name = pickFirstString([
    properties.cameraName,
    properties.camera_title,
    properties.name,
    properties.title,
    properties.description,
  ]) || 'Traffic Camera';
  const source = pickFirstString([properties.source, properties.provider, properties.sourceType, 'traffic-cameras']);

  return {
    type: 'Feature',
    geometry: {
      type: 'Point',
      coordinates: [Number(lon), Number(lat)],
    },
    properties: {
      cameraId: pickFirstString([
        properties._mapKey,
        properties.cameraId,
        properties.camera_id,
        properties.id,
        feature.id,
        `${source}:${name}:${Number(lat).toFixed(5)},${Number(lon).toFixed(5)}`,
      ]),
      name,
      location: pickFirstString([
        properties.location,
        properties.city,
        properties.county,
        properties.state,
        properties.directionLabel,
        source,
        'TRAFFIC CAMERA',
      ]),
      source,
      state: derivedState,
      model: pickFirstString([properties.model, 'DEVICE']),
      stream_url: streamUrl,
    },
  };
}

function normalizeCameraFeatureCollection(parsed) {
  const sourceFeatures = Array.isArray(parsed?.features) ? parsed.features : [];
  const features = [];
  const seen = new Set();

  for (const feature of sourceFeatures) {
    const normalized = normalizeCameraFeature(feature);
    if (!normalized) {
      continue;
    }

    const key = String(normalized.properties.cameraId || normalized.properties.stream_url || '').trim();
    if (key && seen.has(key)) {
      continue;
    }
    if (key) {
      seen.add(key);
    }
    features.push(normalized);
  }

  return makeFeatureCollection(features);
}

function getBundledCameraPayload() {
  if (!fs.existsSync(warnedCamerasPath)) {
    return makeFeatureCollection([]);
  }

  const stats = fs.statSync(warnedCamerasPath);
  const mtimeMs = stats.mtimeMs || 0;
  if (cameraLiteCache && cameraLiteCacheMtime === mtimeMs) {
    return cameraLiteCache;
  }

  const raw = fs.readFileSync(warnedCamerasPath, 'utf8');
  const parsed = JSON.parse(raw);
  cameraLiteCache = normalizeCameraFeatureCollection(parsed);
  cameraLiteCacheMtime = mtimeMs;
  return cameraLiteCache;
}

async function fetchCameraApiPayload({ force = false } = {}) {
  const now = Date.now();
  if (!force && cameraApiCache && cameraApiCacheExpiresAt > now) {
    return cameraApiCache;
  }

  if (!force && cameraApiCachePromise) {
    return cameraApiCachePromise;
  }

  cameraApiCachePromise = fetch(atmosxCameraApiUrl, {
    headers: {
      'User-Agent': 'TuftsWeatherOverlays/1.0',
      Accept: 'application/geo+json, application/json, */*',
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Camera API HTTP ${response.status}`);
      }
      const parsed = await response.json();
      const normalized = normalizeCameraFeatureCollection(parsed);
      cameraApiCache = {
        ...normalized,
        source: atmosxCameraApiUrl,
        updatedAt: new Date().toISOString(),
      };
      cameraApiCacheExpiresAt = Date.now() + 5 * 60 * 1000;
      return cameraApiCache;
    })
    .catch((error) => {
      console.warn('[TuftsWeather Overlays] Camera API failed; using bundled fallback:', error instanceof Error ? error.message : error);
      return getBundledCameraPayload();
    })
    .finally(() => {
      cameraApiCachePromise = null;
    });

  return cameraApiCachePromise;
}

async function getCameraLitePayload(widget = 'severe', { includeCustom = true, force = false } = {}) {
  const basePayload = await fetchCameraApiPayload({ force });
  return makeFeatureCollection([
    ...(basePayload.features || []),
    ...(includeCustom ? getCustomCameraFeatures(widget) : []),
  ]);
}

function getFeaturePolygonSet(feature) {
  const geometry = feature?.geometry;
  if (!geometry) {
    return [];
  }

  if (geometry.type === 'Polygon') {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  }

  if (geometry.type === 'MultiPolygon') {
    return Array.isArray(geometry.coordinates) ? geometry.coordinates.flat() : [];
  }

  return [];
}

function getPolygonBounds(polygonSet) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const ring of polygonSet) {
    if (!Array.isArray(ring)) continue;
    for (const point of ring) {
      const lon = Number(point?.[0]);
      const lat = Number(point?.[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  }

  if (!Number.isFinite(minLon) || !Number.isFinite(minLat)) {
    return null;
  }

  return { minLon, minLat, maxLon, maxLat };
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = Number(ring[i]?.[0]);
    const yi = Number(ring[i]?.[1]);
    const xj = Number(ring[j]?.[0]);
    const yj = Number(ring[j]?.[1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const intersects = ((yi > lat) !== (yj > lat)) && lon < ((xj - xi) * (lat - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonSet(lon, lat, polygonSet) {
  if (!Array.isArray(polygonSet)) return false;
  for (const ring of polygonSet) {
    if (Array.isArray(ring) && pointInRing(lon, lat, ring)) {
      return true;
    }
  }
  return false;
}

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (value) => (value * Math.PI) / 180;
  const radiusMiles = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return radiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getCameraAlertClassification(alert, widget = 'severe') {
  if (widget === 'winter') {
    return classifyWinterAlert(alert);
  }
  if (widget === 'tropical') {
    return classifyTropicalAlert(alert);
  }
  return classifyAlert(alert);
}

async function getWarnedCameraMatches({ fallbackRadiusMiles = 250, streamSource = '*', search = '', max = 80, widget = 'severe' } = {}) {
  const sourceFilter = String(streamSource || '*').toLowerCase();
  const searchFilter = String(search || '').trim().toLowerCase();
  const activeAlerts = getRelevantActiveAlerts()
    .map((event) => {
      const polygonSet = getFeaturePolygonSet(event);
      const bounds = getPolygonBounds(polygonSet);
      const center = bounds
        ? {
            lon: (bounds.minLon + bounds.maxLon) / 2,
            lat: (bounds.minLat + bounds.maxLat) / 2,
          }
        : null;
      return { event, polygonSet, bounds, center, classification: getCameraAlertClassification(event, widget) };
    })
    .filter((entry) => entry.classification)
    .sort((a, b) => {
      if (b.classification.rank !== a.classification.rank) {
        return b.classification.rank - a.classification.rank;
      }
      return Date.parse(b.event?.properties?.issued || '') - Date.parse(a.event?.properties?.issued || '');
    });

  if (!activeAlerts.length) {
    return [];
  }

  const cameras = (await getCameraLitePayload(widget, { includeCustom: false })).features || [];
  const matches = [];
  const seen = new Set();

  for (const stream of cameras) {
    const properties = stream?.properties || {};
    if (sourceFilter !== '*' && String(properties.source || '').toLowerCase() !== sourceFilter) {
      continue;
    }
    if (searchFilter) {
      const haystack = `${properties.name || ''} ${properties.location || ''} ${properties.source || ''}`.toLowerCase();
      if (!haystack.includes(searchFilter)) {
        continue;
      }
    }

    const [lonRaw, latRaw] = stream?.geometry?.coordinates || [];
    const lon = Number(lonRaw);
    const lat = Number(latRaw);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      continue;
    }

    for (const warning of activeAlerts) {
      let isMatch = false;
      if (warning.bounds) {
        const margin = 0.08;
        const outsideBounds =
          lon < warning.bounds.minLon - margin ||
          lon > warning.bounds.maxLon + margin ||
          lat < warning.bounds.minLat - margin ||
          lat > warning.bounds.maxLat + margin;
        isMatch = !outsideBounds && pointInPolygonSet(lon, lat, warning.polygonSet);
      } else {
        isMatch = pointInPolygonSet(lon, lat, warning.polygonSet);
      }

      if (!isMatch && warning.center) {
        isMatch = haversineMiles(lat, lon, warning.center.lat, warning.center.lon) <= fallbackRadiusMiles;
      }

      const distanceMiles = warning.center
        ? haversineMiles(lat, lon, warning.center.lat, warning.center.lon)
        : null;

      if (isMatch) {
        const key = `${properties.cameraId || properties.stream_url}|${getTrackingId(warning.event)}`;
        if (!seen.has(key)) {
          seen.add(key);
          matches.push({
            stream,
            event: warning.event,
            distanceMiles,
            matchType: pointInPolygonSet(lon, lat, warning.polygonSet) ? 'inside' : 'nearby',
          });
        }
        break;
      }
    }
  }

  matches.sort((a, b) => {
    const aRank = getCameraAlertClassification(a.event, widget)?.rank || 0;
    const bRank = getCameraAlertClassification(b.event, widget)?.rank || 0;
    if (bRank !== aRank) return bRank - aRank;
    if ((a.matchType === 'inside') !== (b.matchType === 'inside')) {
      return a.matchType === 'inside' ? -1 : 1;
    }
    const aDistance = Number.isFinite(a.distanceMiles) ? a.distanceMiles : Infinity;
    const bDistance = Number.isFinite(b.distanceMiles) ? b.distanceMiles : Infinity;
    if (aDistance !== bDistance) return aDistance - bDistance;
    return String(a.stream?.properties?.location || '').localeCompare(String(b.stream?.properties?.location || ''));
  });

  return matches.slice(0, max);
}

const spcOutlookSources = [
  { day: 1, type: 'categorical', url: 'https://www.spc.noaa.gov/products/outlook/day1otlk_cat.nolyr.geojson' },
  { day: 2, type: 'categorical', url: 'https://www.spc.noaa.gov/products/outlook/day2otlk_cat.nolyr.geojson' },
  { day: 3, type: 'categorical', url: 'https://www.spc.noaa.gov/products/outlook/day3otlk_cat.nolyr.geojson' },
  { day: 4, type: 'probability', url: 'https://www.spc.noaa.gov/products/exper/day4-8/day4prob.nolyr.geojson' },
  { day: 5, type: 'probability', url: 'https://www.spc.noaa.gov/products/exper/day4-8/day5prob.nolyr.geojson' },
  { day: 6, type: 'probability', url: 'https://www.spc.noaa.gov/products/exper/day4-8/day6prob.nolyr.geojson' },
  { day: 7, type: 'probability', url: 'https://www.spc.noaa.gov/products/exper/day4-8/day7prob.nolyr.geojson' },
  { day: 8, type: 'probability', url: 'https://www.spc.noaa.gov/products/exper/day4-8/day8prob.nolyr.geojson' },
];

const spcOfficialImageSources = [
  { day: 1, type: 'categorical', pageUrl: 'https://www.spc.noaa.gov/products/outlook/day1otlk.html', prefix: 'day1' },
  { day: 2, type: 'categorical', pageUrl: 'https://www.spc.noaa.gov/products/outlook/day2otlk.html', prefix: 'day2' },
  { day: 3, type: 'categorical', pageUrl: 'https://www.spc.noaa.gov/products/outlook/day3otlk.html', prefix: 'day3' },
  { day: 4, type: 'probability', imageUrl: 'https://www.spc.noaa.gov/products/exper/day4-8/day4prob.gif' },
  { day: 5, type: 'probability', imageUrl: 'https://www.spc.noaa.gov/products/exper/day4-8/day5prob.gif' },
  { day: 6, type: 'probability', imageUrl: 'https://www.spc.noaa.gov/products/exper/day4-8/day6prob.gif' },
  { day: 7, type: 'probability', imageUrl: 'https://www.spc.noaa.gov/products/exper/day4-8/day7prob.gif' },
  { day: 8, type: 'probability', imageUrl: 'https://www.spc.noaa.gov/products/exper/day4-8/day8prob.gif' },
];

function normalizeSpcFeature(feature) {
  const properties = feature?.properties || {};
  return {
    label: String(properties.LABEL || '').trim(),
    detail: String(properties.LABEL2 || '').trim(),
    dn: Number(properties.DN || 0),
    stroke: String(properties.stroke || '#ffffff'),
    fill: String(properties.fill || '#444444'),
    geometry: feature?.geometry || null,
    valid: properties.VALID_ISO || '',
    expires: properties.EXPIRE_ISO || '',
    issued: properties.ISSUE_ISO || '',
    forecaster: properties.FORECASTER || '',
  };
}

async function fetchSpcOutlooks({ force = false } = {}) {
  const now = Date.now();
  if (!force && spcOutlookCache && spcOutlookCacheExpiresAt > now) {
    return spcOutlookCache;
  }

  const days = await Promise.all(spcOutlookSources.map(async (source) => {
    try {
      const response = await fetch(source.url, {
        headers: {
          'User-Agent': 'LocalOverlays/1.0',
          Accept: 'application/geo+json, application/json, */*',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json();
      const outlooks = (Array.isArray(data?.features) ? data.features : [])
        .map(normalizeSpcFeature)
        .filter((feature) => feature.label || feature.detail)
        .sort((a, b) => b.dn - a.dn);

      return {
        day: source.day,
        type: source.type,
        source: source.url,
        outlooks,
        valid: outlooks[0]?.valid || '',
        expires: outlooks[0]?.expires || '',
        issued: outlooks[0]?.issued || '',
        forecaster: outlooks[0]?.forecaster || '',
        error: '',
      };
    } catch (error) {
      return {
        day: source.day,
        type: source.type,
        source: source.url,
        outlooks: [],
        valid: '',
        expires: '',
        issued: '',
        forecaster: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  spcOutlookCache = {
    updatedAt: new Date().toISOString(),
    days,
  };
  spcOutlookCacheExpiresAt = now + 10 * 60 * 1000;
  return spcOutlookCache;
}

async function fetchSpcOfficialImages({ force = false } = {}) {
  const now = Date.now();
  if (!force && spcImageCache && spcImageCacheExpiresAt > now) {
    return spcImageCache;
  }

  const images = await Promise.all(spcOfficialImageSources.map(async (source) => {
    if (source.imageUrl) {
      return {
        day: source.day,
        type: source.type,
        title: `SPC Day ${source.day} Outlook`,
        imageUrl: source.imageUrl,
        pageUrl: source.imageUrl,
        error: '',
      };
    }

    try {
      const response = await fetch(source.pageUrl, {
        headers: {
          'User-Agent': 'TuftsWeatherOverlays/1.0',
          Accept: 'text/html, */*',
        },
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const html = await response.text();
      const tab = html.match(/show_tab\('([^']+)'\)/)?.[1] || '';
      if (!tab) {
        throw new Error('SPC image tab not found');
      }

      return {
        day: source.day,
        type: source.type,
        title: `SPC Day ${source.day} Outlook`,
        imageUrl: `https://www.spc.noaa.gov/products/outlook/${source.prefix}${tab}.png`,
        pageUrl: source.pageUrl,
        error: '',
      };
    } catch (error) {
      return {
        day: source.day,
        type: source.type,
        title: `SPC Day ${source.day} Outlook`,
        imageUrl: '',
        pageUrl: source.pageUrl,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));

  spcImageCache = {
    updatedAt: new Date().toISOString(),
    images,
  };
  spcImageCacheExpiresAt = now + 10 * 60 * 1000;
  return spcImageCache;
}

async function fetchNhcCurrentStorms({ force = false } = {}) {
  const now = Date.now();
  if (!force && tropicalStormCache && tropicalStormCacheExpiresAt > now) {
    return tropicalStormCache;
  }

  const response = await fetch(currentStormsUrl, {
    headers: {
      'User-Agent': 'LocalOverlays/1.0',
      Accept: 'application/json, */*',
    },
  });

  if (!response.ok) {
    throw new Error(`NHC CurrentStorms HTTP ${response.status}`);
  }

  const payload = await response.json();
  tropicalStormCache = {
    updatedAt: new Date().toISOString(),
    activeStorms: Array.isArray(payload.activeStorms) ? payload.activeStorms : [],
    source: currentStormsUrl,
    testActive: false,
  };
  tropicalStormCacheExpiresAt = now + 60 * 1000;
  return tropicalStormCache;
}

function buildTestTropicalSystem(type) {
  const preset = tropicalSystemPresets[type];
  if (!preset) {
    return null;
  }

  const now = new Date();
  return {
    id: `al99${now.getUTCFullYear()}`,
    binNumber: 'AT99',
    name: preset.name,
    displayLabel: preset.displayLabel,
    classification: preset.classification,
    intensity: String(preset.intensity),
    pressure: String(preset.pressure),
    latitude: '25.0N',
    longitude: '76.0W',
    movementDir: String(preset.movementDir),
    movementSpeed: String(preset.movementSpeed),
    lastUpdate: now.toISOString(),
    publicAdvisory: {
      advNum: 'TEST',
      issuance: now.toISOString(),
    },
    isLocalTest: true,
  };
}

async function getTropicalSystemsPayload({ force = false } = {}) {
  if (state.tropicalTestSystem) {
    return {
      updatedAt: new Date().toISOString(),
      activeStorms: [state.tropicalTestSystem],
      source: 'local-test',
      testActive: true,
    };
  }

  return fetchNhcCurrentStorms({ force });
}

const app = express();
const server = createServer(app);
const localhostRedirectServer = createServer((request, response) => {
  const host = String(runtimeConfig.server.host || '127.0.0.1');
  const port = Number(runtimeConfig.server.port || 4318);
  const target = `http://${host}:${port}/`;

  response.statusCode = 302;
  response.setHeader('Location', target);
  response.setHeader('Cache-Control', 'no-store');
  response.end(`Redirecting to ${target}`);
});
const wss = new WebSocketServer({ server, path: '/stream' });

const parserSettings = createParserSettings(runtimeConfig);
let backfillTimer = null;
let parser = null;
let parserAuthFailed = false;
let spcOutlookCache = null;
let spcOutlookCacheExpiresAt = 0;
let spcImageCache = null;
let spcImageCacheExpiresAt = 0;
let tropicalStormCache = null;
let tropicalStormCacheExpiresAt = 0;

const currentStormsUrl = 'https://www.nhc.noaa.gov/CurrentStorms.json';

const tropicalSystemPresets = {
  'tropical-depression': {
    name: '',
    displayLabel: 'Tropical Depression',
    classification: 'TD',
    intensity: 30,
    pressure: 1007,
    movementDir: 300,
    movementSpeed: 12,
  },
  'tropical-storm': {
    name: '',
    displayLabel: 'Tropical Storm',
    classification: 'TS',
    intensity: 55,
    pressure: 995,
    movementDir: 315,
    movementSpeed: 14,
  },
  'cat-1': {
    name: '',
    displayLabel: 'Cat 1 Hurricane',
    classification: 'HU',
    intensity: 70,
    pressure: 982,
    movementDir: 320,
    movementSpeed: 13,
  },
  'cat-3': {
    name: '',
    displayLabel: 'Cat 3 Hurricane',
    classification: 'HU',
    intensity: 105,
    pressure: 955,
    movementDir: 330,
    movementSpeed: 11,
  },
  'cat-5': {
    name: '',
    displayLabel: 'Cat 5 Hurricane',
    classification: 'HU',
    intensity: 145,
    pressure: 915,
    movementDir: 335,
    movementSpeed: 10,
  },
};

app.use(express.json({ limit: '64kb' }));

function createParserSettings(config) {
  const username = String(config.nwws.username ?? '').trim();
  const password = String(config.nwws.password ?? '').trim();
  const nickname = String(config.nwws.nickname ?? 'TuftsWeather Overlays').trim() || 'TuftsWeather Overlays';
  const hasCreds = Boolean(username && password);
  const useWire = Boolean(config.nwws.enabled && hasCreds);

  return {
    database: parserDatabasePath,
    is_wire: useWire,
    journal: false,
    noaa_weather_wire_service_settings: {
      reconnection_settings: {
        enabled: true,
        interval: config.nwws.reconnectIntervalSeconds,
      },
      credentials: {
        username,
        password,
        nickname,
      },
      cache: {
        enabled: false,
        max_db_history: 0,
        max_db_cache_size: 0,
      },
      preferences: {
        cap_only: false,
      },
    },
    national_weather_service_settings: {
      enabled: config.nwsApi.enabled !== false,
      interval: config.nwsApi.enabled === false ? 86400 : config.nwsApi.pollIntervalSeconds,
      endpoint: config.nwsApi.endpoint,
    },
    global_settings: {
      parent_events_only: true,
      better_event_parsing: true,
      ignore_geometry_parsing: false,
      shapefile_coordinates: false,
      shapefile_skip: 15,
      filtering: {
        events: config.filters.events,
        filtered_icao: config.filters.filteredIcao,
        ignored_icao: config.filters.ignoredIcao,
        ignored_events: config.filters.ignoredEvents,
        ugc_filter: config.filters.ugcFilter,
        state_filter: config.filters.stateFilter,
        check_expired: config.filters.checkExpired,
        ignore_test_products: config.filters.ignoreTestProducts,
      },
      eas_settings: {
        directory: null,
        intro_wav: null,
      },
    },
  };
}

function getTrackingId(alert) {
  return alert?.properties?.details?.tracking ?? alert?.properties?.id ?? '';
}

function normalizeText(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isAlertActive(alert) {
  const properties = alert?.properties ?? {};
  const action = normalizeText(properties.action_type || properties.messageType);
  if (action === 'EXPIRED' || action === 'CANCELLED' || action === 'CANCELED') {
    return false;
  }

  const expiresAt = Date.parse(
    String(properties.expires || properties.ends || properties.end || ''),
  );

  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    return false;
  }

  return true;
}

function isAtlanticTropicalProduct(alert) {
  const properties = alert?.properties ?? alert?.raw?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const parameters = properties?.parameters ?? {};
  const geocode = properties?.geocode ?? {};
  const ugcCodes = Array.isArray(geocode.UGC) ? geocode.UGC : [];
  const text = normalizeText([
    properties.sender_icao,
    properties.sender_name,
    properties.locations,
    properties.areaDesc,
    properties.description,
    details.tracking,
    details.header,
    parameters.wmo,
    ...ugcCodes,
  ].filter(Boolean).join(' '));

  return !(
    text.includes('PGUM') ||
    text.includes('PHFO') ||
    text.includes('PPG') ||
    text.includes('GUAM') ||
    text.includes('NORTHERN MARIANAS') ||
    text.includes('MARIANA ISLANDS') ||
    text.includes('TINIAN') ||
    text.includes('SAIPAN') ||
    text.includes('ROTA') ||
    text.includes('HAWAII') ||
    text.includes('AMERICAN SAMOA') ||
    /\bMP[ZC]\d{3}\b/.test(text) ||
    /\bGU[ZC]\d{3}\b/.test(text) ||
    /\bAS[ZC]\d{3}\b/.test(text) ||
    /\bHI[ZC]\d{3}\b/.test(text)
  );
}

function classifyAlert(alert) {
  const properties = alert?.properties ?? alert?.raw?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const event = normalizeText(properties.event || details.native);
  const name = normalizeText(details.name || properties.properEventName || properties.event);
  const headline = normalizeText(properties.headline);
  const description = normalizeText(details.description || properties.description);
  const instruction = normalizeText(properties.instruction);
  const combinedText = `${name} ${event} ${headline} ${description} ${instruction}`;
  const paramsText = normalizeText(
    Object.entries(properties.parameters || {})
      .map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(' ') : value}`)
      .join(' '),
  );

  if (combinedText.includes('TORNADO EMERGENCY') || paramsText.includes('CATASTROPHIC')) {
    return { key: 'tornado-emergency', label: 'TORNADO EMERGENCY', rank: 100, color: '#ff1493', fill: '#ff1493' };
  }

  if (
    name.includes('PDS TORNADO WARNING') ||
    (combinedText.includes('PARTICULARLY DANGEROUS SITUATION') && event === 'TORNADO WARNING')
  ) {
    return { key: 'pds-tornado', label: 'PDS - TORNADO WARNING', rank: 90, color: '#7c3aed', fill: '#7c3aed' };
  }

  const isObservedTornadoWarning =
    event === 'TORNADO WARNING' &&
    (
      combinedText.includes('CONFIRMED TORNADO') ||
      combinedText.includes('TORNADO OBSERVED') ||
      combinedText.includes('OBSERVED TORNADO') ||
      paramsText.includes('TORNADODETECTION OBSERVED') ||
      paramsText.includes('TORNADO_DETECTION OBSERVED') ||
      paramsText.includes('TORNADO DETECTION OBSERVED')
    );

  if (isObservedTornadoWarning) {
    return { key: 'tornado-observed', label: 'CONFIRMED TORNADO WARNING', rank: 80, color: '#a40000', fill: '#a40000' };
  }

  if (name.includes('RADAR INDICATED TORNADO WARNING') || event === 'TORNADO WARNING') {
    return { key: 'radar-indicated-tornado-warning', label: 'TORNADO WARNING', rank: 70, color: '#d10000', fill: '#d10000' };
  }

  if (name.includes('TORNADO WATCH') || event === 'TORNADO WATCH') {
    return { key: 'tornado-watch', label: 'Tornado Watch', rank: 60, color: '#ff0000', fill: '#ff0000' };
  }

  if (name.includes('SEVERE THUNDERSTORM WATCH') || event === 'SEVERE THUNDERSTORM WATCH') {
    return { key: 'severe-thunderstorm-watch', label: 'Severe Thunderstorm Watch', rank: 20, color: '#e47b8f', fill: '#e47b8f' };
  }

  if (
    name.includes('EDS SEVERE THUNDERSTORM WARNING') ||
    combinedText.includes('EDS SEVERE THUNDERSTORM WARNING') ||
    combinedText.includes('EMERGENCY DAMAGE THREAT') ||
    paramsText.includes('DAMAGE_THREAT EMERGENCY') ||
    paramsText.includes('THUNDERSTORMDAMAGETHREAT EMERGENCY')
  ) {
    return { key: 'eds-severe-thunderstorm', label: 'EDS - SEVERE THUNDERSTORM WARNING', rank: 50, color: '#8a5400', fill: '#8a5400' };
  }

  if (
    name.includes('DESTRUCTIVE SEVERE THUNDERSTORM WARNING') ||
    combinedText.includes('DESTRUCTIVE SEVERE THUNDERSTORM WARNING') ||
    paramsText.includes('DAMAGE_THREAT DESTRUCTIVE') ||
    paramsText.includes('THUNDERSTORMDAMAGETHREAT DESTRUCTIVE')
  ) {
    return { key: 'destructive-severe-thunderstorm', label: 'DESTRUCTIVE - SEVERE THUNDERSTORM WARNING', rank: 45, color: '#a76500', fill: '#a76500' };
  }

  if (
    name.includes('CONSIDERABLE SEVERE THUNDERSTORM WARNING') ||
    combinedText.includes('CONSIDERABLE SEVERE THUNDERSTORM WARNING') ||
    paramsText.includes('DAMAGE_THREAT CONSIDERABLE') ||
    paramsText.includes('THUNDERSTORMDAMAGETHREAT CONSIDERABLE')
  ) {
    return { key: 'considerable-severe-thunderstorm', label: 'CONSIDERABLE - SEVERE THUNDERSTORM WARNING', rank: 40, color: '#c79a00', fill: '#c79a00' };
  }

  if (
    name.includes('SEVERE THUNDERSTORM WARNING') ||
    event === 'SEVERE THUNDERSTORM WARNING'
  ) {
    return { key: 'severe-thunderstorm', label: 'Severe Thunderstorm Warning', rank: 30, color: '#f5cb00', fill: '#f5cb00' };
  }

  if (
    name.includes('FLASH FLOOD EMERGENCY') ||
    combinedText.includes('FLASH FLOOD EMERGENCY') ||
    paramsText.includes('FLASH FLOOD EMERGENCY')
  ) {
    return { key: 'flash-flood-emergency', label: 'FLASH FLOOD EMERGENCY', rank: 3, color: '#0b3d1b', fill: '#0b3d1b' };
  }

  if (
    name.includes('CONSIDERABLE FLASH FLOOD WARNING') ||
    combinedText.includes('CONSIDERABLE FLASH FLOOD WARNING') ||
    paramsText.includes('DAMAGE_THREAT CONSIDERABLE')
  ) {
    return { key: 'considerable-flash-flood-warning', label: 'CONSIDERABLE - FLASH FLOOD WARNING', rank: 2, color: '#13662f', fill: '#13662f' };
  }

  if (
    name.includes('FLASH FLOOD WARNING') ||
    event === 'FLASH FLOOD WARNING'
  ) {
    return { key: 'flash-flood-warning', label: 'Flash Flood Warning', rank: 1, color: '#1f8a43', fill: '#1f8a43' };
  }

  return null;
}

function classifyTropicalAlert(alert) {
  const properties = alert?.properties ?? alert?.raw?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const event = normalizeText(properties.event || details.native);
  const name = normalizeText(details.name || properties.properEventName || properties.event);
  const headline = normalizeText(properties.headline);
  const combined = `${name} ${event} ${headline}`;
  const tropicalWindProduct =
    event === 'HURRICANE WARNING' ||
    event === 'HURRICANE WATCH' ||
    event === 'TROPICAL STORM WARNING' ||
    event === 'TROPICAL STORM WATCH' ||
    event === 'STORM SURGE WARNING' ||
    event === 'STORM SURGE WATCH' ||
    combined.includes('HURRICANE WARNING') ||
    combined.includes('HURRICANE WATCH') ||
    combined.includes('TROPICAL STORM WARNING') ||
    combined.includes('TROPICAL STORM WATCH') ||
    combined.includes('STORM SURGE WARNING') ||
    combined.includes('STORM SURGE WATCH');

  if (event === 'TORNADO WARNING' || combined.includes('TORNADO WARNING')) {
    return { key: 'tornado-warning', label: 'TORNADO WARNING', countKey: 'tornadoWarning', rank: 50, color: '#d10000', textColor: '#ffffff' };
  }

  if (tropicalWindProduct && !isAtlanticTropicalProduct(alert)) {
    return null;
  }

  if (event === 'HURRICANE WARNING' || combined.includes('HURRICANE WARNING')) {
    return { key: 'hurricane-warning', label: 'HURRICANE WARNING', countKey: 'hurricaneWarning', rank: 45, color: '#d10000', textColor: '#ffffff' };
  }

  if (event === 'STORM SURGE WARNING' || combined.includes('STORM SURGE WARNING')) {
    return { key: 'storm-surge-warning', label: 'STORM SURGE WARNING', rank: 43, color: '#b40084', textColor: '#ffffff' };
  }

  if (event === 'HURRICANE WATCH' || combined.includes('HURRICANE WATCH')) {
    return { key: 'hurricane-watch', label: 'HURRICANE WATCH', countKey: 'hurricaneWatch', rank: 40, color: '#a000c8', textColor: '#ffffff' };
  }

  if (event === 'STORM SURGE WATCH' || combined.includes('STORM SURGE WATCH')) {
    return { key: 'storm-surge-watch', label: 'STORM SURGE WATCH', rank: 38, color: '#7a39bf', textColor: '#ffffff' };
  }

  if (event === 'TROPICAL STORM WARNING' || combined.includes('TROPICAL STORM WARNING')) {
    return { key: 'tropical-storm-warning', label: 'TROPICAL STORM WARNING', countKey: 'tropicalStormWarning', rank: 35, color: '#d48700', textColor: '#ffffff' };
  }

  if (event === 'TROPICAL STORM WATCH' || combined.includes('TROPICAL STORM WATCH')) {
    return { key: 'tropical-storm-watch', label: 'TROPICAL STORM WATCH', countKey: 'tropicalStormWatch', rank: 30, color: '#3f67a6', textColor: '#ffffff' };
  }

  return null;
}

function classifyWinterAlert(alert) {
  const properties = alert?.properties ?? alert?.raw?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const event = normalizeText(properties.event || details.native);
  const name = normalizeText(details.name || properties.properEventName || properties.event);
  const headline = normalizeText(properties.headline);
  const combined = `${name} ${event} ${headline}`;

  if (event === 'BLIZZARD WARNING' || combined.includes('BLIZZARD WARNING')) {
    return { key: 'blizzard-warning', label: 'BLIZZARD WARNING', countKey: 'blizzardWarning', rank: 50, color: '#2f7dff', textColor: '#ffffff' };
  }

  if (event === 'BLIZZARD WATCH' || combined.includes('BLIZZARD WATCH')) {
    return { key: 'blizzard-watch', label: 'BLIZZARD WATCH', countKey: 'blizzardWatch', rank: 45, color: '#6d8dff', textColor: '#ffffff' };
  }

  if (event === 'WINTER STORM WARNING' || combined.includes('WINTER STORM WARNING')) {
    return { key: 'winter-storm-warning', label: 'WINTER STORM WARNING', countKey: 'winterStormWarning', rank: 40, color: '#d14cff', textColor: '#ffffff' };
  }

  if (event === 'WINTER STORM WATCH' || combined.includes('WINTER STORM WATCH')) {
    return { key: 'winter-storm-watch', label: 'WINTER STORM WATCH', countKey: 'winterStormWatch', rank: 35, color: '#8a68ff', textColor: '#ffffff' };
  }

  if (event === 'ICE STORM WARNING' || combined.includes('ICE STORM WARNING')) {
    return { key: 'ice-storm-warning', label: 'ICE STORM WARNING', rank: 34, color: '#8ff0ff', textColor: '#ffffff' };
  }

  if (event === 'LAKE EFFECT SNOW WARNING' || combined.includes('LAKE EFFECT SNOW WARNING')) {
    return { key: 'lake-effect-snow-warning', label: 'LAKE EFFECT SNOW WARNING', rank: 33, color: '#56d4ff', textColor: '#ffffff' };
  }

  if (event === 'WINTER WEATHER ADVISORY' || combined.includes('WINTER WEATHER ADVISORY')) {
    return { key: 'winter-weather-advisory', label: 'WINTER WEATHER ADVISORY', rank: 25, color: '#7fb7ff', textColor: '#ffffff' };
  }

  return null;
}

function buildWinterRiskText(alert, classification) {
  const properties = alert?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const text = [
    properties.headline,
    properties.description,
    details.description,
    properties.instruction,
    details.instruction,
  ].filter(Boolean).join(' ');
  const combined = normalizeText(text);
  const parts = [];
  const add = (value) => {
    const normalized = normalizeText(value).replace(/\s+\.\s*/g, '. ').trim();
    if (normalized && !parts.includes(normalized)) {
      parts.push(normalized);
    }
  };

  if (classification.key === 'blizzard-warning') {
    add('BLIZZARD CONDITIONS EXPECTED.');
    add('WHITEOUTS POSSIBLE.');
    add('DANGEROUS TRAVEL LIKELY.');
  } else if (classification.key === 'blizzard-watch') {
    add('BLIZZARD CONDITIONS POSSIBLE.');
    add('WHITEOUTS POSSIBLE.');
    add('DANGEROUS TRAVEL POSSIBLE.');
  } else if (classification.key === 'winter-storm-warning') {
    add('WINTER STORM CONDITIONS EXPECTED.');
    add('HAZARDOUS TRAVEL LIKELY.');
  } else if (classification.key === 'winter-storm-watch') {
    add('WINTER STORM CONDITIONS POSSIBLE.');
    add('HAZARDOUS TRAVEL POSSIBLE.');
  } else if (classification.key === 'ice-storm-warning') {
    add('ICE STORM CONDITIONS EXPECTED.');
    add('DANGEROUS TRAVEL LIKELY.');
  } else if (classification.key === 'lake-effect-snow-warning') {
    add('LAKE EFFECT SNOW EXPECTED.');
    add('HAZARDOUS TRAVEL LIKELY.');
  } else if (classification.key === 'winter-weather-advisory') {
    add('WINTER WEATHER CONDITIONS EXPECTED.');
    add('HAZARDOUS TRAVEL POSSIBLE.');
  }

  if (/HEAVY SNOW|SNOW/i.test(combined)) add('HEAVY SNOW POSSIBLE.');
  if (/ICE|ICING|FREEZING RAIN|SLEET/i.test(combined)) add('ICE ACCUMULATION POSSIBLE.');
  if (/BLOWING SNOW/i.test(combined) && !parts.includes('WHITEOUTS POSSIBLE.')) add('BLOWING SNOW POSSIBLE.');
  if (/WIND|GUST/i.test(combined) && !/BLIZZARD/.test(combined)) add('STRONG WINDS POSSIBLE.');

  return parts.slice(0, 5).join(' ');
}

function buildWinterStripItem(alert) {
  const classification = classifyWinterAlert(alert);
  if (!classification) {
    return null;
  }

  const properties = alert?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const locations = String(properties.locations || properties.areaDesc || '')
    .replace(/\s*;\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toUpperCase();

  return {
    key: alert?.properties?.hash || getTrackingId(alert),
    label: classification.label,
    locations,
    color: classification.color,
    textColor: classification.textColor,
    rank: classification.rank,
    issued: properties.issued || details.issued || '',
    riskText: buildWinterRiskText(alert, classification),
  };
}

function buildTropicalRiskText(alert, classification) {
  const properties = alert?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const parameters = properties?.parameters ?? {};
  const sources = [
    properties.headline,
    properties.description,
    details.description,
    properties.instruction,
    details.instruction,
  ].filter(Boolean).join(' ');
  const combined = normalizeText(sources);
  const parts = [];
  const add = (value) => {
    const normalized = normalizeText(value).replace(/\s+\.\s*/g, '. ').trim();
    if (normalized && !parts.includes(normalized)) {
      parts.push(normalized);
    }
  };

  const windThreat = String(parameters.windThreat || parameters.wind_threat || '').trim();
  const surgeThreat = String(parameters.stormSurgeThreat || parameters.storm_surge_threat || '').trim();
  const floodingThreat = String(parameters.floodingRainThreat || parameters.flooding_rain_threat || '').trim();
  const tornadoThreat = String(parameters.tornadoThreat || parameters.tornado_threat || '').trim();

  if (classification.key === 'tornado-warning') {
    add('TORNADO POSSIBLE.');
  } else if (classification.key === 'storm-surge-warning') {
    add('LIFE-THREATENING STORM SURGE EXPECTED.');
  } else if (classification.key === 'storm-surge-watch') {
    add('LIFE-THREATENING STORM SURGE POSSIBLE.');
  } else if (classification.key.includes('hurricane')) {
    add(classification.key.endsWith('warning') ? 'HURRICANE CONDITIONS EXPECTED.' : 'HURRICANE CONDITIONS POSSIBLE.');
  } else if (classification.key.includes('tropical-storm')) {
    add(classification.key.endsWith('warning') ? 'TROPICAL STORM CONDITIONS EXPECTED.' : 'TROPICAL STORM CONDITIONS POSSIBLE.');
  }

  if (windThreat) add(`WIND THREAT ${windThreat}.`);
  if (surgeThreat) add(`STORM SURGE THREAT ${surgeThreat}.`);
  if (floodingThreat) add(`FLOODING RAIN THREAT ${floodingThreat}.`);
  if (tornadoThreat) add(`TORNADO THREAT ${tornadoThreat}.`);

  if (/STORM SURGE|SURGE/i.test(combined)) add('STORM SURGE POSSIBLE.');
  if (/FLOOD|RAIN/i.test(combined)) add('FLOODING RAIN POSSIBLE.');
  if (/TORNADO/i.test(combined) && classification.key !== 'tornado-warning') add('ISOLATED TORNADOES POSSIBLE.');
  if (/DAMAGING WIND|HURRICANE FORCE|TROPICAL STORM FORCE|WIND/i.test(combined)) add('DAMAGING WINDS POSSIBLE.');

  return parts.slice(0, 5).join(' ');
}

function buildTropicalStripItem(alert) {
  const classification = classifyTropicalAlert(alert);
  if (!classification) {
    return null;
  }

  const properties = alert?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const locations = String(properties.locations || properties.areaDesc || '')
    .replace(/\s*;\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toUpperCase();

  return {
    key: alert?.properties?.hash || getTrackingId(alert),
    label: classification.label,
    locations,
    color: classification.color,
    textColor: classification.textColor,
    rank: classification.rank,
    issued: properties.issued || details.issued || '',
    riskText: buildTropicalRiskText(alert, classification),
  };
}

function dedupeAlerts(alerts) {
  const map = new Map();

  for (const alert of alerts) {
    const trackingKey =
      alert?.properties?.details?.tracking ||
      alert?.properties?.id ||
      alert?.id ||
      alert?.properties?.hash ||
      '';

    if (!trackingKey) {
      continue;
    }

    const currentIssued = Date.parse(
      String(alert?.properties?.issued || alert?.properties?.details?.issued || alert?.properties?.sent || ''),
    ) || 0;
    const existing = map.get(trackingKey);

    if (!existing) {
      map.set(trackingKey, alert);
      continue;
    }

    const existingIssued = Date.parse(
      String(existing?.properties?.issued || existing?.properties?.details?.issued || existing?.properties?.sent || ''),
    ) || 0;

    if (currentIssued >= existingIssued) {
      map.set(trackingKey, alert);
    }
  }

  return Array.from(map.values());
}

function buildStructuredRiskText(alert, fallbackType = '') {
  const properties = alert?.properties ?? {};
  const parameters = properties?.parameters ?? {};
  const parts = [];
  const add = (value) => {
    const normalized = normalizeText(value).replace(/\s+\.\s*/g, '. ').trim();
    if (!normalized || parts.includes(normalized)) {
      return;
    }
    parts.push(normalized);
  };

  const tornadoDetection = normalizeText(
    parameters.tornado_detection ||
    (Array.isArray(parameters.tornadoDetection) ? parameters.tornadoDetection[0] : '') ||
    '',
  );
  const damageThreat = normalizeText(
    parameters.damage_threat ||
    (Array.isArray(parameters.thunderstormDamageThreat) ? parameters.thunderstormDamageThreat[0] : '') ||
    '',
  );
  const maxHailSize = String(parameters.max_hail_size || parameters.maxHailSize || '').trim();
  const maxWindGust = String(parameters.max_wind_gust || parameters.maxWindGust || '').trim();
  const type = normalizeText(fallbackType);
  const hailText = maxHailSize ? `HAIL UP TO ${maxHailSize}. VEHICLE HAIL DAMAGE POSSIBLE.` : 'HAIL DAMAGE TO VEHICLES IS POSSIBLE.';
  const windText = maxWindGust ? `DAMAGING WINDS UP TO ${maxWindGust}. TREE AND ROOF DAMAGE POSSIBLE.` : 'TREES AND ROOFS COULD SEE DAMAGE.';

  if (type.includes('TORNADO')) {
    add(tornadoDetection === 'OBSERVED' ? 'TORNADO OBSERVED.' : 'TORNADO POSSIBLE.');
    add(windText);
    add(hailText);
    if (damageThreat === 'CATASTROPHIC') add('CATASTROPHIC DAMAGE THREAT.');
    else if (damageThreat === 'CONSIDERABLE') add('CONSIDERABLE DAMAGE THREAT.');
  }

  if (type.includes('SEVERE THUNDERSTORM')) {
    add(windText);
    add(hailText);
    if (tornadoDetection === 'POSSIBLE') add('TORNADO POSSIBLE.');
    if (type.includes('DESTRUCTIVE') || damageThreat === 'DESTRUCTIVE') add('DESTRUCTIVE SEVERE THUNDERSTORM WARNING.');
    else if (type.includes('CONSIDERABLE') || damageThreat === 'CONSIDERABLE') add('CONSIDERABLE SEVERE THUNDERSTORM WARNING.');
  }

  if (type.includes('TORNADO WATCH')) {
    add('TORNADOES POSSIBLE.');
    add('DAMAGING WINDS POSSIBLE.');
    add('LARGE HAIL POSSIBLE.');
  }

  if (type.includes('SEVERE THUNDERSTORM WATCH')) {
    add('SEVERE THUNDERSTORMS POSSIBLE.');
    add('DAMAGING WINDS POSSIBLE.');
    add('LARGE HAIL POSSIBLE.');
  }

  if (type.includes('FLASH FLOOD')) {
    add('FLASH FLOODING IS POSSIBLE.');
    add('LOW-WATER CROSSINGS COULD FLOOD.');
    add('TURN AROUND, DON\'T DROWN.');
  }

  return parts.join(' ');
}

function buildWarningStripItem(alert) {
  const properties = alert?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const event = normalizeText(properties.event || details.native);
  const name = normalizeText(details.name || properties.properEventName || properties.event);
  const classification = classifyAlert(alert);
  const locations = String(properties.locations || properties.areaDesc || '')
    .replace(/\s*;\s*/g, ' - ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .toUpperCase();
  const riskText = extractRiskText(alert);

    if (
      name.includes('CONFIRMED TORNADO WARNING') ||
      name.includes('TORNADO OBSERVED') ||
        name.includes('RADAR INDICATED TORNADO WARNING') ||
        name.includes('PDS TORNADO') ||
      name.includes('TORNADO EMERGENCY') ||
      event === 'TORNADO WARNING'
      ) {
        const resolvedRiskText = buildStructuredRiskText(alert, name || 'TORNADO WARNING') || riskText;
        return {
          key: alert?.properties?.hash || getTrackingId(alert),
        label: classification?.label || name || 'TORNADO WARNING',
          locations,
          color: classification?.color || '#d10000',
          textColor: '#ffffff',
          rank: classification?.rank || 2,
          issued: properties.issued || details.issued || '',
        riskText: resolvedRiskText || 'TORNADO POSSIBLE.',
      };
    }

  if (name.includes('TORNADO WATCH') || event === 'TORNADO WATCH') {
      const resolvedRiskText = buildStructuredRiskText(alert, name || 'TORNADO WATCH') || riskText;
      return {
        key: alert?.properties?.hash || getTrackingId(alert),
        label: classification?.label || name || 'TORNADO WATCH',
        locations,
        color: classification?.color || '#ff0000',
        textColor: '#ffffff',
        rank: classification?.rank || 2,
        issued: properties.issued || details.issued || '',
        riskText: resolvedRiskText || 'TORNADOES POSSIBLE. DAMAGING WINDS POSSIBLE. LARGE HAIL POSSIBLE.',
      };
    }

  if (
    name.includes('SEVERE THUNDERSTORM WARNING') ||
      name.includes('DESTRUCTIVE SEVERE THUNDERSTORM WARNING') ||
      name.includes('CONSIDERABLE SEVERE THUNDERSTORM WARNING') ||
      event === 'SEVERE THUNDERSTORM WARNING'
      ) {
        const resolvedRiskText = buildStructuredRiskText(alert, name || 'SEVERE THUNDERSTORM WARNING') || riskText;
        return {
          key: alert?.properties?.hash || getTrackingId(alert),
        label: classification?.label || name || 'SEVERE THUNDERSTORM WARNING',
          locations,
          color: classification?.color || '#f5cb00',
          textColor: '#111111',
          rank: classification?.rank || 1,
          issued: properties.issued || details.issued || '',
        riskText: resolvedRiskText || 'DAMAGING WINDS POSSIBLE. LARGE HAIL POSSIBLE.',
      };
    }

  if (name.includes('SEVERE THUNDERSTORM WATCH') || event === 'SEVERE THUNDERSTORM WATCH') {
      const resolvedRiskText = buildStructuredRiskText(alert, name || 'SEVERE THUNDERSTORM WATCH') || riskText;
      return {
        key: alert?.properties?.hash || getTrackingId(alert),
        label: classification?.label || name || 'SEVERE THUNDERSTORM WATCH',
        locations,
        color: classification?.color || '#e47b8f',
        textColor: '#111111',
        rank: classification?.rank || 1,
        issued: properties.issued || details.issued || '',
        riskText: resolvedRiskText || 'SEVERE THUNDERSTORMS POSSIBLE. DAMAGING WINDS POSSIBLE. LARGE HAIL POSSIBLE.',
      };
    }

  if (
    name.includes('FLASH FLOOD WARNING') ||
      name.includes('CONSIDERABLE FLASH FLOOD WARNING') ||
      event === 'FLASH FLOOD WARNING'
      ) {
        const resolvedRiskText = buildStructuredRiskText(alert, name || 'FLASH FLOOD WARNING') || riskText;
        return {
          key: alert?.properties?.hash || getTrackingId(alert),
        label: classification?.label || name || 'FLASH FLOOD WARNING',
          locations,
          color: classification?.color || '#1f8a43',
          textColor: '#ffffff',
          rank: classification?.rank || 1,
          issued: properties.issued || details.issued || '',
        riskText: resolvedRiskText || 'FLASH FLOODING IS POSSIBLE. LOW-WATER CROSSINGS COULD FLOOD.',
      };
    }

  return null;
}

function extractRiskText(alert) {
  const properties = alert?.properties ?? {};
  const details = properties?.details ?? alert?.details ?? {};
  const parameters = properties?.parameters ?? {};
  const event = normalizeText(properties.event || details.native);
  const name = normalizeText(details.name || properties.properEventName || properties.event);
  const combinedType = `${name} ${event}`.trim();
  const parts = [];

  const pushUnique = (value) => {
    const normalized = normalizeText(value)
      .replace(/\s+\.\s*/g, '. ')
      .trim();

    if (!normalized || parts.includes(normalized)) {
      return;
    }

    parts.push(normalized);
  };

  const tornadoDetection = normalizeText(
    parameters.tornado_detection ||
    (Array.isArray(parameters.tornadoDetection) ? parameters.tornadoDetection[0] : '') ||
    '',
  );
  const damageThreat = normalizeText(
    parameters.damage_threat ||
    (Array.isArray(parameters.thunderstormDamageThreat) ? parameters.thunderstormDamageThreat[0] : '') ||
    '',
  );
  const maxHailSize = String(parameters.max_hail_size || parameters.maxHailSize || '').trim();
  const maxWindGust = String(parameters.max_wind_gust || parameters.maxWindGust || '').trim();

  if (combinedType.includes('TORNADO WARNING')) {
    if (tornadoDetection === 'OBSERVED' || name.includes('OBSERVED') || name.includes('CONFIRMED')) {
      pushUnique('TORNADO OBSERVED.');
    } else {
      pushUnique('TORNADO POSSIBLE.');
    }

    if (damageThreat === 'CATASTROPHIC') {
      pushUnique('CATASTROPHIC DAMAGE THREAT.');
    } else if (damageThreat === 'CONSIDERABLE') {
      pushUnique('CONSIDERABLE DAMAGE THREAT.');
    }

    if (maxWindGust) {
      pushUnique(`WIND GUSTS UP TO ${maxWindGust}.`);
    }

    if (maxHailSize) {
      pushUnique(`HAIL UP TO ${maxHailSize}.`);
    }
  }

  if (combinedType.includes('SEVERE THUNDERSTORM WARNING')) {
    if (maxWindGust) {
      pushUnique(`WIND GUSTS UP TO ${maxWindGust}.`);
    }

    if (maxHailSize) {
      pushUnique(`HAIL UP TO ${maxHailSize}.`);
    }

    if (tornadoDetection === 'POSSIBLE') {
      pushUnique('TORNADO POSSIBLE.');
    }

    if (damageThreat === 'DESTRUCTIVE') {
      pushUnique('DESTRUCTIVE DAMAGE THREAT.');
    } else if (damageThreat === 'CONSIDERABLE') {
      pushUnique('CONSIDERABLE DAMAGE THREAT.');
    }
  }

  const directRiskLines = [
    properties.description,
    details.description,
    properties.instruction,
    details.instruction,
  ]
    .filter(Boolean)
    .flatMap((source) => String(source).replace(/\r/g, '\n').split('\n'))
    .map((line) => line.trim())
    .filter((line) => /^HAZARD\.\.\.|^IMPACT\.\.\./i.test(line))
    .map((line) => line.replace(/^HAZARD\.\.\./i, '').replace(/^IMPACT\.\.\./i, '').trim())
    .filter(Boolean);

  for (const line of directRiskLines.slice(0, 3)) {
    pushUnique(line);
  }

  const sources = [
    properties.instruction,
    details.instruction,
    properties.description,
    details.description,
    properties.headline,
  ].filter(Boolean);

  for (const source of sources) {
    const cleaned = String(source)
      .replace(/\r/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('*') && !/UNTIL\s+\d/i.test(line) && !/NATIONAL WEATHER SERVICE/i.test(line))
      .join(' ');

    if (!cleaned) {
      continue;
    }

    const sentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);

    const preferred = sentences.filter((sentence) => (
      /DAMAGING WINDS?|DESTRUCTIVE WINDS?|WIND|HAIL|TORNADO|MOBILE HOMES|ROOFS|OUTBUILDINGS|VEHICLES|TREE|DESTRUCTIVE|CONSIDERABLE|BASEBALL|OBSERVED|POSSIBLE|RADAR INDICATED|THREAT/i.test(sentence)
    ));

    for (const sentence of preferred.slice(0, 2)) {
      pushUnique(
        sentence
          .replace(/^HAZARD\.\.\./i, '')
          .replace(/^IMPACT\.\.\./i, '')
          .trim(),
      );
    }
  }

  if (parts.length) {
    return parts.slice(0, 3).join(' ');
  }

  if (combinedType.includes('TORNADO WARNING')) {
    return 'TORNADO POSSIBLE.';
  }

  if (combinedType.includes('SEVERE THUNDERSTORM WARNING')) {
    return 'DAMAGING WINDS AND LARGE HAIL POSSIBLE.';
  }

  return 'SEVERE WEATHER RISK DETAILS AVAILABLE.';
}

function getRelevantActiveAlerts() {
  return dedupeAlerts([...state.manual.features, ...state.events.features].filter(Boolean))
    .filter(isAlertActive)
    .filter((alert) => Boolean(buildWarningStripItem(alert) || buildTropicalStripItem(alert) || buildWinterStripItem(alert)));
}

function isHighestBannerAlert(classification) {
  return [
    'tornado-emergency',
    'pds-tornado',
    'tornado-observed',
    'radar-indicated-tornado-warning',
    'tornado-watch',
    'eds-severe-thunderstorm',
    'destructive-severe-thunderstorm',
    'considerable-severe-thunderstorm',
    'severe-thunderstorm',
    'severe-thunderstorm-watch',
  ].includes(classification?.key);
}

const testAlertPresets = {
  'tornado-emergency': {
    event: 'Tornado Warning',
    name: 'Tornado Emergency',
    areaDesc: 'Kingfisher, OK - Canadian, OK',
    headline: 'TEST Tornado Emergency for Kingfisher and Canadian Counties',
    description: 'HAZARD...Catastrophic tornado. IMPACT...This is a test tornado emergency.',
    parameters: {
      tornadoDetection: ['OBSERVED'],
      tornadoDamageThreat: ['CATASTROPHIC'],
    },
  },
  'pds-tornado': {
    event: 'Tornado Warning',
    name: 'PDS Tornado Warning',
    areaDesc: 'Logan, KS - Gove, KS',
    headline: 'TEST PDS Tornado Warning for Logan and Gove Counties',
    description: 'Particularly dangerous situation. HAZARD...Observed tornado. IMPACT...This is a test PDS tornado warning.',
    parameters: {
      tornadoDetection: ['OBSERVED'],
      tornadoDamageThreat: ['CONSIDERABLE'],
    },
  },
  'observed-tornado': {
    event: 'Tornado Warning',
    name: 'Confirmed Tornado Warning',
    areaDesc: 'Spencer, IN - Warrick, IN',
    headline: 'TEST Observed Tornado Warning for Spencer and Warrick Counties',
    description: 'HAZARD...Observed tornado. IMPACT...This is a test observed tornado warning.',
    parameters: {
      tornadoDetection: ['OBSERVED'],
    },
  },
  'radar-tornado': {
    event: 'Tornado Warning',
    name: 'Radar Indicated Tornado Warning',
    areaDesc: 'Martin, IN - Daviess, IN',
    headline: 'TEST Radar Indicated Tornado Warning for Martin and Daviess Counties',
    description: 'HAZARD...Radar indicated tornado. IMPACT...This is a test tornado warning.',
    parameters: {
      tornadoDetection: ['RADAR INDICATED'],
    },
  },
  'tornado-watch': {
    event: 'Tornado Watch',
    name: 'Tornado Watch',
    areaDesc: 'OK - KS - TX',
    headline: 'TEST Tornado Watch',
    description: 'Tornadoes possible. Damaging winds possible. Large hail possible.',
    parameters: {},
  },
  'eds-severe': {
    event: 'Severe Thunderstorm Warning',
    name: 'EDS Severe Thunderstorm Warning',
    areaDesc: 'Alfalfa, OK - Woods, OK - Woodward, OK',
    headline: 'TEST EDS Severe Thunderstorm Warning',
    description: 'HAZARD...Extreme damaging winds and large hail. IMPACT...Emergency damage threat.',
    parameters: {
      thunderstormDamageThreat: ['EMERGENCY'],
      windGust: ['90 MPH'],
      maxHailSize: ['2.75'],
      tornadoDetection: ['POSSIBLE'],
    },
  },
  'destructive-severe': {
    event: 'Severe Thunderstorm Warning',
    name: 'Destructive Severe Thunderstorm Warning',
    areaDesc: 'Caddo, OK - Custer, OK - Roger Mills, OK',
    headline: 'TEST Destructive Severe Thunderstorm Warning',
    description: 'HAZARD...Destructive winds and large hail. IMPACT...Tree and roof damage possible.',
    parameters: {
      thunderstormDamageThreat: ['DESTRUCTIVE'],
      windGust: ['80 MPH'],
      maxHailSize: ['2.00'],
    },
  },
  'considerable-severe': {
    event: 'Severe Thunderstorm Warning',
    name: 'Considerable Severe Thunderstorm Warning',
    areaDesc: 'Bent, CO - Otero, CO',
    headline: 'TEST Considerable Severe Thunderstorm Warning',
    description: 'HAZARD...Damaging winds and hail. IMPACT...Considerable damage threat.',
    parameters: {
      thunderstormDamageThreat: ['CONSIDERABLE'],
      windGust: ['70 MPH'],
      maxHailSize: ['1.75'],
    },
  },
  'severe-warning': {
    event: 'Severe Thunderstorm Warning',
    name: 'Severe Thunderstorm Warning',
    areaDesc: 'Hinds, MS - Madison, MS - Warren, MS - Yazoo, MS',
    headline: 'TEST Severe Thunderstorm Warning',
    description: 'HAZARD...Damaging winds and hail. IMPACT...Tree damage and vehicle hail damage possible.',
    parameters: {
      windGust: ['60 MPH'],
      maxHailSize: ['1.00'],
    },
  },
  'severe-watch': {
    event: 'Severe Thunderstorm Watch',
    name: 'Severe Thunderstorm Watch',
    areaDesc: 'AL - MS - TN',
    headline: 'TEST Severe Thunderstorm Watch',
    description: 'Severe thunderstorms possible. Damaging winds possible. Large hail possible.',
    parameters: {},
  },
  'flash-flood': {
    event: 'Flash Flood Warning',
    name: 'Flash Flood Warning',
    areaDesc: 'Jefferson, KY - Oldham, KY',
    headline: 'TEST Flash Flood Warning',
    description: 'HAZARD...Flash flooding. IMPACT...Low-water crossings could flood.',
    parameters: {},
  },
  'hurricane-warning': {
    event: 'Hurricane Warning',
    name: 'Hurricane Warning',
    areaDesc: 'Miami-Dade, FL - Broward, FL - Palm Beach, FL',
    headline: 'TEST Hurricane Warning',
    description: 'Hurricane conditions expected. Storm surge, flooding rain, damaging winds, and isolated tornadoes possible.',
    parameters: {
      windThreat: ['Extreme'],
      stormSurgeThreat: ['Life-threatening'],
      floodingRainThreat: ['Considerable'],
      tornadoThreat: ['Elevated'],
    },
  },
  'hurricane-watch': {
    event: 'Hurricane Watch',
    name: 'Hurricane Watch',
    areaDesc: 'Monroe, FL - Collier, FL',
    headline: 'TEST Hurricane Watch',
    description: 'Hurricane conditions possible. Storm surge and damaging winds possible.',
    parameters: {
      windThreat: ['High'],
      stormSurgeThreat: ['Possible'],
    },
  },
  'tropical-storm-warning': {
    event: 'Tropical Storm Warning',
    name: 'Tropical Storm Warning',
    areaDesc: 'Charleston, SC - Georgetown, SC',
    headline: 'TEST Tropical Storm Warning',
    description: 'Tropical storm conditions expected. Flooding rain and damaging wind gusts possible.',
    parameters: {
      windThreat: ['Moderate'],
      floodingRainThreat: ['Moderate'],
    },
  },
  'tropical-storm-watch': {
    event: 'Tropical Storm Watch',
    name: 'Tropical Storm Watch',
    areaDesc: 'Carteret, NC - Hyde, NC',
    headline: 'TEST Tropical Storm Watch',
    description: 'Tropical storm conditions possible. Coastal flooding and gusty winds possible.',
    parameters: {
      windThreat: ['Possible'],
      floodingRainThreat: ['Possible'],
    },
  },
  'winter-storm-warning': {
    event: 'Winter Storm Warning',
    name: 'Winter Storm Warning',
    areaDesc: 'Laramie, WY - Albany, WY',
    headline: 'TEST Winter Storm Warning',
    description: 'Heavy snow, sleet, and blowing snow expected. Hazardous travel likely.',
    parameters: {},
  },
  'winter-storm-watch': {
    event: 'Winter Storm Watch',
    name: 'Winter Storm Watch',
    areaDesc: 'Larimer, CO - Weld, CO',
    headline: 'TEST Winter Storm Watch',
    description: 'Heavy snow and icy roads possible. Hazardous travel possible.',
    parameters: {},
  },
  'blizzard-warning': {
    event: 'Blizzard Warning',
    name: 'Blizzard Warning',
    areaDesc: 'Campbell, WY - Sheridan, WY',
    headline: 'TEST Blizzard Warning',
    description: 'Blizzard conditions expected with whiteouts, heavy snow, and dangerous travel.',
    parameters: {},
  },
  'blizzard-watch': {
    event: 'Blizzard Watch',
    name: 'Blizzard Watch',
    areaDesc: 'McKenzie, ND - Williams, ND',
    headline: 'TEST Blizzard Watch',
    description: 'Blizzard conditions possible with blowing snow and near whiteout visibility.',
    parameters: {},
  },
};

function buildTestAlert(type) {
  const preset = testAlertPresets[type];
  if (!preset) {
    return null;
  }

  const now = new Date();
  const expires = new Date(now.getTime() + 60 * 60 * 1000);
  const tracking = `LOCAL-TEST-${type}-${now.getTime()}`;
  const baseLon = -97.55 + (Object.keys(testAlertPresets).indexOf(type) * 0.15);
  const baseLat = 35.45;
  const polygon = [
    [baseLon - 0.35, baseLat - 0.22],
    [baseLon + 0.35, baseLat - 0.22],
    [baseLon + 0.35, baseLat + 0.22],
    [baseLon - 0.35, baseLat + 0.22],
    [baseLon - 0.35, baseLat - 0.22],
  ];

  return {
    type: 'Feature',
    id: tracking,
    geometry: {
      type: 'Polygon',
      coordinates: [polygon],
    },
    properties: {
      id: tracking,
      hash: tracking,
      event: preset.event,
      properEventName: preset.name,
      headline: preset.headline,
      description: preset.description,
      instruction: 'This is a TuftsWeather Overlays test alert. Not a real warning.',
      areaDesc: preset.areaDesc,
      locations: preset.areaDesc,
      sent: now.toISOString(),
      effective: now.toISOString(),
      issued: now.toISOString(),
      expires: expires.toISOString(),
      ends: expires.toISOString(),
      action_type: 'NEW',
      messageType: 'NEW',
      is_issued: true,
      is_updated: false,
      is_test: true,
      parameters: preset.parameters,
      details: {
        tracking,
        name: preset.name,
        native: preset.event,
        issued: now.toISOString(),
        description: preset.description,
      },
      geocode: {
        UGC: ['OKZTEST'],
      },
    },
  };
}

function rebuildSummary() {
  const alerts = getRelevantActiveAlerts();
  let highest = null;
  let winterHighest = null;
  let tornadoWarningCount = 0;
  let severeWarningCount = 0;
  const warningStripItems = [];
  const tropicalCounts = {
    tornadoWarning: 0,
    hurricaneWarning: 0,
    hurricaneWatch: 0,
    tropicalStormWarning: 0,
    tropicalStormWatch: 0,
  };
  const tropicalStripItems = [];
  const winterCounts = {
    blizzardWarning: 0,
    blizzardWatch: 0,
    winterStormWarning: 0,
    winterStormWatch: 0,
  };
  const winterStripItems = [];

  for (const alert of alerts) {
    const classification = classifyAlert(alert);
    const tropicalClassification = classifyTropicalAlert(alert);
    const tropicalStripItem = buildTropicalStripItem(alert);
    const winterClassification = classifyWinterAlert(alert);
    const winterStripItem = buildWinterStripItem(alert);

    if (tropicalClassification && tropicalCounts[tropicalClassification.countKey] !== undefined) {
      tropicalCounts[tropicalClassification.countKey] += 1;
    }

    if (tropicalStripItem) {
      tropicalStripItems.push(tropicalStripItem);
    }

    if (winterClassification && winterCounts[winterClassification.countKey] !== undefined) {
      winterCounts[winterClassification.countKey] += 1;
      if (!winterHighest || winterClassification.rank > winterHighest.rank) {
        winterHighest = winterClassification;
      }
    }

    if (winterStripItem) {
      winterStripItems.push(winterStripItem);
    }

    if (!classification) {
      continue;
    }

    if (
      classification.key === 'tornado-emergency' ||
      classification.key === 'pds-tornado' ||
      classification.key === 'tornado-observed' ||
      classification.key === 'radar-indicated-tornado-warning'
    ) {
      tornadoWarningCount += 1;
    } else if (
      classification.key === 'eds-severe-thunderstorm' ||
      classification.key === 'destructive-severe-thunderstorm' ||
      classification.key === 'considerable-severe-thunderstorm' ||
      classification.key === 'severe-thunderstorm'
    ) {
      severeWarningCount += 1;
    }

    if (isHighestBannerAlert(classification) && (!highest || classification.rank > highest.rank)) {
      highest = classification;
    }

    const stripItem = buildWarningStripItem(alert);
    if (stripItem) {
      warningStripItems.push(stripItem);
    }
  }

  const relevantActiveCount = warningStripItems.length;

  state.summary = {
    activeCount: relevantActiveCount,
    tornadoWarningCount,
    severeWarningCount,
    highestKey: highest?.key || '',
    highestLabel: highest?.label || 'No severe alerts active currently',
    highestRank: highest?.rank || 0,
    highestColor: highest?.color || '#006fd6',
    highestFill: highest?.fill || '#006fd6',
    tropicalCounts,
    warningStripItems: warningStripItems
      .sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank;
        return Date.parse(b.issued || '') - Date.parse(a.issued || '');
      })
      .slice(0, 40),
    tropicalStripItems: tropicalStripItems
      .sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank;
        return Date.parse(b.issued || '') - Date.parse(a.issued || '');
      })
      .slice(0, 40),
    winterCounts,
    winterHighestKey: winterHighest?.key || '',
    winterHighestLabel: winterHighest?.label || 'No winter alerts active currently',
    winterHighestRank: winterHighest?.rank || 0,
    winterHighestColor: winterHighest?.color || '#006fd6',
    winterHighestFill: winterHighest?.color || '#006fd6',
    winterStripItems: winterStripItems
      .sort((a, b) => {
        if (b.rank !== a.rank) return b.rank - a.rank;
        return Date.parse(b.issued || '') - Date.parse(a.issued || '');
      })
      .slice(0, 40),
  };
}

function upsertAlerts(alerts) {
  const map = new Map();

  for (const alert of state.events.features) {
    map.set(getTrackingId(alert), alert);
  }

  for (const alert of alerts) {
    const trackingId = getTrackingId(alert);
    if (!trackingId) {
      continue;
    }
    map.set(trackingId, alert);
  }

  state.events = makeFeatureCollection(Array.from(map.values()));
  state.lastEventAt = new Date().toISOString();
  rebuildSummary();
}

function removeAlert(alert) {
  const trackingId = getTrackingId(alert);
  state.events = makeFeatureCollection(
    state.events.features.filter((entry) => getTrackingId(entry) !== trackingId),
  );
  state.lastEventAt = new Date().toISOString();
  rebuildSummary();
}

function broadcast(payload) {
  const serialized = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(serialized);
    }
  }
}

function broadcastCollections() {
  broadcast({
    type: 'update',
    message: {
      activeCount: state.summary.activeCount,
      connected: state.connected,
      mode: state.mode,
      summary: state.summary,
    },
  });
  broadcast({
    type: 'subscribe',
    value: 'summary',
    message: state.summary,
  });
}

function broadcastLiveAlerts(alerts, source = state.mode) {
  if (!Array.isArray(alerts) || alerts.length === 0) {
    return;
  }

  broadcast({
    type: 'subscribe',
    value: 'liveAlerts',
    message: {
      source,
      sentAt: new Date().toISOString(),
      alerts,
    },
  });
}

function setMessage(message, error = '') {
  state.lastMessage = message;
  state.lastError = error;
}

function handleListenError(error) {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `[TuftsWeather Overlays] Port ${runtimeConfig.server.port} is already in use on ${runtimeConfig.server.host}.`,
    );
    console.error(
      '[TuftsWeather Overlays] Stop the old TuftsWeather Overlays process first, then run start again.',
    );
    console.error(
      `[TuftsWeather Overlays] Try: ${path.join(rootDir, 'build-tools', 'stop-windows.cmd')}`,
    );
    process.exit(1);
  }

  console.error('[TuftsWeather Overlays] Server failed to start:', error);
  process.exit(1);
}

function startLocalhostShortcutServer() {
  localhostRedirectServer.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.warn('[TuftsWeather Overlays] Port 80 is already in use. localhost shortcut was skipped.');
      return;
    }

    console.warn('[TuftsWeather Overlays] localhost shortcut server failed:', error);
  });

  localhostRedirectServer.listen(80, '127.0.0.1', () => {
    console.log('[TuftsWeather Overlays] Shortcut: http://localhost -> dashboard');
  });
}

function getStatusPayload() {
  return {
    startedAt: state.startedAt,
    mode: state.mode,
    connected: state.connected,
    nickname: state.nickname,
    lastError: state.lastError,
    lastMessage: state.lastMessage,
    lastEventAt: state.lastEventAt,
    activeEvents: state.summary.activeCount,
    summary: state.summary,
    endpoints: {
      dashboard: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/`,
      stream: `ws://${runtimeConfig.server.host}:${runtimeConfig.server.port}/stream`,
      warningBanner: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/weather-warning-banner.html`,
      alertCounter: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/alertactive.html`,
      tropicalCounter: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/tropicalactive.html`,
      tropicalAlertCounter: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/tropical-alert-counter.html`,
      warningOutline: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/weather-warning-outline.html`,
      popupAlerts: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/popup-alerts.html?setMaxHistory=2&setBeepVolume=0&setAlertVolume=0`,
      activeWarningStrip: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/active-warning-strip.html`,
      warnedCams: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/widgets/warnedcams`,
      tropicalOutline: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/tropical-outline.html`,
      tropicalBanner: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/tropical-banner.html`,
      tropicalPopup: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/tropical-popup-alerts.html?setMaxHistory=2`,
      atlanticLatestOverlay: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/atlantic-latest-overlay.html`,
      tropicalActiveStrip: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/tropical-active-strip.html`,
      tropicalAlertStrip: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/tropical-warning-strip.html`,
      winterBanner: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/winter-banner.html`,
      winterCounter: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/winter-alert-counter.html`,
      winterOutline: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/winter-outline.html`,
      winterPopup: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/winter-popup-alerts.html?setMaxHistory=2`,
      winterStrip: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/winter-active-strip.html`,
      warnedCamsWinter: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/widgets/warnedcams-winter`,
      spcOutlookMap: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/overlays/spc-outlook-map.html`,
      warnedCamsTropical: `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}/widgets/warnedcams-tropical`,
    },
    config: {
      configPath,
      usingNwws: parserSettings.is_wire,
      hasCredentials: Boolean(runtimeConfig.nwws.username && runtimeConfig.nwws.password),
    },
  };
}

async function refreshFromApi(reason) {
  try {
    await ParserUtils.loadGeoJsonData();
    if (state.mode !== 'nwws-auth-error') {
      setMessage(`Refreshed active alerts from NWS API (${reason})`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setMessage('NWS API refresh failed', message);
  }
}

function scheduleBackfill() {
  if (!parserSettings.is_wire) {
    return;
  }

  const intervalMs = Math.max(runtimeConfig.nwws.backfillIntervalSeconds, 15) * 1000;
  backfillTimer = setInterval(() => {
    void refreshFromApi('scheduled backfill');
  }, intervalMs);
}

function bindParserEvents(manager) {
  manager.on('onConnection', (nickname) => {
    state.connected = true;
    state.mode = 'nwws-live';
    state.nickname = nickname;
    setMessage(`Connected to NWWS as ${nickname}`);
    broadcastCollections();
  });

  manager.on('onReconnection', () => {
    state.connected = true;
    state.mode = 'nwws-live';
    setMessage('Reconnected to NWWS');
    broadcastCollections();
  });

  manager.on('onEvents', (alerts) => {
    upsertAlerts(alerts);
    setMessage(`Updated ${alerts.length} alert(s)`);
    broadcastLiveAlerts(alerts, 'nwws');
    broadcastCollections();
  });

  manager.on('onExpired', (alert) => {
    removeAlert(alert);
    setMessage('Expired alert removed');
    broadcastCollections();
  });

  manager.on('log', (message) => {
    const text = String(message);
    state.lastMessage = text;

    if (text.toLowerCase().includes('not-authorized')) {
      if (parserAuthFailed) {
        return;
      }

      parserAuthFailed = true;
      state.connected = false;
      state.mode = 'nwws-auth-error';
      state.lastError =
        'NWWS login was rejected. Recheck the username and password in localoverlays.local.json.';
      setMessage('NWWS login rejected. Falling back to local API feed.', state.lastError);
      console.error('[TuftsWeather Overlays] NWWS login rejected. Check the username/password in localoverlays.local.json.');
      broadcastCollections();

      void manager.stop();
      return;
    }

    if (text.toLowerCase().includes('offline')) {
      state.connected = false;
      if (state.mode !== 'nwws-auth-error') {
        state.mode = 'api-fallback';
      }
    }
  });
}

wss.on('connection', (socket) => {
  socket.on('message', (rawMessage) => {
    try {
      const payload = JSON.parse(String(rawMessage));
      if (payload.type === 'subscribe' && Array.isArray(payload.message)) {
        for (const channel of payload.message) {
          if (channel === 'summary') {
            socket.send(
              JSON.stringify({
                type: 'subscribe',
                value: 'summary',
                message: state.summary,
              }),
            );
          }
          if (channel === 'events' || channel === 'manual') {
            socket.send(
              JSON.stringify({
                type: 'subscribe',
                value: channel,
                message: state[channel],
              }),
            );
          }
        }
      }
    } catch {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid websocket payload' }));
    }
  });

  socket.send(JSON.stringify({ type: 'status', message: getStatusPayload() }));
});

app.get('/api/status', (_request, response) => {
  response.json(getStatusPayload());
});

app.get('/api/config/custom-cameras', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json(sanitizeCustomCameraConfig(runtimeConfig.customCameras));
});

app.get('/api/config/service', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json(sanitizeServiceConfig(runtimeConfig));
});

app.post('/api/config/service', express.json({ limit: '80kb' }), (request, response) => {
  try {
    const nextServiceConfig = sanitizeServiceConfig(request.body);
    const diskConfig = readConfigFile();
    diskConfig.nwws = nextServiceConfig.nwws;
    diskConfig.nwsApi = nextServiceConfig.nwsApi;
    writeConfigFile(diskConfig);
    runtimeConfig.nwws = nextServiceConfig.nwws;
    runtimeConfig.nwsApi = nextServiceConfig.nwsApi;
    state.nickname = nextServiceConfig.nwws.nickname;
    response.setHeader('Cache-Control', 'no-store');
    response.json(nextServiceConfig);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/api/config/custom-cameras', express.json({ limit: '160kb' }), (request, response) => {
  try {
    const nextCustomCameras = sanitizeCustomCameraConfig(request.body);
    const diskConfig = readConfigFile();
    diskConfig.customCameras = nextCustomCameras;
    writeConfigFile(diskConfig);
    runtimeConfig.customCameras = nextCustomCameras;
    response.setHeader('Cache-Control', 'no-store');
    response.json(nextCustomCameras);
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/api/cameras', async (_request, response) => {
  try {
    response.setHeader('Cache-Control', 'no-store');
    response.json(await getCameraLitePayload('severe'));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/cameras-lite', async (request, response) => {
  const widget = String(request.query.widget || 'severe').toLowerCase();
  try {
    response.setHeader('Cache-Control', 'public, max-age=300');
    response.json(await getCameraLitePayload(widget));
  } catch (error) {
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/api/warned-cameras', async (request, response) => {
  const fallbackRadiusMiles = Math.max(5, Number(request.query.fallbackRadiusMiles || 250));
  const max = Math.min(200, Math.max(1, Number(request.query.max || 80)));
  const widget = String(request.query.widget || 'severe').toLowerCase();
  try {
    response.setHeader('Cache-Control', 'no-store');
    response.json({
      matches: await getWarnedCameraMatches({
        fallbackRadiusMiles,
        max,
        widget,
        streamSource: request.query.streamSource,
        search: request.query.search,
      }),
    });
  } catch (error) {
    response.status(500).json({
      error: error instanceof Error ? error.message : String(error),
      fallbackRadiusMiles,
      max,
      widget,
    });
  }
});

app.get('/api/events', (_request, response) => {
  response.json(state.events);
});

app.get('/api/events/relevant', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json(makeFeatureCollection(getRelevantActiveAlerts()));
});

app.get('/api/spc/outlooks', async (request, response) => {
  try {
    const force = request.query.force === '1';
    response.setHeader('Cache-Control', 'no-store');
    response.json(await fetchSpcOutlooks({ force }));
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : String(error),
      days: [],
    });
  }
});

app.get('/api/spc/outlook-images', async (request, response) => {
  try {
    const force = request.query.force === '1';
    response.setHeader('Cache-Control', 'no-store');
    response.json(await fetchSpcOfficialImages({ force }));
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : String(error),
      images: [],
    });
  }
});

app.get('/api/tropical/systems', async (request, response) => {
  try {
    const force = request.query.force === '1';
    response.setHeader('Cache-Control', 'no-store');
    response.json(await getTropicalSystemsPayload({ force }));
  } catch (error) {
    response.status(502).json({
      error: error instanceof Error ? error.message : String(error),
      activeStorms: [],
      testActive: Boolean(state.tropicalTestSystem),
    });
  }
});

app.get('/api/test-tropical-system', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.json({
    active: Boolean(state.tropicalTestSystem),
    system: state.tropicalTestSystem,
    presets: Object.keys(tropicalSystemPresets),
  });
});

app.post('/api/test-tropical-system/:type', (request, response) => {
  const system = buildTestTropicalSystem(request.params.type);
  if (!system) {
    response.status(404).json({ error: 'Unknown tropical test system type' });
    return;
  }

  state.tropicalTestSystem = system;
  setMessage(`Tropical test system active: ${request.params.type}`);
  broadcastCollections();
  response.json({ ok: true, system });
});

app.delete('/api/test-tropical-system', (_request, response) => {
  state.tropicalTestSystem = null;
  setMessage('Tropical test system cleared');
  broadcastCollections();
  response.json({ ok: true });
});

app.get('/api/test-alerts', (_request, response) => {
  response.json({
    active: state.manual.features.length,
    presets: Object.entries(testAlertPresets).map(([key, preset]) => ({
      key,
      label: preset.name,
      event: preset.event,
    })),
  });
});

app.post('/api/test-alerts/:type', (request, response) => {
  const alert = buildTestAlert(request.params.type);
  if (!alert) {
    response.status(404).json({ error: 'Unknown test alert type' });
    return;
  }

  state.manual = makeFeatureCollection([alert]);
  state.lastEventAt = new Date().toISOString();
  setMessage(`Test alert active: ${alert.properties.properEventName}`);
  rebuildSummary();
  broadcastLiveAlerts([alert], 'test');
  broadcastCollections();
  response.json({ ok: true, alert, summary: state.summary });
});

app.delete('/api/test-alerts', (_request, response) => {
  state.manual = makeFeatureCollection();
  state.lastEventAt = new Date().toISOString();
  setMessage('Test alerts cleared');
  rebuildSummary();
  broadcastCollections();
  response.json({ ok: true, summary: state.summary });
});

app.get(['/widgets/warnedcams', '/widgets/warnedcams/', '/widgets/warnedcams.html'], (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.sendFile(path.join(widgetsDir, 'warnedcams.html'));
});

app.get(['/widgets/warnedcams-tropical', '/widgets/warnedcams-tropical/', '/widgets/warnedcams-tropical.html'], (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.sendFile(path.join(widgetsDir, 'warnedcams-tropical.html'));
});

app.get(['/widgets/warnedcams-winter', '/widgets/warnedcams-winter/', '/widgets/warnedcams-winter.html'], (_request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  response.sendFile(path.join(widgetsDir, 'warnedcams-winter.html'));
});

app.use(express.static(publicDir));

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));

  app.use((request, response, next) => {
    if (request.path.startsWith('/api/') || request.path === '/stream') {
      next();
      return;
    }

    response.sendFile(path.join(distDir, 'index.html'));
  });
}

async function start() {
  const hasCredentials = Boolean(runtimeConfig.nwws.username && runtimeConfig.nwws.password);
  parserAuthFailed = false;

  if (parserSettings.is_wire) {
    state.mode = 'nwws-connecting';
    setMessage('Starting NWWS parser session');
  } else if (runtimeConfig.nwws.enabled && !hasCredentials) {
    state.mode = 'api-fallback';
    setMessage(`NWWS enabled but credentials are blank. Fill ${configPath} to use your wire login.`);
  } else {
    state.mode = 'api-only';
    setMessage('Running with NWS API polling only');
  }

  server.on('error', handleListenError);
  wss.on('error', handleListenError);

  server.listen(runtimeConfig.server.port, runtimeConfig.server.host, () => {
    const baseUrl = `http://${runtimeConfig.server.host}:${runtimeConfig.server.port}`;
    console.log(`[TuftsWeather Overlays] Server ready at ${baseUrl}`);
    console.log(`[TuftsWeather Overlays] Dashboard: ${baseUrl}/`);
    console.log(`[TuftsWeather Overlays] Active alerts URL: ${baseUrl}/overlays/weather-warning-banner.html`);
    console.log(`[TuftsWeather Overlays] Alert counter URL: ${baseUrl}/overlays/alertactive.html`);
    console.log(`[TuftsWeather Overlays] Tropical counter URL: ${baseUrl}/overlays/tropicalactive.html`);
    console.log(`[TuftsWeather Overlays] Tropical alert counter URL: ${baseUrl}/overlays/tropical-alert-counter.html`);
    console.log(`[TuftsWeather Overlays] Warning outline URL: ${baseUrl}/overlays/weather-warning-outline.html`);
    console.log(`[TuftsWeather Overlays] Popup alerts URL: ${baseUrl}/overlays/popup-alerts.html`);
    console.log(`[TuftsWeather Overlays] Active warning strip URL: ${baseUrl}/overlays/active-warning-strip.html`);
    console.log(`[TuftsWeather Overlays] Tropical outline URL: ${baseUrl}/overlays/tropical-outline.html`);
    console.log(`[TuftsWeather Overlays] Tropical banner URL: ${baseUrl}/overlays/tropical-banner.html`);
    console.log(`[TuftsWeather Overlays] Atlantic latest overlay URL: ${baseUrl}/overlays/atlantic-latest-overlay.html`);
    console.log(`[TuftsWeather Overlays] Tropical active strip URL: ${baseUrl}/overlays/tropical-active-strip.html`);
    console.log(`[TuftsWeather Overlays] Tropical warning strip URL: ${baseUrl}/overlays/tropical-warning-strip.html`);
    console.log(`[TuftsWeather Overlays] Winter banner URL: ${baseUrl}/overlays/winter-banner.html`);
    console.log(`[TuftsWeather Overlays] Winter counter URL: ${baseUrl}/overlays/winter-alert-counter.html`);
    console.log(`[TuftsWeather Overlays] Winter outline URL: ${baseUrl}/overlays/winter-outline.html`);
    console.log(`[TuftsWeather Overlays] Winter popup URL: ${baseUrl}/overlays/winter-popup-alerts.html`);
    console.log(`[TuftsWeather Overlays] Winter strip URL: ${baseUrl}/overlays/winter-active-strip.html`);
    console.log(`[TuftsWeather Overlays] SPC outlook map URL: ${baseUrl}/overlays/spc-outlook-map.html`);
    console.log(`[TuftsWeather Overlays] Warned cams URL: ${baseUrl}/widgets/warnedcams`);
    console.log(`[TuftsWeather Overlays] Tropical cams URL: ${baseUrl}/widgets/warnedcams-tropical`);
    console.log(`[TuftsWeather Overlays] Winter cams URL: ${baseUrl}/widgets/warnedcams-winter`);
    console.log(`[TuftsWeather Overlays] WebSocket: ws://${runtimeConfig.server.host}:${runtimeConfig.server.port}/stream`);
    console.log(`[TuftsWeather Overlays] Config: ${configPath}`);
    startLocalhostShortcutServer();

    parser = new Manager(parserSettings);
    bindParserEvents(parser);
    void refreshFromApi('startup');
    scheduleBackfill();
  });
}

function stopServer() {
  if (backfillTimer) {
    clearInterval(backfillTimer);
  }

  localhostRedirectServer.close(() => {});

  if (!parser) {
    server.close(() => process.exit(0));
    return;
  }

  void parser.stop().finally(() => {
    server.close(() => process.exit(0));
  });
}

process.on('SIGINT', stopServer);
process.on('SIGTERM', stopServer);

void start();
