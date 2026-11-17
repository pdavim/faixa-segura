import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import {
  Check,
  CloudOff,
  Download,
  Eraser,
  FileText,
  HardDriveDownload,
  Layers,
  LocateFixed,
  MapPin,
  Minus,
  MousePointerClick,
  PenTool,
  Plus,
  PlusCircle,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Wifi,
  Zap,
} from 'lucide-react';
import type {
  ActiveFireIncident,
  LandClass,
  LatLon,
  LatLonMultiPolygon,
  MunicipalityInfo,
  ParcelOrthophotoCvAnalysis,
  ParcelRecord,
  ParcelVectorContext,
  SpatialZoneBreakdown,
  StormAlertIncident,
} from '../types/domain.ts';
import {
  buildParcelGeoJsonFilename,
  buildParcelLegalDecompositionGeoJson,
  buildParcelLegalGeoJsonFilename,
  buildParcelVerticesGeoJson,
  computeParcelFgc,
  computeParcelLeafletBounds,
  computePolygonMetrics3763,
  haversineDistanceKm,
} from '../lib/spatialEngine.ts';
import { synthesizeDeterministicCadastreContext } from '../lib/vectorContextIngestor.ts';
import {
  computeParcelCvRasterGrid,
  fuseCvDetectionsIntoVectorContext,
  runOrthophotoPixelPipeline,
  synthesizeDeterministicParcelOrthophotoRgba,
} from '../lib/orthophotoCvPipeline.ts';
import {
  buildLocalParcelRecord,
  extractCadernetaOffline,
} from '../lib/offlineParcelBuilder.ts';
import {
  appendPolygonVertex,
  clearAllPolygonVertices,
  removePolygonVertexAt,
  updatePolygonVertexAt,
} from '../lib/userWorkspaceStore.ts';
import {
  addAssistedBuildingToParcel,
  addAssistedEasementToParcel,
  addAssistedExemptZoneToParcel,
  buildRectangularFootprintAtWgs84,
  mergePreservingUserDefinedContext,
  overrideCvCrownStatus,
  removeAssistedVectorElement,
  resetParcelToAutomaticContext,
  reviewCvRoofDetection,
  toggleAssistedBuildingRole,
  updateAssistedEasementWidth,
  type AssistedSubTool,
  type BuildingDrawStyle,
  type EasementPresetCode,
  type ExemptPresetCode,
} from '../lib/assistedMapEditor.ts';
import { AssistedHitlPanel } from './AssistedHitlPanel.tsx';
import {
  buildOfflineFallbackTileSvgDataUrl,
  buildTileUrl,
  formatByteSizePt,
  getSharedOfflineTileCacheManager,
  resolveTileTemplateUrl,
  type MapTileStyle,
  type OfflineParcelMapSnapshot,
  type OfflineTileCacheManager,
  type OfflineTileCacheStats,
  type SnapshotDownloadProgress,
  type TileServeSource,
} from '../lib/offlineTileCache.ts';
import { useOnlineStatus } from '../hooks/usePWAInstall.ts';

class OfflineAwareLeafletTileLayer extends L.TileLayer {
  private readonly tileStyle: MapTileStyle;
  private readonly tileCacheManager: OfflineTileCacheManager;
  private readonly getActiveParcelId: () => string;
  private readonly onTileServed?: (source: TileServeSource) => void;

  constructor(params: {
    style: MapTileStyle;
    maxZoom: number;
    tileCacheManager: OfflineTileCacheManager;
    getActiveParcelId: () => string;
    onTileServed?: (source: TileServeSource) => void;
  }) {
    const templateUrl = resolveTileTemplateUrl(params.style);

    super(templateUrl, {
      maxZoom: params.maxZoom,
      attribution:
        params.style === 'ORTHOPHOTO'
          ? 'Ortofoto Aérea / Satélite · Cache Offline EPSG:3763'
          : 'Cartografia Topográfica & Vetorial OSM · Cache Offline',
    });

    this.tileStyle = params.style;
    this.tileCacheManager = params.tileCacheManager;
    this.getActiveParcelId = params.getActiveParcelId;
    this.onTileServed = params.onTileServed;
  }

  // Exact 2 arguments (coords, done) so Leaflet GridLayer awaits async completion
  protected override createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const img = document.createElement('img');
    img.alt = '';
    img.setAttribute('role', 'presentation');
    img.decoding = 'async';

    const style = this.tileStyle;
    const maxTileIndex = Math.pow(2, coords.z);
    const normX = ((coords.x % maxTileIndex) + maxTileIndex) % maxTileIndex;
    const normY = coords.y;

    const applyFallbackSvg = () => {
      img.onload = () => {
        this.onTileServed?.('FALLBACK_SVG');
        done(undefined, img);
      };
      img.onerror = () => {
        done(undefined, img);
      };
      img.src = buildOfflineFallbackTileSvgDataUrl(style, coords.z, normX, normY);
    };

    if (normY < 0 || normY >= maxTileIndex) {
      applyFallbackSvg();
      return img;
    }

    void this.tileCacheManager
      .getOrFetchTile({
        style,
        z: coords.z,
        x: normX,
        y: normY,
        parcelId: this.getActiveParcelId(),
      })
      .then((lookup) => {
        if (!lookup) {
          applyFallbackSvg();
          return;
        }

        const blob = new Blob([lookup.data], { type: lookup.mimeType });
        const objectUrl = URL.createObjectURL(blob);
        img.setAttribute('data-tile-source', lookup.source);
        img.setAttribute('data-tile-url', buildTileUrl(style, coords.z, normX, normY));

        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          this.onTileServed?.(lookup.source);
          done(undefined, img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(objectUrl);
          applyFallbackSvg();
        };
        img.src = objectUrl;
      })
      .catch(() => {
        applyFallbackSvg();
      });

    return img;
  }
}

function createOfflineAwareLeafletTileLayer(params: {
  style: MapTileStyle;
  maxZoom: number;
  tileCacheManager: OfflineTileCacheManager;
  getActiveParcelId: () => string;
  onTileServed?: (source: TileServeSource) => void;
}): L.TileLayer {
  return new OfflineAwareLeafletTileLayer(params);
}

interface MapZonesViewProps {
  parcels: ParcelRecord[];
  activeParcel: ParcelRecord;
  municipalities: MunicipalityInfo[];
  fires: ActiveFireIncident[];
  storms?: StormAlertIncident[];
  proximityAlertRadiusKm?: number;
  onSelectParcel: (parcelId: string) => void;
  onCreateParcel: (newParcel: ParcelRecord) => void;
  onUpdateParcel?: (updatedParcel: ParcelRecord) => void;
  onNavigateTab: (tab: 'today' | 'map' | 'certify' | 'providers' | 'docs', subMode?: string) => void;
}

export const MapZonesView: React.FC<MapZonesViewProps> = ({
  parcels,
  activeParcel,
  municipalities,
  fires,
  storms = [],
  proximityAlertRadiusKm = 15,
  onSelectParcel,
  onCreateParcel,
  onUpdateParcel,
  onNavigateTab,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const overlaysGroupRef = useRef<L.LayerGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);

  const [baseMapStyle, setBaseMapStyle] = useState<'ORTHOPHOTO' | 'VECTOR'>('ORTHOPHOTO');
  const [mapToolMode, setMapToolMode] = useState<'INSPECT' | 'ASSISTED' | 'DRAW' | 'CADERNETA'>(
    'INSPECT'
  );
  const [visibleLayers, setVisibleLayers] = useState({
    zones675: true,
    eredes: true,
    exempt: true,
    neighborRisk: true,
    detectedContext: true,
    orthophotoCv: true,
    hazardPerimeter: true,
  });

  // Drawing custom polygon state
  const [drawnVertices, setDrawnVertices] = useState<LatLon[]>([]);
  const [drawVertexActionMode, setDrawVertexActionMode] = useState<'ADD_EDIT' | 'DELETE_VERTEX'>(
    'ADD_EDIT'
  );
  const [newParcelLabel, setNewParcelLabel] = useState('');
  const [newParcelDico, setNewParcelDico] = useState(activeParcel.dico);
  const [newParcelLandClass, setNewParcelLandClass] = useState<LandClass>('FOREST_SCRUB');
  const [newParcelEredes, setNewParcelEredes] = useState(true);
  const [savingParcel, setSavingParcel] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);

  // Caderneta Predial extraction, live vector context detection, Orthophoto 25cm CV & GIS export state
  const [cadernetaText, setCadernetaText] = useState('');
  const [extractingCaderneta, setExtractingCaderneta] = useState(false);
  const [detectingContext, setDetectingContext] = useState(false);
  const [runningOrthophotoCv, setRunningOrthophotoCv] = useState(false);
  const [vectorStatusNotice, setVectorStatusNotice] = useState<{
    parcelId: string;
    summary: string;
    detectedAtTime: string;
  } | null>(null);
  const [cvStatusNotice, setCvStatusNotice] = useState<{
    parcelId: string;
    summary: string;
    analyzedAtTime: string;
  } | null>(null);
  const [lookingUpCadastre, setLookingUpCadastre] = useState(false);
  const [cadastreLookupNotice, setCadastreLookupNotice] = useState<string | null>(null);
  const [calculatingSlope, setCalculatingSlope] = useState(false);
  const [slopeStatusNotice, setSlopeStatusNotice] = useState<{
    parcelId: string;
    summary: string;
  } | null>(null);
  const [selectedZoneCallout, setSelectedZoneCallout] = useState<string | null>(null);
  const [exportedGeoJsonNotice, setExportedGeoJsonNotice] = useState<{
    parcelId: string;
    filename: string;
    detailLabel: string;
    exportedAtTime: string;
  } | null>(null);

  // Phase 3: Assisted Map Editing (Human-in-the-Loop) state
  const [assistedSubTool, setAssistedSubTool] = useState<AssistedSubTool>('REVIEW');
  const [assistedBldgStyle, setAssistedBldgStyle] = useState<BuildingDrawStyle>('STAMP_1CLICK');
  const [assistedBldgLabel, setAssistedBldgLabel] = useState('');
  const [assistedEasementPreset, setAssistedEasementPreset] =
    useState<EasementPresetCode>('EREDES_MT');
  const [assistedEasementWidthM, setAssistedEasementWidthM] = useState<number>(4.25);
  const [assistedExemptPreset, setAssistedExemptPreset] =
    useState<ExemptPresetCode>('RIPARIAN_WATERWAY');
  const [assistedExemptWidthM, setAssistedExemptWidthM] = useState<number>(5);
  const [assistedDraftPoints, setAssistedDraftPoints] = useState<LatLon[]>([]);
  const [assistedSelectedId, setAssistedSelectedId] = useState<string | null>(null);
  const [assistedFeedback, setAssistedFeedback] = useState<string | null>(null);
  const [assistedUndoStack, setAssistedUndoStack] = useState<ParcelRecord[]>([]);

  const commitAssistedParcelMutation = useCallback(
    (nextParcel: ParcelRecord, feedbackPt: string) => {
      setAssistedUndoStack((prev) => [activeParcel, ...prev].slice(0, 10));
      onUpdateParcel?.(nextParcel);
      setAssistedFeedback(feedbackPt);
      setVisibleLayers((prev) => ({
        ...prev,
        zones675: true,
        eredes: true,
        exempt: true,
        detectedContext: true,
      }));
    },
    [activeParcel, onUpdateParcel]
  );

  const handleLookupOfficialDgtCadastre = async () => {
    setLookingUpCadastre(true);
    setCadastreLookupNotice(null);
    setDrawError(null);
    try {
      const center = mapInstanceRef.current?.getCenter();
      const targetPoint: LatLon = center
        ? { lat: Number(center.lat.toFixed(6)), lon: Number(center.lng.toFixed(6)) }
        : activeParcel.spatial.centroidWgs84;
      const resp = await fetch('/api/spatial/official-cadastre', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPoint }),
      });
      if (!resp.ok) {
        setCadastreLookupNotice('Serviço OGC da DGT temporariamente indisponível.');
        return;
      }
      const data = (await resp.json()) as {
        found?: boolean;
        match?: {
          cadastralReference: string;
          areaM2: number;
          vertices: LatLon[];
          sourceLabel: string;
        } | null;
        fallbackNotePt?: string;
      };
      if (data.found && data.match && Array.isArray(data.match.vertices) && data.match.vertices.length >= 3) {
        setDrawnVertices(data.match.vertices);
        setNewParcelLabel(`Prédio DGT ${data.match.cadastralReference}`);
        setMapToolMode('DRAW');
        setCadastreLookupNotice(
          `Polígono oficial ${data.match.cadastralReference} (${data.match.areaM2.toFixed(0)} m²) carregado para validação.`
        );
      } else {
        setCadastreLookupNotice(
          data.fallbackNotePt ||
            'Sem geometria cadastral oficial publicada pela DGT neste ponto (concelho sem cadastro geométrico aberto).'
        );
      }
    } catch {
      setCadastreLookupNotice('Sem ligação ao endpoint de cadastro oficial DGT.');
    } finally {
      setLookingUpCadastre(false);
    }
  };

  const handleRefreshElevationSlope = async () => {
    setCalculatingSlope(true);
    try {
      const resp = await fetch('/api/spatial/elevation-slope', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parcelId: activeParcel.id,
          vertices: activeParcel.vertices,
        }),
      });
      if (resp.ok) {
        const data = (await resp.json()) as {
          avgSlopePct?: number;
          elevationMeta?: ParcelRecord['elevationMeta'];
        };
        if (typeof data.avgSlopePct === 'number' && data.elevationMeta) {
          onUpdateParcel?.({
            ...activeParcel,
            avgSlopePct: data.avgSlopePct,
            elevationMeta: data.elevationMeta,
          });
          setSlopeStatusNotice({
            parcelId: activeParcel.id,
            summary: `Declive MDT ${data.avgSlopePct}% · Alt. ${data.elevationMeta.minElevationM}–${data.elevationMeta.maxElevationM} m (desnível ${data.elevationMeta.reliefM} m) · ${data.elevationMeta.aspectLabelPt}`,
          });
        }
      }
    } catch {
      setSlopeStatusNotice({
        parcelId: activeParcel.id,
        summary: `Declive ${activeParcel.avgSlopePct}% mantido localmente.`,
      });
    } finally {
      setCalculatingSlope(false);
    }
  };

  const commitAssistedMutationRef = useRef(commitAssistedParcelMutation);
  commitAssistedMutationRef.current = commitAssistedParcelMutation;

  const activeParcelObjRef = useRef(activeParcel);
  activeParcelObjRef.current = activeParcel;

  const assistedSubToolRef = useRef(assistedSubTool);
  assistedSubToolRef.current = assistedSubTool;

  const assistedBldgStyleRef = useRef(assistedBldgStyle);
  assistedBldgStyleRef.current = assistedBldgStyle;

  const assistedBldgLabelRef = useRef(assistedBldgLabel);
  assistedBldgLabelRef.current = assistedBldgLabel;

  const mapToolModeRef = useRef(mapToolMode);
  mapToolModeRef.current = mapToolMode;

  const drawVertexActionModeRef = useRef(drawVertexActionMode);
  drawVertexActionModeRef.current = drawVertexActionMode;

  useEffect(() => {
    if (drawnVertices.length === 0 && drawVertexActionMode === 'DELETE_VERTEX') {
      setDrawVertexActionMode('ADD_EDIT');
    }
  }, [drawnVertices.length, drawVertexActionMode]);

  const handleDeleteDrawnVertexAt = useCallback((indexToRemove: number) => {
    setDrawError(null);
    setDrawnVertices((prev) => removePolygonVertexAt(prev, indexToRemove));
  }, []);

  const handleClearAllDrawnVertices = useCallback(() => {
    setDrawError(null);
    setDrawnVertices(clearAllPolygonVertices());
    setDrawVertexActionMode('ADD_EDIT');
  }, []);

  const activeParcelIdRef = useRef(activeParcel.id);
  activeParcelIdRef.current = activeParcel.id;

  const isOnline = useOnlineStatus();
  const tileCacheManagerRef = useRef<OfflineTileCacheManager>(getSharedOfflineTileCacheManager());
  const statsRefreshTimerRef = useRef<number | null>(null);

  const [savedSnapshots, setSavedSnapshots] = useState<OfflineParcelMapSnapshot[]>([]);
  const [cacheStats, setCacheStats] = useState<OfflineTileCacheStats>({
    tileCount: 0,
    totalBytes: 0,
    snapshotCount: 0,
  });
  const [downloadProgress, setDownloadProgress] = useState<SnapshotDownloadProgress | null>(null);
  const [cacheFeedback, setCacheFeedback] = useState<string | null>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [offlineCacheHits, setOfflineCacheHits] = useState(0);

  const refreshCacheOverview = useCallback(async () => {
    const manager = tileCacheManagerRef.current;
    const [snaps, stats] = await Promise.all([manager.listSnapshots(), manager.getStats()]);
    setSavedSnapshots(snaps);
    setCacheStats(stats);
  }, []);

  const scheduleStatsRefresh = useCallback(() => {
    if (statsRefreshTimerRef.current !== null) return;
    statsRefreshTimerRef.current = window.setTimeout(() => {
      statsRefreshTimerRef.current = null;
      void refreshCacheOverview();
    }, 550);
  }, [refreshCacheOverview]);

  useEffect(() => {
    void refreshCacheOverview();
    return () => {
      if (statsRefreshTimerRef.current !== null) {
        window.clearTimeout(statsRefreshTimerRef.current);
      }
    };
  }, [refreshCacheOverview]);

  const handleTileServed = useCallback(
    (source: TileServeSource) => {
      if (source === 'CACHE') {
        setOfflineCacheHits((prev) => prev + 1);
      } else if (source === 'NETWORK') {
        scheduleStatsRefresh();
      }
    },
    [scheduleStatsRefresh]
  );

  const handleTileServedRef = useRef(handleTileServed);
  handleTileServedRef.current = handleTileServed;

  const [leafletControlsHost, setLeafletControlsHost] = useState<HTMLElement | null>(null);
  const [currentZoom, setCurrentZoom] = useState<number>(18);
  const MIN_MAP_ZOOM = 6;
  const MAX_MAP_ZOOM = 19;

  // Initialize Leaflet Map once with custom branded mobile-first controls
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const initialBounds = computeParcelLeafletBounds(activeParcel);
    const map = L.map(mapContainerRef.current, {
      center: [initialBounds.center.lat, initialBounds.center.lon],
      zoom: 18,
      minZoom: MIN_MAP_ZOOM,
      maxZoom: MAX_MAP_ZOOM,
      zoomControl: false,
    });

    const initialTileLayer = createOfflineAwareLeafletTileLayer({
      style: 'ORTHOPHOTO',
      maxZoom: MAX_MAP_ZOOM,
      tileCacheManager: tileCacheManagerRef.current,
      getActiveParcelId: () => activeParcelIdRef.current,
      onTileServed: (src) => handleTileServedRef.current(src),
    }).addTo(map);

    tileLayerRef.current = initialTileLayer;
    overlaysGroupRef.current = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;

    map.fitBounds(initialBounds.leafletBounds, {
      padding: [36, 36],
      maxZoom: 18,
      animate: false,
    });
    setCurrentZoom(map.getZoom());

    // Mount propagation-isolated custom control host directly inside .leaflet-container
    const controlsHost = L.DomUtil.create(
      'div',
      'leaflet-faixasegura-controls absolute right-3 bottom-7 z-[1000] pointer-events-auto'
    );
    L.DomEvent.disableClickPropagation(controlsHost);
    L.DomEvent.disableScrollPropagation(controlsHost);
    map.getContainer().appendChild(controlsHost);
    setLeafletControlsHost(controlsHost);

    map.on('zoomend', () => {
      setCurrentZoom(map.getZoom());
    });

    map.on('click', (ev: L.LeafletMouseEvent) => {
      if (
        mapToolModeRef.current === 'DRAW' &&
        drawVertexActionModeRef.current !== 'DELETE_VERTEX'
      ) {
        setDrawError(null);
        setDrawnVertices((prev) =>
          appendPolygonVertex(prev, {
            lat: ev.latlng.lat,
            lon: ev.latlng.lng,
          })
        );
        return;
      }

      if (mapToolModeRef.current === 'ASSISTED') {
        const sub = assistedSubToolRef.current;
        const clickPt: LatLon = {
          lat: Number(ev.latlng.lat.toFixed(6)),
          lon: Number(ev.latlng.lng.toFixed(6)),
        };

        if (
          (sub === 'OWN_BUILDING' || sub === 'NEIGHBOR_BUILDING') &&
          assistedBldgStyleRef.current === 'STAMP_1CLICK'
        ) {
          const role = sub === 'OWN_BUILDING' ? 'OWN' : 'NEIGHBOR';
          const rect = buildRectangularFootprintAtWgs84(clickPt, 8.5, 6.5);
          const nextParcel = addAssistedBuildingToParcel(activeParcelObjRef.current, {
            footprint: rect,
            role,
            label: assistedBldgLabelRef.current.trim() || undefined,
          });
          setAssistedBldgLabel('');
          commitAssistedMutationRef.current(
            nextParcel,
            role === 'OWN'
              ? 'Anexo / edificação própria adicionada e faixas 0–2–10–50 m recalculadas em EPSG:3763.'
              : 'Edifício vizinho adicionado e obrigação confinante recalculada em EPSG:3763.'
          );
          return;
        }

        if (sub !== 'REVIEW') {
          setAssistedDraftPoints((prev) => appendPolygonVertex(prev, clickPt));
        }
      }
    });

    return () => {
      setLeafletControlsHost(null);
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Switch tile layer (Orthophoto vs Vector) using CacheFirst offline-aware tile layer
  const isInitialStyleRenderRef = useRef(true);
  useEffect(() => {
    if (isInitialStyleRenderRef.current) {
      isInitialStyleRenderRef.current = false;
      return;
    }
    const map = mapInstanceRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }

    tileLayerRef.current = createOfflineAwareLeafletTileLayer({
      style: baseMapStyle,
      maxZoom: MAX_MAP_ZOOM,
      tileCacheManager: tileCacheManagerRef.current,
      getActiveParcelId: () => activeParcelIdRef.current,
      onTileServed: (src) => handleTileServedRef.current(src),
    }).addTo(map);
  }, [baseMapStyle]);

  const handleCenterOnActiveParcel = useCallback((animate = true) => {
    const map = mapInstanceRef.current;
    if (!map) return;
    const bounds = computeParcelLeafletBounds(activeParcelObjRef.current);
    map.fitBounds(bounds.leafletBounds, {
      padding: [36, 36],
      maxZoom: 18,
      animate,
    });
    setCurrentZoom(map.getZoom());
  }, []);

  const handleZoomIn = useCallback(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    map.zoomIn(1);
  }, []);

  const handleZoomOut = useCallback(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    map.zoomOut(1);
  }, []);

  // Fit active parcel bounds when activeParcel changes
  useEffect(() => {
    handleCenterOnActiveParcel(false);
    setSelectedZoneCallout(null);
    setAssistedDraftPoints([]);
    setAssistedSelectedId(null);
    setAssistedFeedback(null);
    setAssistedUndoStack([]);
  }, [activeParcel.id, handleCenterOnActiveParcel]);

  // Render boolean MultiPolygons (with true interior holes) + detected external vector context on map
  useEffect(() => {
    const group = overlaysGroupRef.current;
    if (!group) return;
    group.clearLayers();

    const sp = activeParcel.spatial;
    const mp = sp.multiPolygons;
    const meta = sp.decompositionMeta;
    const outerRadiusM = meta?.outerBufferRadiusM ?? 50;
    const allowOverlayClick =
      mapToolMode === 'INSPECT' || (mapToolMode === 'ASSISTED' && assistedSubTool === 'REVIEW');
    const toLatLngs = (pts: LatLon[]): L.LatLngExpression[] => pts.map((p) => [p.lat, p.lon]);
    const toMultiPolyLatLngs = (
      multi: LatLonMultiPolygon | undefined,
      fallback?: LatLon[]
    ): L.LatLngExpression[][][] => {
      if (multi && multi.length > 0) {
        return multi
          .map((poly) =>
            poly
              .filter((ring) => ring.length >= 3)
              .map((ring) => ring.map((p) => [p.lat, p.lon] as [number, number]))
          )
          .filter((poly) => poly.length > 0);
      }
      if (fallback && fallback.length >= 3) {
        return [[fallback.map((p) => [p.lat, p.lon] as [number, number])]];
      }
      return [];
    };

    // 0. Phase 2 Orthophoto 25 cm Semantic Raster Mask (underneath crisp vector boundaries)
    if (visibleLayers.orthophotoCv && activeParcel.cvAnalysis?.overlayDataUrl) {
      L.imageOverlay(
        activeParcel.cvAnalysis.overlayDataUrl,
        activeParcel.cvAnalysis.leafletBounds,
        {
          opacity: 0.54,
          interactive: false,
        }
      ).addTo(group);
    }

    // 1. Exempt Zones: General Exempt Core (#4ADE80) + Riparian/Agricultural Protected Sub-layer (#10B981)
    if (visibleLayers.exempt) {
      const exemptCoords = toMultiPolyLatLngs(mp?.exemptCore, sp.polygons.exemptCore);
      if (exemptCoords.length > 0 && sp.exemptAreaM2 > 0) {
        L.polygon(exemptCoords, {
          color: '#4ADE80',
          weight: 1.5,
          fillColor: '#4ADE80',
          fillOpacity: 0.16,
          interactive: allowOverlayClick,
        })
          .bindTooltip(
            `Zona Isenta (${sp.exemptAreaM2.toFixed(0)} m² · Ripícola/Agrícola: ${(meta?.riparianProtectedM2 ?? 0).toFixed(0)} m²)`,
            { sticky: true }
          )
          .on('click', () =>
            setSelectedZoneCallout(
              `Zona Isenta (${sp.exemptAreaM2.toFixed(0)} m²): Fora das faixas obrigatórias ou protegida por galeria ripícola / regime agrícola (${(meta?.riparianProtectedM2 ?? 0).toFixed(0)} m²).`
            )
          )
          .addTo(group);
      }

      const riparianCoords = toMultiPolyLatLngs(mp?.riparianAndAgriExempt);
      if (riparianCoords.length > 0 && (meta?.riparianProtectedM2 ?? 0) > 0) {
        L.polygon(riparianCoords, {
          color: '#10B981',
          weight: 2,
          dashArray: '4, 3',
          fillColor: '#10B981',
          fillOpacity: 0.24,
          interactive: allowOverlayClick,
        })
          .bindTooltip(
            `Galeria Ripícola / Solo Agrícola Protegido: ${(meta?.riparianProtectedM2 ?? 0).toFixed(0)} m² (Isenção DL 82/2021)`,
            { sticky: true }
          )
          .on('click', () =>
            setSelectedZoneCallout(
              `Galeria Ripícola / Solo Agrícola Protegido (${(meta?.riparianProtectedM2 ?? 0).toFixed(0)} m²): Vegetação ripícola junto a linha de água protegida contra corte raso (Art.º 49.º DL 82/2021).`
            )
          )
          .addTo(group);
      }
    }

    // 2. Despacho 675/2026 Boolean Ring Zones (Z3 Amber -> Z2 Orange -> Z1 Crimson + Neighbor-Induced Slice)
    if (visibleLayers.zones675) {
      const z3Coords = toMultiPolyLatLngs(mp?.zone3Extended, sp.polygons.zone3Extended);
      if (z3Coords.length > 0 && sp.zone3ExtendedM2 > 0) {
        L.polygon(z3Coords, {
          color: '#F59E0B',
          weight: 2,
          fillColor: '#F59E0B',
          fillOpacity: 0.24,
          interactive: allowOverlayClick,
        })
          .bindTooltip(
            `Zona 3 Alargada (10–${outerRadiusM}m): ${sp.zone3ExtendedM2.toFixed(0)} m²`,
            { sticky: true }
          )
          .on('click', () =>
            setSelectedZoneCallout(
              `Zona 3 Alargada (10–${outerRadiusM} m · ${sp.zone3ExtendedM2.toFixed(0)} m²): Mato rasteiro (<20 cm) e copas afastadas 4 m (10 m pinheiro/eucalipto).`
            )
          )
          .addTo(group);
      }

      const z2Coords = toMultiPolyLatLngs(mp?.zone2Near, sp.polygons.zone2Near);
      if (z2Coords.length > 0 && sp.zone2NearM2 > 0) {
        L.polygon(z2Coords, {
          color: '#EA580C',
          weight: 2,
          fillColor: '#EA580C',
          fillOpacity: 0.32,
          interactive: allowOverlayClick,
        })
          .bindTooltip(`Zona 2 Próxima (2–10m): ${sp.zone2NearM2.toFixed(0)} m²`, { sticky: true })
          .on('click', () =>
            setSelectedZoneCallout(
              `Zona 2 Interface Próxima (2–10 m · ${sp.zone2NearM2.toFixed(0)} m²): Desramação a 50% / mín. 4m e zero copas a menos de 5m da parede.`
            )
          )
          .addTo(group);
      }

      const z1Coords = toMultiPolyLatLngs(mp?.zone1Immediate, sp.polygons.zone1Immediate);
      if (z1Coords.length > 0 && sp.zone1ImmediateM2 > 0) {
        L.polygon(z1Coords, {
          color: '#E11D48',
          weight: 2.5,
          fillColor: '#E11D48',
          fillOpacity: 0.42,
          interactive: allowOverlayClick,
        })
          .bindTooltip(`Zona 1 Faixa Inerte (0–2m): ${sp.zone1ImmediateM2.toFixed(0)} m²`, { sticky: true })
          .on('click', () =>
            setSelectedZoneCallout(
              `Zona 1 Interface Imediata (0–2 m · ${sp.zone1ImmediateM2.toFixed(0)} m²): Faixa inerte obrigatória (brita, lajeado ou solo mineral nu).`
            )
          )
          .addTo(group);
      }

      const nbInducedCoords = toMultiPolyLatLngs(mp?.neighborInducedObligation);
      if (nbInducedCoords.length > 0 && (meta?.neighborInducedCleanAreaM2 ?? 0) > 0) {
        L.polygon(nbInducedCoords, {
          color: '#FB7185',
          weight: 2,
          dashArray: '5, 4',
          fillColor: '#FB7185',
          fillOpacity: 0.14,
          interactive: allowOverlayClick,
        })
          .bindTooltip(
            `Obrigação Induzida por Edifício Vizinho: ${(meta?.neighborInducedCleanAreaM2 ?? 0).toFixed(0)} m² dentro desta parcela`,
            { sticky: true }
          )
          .on('click', () =>
            setSelectedZoneCallout(
              `Obrigação Induzida por Vizinho (${(meta?.neighborInducedCleanAreaM2 ?? 0).toFixed(0)} m²): Área no interior do seu lote abrangida pelo raio legal de 50 m de habitação confinante externa.`
            )
          )
          .addTo(group);
      }
    }

    // 3. Third-Party Easements: E-REDES / REN + Public Road Corridors (#06B6D4)
    const easementCoords = toMultiPolyLatLngs(
      mp?.thirdPartyCorridor,
      sp.polygons.thirdPartyCorridor
    );
    if (visibleLayers.eredes && easementCoords.length > 0 && sp.thirdPartyEasementM2 > 0) {
      L.polygon(easementCoords, {
        color: '#06B6D4',
        weight: 2.5,
        fillColor: '#06B6D4',
        fillOpacity: 0.32,
        interactive: allowOverlayClick,
      })
        .bindTooltip(
          `Servidões de Terceiros: ${sp.thirdPartyEasementM2.toFixed(0)} m² (E-REDES ${(meta?.eredesEasementM2 ?? 0).toFixed(0)} m² · Rede Viária ${(meta?.roadEasementM2 ?? 0).toFixed(0)} m²)`,
          { sticky: true }
        )
        .on('click', () =>
          setSelectedZoneCallout(
            `Servidões de Terceiros (${sp.thirdPartyEasementM2.toFixed(0)} m²): E-REDES ${(meta?.eredesEasementM2 ?? 0).toFixed(0)} m² + Faixa Viária ${(meta?.roadEasementM2 ?? 0).toFixed(0)} m² — gestão da responsabilidade da entidade gestora (Art.º 49.º DL 82/2021, poupança ~${sp.estimatedEredesSavingsEur.toFixed(0)} €).`
          )
        )
        .addTo(group);
    }

    // 4. Neighbor Risk Overflow Crescent (#A855F7)
    const neighborOverflowCoords = toMultiPolyLatLngs(
      mp?.neighborRiskOverflow,
      sp.polygons.neighborRiskParcel
    );
    if (visibleLayers.neighborRisk && neighborOverflowCoords.length > 0) {
      L.polygon(neighborOverflowCoords, {
        color: '#A855F7',
        weight: 2.5,
        dashArray: '5, 5',
        fillColor: '#A855F7',
        fillOpacity: 0.32,
        interactive: allowOverlayClick,
      })
        .bindTooltip(
          `Transbordo da Faixa de 50 m em Terreno Confinante (${(meta?.neighborOverflowRiskM2 ?? 0).toFixed(0)} m² · Fachada a ${sp.neighborMinDistanceM.toFixed(1)} m · NDVI ${activeParcel.neighborInfo.ndvi})`,
          { sticky: true }
        )
        .on('click', () =>
          setSelectedZoneCallout(
            `ALERTA VIZINHO: Coroa de 50 m da sua habitação transborda ${(meta?.neighborOverflowRiskM2 ?? 0).toFixed(0)} m² para terreno confinante (${sp.neighborDirection}, parede a ${sp.neighborMinDistanceM.toFixed(1)} m). Pode emitir Requerimento GTF.`
          )
        )
        .addTo(group);
    }

    // 5. Detected External Vector Context (Neighbor Buildings, Powerline/Road Centerlines, Waterways, Orchards)
    if (visibleLayers.detectedContext && activeParcel.vectorContext) {
      for (const bldg of activeParcel.vectorContext.buildings) {
        if (bldg.footprint.length < 3) continue;
        if (bldg.role === 'NEIGHBOR') {
          const isUserDef = bldg.source === 'USER_DEFINED';
          L.polygon(toLatLngs(bldg.footprint), {
            color: isUserDef ? '#7E22CE' : '#9333EA',
            weight: assistedSelectedId === bldg.id ? 3.5 : 2,
            fillColor: '#C084FC',
            fillOpacity: 0.78,
            interactive: allowOverlayClick,
          })
            .bindTooltip(
              `${bldg.label} · ${bldg.areaM2.toFixed(0)} m² (a ${bldg.distanceToParcelEdgeM.toFixed(1)} m da estrema)`,
              { sticky: true }
            )
            .on('click', () => {
              setAssistedSelectedId(bldg.id);
              setSelectedZoneCallout(
                `${bldg.label}: Edifício externo a ${bldg.distanceToParcelEdgeM.toFixed(1)} m do limite da parcela — projeta faixa obrigatória sobre o seu terreno.`
              );
            })
            .addTo(group);
        }
      }

      for (const eas of activeParcel.vectorContext.easements) {
        if (eas.centerline.length < 2) continue;
        const isPower = eas.category === 'EREDES_MT_AT' || eas.category === 'REN_MAT';
        L.polyline(toLatLngs(eas.centerline), {
          color: isPower ? '#06B6D4' : '#64748B',
          weight: assistedSelectedId === eas.id ? 4.5 : isPower ? 3 : 2.5,
          dashArray: eas.source === 'USER_DEFINED' ? undefined : isPower ? '8, 4' : '4, 4',
          interactive: allowOverlayClick,
        })
          .bindTooltip(`${eas.label} · ${eas.operatorLabel} (±${eas.bufferHalfWidthM} m)`, {
            sticky: true,
          })
          .on('click', () => {
            setAssistedSelectedId(eas.id);
            setSelectedZoneCallout(
              `${eas.label} (±${eas.bufferHalfWidthM} m · ${eas.operatorLabel}): Faixa linear subtraída à sua área obrigatória de limpeza.`
            );
          })
          .addTo(group);
      }

      for (const ex of activeParcel.vectorContext.exemptFeatures) {
        if (ex.centerline && ex.centerline.length >= 2) {
          L.polyline(toLatLngs(ex.centerline), {
            color: '#10B981',
            weight: assistedSelectedId === ex.id ? 4 : 2.5,
            dashArray: ex.source === 'USER_DEFINED' ? undefined : '3, 5',
            interactive: allowOverlayClick,
          })
            .bindTooltip(`${ex.label} · ${ex.legalBasis}`, { sticky: true })
            .on('click', () => {
              setAssistedSelectedId(ex.id);
              setSelectedZoneCallout(`${ex.label}: ${ex.legalBasis}`);
            })
            .addTo(group);
        } else if (ex.polygon && ex.polygon.length >= 3) {
          L.polygon(toLatLngs(ex.polygon), {
            color: '#059669',
            weight: assistedSelectedId === ex.id ? 3 : 2,
            fillColor: '#10B981',
            fillOpacity: 0.28,
            interactive: allowOverlayClick,
          })
            .bindTooltip(`${ex.label} · ${ex.legalBasis}`, { sticky: true })
            .on('click', () => {
              setAssistedSelectedId(ex.id);
              setSelectedZoneCallout(`${ex.label}: ${ex.legalBasis}`);
            })
            .addTo(group);
        }
      }
    }

    // 6. Own Building footprints (Crisp White, individually clickable when present in vectorContext)
    const ownVectorBldgs = (activeParcel.vectorContext?.buildings ?? []).filter(
      (b) => b.role === 'OWN' && b.footprint.length >= 3
    );
    if (ownVectorBldgs.length > 0) {
      for (const bldg of ownVectorBldgs) {
        L.polygon(toLatLngs(bldg.footprint), {
          color: bldg.source === 'USER_DEFINED' ? '#14532D' : '#0F172A',
          weight: assistedSelectedId === bldg.id ? 3 : 2,
          fillColor: '#FFFFFF',
          fillOpacity: 0.94,
          interactive: allowOverlayClick,
        })
          .bindTooltip(`${bldg.label} (${bldg.areaM2.toFixed(0)} m²)`, { sticky: true })
          .on('click', () => {
            setAssistedSelectedId(bldg.id);
            setSelectedZoneCallout(
              `${bldg.label} (${bldg.areaM2.toFixed(0)} m²): Edificação própria na parcela que gera as faixas concêntricas 0–2 m, 2–10 m e 10–50 m.`
            );
          })
          .addTo(group);
      }
    } else {
      const ownBldgCoords = toMultiPolyLatLngs(mp?.ownBuildings, sp.polygons.buildingFootprint);
      if (ownBldgCoords.length > 0) {
        L.polygon(ownBldgCoords, {
          color: '#0F172A',
          weight: 1.5,
          fillColor: '#FFFFFF',
          fillOpacity: 0.92,
          interactive: allowOverlayClick,
        })
          .bindTooltip(
            `Edificação Própria na Parcela (${(meta?.ownBuildingsAreaM2 ?? 102).toFixed(0)} m²)`,
            { sticky: true }
          )
          .addTo(group);
      }
    }

    // 6B. Phase 2 & Phase 3 CV Detections: Individual Tree Crowns & Unmapped Roofs/Annexes
    if (visibleLayers.orthophotoCv && activeParcel.cvAnalysis) {
      for (const roof of activeParcel.cvAnalysis.detectedRoofs) {
        if (
          !roof.isUnmappedInOsm ||
          roof.reviewStatus === 'DISMISSED' ||
          roof.reviewStatus === 'ACCEPTED' ||
          roof.footprintWgs84.length < 3
        ) {
          continue;
        }
        L.polygon(toLatLngs(roof.footprintWgs84), {
          color: '#F43F5E',
          weight: assistedSelectedId === roof.id ? 3.5 : 2.5,
          dashArray: '4, 3',
          fillColor: '#F43F5E',
          fillOpacity: 0.52,
          interactive: allowOverlayClick,
        })
          .bindTooltip(
            `${roof.label} · ${roof.areaM2.toFixed(1)} m² (Confiança ${Math.round(roof.confidence * 100)}%)`,
            { sticky: true }
          )
          .on('click', () => {
            setAssistedSelectedId(roof.id);
            setSelectedZoneCallout(
              `${roof.label} (${roof.areaM2.toFixed(1)} m²): Cobertura detetada em ortofoto 25 cm não constante no OSM/Cadastro. Pode validá-la ou descartá-la em Edição Assistida.`
            );
          })
          .addTo(group);
      }

      for (const crown of activeParcel.cvAnalysis.crowns) {
        if (crown.polygonWgs84.length < 3) continue;
        const isProtectedOak = crown.humanOverride === 'PROTECTED_QUERCUS';
        const isViolating = crown.violationRulePt !== null;
        const strokeColor = isProtectedOak
          ? '#D97706'
          : isViolating
            ? '#DC2626'
            : '#15803D';
        const fillColor = isProtectedOak
          ? '#F59E0B'
          : isViolating
            ? '#EF4444'
            : '#22C55E';
        L.polygon(toLatLngs(crown.polygonWgs84), {
          color: strokeColor,
          weight: assistedSelectedId === crown.id ? 3 : isViolating || isProtectedOak ? 2 : 1.5,
          dashArray: isViolating ? '3, 3' : undefined,
          fillColor,
          fillOpacity: isViolating ? 0.34 : isProtectedOak ? 0.32 : 0.2,
          interactive: allowOverlayClick,
        })
          .bindTooltip(
            `Copa Ø ${crown.diameterM.toFixed(1)} m (${
              isProtectedOak
                ? 'Sobreiro/Azinheira Protegida ICNF'
                : crown.speciesGroup === 'RESINOUS_EUCALYPT'
                  ? 'Pinheiro/Eucalipto'
                  : 'Folhosa/Quercínea'
            }) · Parede: ${crown.distanceToBuildingWallM.toFixed(1)} m · Copa vizinha: ${crown.nearestCrownDistanceM.toFixed(1)} m${isViolating ? ` · ${crown.violationRulePt}` : ' · Conforme'}`,
            { sticky: true }
          )
          .on('click', () => {
            setAssistedSelectedId(crown.id);
            setSelectedZoneCallout(
              `Copa Individual ${crown.id} (Ø ${crown.diameterM.toFixed(1)} m · ${crown.areaM2.toFixed(1)} m²): A ${crown.distanceToBuildingWallM.toFixed(1)} m da fachada — ${
                isProtectedOak
                  ? 'Marcada como Quercínea Protegida (DL 169/2001)'
                  : crown.violationRulePt ?? 'Cumpre Despacho n.º 675/2026'
              }.`
            );
          })
          .addTo(group);
      }
    }

    // 7. User Parcel Boundary (#FACC15 Laser Yellow Dashed)
    L.polygon(toLatLngs(sp.polygons.parcel), {
      color: '#FACC15',
      weight: 3,
      dashArray: '8, 6',
      fillColor: '#FACC15',
      fillOpacity: 0.05,
      interactive: false,
    }).addTo(group);

    // 7. Drawn vertices preview (draggable + individually deletable) when in DRAW mode
    if (drawnVertices.length > 0) {
      if (drawnVertices.length >= 3) {
        L.polygon(toLatLngs(drawnVertices), {
          color: '#38BDF8',
          weight: 2.5,
          fillColor: '#38BDF8',
          fillOpacity: 0.25,
        }).addTo(group);
      } else if (drawnVertices.length === 2) {
        L.polyline(toLatLngs(drawnVertices), {
          color: '#38BDF8',
          weight: 2.5,
          dashArray: '6 4',
        }).addTo(group);
      }

      const isDeleteMode = drawVertexActionMode === 'DELETE_VERTEX';
      drawnVertices.forEach((pt, idx) => {
        const badgeClasses = isDeleteMode
          ? 'w-7 h-7 rounded-full bg-[#DC2626] border-2 border-white text-white text-[10px] font-mono font-bold flex items-center justify-center shadow-md cursor-pointer'
          : 'w-6 h-6 rounded-full bg-[#FACC15] border-2 border-[#0F172A] text-slate-950 text-[10px] font-mono font-bold flex items-center justify-center shadow-md cursor-grab';
        const sizePx = isDeleteMode ? 28 : 24;
        const anchorPx = sizePx / 2;

        const marker = L.marker([pt.lat, pt.lon], {
          draggable: !isDeleteMode,
          icon: L.divIcon({
            className: 'fs-draw-vertex-handle bg-transparent border-0',
            html: `<div data-testid="map-draw-vertex-marker-${idx}" class="${badgeClasses}">${
              isDeleteMode ? `V${idx + 1}×` : `V${idx + 1}`
            }</div>`,
            iconSize: [sizePx, sizePx],
            iconAnchor: [anchorPx, anchorPx],
          }),
          title: isDeleteMode
            ? `Clique para apagar vértice V${idx + 1}`
            : `Vértice V${idx + 1} (${pt.lat.toFixed(6)}, ${pt.lon.toFixed(6)}) · Arraste para mover`,
        });

        marker.on('click', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          if (drawVertexActionModeRef.current === 'DELETE_VERTEX') {
            handleDeleteDrawnVertexAt(idx);
          }
        });

        marker.on('contextmenu', (ev: L.LeafletMouseEvent) => {
          L.DomEvent.stopPropagation(ev);
          handleDeleteDrawnVertexAt(idx);
        });

        marker.on('dragend', () => {
          const pos = marker.getLatLng();
          setDrawError(null);
          setDrawnVertices((prev) =>
            updatePolygonVertexAt(prev, idx, {
              lat: pos.lat,
              lon: pos.lng,
            })
          );
        });

        marker.addTo(group);
      });
    }

    // 7B. Assisted HITL multi-point draft preview (draggable handles)
    if (mapToolMode === 'ASSISTED' && assistedDraftPoints.length > 0) {
      const isLineDraft =
        assistedSubTool === 'EASEMENT_LINE' ||
        (assistedSubTool === 'EXEMPT_ZONE' && assistedExemptPreset === 'RIPARIAN_WATERWAY');

      if (isLineDraft && assistedDraftPoints.length >= 2) {
        L.polyline(toLatLngs(assistedDraftPoints), {
          color: assistedSubTool === 'EASEMENT_LINE' ? '#06B6D4' : '#10B981',
          weight: 3.5,
          dashArray: '6, 4',
        }).addTo(group);
      } else if (!isLineDraft && assistedDraftPoints.length >= 3) {
        L.polygon(toLatLngs(assistedDraftPoints), {
          color: '#22C55E',
          weight: 2.5,
          fillColor: '#22C55E',
          fillOpacity: 0.26,
        }).addTo(group);
      } else if (assistedDraftPoints.length === 2) {
        L.polyline(toLatLngs(assistedDraftPoints), {
          color: '#22C55E',
          weight: 2.5,
          dashArray: '5, 4',
        }).addTo(group);
      }

      assistedDraftPoints.forEach((pt, idx) => {
        const marker = L.marker([pt.lat, pt.lon], {
          draggable: true,
          icon: L.divIcon({
            className: 'fs-hitl-draft-handle bg-transparent border-0',
            html: `<div data-testid="hitl-draft-marker-${idx}" class="w-6 h-6 rounded-full bg-[#22C55E] border-2 border-[#0F172A] text-slate-950 text-[10px] font-mono font-bold flex items-center justify-center shadow-md cursor-grab">P${idx + 1}</div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          }),
        });
        marker.on('dragend', () => {
          const pos = marker.getLatLng();
          setAssistedDraftPoints((prev) =>
            updatePolygonVertexAt(prev, idx, { lat: pos.lat, lon: pos.lng })
          );
        });
        marker.addTo(group);
      });
    }

    // 8. Proximity Surveillance Ring + Active ANEPC Fires & IPMA Storm Cells
    if (visibleLayers.hazardPerimeter) {
      L.circle([sp.centroidWgs84.lat, sp.centroidWgs84.lon], {
        radius: proximityAlertRadiusKm * 1000,
        color: '#22C55E',
        weight: 1.5,
        dashArray: '6, 6',
        fillColor: '#22C55E',
        fillOpacity: 0.03,
        interactive: false,
      }).addTo(group);

      storms.forEach((st) => {
        const stormColor =
          st.severity === 'RED'
            ? '#DC2626'
            : st.severity === 'ORANGE'
              ? '#D97706'
              : '#0284C7';
        const distKm = haversineDistanceKm(sp.centroidWgs84, { lat: st.lat, lon: st.lon });

        L.circle([st.lat, st.lon], {
          radius: st.radiusKm * 1000,
          color: stormColor,
          weight: 2,
          dashArray: '6, 4',
          fillColor: stormColor,
          fillOpacity: 0.12,
        })
          .bindTooltip(
            `Tempestade / Aviso Meteorológico: ${st.title} · Rajadas ${st.maxWindKmh} km/h (${distKm.toFixed(1)} km)`,
            { sticky: true }
          )
          .on('click', () =>
            setSelectedZoneCallout(
              `ALERTA TEMPESTADE (${st.municipality}): ${st.title} — Vento até ${st.maxWindKmh} km/h, precipitação ${st.precipitationMmH} mm/h (${st.validUntil}).`
            )
          )
          .addTo(group);

        L.circleMarker([st.lat, st.lon], {
          radius: 7,
          color: '#FFFFFF',
          weight: 2,
          fillColor: stormColor,
          fillOpacity: 0.95,
        })
          .bindTooltip(
            `Centro de Tempestade (${st.municipality}): ${distKm.toFixed(1)} km · ${st.maxWindKmh} km/h`,
            { sticky: true }
          )
          .addTo(group);
      });

      fires.forEach((f) => {
        L.circleMarker([f.lat, f.lon], {
          radius: 8,
          color: '#FFFFFF',
          weight: 2,
          fillColor: '#DC2626',
          fillOpacity: 0.95,
        })
          .bindTooltip(`Fogo Ativo ANEPC: ${f.municipality} (${f.distanceKm.toFixed(1)} km)`, {
            sticky: true,
          })
          .on('click', () =>
            setSelectedZoneCallout(
              `OCORRÊNCIA ANEPC (${f.municipality} · ${f.parish}): Incêndio em ${f.nature} (${f.status}) a ${f.distanceKm.toFixed(1)} km deste terreno (${f.operatives} operacionais).`
            )
          )
          .addTo(group);
      });
    }
  }, [
    activeParcel,
    visibleLayers,
    drawnVertices,
    drawVertexActionMode,
    handleDeleteDrawnVertexAt,
    mapToolMode,
    assistedSubTool,
    assistedExemptPreset,
    assistedDraftPoints,
    assistedSelectedId,
    fires,
    storms,
    proximityAlertRadiusKm,
  ]);

  const drawnMetrics = computePolygonMetrics3763(drawnVertices);

  const handleSaveDrawnParcel = async (e: React.FormEvent) => {
    e.preventDefault();
    setDrawError(null);
    if (!newParcelLabel.trim()) {
      setDrawError('Indique um nome identificador para o terreno (ex.: Pinhal Avô Mafra).');
      return;
    }
    if (drawnVertices.length < 3) {
      setDrawError('Toque em pelo menos 3 cantos no mapa para fechar o polígono do lote.');
      return;
    }

    setSavingParcel(true);
    try {
      let createdParcel: ParcelRecord | null = null;
      const isBrowserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;

      if (isBrowserOnline) {
        try {
          const res = await fetch('/api/parcels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              label: newParcelLabel.trim(),
              dico: newParcelDico,
              vertices: drawnVertices,
              landClass: newParcelLandClass,
              hasEredesLine: newParcelEredes,
            }),
          });
          const data = await res.json();
          if (!res.ok) {
            setDrawError(data.error || 'Erro ao guardar terreno.');
            return;
          }
          createdParcel = data as ParcelRecord;
        } catch {
          // Network unreachable — fall back to deterministic client-side EPSG:3763 engine
        }
      }

      if (!createdParcel) {
        createdParcel = buildLocalParcelRecord({
          label: newParcelLabel.trim(),
          dico: newParcelDico,
          vertices: drawnVertices,
          landClass: newParcelLandClass,
          hasEredesLine: newParcelEredes,
          municipalities,
        });
      }

      onCreateParcel(createdParcel);
      setDrawnVertices([]);
      setNewParcelLabel('');
      setMapToolMode('INSPECT');
    } finally {
      setSavingParcel(false);
    }
  };

  const handleExtractCaderneta = async (sampleText?: string) => {
    const rawText = (sampleText ?? cadernetaText).trim();
    if (!rawText) {
      setDrawError('Cole os dados da Caderneta Predial ou carregue um exemplo oficial.');
      return;
    }
    setDrawError(null);
    setExtractingCaderneta(true);
    try {
      let createdParcel: ParcelRecord | null = null;
      const isBrowserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;

      if (isBrowserOnline) {
        try {
          const res = await fetch('/api/ai/caderneta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rawText }),
          });
          if (res.ok) {
            const extracted = await res.json();
            const createRes = await fetch('/api/parcels', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                label: extracted.suggestedLabel,
                dico: extracted.dico,
                matrixArticle: extracted.matrixArticle,
                hasProtectedOaks: extracted.hasProtectedOaks,
                vertices: extracted.vertices,
                landClass: 'FOREST_SCRUB',
                hasEredesLine: true,
              }),
            });
            if (createRes.ok) {
              createdParcel = (await createRes.json()) as ParcelRecord;
            }
          }
        } catch {
          // Network unreachable — fall back to offline Caderneta parser + EPSG:3763 engine
        }
      }

      if (!createdParcel) {
        const offlineExtracted = extractCadernetaOffline(rawText, municipalities);
        createdParcel = buildLocalParcelRecord({
          label: offlineExtracted.suggestedLabel,
          dico: offlineExtracted.dico,
          matrixArticle: offlineExtracted.matrixArticle,
          hasProtectedOaks: offlineExtracted.hasProtectedOaks,
          vertices: offlineExtracted.vertices,
          landClass: 'FOREST_SCRUB',
          hasEredesLine: true,
          municipalities,
        });
      }

      onCreateParcel(createdParcel);
      setCadernetaText('');
      setMapToolMode('INSPECT');
    } finally {
      setExtractingCaderneta(false);
    }
  };

  const activeVertexCount =
    activeParcel.vertices.length >= 3
      ? activeParcel.vertices.length
      : activeParcel.spatial.polygons.parcel.length;

  const handleDetectVectorContext = async () => {
    if (detectingContext) return;
    setDetectingContext(true);
    try {
      let nextVectorContext: ParcelVectorContext | null = null;
      let nextSpatial: SpatialZoneBreakdown | null = null;

      const isBrowserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (isBrowserOnline) {
        try {
          const res = await fetch('/api/spatial/vector-context', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parcelId: activeParcel.id,
              vertices: activeParcel.vertices,
              buildingCenter: activeParcel.buildingCenter,
              landClass: activeParcel.landClass,
              hasEredesLine: activeParcel.hasEredesLine,
              eredesType: activeParcel.eredesType,
              hasProtectedOaks: activeParcel.hasProtectedOaks,
              existingContext: activeParcel.vectorContext,
              forceRefresh: true,
            }),
          });
          if (res.ok) {
            const payload = (await res.json()) as {
              vectorContext?: ParcelVectorContext;
              spatial?: SpatialZoneBreakdown;
            };
            if (payload.vectorContext && payload.spatial) {
              nextVectorContext = payload.vectorContext;
              nextSpatial = payload.spatial;
            }
          }
        } catch {
          // Offline or transient network error — compute deterministic cadastral context locally
        }
      }

      if (!nextVectorContext || !nextSpatial) {
        const autoSynth = synthesizeDeterministicCadastreContext({
          parcelVertices: activeParcel.vertices,
          buildingCenter: activeParcel.buildingCenter,
          hasEredesLine: activeParcel.hasEredesLine,
          eredesType: activeParcel.eredesType,
          hasProtectedOaks: activeParcel.hasProtectedOaks,
        });
        nextVectorContext = mergePreservingUserDefinedContext(
          autoSynth,
          activeParcel.vectorContext
        );
        nextSpatial = computeParcelFgc({
          vertices: activeParcel.vertices,
          buildingCenter: activeParcel.buildingCenter,
          landClass: activeParcel.landClass,
          hasEredesLine: activeParcel.hasEredesLine,
          eredesType: activeParcel.eredesType,
          vectorContext: nextVectorContext,
        });
      }

      const updatedParcel: ParcelRecord = {
        ...activeParcel,
        vectorContext: nextVectorContext,
        spatial: nextSpatial,
      };
      onUpdateParcel?.(updatedParcel);
      setVisibleLayers((prev) => ({ ...prev, detectedContext: true }));
      setVectorStatusNotice({
        parcelId: activeParcel.id,
        summary: nextVectorContext.sourceSummaryPt,
        detectedAtTime: new Date().toISOString().slice(11, 19) + ' UTC',
      });
    } finally {
      setDetectingContext(false);
    }
  };

  const handleRunOrthophotoCv = async () => {
    if (runningOrthophotoCv) return;
    setRunningOrthophotoCv(true);
    try {
      let nextCv: ParcelOrthophotoCvAnalysis | null = null;
      let nextVectorContext: ParcelVectorContext | undefined = activeParcel.vectorContext;
      let nextSpatial: SpatialZoneBreakdown = activeParcel.spatial;

      const isBrowserOnline = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (isBrowserOnline) {
        try {
          const res = await fetch('/api/spatial/orthophoto-cv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              parcelId: activeParcel.id,
              vertices: activeParcel.vertices,
              buildingCenter: activeParcel.buildingCenter,
              landClass: activeParcel.landClass,
              hasEredesLine: activeParcel.hasEredesLine,
              eredesType: activeParcel.eredesType,
              vectorContext: activeParcel.vectorContext,
              forceRefresh: true,
            }),
          });
          if (res.ok) {
            const payload = (await res.json()) as {
              cvAnalysis?: ParcelOrthophotoCvAnalysis;
              vectorContext?: ParcelVectorContext;
              spatial?: SpatialZoneBreakdown;
            };
            if (payload.cvAnalysis) {
              nextCv = payload.cvAnalysis;
              if (payload.vectorContext) nextVectorContext = payload.vectorContext;
              if (payload.spatial) nextSpatial = payload.spatial;
            }
          }
        } catch {
          // Offline or transient error — fall back to local isomorphic pixel CV pipeline
        }
      }

      if (!nextCv) {
        const localCtx =
          nextVectorContext ??
          synthesizeDeterministicCadastreContext({
            parcelVertices: activeParcel.vertices,
            buildingCenter: activeParcel.buildingCenter,
            hasEredesLine: activeParcel.hasEredesLine,
            eredesType: activeParcel.eredesType,
            hasProtectedOaks: activeParcel.hasProtectedOaks,
          });
        nextVectorContext = localCtx;
        const grid = computeParcelCvRasterGrid(activeParcel.vertices, 28, 224);
        const synthRgba = synthesizeDeterministicParcelOrthophotoRgba({
          grid,
          parcelVertices: activeParcel.vertices,
          landClass: activeParcel.landClass,
          spatial: nextSpatial,
          vectorContext: localCtx,
        });
        const localOut = runOrthophotoPixelPipeline({
          rgba: synthRgba,
          grid,
          parcelVertices: activeParcel.vertices,
          landClass: activeParcel.landClass,
          spatial: nextSpatial,
          vectorContext: localCtx,
          imagerySourceLabel: 'Ortofoto Sintética Georreferenciada EPSG:3763 (Offline)',
          engineMode: 'OFFLINE_SYNTHETIC_CV',
        });
        nextCv = localOut.analysis;
      }

      const updatedParcel: ParcelRecord = {
        ...activeParcel,
        vectorContext: nextVectorContext,
        cvAnalysis: nextCv,
        spatial: nextSpatial,
      };
      onUpdateParcel?.(updatedParcel);
      setVisibleLayers((prev) => ({ ...prev, orthophotoCv: true }));
      setCvStatusNotice({
        parcelId: activeParcel.id,
        summary: `${nextCv.imagerySourceLabel} · ${nextCv.crowns.length} copas · GSD ${nextCv.gsdMetersPerPx.toFixed(2)} m/px`,
        analyzedAtTime: new Date().toISOString().slice(11, 19) + ' UTC',
      });
    } finally {
      setRunningOrthophotoCv(false);
    }
  };

  const handleFuseCvIntoBoolean = () => {
    if (!activeParcel.cvAnalysis) return;
    const baseCtx =
      activeParcel.vectorContext ??
      synthesizeDeterministicCadastreContext({
        parcelVertices: activeParcel.vertices,
        buildingCenter: activeParcel.buildingCenter,
        hasEredesLine: activeParcel.hasEredesLine,
        eredesType: activeParcel.eredesType,
        hasProtectedOaks: activeParcel.hasProtectedOaks,
      });

    const fused = fuseCvDetectionsIntoVectorContext({
      existingContext: baseCtx,
      cvAnalysis: activeParcel.cvAnalysis,
      parcelVertices: activeParcel.vertices,
    });

    const recomputedSpatial = computeParcelFgc({
      vertices: activeParcel.vertices,
      buildingCenter: activeParcel.buildingCenter,
      landClass: activeParcel.landClass,
      hasEredesLine: activeParcel.hasEredesLine,
      eredesType: activeParcel.eredesType,
      vectorContext: fused.vectorContext,
    });

    const updatedAuditSummary = activeParcel.cvAnalysis.zoneCompliance.auditSummaryPt.replace(
      /\s*·\s*\d+\s*anexo\(s\)\/edifício\(s\)\s*omisso\(s\)\s*no\s*OSM/i,
      fused.addedBuildingsCount > 0
        ? ` · ${fused.addedBuildingsCount} anexo(s) CV fundido(s) nas faixas`
        : ''
    );

    const updatedCv: ParcelOrthophotoCvAnalysis = {
      ...activeParcel.cvAnalysis,
      unmappedRoofsCount: 0,
      fusedIntoVectorContext: true,
      detectedRoofs: activeParcel.cvAnalysis.detectedRoofs.map((r) => ({
        ...r,
        isUnmappedInOsm: false,
      })),
      zoneCompliance: {
        ...activeParcel.cvAnalysis.zoneCompliance,
        auditSummaryPt: updatedAuditSummary,
      },
    };

    const updatedParcel: ParcelRecord = {
      ...activeParcel,
      vectorContext: fused.vectorContext,
      cvAnalysis: updatedCv,
      spatial: recomputedSpatial,
    };
    onUpdateParcel?.(updatedParcel);
    setVisibleLayers((prev) => ({ ...prev, zones675: true, detectedContext: true }));
    setCvStatusNotice({
      parcelId: activeParcel.id,
      summary:
        fused.addedBuildingsCount > 0
          ? `${fused.addedBuildingsCount} estrutura(s) CV fundida(s) na álgebra booleana EPSG:3763`
          : ' Geometria CV já sincronizada com as faixas booleanas EPSG:3763',
      analyzedAtTime: new Date().toISOString().slice(11, 19) + ' UTC',
    });
  };

  const handleCommitAssistedDraft = () => {
    if (assistedSubTool === 'OWN_BUILDING' || assistedSubTool === 'NEIGHBOR_BUILDING') {
      if (assistedDraftPoints.length < 3) return;
      const role = assistedSubTool === 'OWN_BUILDING' ? 'OWN' : 'NEIGHBOR';
      const next = addAssistedBuildingToParcel(activeParcel, {
        footprint: assistedDraftPoints,
        role,
        label: assistedBldgLabel.trim() || undefined,
      });
      setAssistedDraftPoints([]);
      setAssistedBldgLabel('');
      commitAssistedParcelMutation(
        next,
        role === 'OWN'
          ? 'Polígono de edificação própria guardado e faixas recalculadas em EPSG:3763.'
          : 'Polígono de edifício vizinho guardado e obrigação confinante recalculada.'
      );
      return;
    }

    if (assistedSubTool === 'EASEMENT_LINE') {
      if (assistedDraftPoints.length < 2) return;
      const next = addAssistedEasementToParcel(activeParcel, {
        centerline: assistedDraftPoints,
        preset: assistedEasementPreset,
        bufferHalfWidthM: assistedEasementWidthM,
      });
      setAssistedDraftPoints([]);
      commitAssistedParcelMutation(
        next,
        `Servidão linear (±${assistedEasementWidthM} m) subtraída às faixas obrigatórias em EPSG:3763.`
      );
      return;
    }

    if (assistedSubTool === 'EXEMPT_ZONE') {
      const next = addAssistedExemptZoneToParcel(activeParcel, {
        points: assistedDraftPoints,
        preset: assistedExemptPreset,
        bufferHalfWidthM: assistedExemptWidthM,
      });
      if (next === activeParcel) return;
      setAssistedDraftPoints([]);
      commitAssistedParcelMutation(
        next,
        assistedExemptPreset === 'RIPARIAN_WATERWAY'
          ? `Galeria ripícola (±${assistedExemptWidthM} m) protegida e recalculada em EPSG:3763.`
          : 'Polígono agrícola regado classificado como zona isenta em EPSG:3763.'
      );
    }
  };

  const handleUndoAssistedEdit = () => {
    if (assistedUndoStack.length === 0) return;
    const [previousSnapshot, ...rest] = assistedUndoStack;
    setAssistedUndoStack(rest);
    onUpdateParcel?.(previousSnapshot);
    setAssistedFeedback('Última edição assistida anulada e geometria EPSG:3763 restaurada.');
  };

  const handleResetAssistedToAuto = () => {
    const next = resetParcelToAutomaticContext(activeParcel);
    commitAssistedParcelMutation(
      next,
      'Edições manuais removidas — contexto vetorial e CV repostos para a base automática.'
    );
  };

  const handleExportParcelGeoJson = () => {
    const exportedAtIso = new Date().toISOString();
    const geoJsonContent = buildParcelVerticesGeoJson(activeParcel, exportedAtIso);
    const filename = buildParcelGeoJsonFilename(activeParcel);

    const blob = new Blob([geoJsonContent], {
      type: 'application/geo+json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    setExportedGeoJsonNotice({
      parcelId: activeParcel.id,
      filename,
      detailLabel: `${activeVertexCount} vértices`,
      exportedAtTime: exportedAtIso.slice(11, 19) + ' UTC',
    });
  };

  const handleExportLegalLayersGeoJson = () => {
    const exportedAtIso = new Date().toISOString();
    const geoJsonContent = buildParcelLegalDecompositionGeoJson(activeParcel, exportedAtIso);
    const filename = buildParcelLegalGeoJsonFilename(activeParcel);
    const parsedCount = (() => {
      try {
        const parsed = JSON.parse(geoJsonContent) as { features?: unknown[] };
        return Array.isArray(parsed.features) ? parsed.features.length : 10;
      } catch {
        return 10;
      }
    })();

    const blob = new Blob([geoJsonContent], {
      type: 'application/geo+json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    setExportedGeoJsonNotice({
      parcelId: activeParcel.id,
      filename,
      detailLabel: `${parsedCount} camadas booleanas MultiPolygon`,
      exportedAtTime: exportedAtIso.slice(11, 19) + ' UTC',
    });
  };

  const activeParcelSnapshot =
    savedSnapshots.find((snap) => snap.parcelId === activeParcel.id) ?? null;
  const isDownloadingSnapshot = downloadProgress !== null;

  const handleDownloadOfflineSnapshot = async () => {
    if (isDownloadingSnapshot) return;
    setCacheError(null);
    setCacheFeedback(null);

    if (!isOnline) {
      setCacheError(
        'Sem ligação à internet. Pré-descarregue o snapshot antes de entrar numa zona sem cobertura.'
      );
      return;
    }

    try {
      const snapshot = await tileCacheManagerRef.current.downloadParcelSnapshot(
        activeParcel,
        (prog) => setDownloadProgress(prog)
      );
      await refreshCacheOverview();
      tileLayerRef.current?.redraw();
      setCacheFeedback(
        `Snapshot guardado: ${snapshot.tileCount} mosaicos (Ortofoto + Vetorial · Z${Math.min(...snapshot.zoomLevels)}–Z${Math.max(...snapshot.zoomLevels)} · ${formatByteSizePt(snapshot.totalBytes)}) disponíveis sem internet.`
      );
    } catch (err) {
      setCacheError(
        err instanceof Error
          ? err.message
          : 'Não foi possível guardar o snapshot offline da parcela.'
      );
    } finally {
      setDownloadProgress(null);
    }
  };

  const handleSelectSavedSnapshot = (snapshot: OfflineParcelMapSnapshot) => {
    setCacheError(null);
    onSelectParcel(snapshot.parcelId);
    const map = mapInstanceRef.current;
    if (map) {
      map.fitBounds(snapshot.bounds.leafletBounds, {
        padding: [36, 36],
        maxZoom: 18,
        animate: true,
      });
      setCurrentZoom(map.getZoom());
    }
  };

  const handleDeleteSnapshot = async (parcelId: string, parcelLabel: string) => {
    setCacheError(null);
    await tileCacheManagerRef.current.deleteParcelSnapshot(parcelId);
    await refreshCacheOverview();
    setCacheFeedback(`Snapshot offline removido para ${parcelLabel}.`);
  };

  const handleClearAllTileCache = async () => {
    setCacheError(null);
    await tileCacheManagerRef.current.clearAll();
    setOfflineCacheHits(0);
    await refreshCacheOverview();
    setCacheFeedback('Cache cartográfica offline limpa deste dispositivo.');
  };

  return (
    <div className="space-y-5">
      {/* Top Mode Bar */}
      <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4 flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
            Raio-X Cartográfico EPSG:3763 · Despacho n.º 675/2026
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums">
            {activeParcel.bupiRggId} · {activeParcel.matrixArticle} · Centroide PT-TM06 X:{activeParcel.spatial.centroidPtTm06.x}m Y:{activeParcel.spatial.centroidPtTm06.y}m
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full md:w-auto">
          <div
            role="group"
            aria-label="Modo de interação cartográfica"
            className="grid grid-cols-2 sm:inline-flex items-center gap-1 p-1 w-full sm:w-auto rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
          >
            <button
              type="button"
              data-testid="map-mode-inspect-btn"
              onClick={() => setMapToolMode('INSPECT')}
              className={`min-h-[40px] px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                mapToolMode === 'INSPECT'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              <MapPin className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">BUPi / Zonas</span>
              <span className="sm:hidden">Zonas</span>
            </button>
            <button
              type="button"
              data-testid="map-mode-assisted-btn"
              onClick={() => setMapToolMode('ASSISTED')}
              className={`min-h-[40px] px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                mapToolMode === 'ASSISTED'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              <MousePointerClick className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Edição Assistida</span>
              <span className="sm:hidden">Assistida</span>
            </button>
            <button
              type="button"
              data-testid="map-mode-draw-btn"
              onClick={() => setMapToolMode('DRAW')}
              className={`min-h-[40px] px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                mapToolMode === 'DRAW'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              <PenTool className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Desenhar Lote</span>
              <span className="sm:hidden">Desenhar</span>
            </button>
            <button
              type="button"
              data-testid="map-mode-caderneta-btn"
              onClick={() => setMapToolMode('CADERNETA')}
              className={`min-h-[40px] px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                mapToolMode === 'CADERNETA'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              <FileText className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="hidden sm:inline">Caderneta AT</span>
              <span className="sm:hidden">Caderneta</span>
            </button>
          </div>

          <div
            role="group"
            aria-label="Fundo cartográfico"
            className="grid grid-cols-2 sm:inline-flex items-center gap-1 p-1 w-full sm:w-auto rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
          >
            <button
              type="button"
              data-testid="basemap-orthophoto-btn"
              aria-pressed={baseMapStyle === 'ORTHOPHOTO'}
              onClick={() => setBaseMapStyle('ORTHOPHOTO')}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                baseMapStyle === 'ORTHOPHOTO'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
              }`}
            >
              <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Ortofoto</span>
            </button>
            <button
              type="button"
              data-testid="basemap-vector-btn"
              aria-pressed={baseMapStyle === 'VECTOR'}
              onClick={() => setBaseMapStyle('VECTOR')}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 ${
                baseMapStyle === 'VECTOR'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
              }`}
            >
              <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span>Topográfico</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Split Grid: Map Canvas + Zone Audit Inspector */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-start">
        {/* Interactive Map Column */}
        <div className="md:col-span-7 space-y-3">
          <div className="rounded-2xl overflow-hidden border-2 border-slate-300 dark:border-[#263248] bg-[#1c2e22] relative">
            <div
              ref={mapContainerRef}
              data-testid="faixasegura-leaflet-map"
              data-zoom={currentZoom}
              className={`w-full h-[360px] sm:h-[420px] z-0 ${
                mapToolMode === 'DRAW' || (mapToolMode === 'ASSISTED' && assistedSubTool !== 'REVIEW')
                  ? 'cursor-crosshair'
                  : ''
              }`}
            />
            {leafletControlsHost &&
              createPortal(
                <div
                  role="group"
                  aria-label="Controlos de zoom e enquadramento da parcela"
                  data-testid="custom-leaflet-controls"
                  className="flex flex-col items-end gap-2 select-none"
                >
                  <div className="flex flex-col rounded-2xl overflow-hidden bg-white/95 dark:bg-[#161E2E]/95 backdrop-blur-md border-2 border-[#14532D]/35 dark:border-[#22C55E]/45 shadow-lg divide-y divide-slate-200 dark:divide-[#263248]">
                    <button
                      type="button"
                      data-testid="leaflet-zoom-in-btn"
                      onClick={handleZoomIn}
                      disabled={currentZoom >= MAX_MAP_ZOOM}
                      aria-label="Aumentar zoom do mapa"
                      title="Aumentar zoom"
                      className="min-h-[46px] min-w-[46px] flex items-center justify-center text-[#14532D] dark:text-[#22C55E] hover:bg-[#14532D]/10 dark:hover:bg-[#22C55E]/15 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#14532D] dark:focus-visible:ring-[#22C55E]"
                    >
                      <Plus className="w-5 h-5 stroke-[2.5]" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      data-testid="leaflet-zoom-out-btn"
                      onClick={handleZoomOut}
                      disabled={currentZoom <= MIN_MAP_ZOOM}
                      aria-label="Diminuir zoom do mapa"
                      title="Diminuir zoom"
                      className="min-h-[46px] min-w-[46px] flex items-center justify-center text-[#14532D] dark:text-[#22C55E] hover:bg-[#14532D]/10 dark:hover:bg-[#22C55E]/15 active:scale-95 transition disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#14532D] dark:focus-visible:ring-[#22C55E]"
                    >
                      <Minus className="w-5 h-5 stroke-[2.5]" aria-hidden="true" />
                    </button>
                  </div>

                  <button
                    type="button"
                    data-testid="leaflet-center-parcel-btn"
                    onClick={() => handleCenterOnActiveParcel(true)}
                    aria-label={`Centrar mapa nos limites de ${activeParcel.label}`}
                    title={`Enquadrar limites de ${activeParcel.label}`}
                    className="min-h-[46px] min-w-[46px] px-3.5 py-2 rounded-2xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 border-2 border-[#FACC15] dark:border-[#0B0F17] shadow-lg inline-flex items-center justify-center gap-1.5 text-xs font-bold whitespace-nowrap active:scale-95 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FACC15]"
                  >
                    <LocateFixed className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>Centrar Lote</span>
                  </button>
                </div>,
                leafletControlsHost
              )}
          </div>

          {/* Layer Visibility Toggles (Solar high-contrast) */}
          <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-3 flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-400 mr-0.5 whitespace-nowrap">
              Camadas:
            </span>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, zones675: !v.zones675 }))}
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                visibleLayers.zones675
                  ? 'border-[#E11D48] bg-[#E11D48]/10 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#E11D48] shrink-0" aria-hidden="true" />
              Faixas 0–2–10–50m
            </button>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, eredes: !v.eredes }))}
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                visibleLayers.eredes
                  ? 'border-[#06B6D4] bg-[#06B6D4]/10 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#06B6D4] shrink-0" aria-hidden="true" />
              Servidão E-REDES
            </button>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, exempt: !v.exempt }))}
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                visibleLayers.exempt
                  ? 'border-[#16A34A] bg-[#4ADE80]/15 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#4ADE80] shrink-0" aria-hidden="true" />
              Zona Isenta
            </button>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, neighborRisk: !v.neighborRisk }))}
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                visibleLayers.neighborRisk
                  ? 'border-[#A855F7] bg-[#A855F7]/15 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#A855F7] shrink-0" aria-hidden="true" />
              Vizinho em Risco
            </button>
            <button
              type="button"
              data-testid="layer-toggle-detected-context"
              onClick={() =>
                setVisibleLayers((v) => ({ ...v, detectedContext: !v.detectedContext }))
              }
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                visibleLayers.detectedContext
                  ? 'border-[#9333EA] bg-[#C084FC]/15 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#C084FC] shrink-0" aria-hidden="true" />
              Elementos Detetados
            </button>
            <button
              type="button"
              data-testid="layer-toggle-orthophoto-cv"
              onClick={() =>
                setVisibleLayers((v) => ({ ...v, orthophotoCv: !v.orthophotoCv }))
              }
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                visibleLayers.orthophotoCv
                  ? 'border-[#15803D] bg-[#15803D]/15 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#15803D] shrink-0" aria-hidden="true" />
              Segmentação CV 25 cm
            </button>
            <button
              type="button"
              data-testid="layer-toggle-hazard-perimeter"
              onClick={() =>
                setVisibleLayers((v) => ({ ...v, hazardPerimeter: !v.hazardPerimeter }))
              }
              className={`min-h-[40px] px-2.5 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 tabular-nums ${
                visibleLayers.hazardPerimeter
                  ? 'border-[#DC2626] bg-[#DC2626]/10 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-full bg-[#DC2626] shrink-0" aria-hidden="true" />
              Incêndios & Tempestades ({proximityAlertRadiusKm} km)
            </button>
          </div>

          {/* Offline Tile Snapshot & Cache Strategy Panel */}
          <section
            aria-label="Cache offline de mapas"
            data-testid="offline-map-cache-panel"
            className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-4 space-y-3"
          >
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-white">
                  {isOnline ? (
                    <Wifi className="w-4 h-4 text-[#16A34A] shrink-0" aria-hidden="true" />
                  ) : (
                    <CloudOff className="w-4 h-4 text-[#D97706] shrink-0" aria-hidden="true" />
                  )}
                  <span className="truncate">Snapshots de Mapa Offline</span>
                </div>
                <p
                  data-testid="offline-cache-status-line"
                  className="text-xs text-slate-500 dark:text-slate-400 mt-0.5 tabular-nums"
                >
                  {!isOnline ? (
                    <>
                      <span className="font-semibold text-[#B45309] dark:text-[#FBBF24]">
                        Modo sem rede ativo
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span>
                        {activeParcelSnapshot
                          ? `Snapshot local pronto (${activeParcelSnapshot.tileCount} mosaicos · Z15–Z19)`
                          : `${cacheStats.tileCount} mosaicos em cache local`}
                      </span>
                      {offlineCacheHits > 0 && (
                        <>
                          <span aria-hidden="true"> · </span>
                          <span>{offlineCacheHits} servidos offline</span>
                        </>
                      )}
                    </>
                  ) : activeParcelSnapshot ? (
                    <>
                      <span className="font-semibold text-[#14532D] dark:text-[#4ADE80]">
                        Snapshot Offline Pronto
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span>{activeParcelSnapshot.tileCount} mosaicos (Ortofoto + Vetorial)</span>
                      <span aria-hidden="true"> · </span>
                      <span>Z15–Z19</span>
                      <span aria-hidden="true"> · </span>
                      <span>{formatByteSizePt(activeParcelSnapshot.totalBytes)}</span>
                    </>
                  ) : (
                    <>
                      <span>Cache local: {cacheStats.tileCount} mosaicos</span>
                      <span aria-hidden="true"> · </span>
                      <span>{formatByteSizePt(cacheStats.totalBytes)}</span>
                      <span aria-hidden="true"> · </span>
                      <span>Guarde o lote antes de ir para zonas sem rede</span>
                    </>
                  )}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  data-testid="save-offline-snapshot-btn"
                  disabled={!isOnline || isDownloadingSnapshot}
                  onClick={handleDownloadOfflineSnapshot}
                  title={
                    !isOnline
                      ? 'Ligue-se à internet para pré-descarregar novos mosaicos'
                      : 'Guardar mosaicos de satélite e mapa vetorial para consulta sem rede'
                  }
                  className="min-h-[42px] px-3.5 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14532D] dark:focus-visible:ring-[#22C55E]"
                >
                  {isDownloadingSnapshot ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin shrink-0" aria-hidden="true" />
                      <span className="tabular-nums">
                        A guardar {downloadProgress.completedTiles}/{downloadProgress.totalTiles}
                      </span>
                    </>
                  ) : activeParcelSnapshot ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>Atualizar Snapshot</span>
                    </>
                  ) : (
                    <>
                      <HardDriveDownload className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                      <span>Guardar Mapa Offline</span>
                    </>
                  )}
                </button>

                {cacheStats.tileCount > 0 && !isDownloadingSnapshot && (
                  <button
                    type="button"
                    data-testid="clear-offline-cache-btn"
                    onClick={handleClearAllTileCache}
                    aria-label="Limpar cache cartográfica offline"
                    title="Limpar todos os mosaicos guardados"
                    className="min-h-[42px] px-3 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Limpar Cache</span>
                  </button>
                )}
              </div>
            </div>

            {downloadProgress && (
              <div className="space-y-1.5" role="status" aria-live="polite">
                <progress
                  aria-label="Progresso de transferência do snapshot offline"
                  value={downloadProgress.completedTiles}
                  max={Math.max(1, downloadProgress.totalTiles)}
                  className="w-full h-2 rounded-full overflow-hidden block [&::-webkit-progress-bar]:bg-slate-200 dark:[&::-webkit-progress-bar]:bg-[#0B0F17] [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-value]:bg-[#14532D] dark:[&::-webkit-progress-value]:bg-[#22C55E] [&::-webkit-progress-value]:rounded-full [&::-moz-progress-bar]:bg-[#14532D] dark:[&::-moz-progress-bar]:bg-[#22C55E]"
                />
                <p className="text-xs text-slate-600 dark:text-slate-400 tabular-nums">
                  A pré-carregar Ortofoto + Mapa Vetorial (Z15–Z19): {downloadProgress.completedTiles} de{' '}
                  {downloadProgress.totalTiles} mosaicos · {formatByteSizePt(downloadProgress.bytesStored)}
                </p>
              </div>
            )}

            {savedSnapshots.length > 0 && (
              <div className="pt-2.5 border-t border-slate-200 dark:border-[#263248] space-y-2">
                <div className="flex items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                  <span className="whitespace-nowrap">Snapshots prontos sem rede ({savedSnapshots.length})</span>
                  <span className="whitespace-nowrap shrink-0">Total: {formatByteSizePt(cacheStats.totalBytes)}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {savedSnapshots.map((snap) => {
                    const isSelected = snap.parcelId === activeParcel.id;
                    return (
                      <div
                        key={snap.parcelId}
                        className={`inline-flex items-center rounded-xl border text-xs transition-colors max-w-full ${
                          isSelected
                            ? 'border-[#14532D] bg-[#14532D]/10 dark:border-[#22C55E] dark:bg-[#22C55E]/15 text-slate-900 dark:text-white'
                            : 'border-slate-300 dark:border-[#263248] bg-slate-50 dark:bg-[#0B0F17] text-slate-700 dark:text-slate-300'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => handleSelectSavedSnapshot(snap)}
                          className="min-h-[40px] px-3 py-1.5 font-semibold inline-flex items-center gap-1.5 truncate max-w-[230px] sm:max-w-[280px]"
                        >
                          <LocateFixed className="w-3.5 h-3.5 shrink-0 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
                          <span className="truncate">{snap.parcelLabel}</span>
                          <span className="font-mono font-normal text-slate-500 dark:text-slate-400 tabular-nums shrink-0">
                            · {snap.tileCount}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteSnapshot(snap.parcelId, snap.parcelLabel)}
                          aria-label={`Remover snapshot offline de ${snap.parcelLabel}`}
                          title="Remover snapshot desta parcela"
                          className="min-h-[40px] min-w-[36px] px-2 text-slate-400 hover:text-[#DC2626] transition-colors inline-flex items-center justify-center border-l border-slate-200 dark:border-[#263248]"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {cacheFeedback && !downloadProgress && (
              <p
                role="status"
                aria-live="polite"
                className="text-xs text-[#14532D] dark:text-[#4ADE80] flex items-center gap-1.5 tabular-nums"
              >
                <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>{cacheFeedback}</span>
              </p>
            )}

            {cacheError && (
              <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                {cacheError}
              </p>
            )}
          </section>

          {selectedZoneCallout && (
            <div className="rounded-xl p-3.5 bg-slate-900 text-white text-xs leading-relaxed flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <span>{selectedZoneCallout}</span>
              {selectedZoneCallout.includes('VIZINHO') && (
                <button
                  type="button"
                  onClick={() => onNavigateTab('certify', 'neighbor')}
                  className="min-h-[40px] px-3.5 py-1.5 rounded-lg bg-[#A855F7] hover:bg-[#9333EA] text-white font-semibold whitespace-nowrap shrink-0"
                >
                  Emitir Requerimento GTF
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Contextual Inspector / Assisted HITL / Draw / Caderneta */}
        <div className="md:col-span-5 space-y-4">
          {mapToolMode === 'ASSISTED' && (
            <AssistedHitlPanel
              activeParcel={activeParcel}
              subTool={assistedSubTool}
              onSelectSubTool={(tool) => {
                setAssistedSubTool(tool);
                setAssistedDraftPoints([]);
              }}
              buildingDrawStyle={assistedBldgStyle}
              onChangeBuildingDrawStyle={(style) => {
                setAssistedBldgStyle(style);
                setAssistedDraftPoints([]);
              }}
              buildingCustomLabel={assistedBldgLabel}
              onChangeBuildingCustomLabel={setAssistedBldgLabel}
              easementPreset={assistedEasementPreset}
              onChangeEasementPreset={setAssistedEasementPreset}
              easementHalfWidthM={assistedEasementWidthM}
              onChangeEasementHalfWidthM={setAssistedEasementWidthM}
              exemptPreset={assistedExemptPreset}
              onChangeExemptPreset={(preset) => {
                setAssistedExemptPreset(preset);
                setAssistedDraftPoints([]);
              }}
              exemptHalfWidthM={assistedExemptWidthM}
              onChangeExemptHalfWidthM={setAssistedExemptWidthM}
              draftPoints={assistedDraftPoints}
              onClearDraftPoints={() => setAssistedDraftPoints([])}
              onRemoveLastDraftPoint={() =>
                setAssistedDraftPoints((prev) => prev.slice(0, -1))
              }
              onCommitDraftGeometry={handleCommitAssistedDraft}
              selectedElementId={assistedSelectedId}
              onSelectElementId={setAssistedSelectedId}
              onFocusMapLatLon={(pt) => mapInstanceRef.current?.panTo([pt.lat, pt.lon])}
              onToggleBuildingRole={(buildingId) => {
                const next = toggleAssistedBuildingRole(activeParcel, buildingId);
                commitAssistedParcelMutation(
                  next,
                  'Papel da edificação (Próprio ↔ Vizinho) atualizado e faixas EPSG:3763 recalculadas.'
                );
              }}
              onUpdateEasementWidth={(easementId, nextHalfWidthM) => {
                const next = updateAssistedEasementWidth(
                  activeParcel,
                  easementId,
                  nextHalfWidthM
                );
                commitAssistedParcelMutation(
                  next,
                  `Largura da servidão ajustada para ±${nextHalfWidthM} m e subtraída em EPSG:3763.`
                );
              }}
              onRemoveVectorElement={(kind, id) => {
                const next = removeAssistedVectorElement(activeParcel, kind, id);
                if (assistedSelectedId === id) setAssistedSelectedId(null);
                commitAssistedParcelMutation(
                  next,
                  'Elemento removido da decomposição e áreas legais recalculadas em EPSG:3763.'
                );
              }}
              onReviewCvRoof={(roofId, decision) => {
                const next = reviewCvRoofDetection(activeParcel, roofId, decision);
                commitAssistedParcelMutation(
                  next,
                  decision === 'DISMISS_FALSE_POSITIVE'
                    ? 'Falso positivo de cobertura descartado da auditoria CV.'
                    : 'Cobertura validada pelo utilizador e fundida nos anéis booleanos EPSG:3763.'
                );
              }}
              onOverrideCvCrown={(crownId, override) => {
                const next = overrideCvCrownStatus(activeParcel, crownId, override);
                commitAssistedParcelMutation(
                  next,
                  override === 'PROTECTED_QUERCUS'
                    ? 'Copa classificada como Sobreiro/Azinheira protegida (DL 169/2001) — abate interdito sem licença ICNF.'
                    : override === 'PRUNED_COMPLIANT'
                      ? 'Copa registada como já desramada/conforme no terreno.'
                      : 'Regra automática de auditoria CV reposta para esta copa.'
                );
              }}
              undoCount={assistedUndoStack.length}
              onUndoLastEdit={handleUndoAssistedEdit}
              onResetToAutomatic={handleResetAssistedToAuto}
              onRunOrthophotoCv={handleRunOrthophotoCv}
              runningOrthophotoCv={runningOrthophotoCv}
              statusFeedbackPt={assistedFeedback}
            />
          )}

          {mapToolMode === 'DRAW' && (
            <form
              onSubmit={handleSaveDrawnParcel}
              className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Desenhar Novo Polígono no Mapa
                </h2>
                <button
                  type="button"
                  data-testid="map-draw-clear-all-btn"
                  disabled={drawnVertices.length === 0}
                  onClick={handleClearAllDrawnVertices}
                  className="min-h-[38px] px-3 py-1 rounded-xl border border-rose-300 dark:border-rose-800/70 text-xs font-semibold text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-45 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                  Apagar Todos ({drawnVertices.length})
                </button>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Toque em 3 ou mais vértices sobre a ortofoto para calcular imediatamente as coroas legais em EPSG:3763. Pode mover ou apagar qualquer vértice individualmente.
              </p>

              {/* Vertex Mode Switch + Undo */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div
                  role="group"
                  aria-label="Modo de edição de vértices no mapa principal"
                  className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
                >
                  <button
                    type="button"
                    data-testid="map-draw-mode-add"
                    onClick={() => setDrawVertexActionMode('ADD_EDIT')}
                    className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                      drawVertexActionMode === 'ADD_EDIT'
                        ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                        : 'text-slate-700 dark:text-slate-300'
                    }`}
                  >
                    <PenTool className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Adicionar / Mover</span>
                  </button>
                  <button
                    type="button"
                    data-testid="map-draw-mode-delete"
                    disabled={drawnVertices.length === 0}
                    onClick={() =>
                      setDrawVertexActionMode((prev) =>
                        prev === 'DELETE_VERTEX' ? 'ADD_EDIT' : 'DELETE_VERTEX'
                      )
                    }
                    className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-45 ${
                      drawVertexActionMode === 'DELETE_VERTEX'
                        ? 'bg-[#DC2626] text-white'
                        : 'text-[#DC2626] dark:text-rose-400'
                    }`}
                  >
                    <Eraser className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                    <span>Apagar Vértice</span>
                  </button>
                </div>

                <button
                  type="button"
                  disabled={drawnVertices.length === 0}
                  onClick={() => handleDeleteDrawnVertexAt(drawnVertices.length - 1)}
                  className="min-h-[36px] px-2.5 py-1 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 inline-flex items-center gap-1 whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Anular Último
                </button>
              </div>

              <div className="rounded-xl p-3 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] space-y-2.5">
                <div className="text-xs font-mono tabular-nums flex items-center justify-between">
                  <span>Vértices marcados: {drawnVertices.length}</span>
                  <span>Área EPSG:3763: {drawnMetrics.areaM2.toLocaleString('pt-PT')} m²</span>
                </div>

                {drawnVertices.length > 0 && (
                  <div
                    data-testid="map-draw-vertex-list"
                    className="max-h-[120px] overflow-y-auto pt-2 border-t border-slate-200 dark:border-[#263248] flex flex-wrap items-center gap-1.5"
                  >
                    {drawnVertices.map((pt, idx) => (
                      <div
                        key={`${idx}-${pt.lat}-${pt.lon}`}
                        className="inline-flex items-center rounded-lg border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-xs"
                      >
                        <button
                          type="button"
                          onClick={() => mapInstanceRef.current?.panTo([pt.lat, pt.lon])}
                          className="min-h-[32px] px-2 py-1 font-mono tabular-nums inline-flex items-center gap-1 whitespace-nowrap text-slate-800 dark:text-slate-200"
                        >
                          <span className="font-bold text-[#14532D] dark:text-[#4ADE80]">
                            V{idx + 1}
                          </span>
                          <span>
                            {pt.lat.toFixed(5)}, {pt.lon.toFixed(5)}
                          </span>
                        </button>
                        <button
                          type="button"
                          data-testid={`map-draw-delete-vertex-${idx}`}
                          aria-label={`Apagar vértice V${idx + 1}`}
                          title={`Apagar vértice V${idx + 1}`}
                          onClick={() => handleDeleteDrawnVertexAt(idx)}
                          className="min-h-[32px] min-w-[28px] px-1.5 border-l border-slate-200 dark:border-[#263248] text-slate-500 hover:text-[#DC2626] dark:text-slate-400 dark:hover:text-rose-400 inline-flex items-center justify-center transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label htmlFor="draw-parcel-label" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Nome Identificador do Terreno
                </label>
                <input
                  id="draw-parcel-label"
                  type="text"
                  value={newParcelLabel}
                  onChange={(e) => setNewParcelLabel(e.target.value)}
                  placeholder="Ex.: Pinhal da Encosta · Mafra"
                  className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="draw-dico" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Município (DICO)
                  </label>
                  <select
                    id="draw-dico"
                    value={newParcelDico}
                    onChange={(e) => setNewParcelDico(e.target.value)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    {municipalities.map((m) => (
                      <option key={m.dico} value={m.dico}>
                        {m.name} ({m.district})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="draw-cos" className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    Ocupação COS (DGT)
                  </label>
                  <select
                    id="draw-cos"
                    value={newParcelLandClass}
                    onChange={(e) => setNewParcelLandClass(e.target.value as LandClass)}
                    className="w-full min-h-[44px] px-3 py-2 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-sm text-slate-900 dark:text-white"
                  >
                    <option value="FOREST_SCRUB">Florestal / Mato (50 m)</option>
                    <option value="AGRICULTURE">Agrícola / Pomar (10 m)</option>
                  </select>
                </div>
              </div>

              <label className="flex items-center gap-2.5 text-xs text-slate-700 dark:text-slate-300 min-h-[40px] cursor-pointer">
                <input
                  type="checkbox"
                  checked={newParcelEredes}
                  onChange={(e) => setNewParcelEredes(e.target.checked)}
                  className="w-4 h-4 rounded accent-[#14532D]"
                />
                Atravessado por linha aérea MT/AT da E-REDES (subtrair faixa de servidão)
              </label>

              {drawError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {drawError}
                </p>
              )}

              <button
                type="submit"
                disabled={savingParcel}
                className="w-full min-h-[46px] px-4 py-2.5 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:text-slate-950 text-white text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2"
              >
                <PlusCircle className="w-4 h-4" aria-hidden="true" />
                {savingParcel ? 'A calcular faixas EPSG:3763...' : 'Calcular Faixas e Guardar Terreno'}
              </button>
            </form>
          )}

          {mapToolMode === 'CADERNETA' && (
            <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Importar Caderneta Predial Rústica / Urbana (RGPD Privado)
              </h2>
              <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Extraia automaticamente Concelho, Artigo Matricial, Secção e alertas de Sobreiros/Azinheiras a partir do texto da Caderneta das Finanças.
              </p>

              <label htmlFor="caderneta-textarea" className="sr-only">
                Texto da Caderneta Predial
              </label>
              <textarea
                id="caderneta-textarea"
                rows={4}
                value={cadernetaText}
                onChange={(e) => setCadernetaText(e.target.value)}
                placeholder="Ex.: Prédio Rústico sito em Figueiró dos Vinhos, Artigo Matricial 318, Secção H, composto por pinhal e 3 sobreiros adultos..."
                className="w-full p-3 rounded-xl bg-slate-50 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs text-slate-900 dark:text-white"
              />

              {drawError && (
                <p role="alert" className="text-xs font-semibold text-[#DC2626]">
                  {drawError}
                </p>
              )}

              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  type="button"
                  onClick={() =>
                    handleExtractCaderneta(
                      'AUTORIDADE TRIBUTÁRIA - CADERNETA PREDIAL RÚSTICA. Concelho: Mafra. Artigo Matricial: 412 Secção: M. Confrontações Norte: Caminho Público. Cultura: Mato, Pinhal e 4 Sobreiros.'
                    )
                  }
                  className="flex-1 min-h-[44px] px-3 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Testar c/ Caderneta Exemplo (Mafra)
                </button>
                <button
                  type="button"
                  disabled={extractingCaderneta}
                  onClick={() => handleExtractCaderneta()}
                  className="flex-1 min-h-[44px] px-4 py-2 rounded-xl bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold whitespace-nowrap"
                >
                  {extractingCaderneta ? 'A extrair...' : 'Extrair e Posicionar Lote'}
                </button>
              </div>

              <div className="pt-3 border-t border-slate-200 dark:border-[#263248] space-y-2">
                <button
                  type="button"
                  data-testid="lookup-dgt-cadastre-btn"
                  disabled={lookingUpCadastre}
                  onClick={() => void handleLookupOfficialDgtCadastre()}
                  className="w-full min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                >
                  <LocateFixed className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {lookingUpCadastre
                      ? 'A consultar OGC API DGT...'
                      : 'Consultar Cadastro Oficial DGT no Centro do Mapa'}
                  </span>
                </button>
                {cadastreLookupNotice && (
                  <p
                    role="status"
                    data-testid="dgt-cadastre-lookup-notice"
                    className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed"
                  >
                    {cadastreLookupNotice}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Zone Breakdown Card (Always visible in INSPECT or below tools) */}
          <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-white">
                Decomposição Legal da Parcela (m²)
              </h2>
              <select
                aria-label="Selecionar parcela BUPi registada"
                value={activeParcel.id}
                onChange={(e) => onSelectParcel(e.target.value)}
                className="w-full min-h-[40px] px-3 py-1.5 rounded-lg bg-slate-100 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-900 dark:text-white truncate"
              >
                {parcels.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                <span>{activeVertexCount} vértices WGS84</span>
                <span aria-hidden="true"> · </span>
                <span>Perímetro {activeParcel.spatial.perimeterM.toFixed(1)} m</span>
                <span aria-hidden="true"> · </span>
                <span>Área total {activeParcel.spatial.totalAreaM2.toFixed(0)} m²</span>
              </p>
            </div>

            <div className="divide-y divide-slate-200 dark:divide-[#263248] text-xs">
              <div className="py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-sm bg-[#E11D48] shrink-0" aria-hidden="true" />
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      Zona 1 · Interface Imediata (0–2 m)
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">
                      Faixa inerte (brita/solo mineral nu, zero vegetação)
                    </div>
                  </div>
                </div>
                <span className="font-mono font-bold tabular-nums text-slate-900 dark:text-white shrink-0">
                  {activeParcel.spatial.zone1ImmediateM2.toFixed(0)} m²
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-sm bg-[#EA580C] shrink-0" aria-hidden="true" />
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      Zona 2 · Interface Próxima (2–10 m)
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">
                      Desramação 50% (mín. 4m) e zero copas a &lt;5m da parede
                    </div>
                  </div>
                </div>
                <span className="font-mono font-bold tabular-nums text-slate-900 dark:text-white shrink-0">
                  {activeParcel.spatial.zone2NearM2.toFixed(0)} m²
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-sm bg-[#F59E0B] shrink-0" aria-hidden="true" />
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      Zona 3 · Interface Alargada (10–{activeParcel.spatial.decompositionMeta?.outerBufferRadiusM ?? 50} m)
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 tabular-nums">
                      Corte de mato e afastamento 10 m pinheiro/eucalipto
                      {(activeParcel.spatial.decompositionMeta?.neighborInducedCleanAreaM2 ?? 0) > 0 && (
                        <>
                          {' · '}
                          <span className="text-slate-700 dark:text-slate-300">
                            {(activeParcel.spatial.decompositionMeta?.neighborInducedCleanAreaM2 ?? 0).toFixed(0)} m² por vizinho
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                <span className="font-mono font-bold tabular-nums text-slate-900 dark:text-white shrink-0">
                  {activeParcel.spatial.zone3ExtendedM2.toFixed(0)} m²
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-sm bg-[#06B6D4] shrink-0" aria-hidden="true" />
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1">
                      Servidões de Terceiros (E-REDES / Vias)
                      <Zap className="w-3 h-3 text-[#0284C7]" aria-hidden="true" />
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 tabular-nums">
                      E-REDES {(activeParcel.spatial.decompositionMeta?.eredesEasementM2 ?? activeParcel.spatial.thirdPartyEasementM2).toFixed(0)} m²
                      {' · '}
                      Viária {(activeParcel.spatial.decompositionMeta?.roadEasementM2 ?? 0).toFixed(0)} m²
                      {' · '}
                      ~{activeParcel.spatial.estimatedEredesSavingsEur.toFixed(0)} € poupados
                    </div>
                  </div>
                </div>
                <span className="font-mono font-bold tabular-nums text-[#0284C7] dark:text-[#38BDF8] shrink-0">
                  {activeParcel.spatial.thirdPartyEasementM2.toFixed(0)} m²
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  <span className="w-3 h-3 rounded-sm bg-[#4ADE80] shrink-0" aria-hidden="true" />
                  <div>
                    <div className="font-semibold text-slate-900 dark:text-slate-100">
                      Zona Isenta &amp; Galeria Ripícola
                    </div>
                    <div className="text-slate-500 dark:text-slate-400 tabular-nums">
                      Ripícola/Agrícola protegida {(activeParcel.spatial.decompositionMeta?.riparianProtectedM2 ?? 0).toFixed(0)} m² · Fora de faixas
                    </div>
                  </div>
                </div>
                <span className="font-mono font-bold tabular-nums text-slate-700 dark:text-slate-300 shrink-0">
                  {activeParcel.spatial.exemptAreaM2.toFixed(0)} m²
                </span>
              </div>
            </div>

            {activeParcel.hasProtectedOaks && (
              <div className="rounded-xl p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-300 dark:border-amber-800/60 text-xs text-amber-950 dark:text-amber-200 flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 text-[#D97706] shrink-0 mt-0.5" aria-hidden="true" />
                <span>{activeParcel.protectedOakNotes}</span>
              </div>
            )}

            {/* Boolean EPSG:3763 & Live OSM / Cadastre Vector Context Telemetry */}
            <div
              data-testid="boolean-vector-context-section"
              className="pt-3 border-t border-slate-200 dark:border-[#263248] space-y-2.5"
            >
              <div className="flex flex-col gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Álgebra Booleana EPSG:3763 &amp; Contexto Vetorial
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                    <span>
                      Edifícios próprios: {activeParcel.spatial.decompositionMeta?.ownBuildingsCount ?? 1} (
                      {(activeParcel.spatial.decompositionMeta?.ownBuildingsAreaM2 ?? 102).toFixed(0)} m²)
                    </span>
                    <span aria-hidden="true"> · </span>
                    <span>
                      Vizinhos ≤50 m: {activeParcel.spatial.decompositionMeta?.neighborBuildingsWithin50mCount ?? 0}
                    </span>
                    <span aria-hidden="true"> · </span>
                    <span>
                      Obrigação induzida: {(activeParcel.spatial.decompositionMeta?.neighborInducedCleanAreaM2 ?? 0).toFixed(0)} m²
                    </span>
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                    <span>
                      Transbordo no vizinho: {(activeParcel.spatial.decompositionMeta?.neighborOverflowRiskM2 ?? 0).toFixed(0)} m² ({activeParcel.spatial.neighborDirection} · {activeParcel.spatial.neighborMinDistanceM.toFixed(1)} m)
                    </span>
                    <span aria-hidden="true"> · </span>
                    <span>
                      {activeParcel.vectorContext?.sourceMode === 'LIVE_OVERPASS_WFS'
                        ? 'OSM Overpass Tempo Real'
                        : 'Síntese Cadastral EPSG:3763'}
                    </span>
                  </p>
                  {activeParcel.elevationMeta && (
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                      <span>Declive MDT {activeParcel.avgSlopePct}%</span>
                      <span aria-hidden="true"> · </span>
                      <span>
                        Alt. {activeParcel.elevationMeta.minElevationM}–{activeParcel.elevationMeta.maxElevationM} m
                      </span>
                      <span aria-hidden="true"> · </span>
                      <span>{activeParcel.elevationMeta.aspectLabelPt}</span>
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="detect-vector-context-btn"
                    disabled={detectingContext}
                    onClick={handleDetectVectorContext}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-[#14532D]/40 dark:border-[#22C55E]/45 bg-[#14532D]/5 hover:bg-[#14532D]/10 dark:bg-[#22C55E]/10 dark:hover:bg-[#22C55E]/20 text-[#14532D] dark:text-[#4ADE80] text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 shrink-0 ${detectingContext ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    <span>
                      {detectingContext
                        ? 'A detetar OSM / E-REDES...'
                        : 'Detetar Elementos Reais (OSM / E-REDES)'}
                    </span>
                  </button>

                  <button
                    type="button"
                    data-testid="refresh-elevation-slope-btn"
                    disabled={calculatingSlope}
                    onClick={() => void handleRefreshElevationSlope()}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 shrink-0 ${calculatingSlope ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    <span>{calculatingSlope ? 'A medir MDT...' : 'Calcular Declive MDT'}</span>
                  </button>
                </div>
              </div>

              {vectorStatusNotice?.parcelId === activeParcel.id && (
                <p
                  role="status"
                  aria-live="polite"
                  data-testid="vector-context-status-notice"
                  className="text-xs text-[#14532D] dark:text-[#4ADE80] flex items-center gap-1.5 tabular-nums"
                >
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {vectorStatusNotice.summary} · {vectorStatusNotice.detectedAtTime}
                  </span>
                </p>
              )}

              {slopeStatusNotice?.parcelId === activeParcel.id && (
                <p
                  role="status"
                  aria-live="polite"
                  data-testid="elevation-slope-status-notice"
                  className="text-xs text-[#14532D] dark:text-[#4ADE80] flex items-center gap-1.5 tabular-nums"
                >
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>{slopeStatusNotice.summary}</span>
                </p>
              )}
            </div>

            {/* Phase 2: 25 cm Orthophoto Computer Vision & Crown Spacing Audit (ONNX / OBIA) */}
            <div
              data-testid="orthophoto-cv-section"
              className="pt-3 border-t border-slate-200 dark:border-[#263248] space-y-2.5"
            >
              <div className="flex flex-col gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Pipeline CV Ortofoto 25 cm (Copas, Mato &amp; Anexos)
                  </div>

                  {activeParcel.cvAnalysis ? (
                    <>
                      <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                        <span>
                          Zona 1 inerte: {activeParcel.cvAnalysis.zoneCompliance.zone1BareMineralPct.toFixed(0)}%
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>Copas: {activeParcel.cvAnalysis.crowns.length}</span>
                        <span aria-hidden="true"> · </span>
                        <span
                          className={
                            activeParcel.cvAnalysis.zoneCompliance.zone2CrownsUnder5mCount > 0 ||
                            activeParcel.cvAnalysis.zoneCompliance.crownSpacingViolationsCount > 0
                              ? 'text-[#DC2626] dark:text-rose-400 font-semibold'
                              : 'text-[#14532D] dark:text-[#4ADE80]'
                          }
                        >
                          Infrações copas:{' '}
                          {activeParcel.cvAnalysis.zoneCompliance.zone2CrownsUnder5mCount +
                            activeParcel.cvAnalysis.zoneCompliance.crownSpacingViolationsCount}
                        </span>
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                        <span>
                          Mato: {activeParcel.cvAnalysis.classAreasM2.SHRUB_SCRUB_FUEL.toFixed(0)} m²
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>
                          Copa arbórea: {activeParcel.cvAnalysis.classAreasM2.TREE_CANOPY_CROWN.toFixed(0)} m²
                        </span>
                        <span aria-hidden="true"> · </span>
                        <span>
                          Anexos omissos: {activeParcel.cvAnalysis.unmappedRoofsCount}
                        </span>
                      </p>
                      <p className="text-xs text-slate-600 dark:text-slate-300 tabular-nums mt-0.5">
                        {activeParcel.cvAnalysis.zoneCompliance.auditSummaryPt}
                      </p>
                    </>
                  ) : (
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
                      Segmentação semântica em 7 classes SGIFR, medição de copas individuais (&lt;5 m fachada / &lt;10 m pinhal) e deteção de anexos omissos no cadastro.
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="run-orthophoto-cv-btn"
                    disabled={runningOrthophotoCv}
                    onClick={handleRunOrthophotoCv}
                    className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 shrink-0 ${runningOrthophotoCv ? 'animate-spin' : ''}`}
                      aria-hidden="true"
                    />
                    <span>
                      {runningOrthophotoCv
                        ? 'A segmentar ortofoto...'
                        : activeParcel.cvAnalysis
                          ? 'Reanalisar Ortofoto 25 cm'
                          : 'Analisar Ortofoto 25 cm (CV)'}
                    </span>
                  </button>

                  {activeParcel.cvAnalysis &&
                    (activeParcel.cvAnalysis.unmappedRoofsCount > 0 ||
                      !activeParcel.cvAnalysis.fusedIntoVectorContext) && (
                      <button
                        type="button"
                        data-testid="fuse-cv-into-boolean-btn"
                        onClick={handleFuseCvIntoBoolean}
                        className="min-h-[40px] px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] bg-slate-50 hover:bg-slate-100 dark:bg-[#0B0F17] dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0"
                      >
                        <Layers className="w-3.5 h-3.5 text-[#F43F5E] shrink-0" aria-hidden="true" />
                        <span>Fundir Anexos nas Faixas</span>
                      </button>
                    )}
                </div>
              </div>

              {cvStatusNotice?.parcelId === activeParcel.id && (
                <p
                  role="status"
                  aria-live="polite"
                  data-testid="orthophoto-cv-status-notice"
                  className="text-xs text-[#14532D] dark:text-[#4ADE80] flex items-center gap-1.5 tabular-nums"
                >
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    {cvStatusNotice.summary} · {cvStatusNotice.analyzedAtTime}
                  </span>
                </p>
              )}
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-[#263248] space-y-2.5">
              <div className="flex flex-col gap-2">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Interoperabilidade SIG / BUPi (RFC 7946)
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    <span>{activeVertexCount} vértices + anéis booleanos MultiPolygon</span>
                    <span aria-hidden="true"> · </span>
                    <span>QGIS / ArcGIS / PostGIS</span>
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="export-legal-layers-geojson-btn"
                    onClick={handleExportLegalLayersGeoJson}
                    className="min-h-[42px] px-3.5 py-2 rounded-xl border border-[#14532D]/35 dark:border-[#22C55E]/40 bg-slate-50 hover:bg-slate-100 dark:bg-[#0B0F17] dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14532D] dark:focus-visible:ring-[#22C55E]"
                  >
                    <Layers
                      className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E] shrink-0"
                      aria-hidden="true"
                    />
                    <span>Exportar Camadas Legais</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleExportParcelGeoJson}
                    className="min-h-[42px] px-3.5 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-slate-50 hover:bg-slate-100 dark:bg-[#0B0F17] dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14532D] dark:focus-visible:ring-[#22C55E]"
                  >
                    <Download
                      className="w-3.5 h-3.5 text-[#14532D] dark:text-[#22C55E] shrink-0"
                      aria-hidden="true"
                    />
                    <span>Export GeoJSON</span>
                  </button>
                </div>
              </div>

              {exportedGeoJsonNotice?.parcelId === activeParcel.id && (
                <p
                  role="status"
                  aria-live="polite"
                  className="text-xs text-[#14532D] dark:text-[#4ADE80] flex items-center gap-1.5 tabular-nums"
                >
                  <Check className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">
                    Transferido: <span className="font-mono">{exportedGeoJsonNotice.filename}</span>
                    {' · '}
                    {exportedGeoJsonNotice.detailLabel} ({exportedGeoJsonNotice.exportedAtTime})
                  </span>
                </p>
              )}
            </div>

            <div className="pt-2 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'certificate')}
                className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:text-slate-950 text-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                Certificar Limpeza SHA-256
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'quotes')}
                className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-xs font-semibold transition-colors whitespace-nowrap"
              >
                Pedir 3 Orçamentos ({activeParcel.spatial.mandatoryCleanAreaM2.toFixed(0)} m²)
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
