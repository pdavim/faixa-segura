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
  MunicipalityInfo,
  ParcelRecord,
} from '../types/domain.ts';
import {
  buildParcelGeoJsonFilename,
  buildParcelVerticesGeoJson,
  computeParcelLeafletBounds,
  computePolygonMetrics3763,
} from '../lib/spatialEngine.ts';
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
  buildOfflineFallbackTileSvgDataUrl,
  buildTileUrl,
  formatByteSizePt,
  getSharedOfflineTileCacheManager,
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
    const templateUrl =
      params.style === 'ORTHOPHOTO'
        ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        : 'https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';

    super(templateUrl, {
      maxZoom: params.maxZoom,
      attribution:
        params.style === 'ORTHOPHOTO'
          ? 'Ortofoto Aérea / Satélite · Cache Offline EPSG:3763'
          : 'Cartografia Vetorial OpenStreetMap / CARTO · Cache Offline',
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
  onSelectParcel: (parcelId: string) => void;
  onCreateParcel: (newParcel: ParcelRecord) => void;
  onNavigateTab: (tab: 'today' | 'map' | 'certify' | 'providers' | 'docs', subMode?: string) => void;
}

export const MapZonesView: React.FC<MapZonesViewProps> = ({
  parcels,
  activeParcel,
  municipalities,
  fires,
  onSelectParcel,
  onCreateParcel,
  onNavigateTab,
}) => {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const overlaysGroupRef = useRef<L.LayerGroup | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);

  const [baseMapStyle, setBaseMapStyle] = useState<'ORTHOPHOTO' | 'VECTOR'>('ORTHOPHOTO');
  const [mapToolMode, setMapToolMode] = useState<'INSPECT' | 'DRAW' | 'CADERNETA'>('INSPECT');
  const [visibleLayers, setVisibleLayers] = useState({
    zones675: true,
    eredes: true,
    exempt: true,
    neighborRisk: true,
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

  // Caderneta Predial extraction & GIS export state
  const [cadernetaText, setCadernetaText] = useState('');
  const [extractingCaderneta, setExtractingCaderneta] = useState(false);
  const [selectedZoneCallout, setSelectedZoneCallout] = useState<string | null>(null);
  const [exportedGeoJsonNotice, setExportedGeoJsonNotice] = useState<{
    parcelId: string;
    filename: string;
    vertexCount: number;
    exportedAtTime: string;
  } | null>(null);

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

  const handleCenterOnActiveParcel = useCallback(
    (animate = true) => {
      const map = mapInstanceRef.current;
      if (!map) return;
      const bounds = computeParcelLeafletBounds(activeParcel);
      map.fitBounds(bounds.leafletBounds, {
        padding: [36, 36],
        maxZoom: 18,
        animate,
      });
      setCurrentZoom(map.getZoom());
    },
    [activeParcel]
  );

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
  }, [activeParcel.id, handleCenterOnActiveParcel]);

  // Render spatial polygons on map
  useEffect(() => {
    const group = overlaysGroupRef.current;
    if (!group) return;
    group.clearLayers();

    const sp = activeParcel.spatial;
    const toLatLngs = (pts: LatLon[]): L.LatLngExpression[] => pts.map((p) => [p.lat, p.lon]);

    // 1. Exempt Green interior (#4ADE80)
    if (visibleLayers.exempt && sp.polygons.exemptCore.length >= 3) {
      L.polygon(toLatLngs(sp.polygons.exemptCore), {
        color: '#4ADE80',
        weight: 1.5,
        fillColor: '#4ADE80',
        fillOpacity: 0.16,
      })
        .bindTooltip('Zona Interior Isenta (Sem obrigação legal)', { sticky: true })
        .on('click', () =>
          setSelectedZoneCallout(
            `Zona Interior Isenta (${sp.exemptAreaM2.toFixed(0)} m²): Fora dos buffers de edifícios e vias.`
          )
        )
        .addTo(group);
    }

    // 2. Despacho 675/2026 Zones (Z3 Amber -> Z2 Orange -> Z1 Crimson)
    if (visibleLayers.zones675) {
      L.polygon(toLatLngs(sp.polygons.zone3Extended), {
        color: '#F59E0B',
        weight: 2,
        fillColor: '#F59E0B',
        fillOpacity: 0.24,
      })
        .bindTooltip(`Zona 3 Alargada (10–50m): ${sp.zone3ExtendedM2.toFixed(0)} m²`, { sticky: true })
        .on('click', () =>
          setSelectedZoneCallout(
            `Zona 3 Alargada (10–50 m · ${sp.zone3ExtendedM2.toFixed(0)} m²): Mato rasteiro (<20 cm) e copas afastadas 4 m (10 m pinheiro/eucalipto).`
          )
        )
        .addTo(group);

      L.polygon(toLatLngs(sp.polygons.zone2Near), {
        color: '#EA580C',
        weight: 2,
        fillColor: '#EA580C',
        fillOpacity: 0.32,
      })
        .bindTooltip(`Zona 2 Próxima (2–10m): ${sp.zone2NearM2.toFixed(0)} m²`, { sticky: true })
        .on('click', () =>
          setSelectedZoneCallout(
            `Zona 2 Interface Próxima (2–10 m · ${sp.zone2NearM2.toFixed(0)} m²): Desramação a 50% / mín. 4m e zero copas a menos de 5m da parede.`
          )
        )
        .addTo(group);

      L.polygon(toLatLngs(sp.polygons.zone1Immediate), {
        color: '#E11D48',
        weight: 2.5,
        fillColor: '#E11D48',
        fillOpacity: 0.42,
      })
        .bindTooltip(`Zona 1 Faixa Inerte (0–2m): ${sp.zone1ImmediateM2.toFixed(0)} m²`, { sticky: true })
        .on('click', () =>
          setSelectedZoneCallout(
            `Zona 1 Interface Imediata (0–2 m · ${sp.zone1ImmediateM2.toFixed(0)} m²): Faixa inerte obrigatória (brita, lajeado ou solo mineral nu).`
          )
        )
        .addTo(group);
    }

    // 3. E-REDES Third-Party Corridor (#06B6D4)
    if (visibleLayers.eredes && sp.polygons.thirdPartyCorridor.length >= 3) {
      L.polygon(toLatLngs(sp.polygons.thirdPartyCorridor), {
        color: '#06B6D4',
        weight: 2.5,
        fillColor: '#06B6D4',
        fillOpacity: 0.32,
      })
        .bindTooltip(
          `Servidão ${activeParcel.eredesType}: ${sp.thirdPartyEasementM2.toFixed(0)} m² (Responsabilidade E-REDES)`,
          { sticky: true }
        )
        .on('click', () =>
          setSelectedZoneCallout(
            `Servidão ${activeParcel.eredesType} (${sp.thirdPartyEasementM2.toFixed(0)} m²): Limpeza da responsabilidade legal da E-REDES (Art.º 49.º DL 82/2021) — poupa ~${sp.estimatedEredesSavingsEur.toFixed(0)} €.`
          )
        )
        .addTo(group);
    }

    // 4. Neighbor Risk Parcel (#A855F7)
    if (visibleLayers.neighborRisk && sp.polygons.neighborRiskParcel.length >= 3) {
      L.polygon(toLatLngs(sp.polygons.neighborRiskParcel), {
        color: '#A855F7',
        weight: 2.5,
        dashArray: '5, 5',
        fillColor: '#A855F7',
        fillOpacity: 0.36,
      })
        .bindTooltip(
          `Terreno Confinante em Infração (Mato a ${sp.neighborMinDistanceM.toFixed(1)}m da fachada · NDVI ${activeParcel.neighborInfo.ndvi})`,
          { sticky: true }
        )
        .on('click', () =>
          setSelectedZoneCallout(
            `ALERTA VIZINHO: ${activeParcel.neighborInfo.vegetationDescription} a ${sp.neighborMinDistanceM.toFixed(2)} m da parede habitacional. Pode gerar Requerimento Municipal imediato.`
          )
        )
        .addTo(group);
    }

    // 5. Building footprint (Crisp White)
    L.polygon(toLatLngs(sp.polygons.buildingFootprint), {
      color: '#0F172A',
      weight: 1.5,
      fillColor: '#FFFFFF',
      fillOpacity: 0.92,
    })
      .bindTooltip('Edificação Habitacional Principal', { sticky: true })
      .addTo(group);

    // 6. User Parcel Boundary (#FACC15 Laser Yellow Dashed)
    L.polygon(toLatLngs(sp.polygons.parcel), {
      color: '#FACC15',
      weight: 3,
      dashArray: '8, 6',
      fillColor: '#FACC15',
      fillOpacity: 0.05,
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

    // 8. Active ANEPC Fires markers
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
        .addTo(group);
    });
  }, [activeParcel, visibleLayers, drawnVertices, drawVertexActionMode, handleDeleteDrawnVertexAt, fires]);

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
      vertexCount: activeVertexCount,
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
            className="grid grid-cols-3 sm:inline-flex items-center gap-1 p-1 w-full sm:w-auto rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
          >
            <button
              type="button"
              onClick={() => setMapToolMode('INSPECT')}
              className={`min-h-[40px] px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap ${
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
              onClick={() => setMapToolMode('DRAW')}
              className={`min-h-[40px] px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap ${
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
              onClick={() => setMapToolMode('CADERNETA')}
              className={`min-h-[40px] px-2 sm:px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap ${
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

          <button
            type="button"
            onClick={() =>
              setBaseMapStyle((prev) => (prev === 'ORTHOPHOTO' ? 'VECTOR' : 'ORTHOPHOTO'))
            }
            className="min-h-[42px] w-full sm:w-auto px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Layers className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            {baseMapStyle === 'ORTHOPHOTO' ? 'Ver Mapa Vetorial' : 'Ver Ortofoto 25 cm'}
          </button>
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
              className="w-full h-[360px] sm:h-[420px] z-0"
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

        {/* Right Column: Contextual Inspector / Draw / Caderneta */}
        <div className="md:col-span-5 space-y-4">
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
                  className="flex-1 min-h-[44px] px-4 py-2 rounded-xl bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950 text-xs font-semibold"
                >
                  {extractingCaderneta ? 'A extrair...' : 'Extrair e Posicionar Lote'}
                </button>
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
                      Zona 3 · Interface Alargada (10–50 m)
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">
                      Corte de mato e afastamento 10 m pinheiro/eucalipto
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
                      Servidão E-REDES
                      <Zap className="w-3 h-3 text-[#0284C7]" aria-hidden="true" />
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">
                      Custo a cargo da utility (~{activeParcel.spatial.estimatedEredesSavingsEur.toFixed(0)} € poupados)
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
                      Zona Interior Isenta
                    </div>
                    <div className="text-slate-500 dark:text-slate-400">
                      Sem obrigação legal de gestão de combustível
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

            <div className="pt-3 border-t border-slate-200 dark:border-[#263248] space-y-2.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Interoperabilidade SIG / BUPi
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                    <span>{activeVertexCount} vértices + polígono RFC 7946</span>
                    <span aria-hidden="true"> · </span>
                    <span>QGIS / ArcGIS / PostGIS</span>
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleExportParcelGeoJson}
                  className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] bg-slate-50 hover:bg-slate-100 dark:bg-[#0B0F17] dark:hover:bg-slate-800 text-slate-900 dark:text-slate-100 text-xs font-semibold transition-colors inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#14532D] dark:focus-visible:ring-[#22C55E]"
                >
                  <Download
                    className="w-4 h-4 text-[#14532D] dark:text-[#22C55E] shrink-0"
                    aria-hidden="true"
                  />
                  Export GeoJSON
                </button>
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
                    {exportedGeoJsonNotice.vertexCount} vértices ({exportedGeoJsonNotice.exportedAtTime})
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
