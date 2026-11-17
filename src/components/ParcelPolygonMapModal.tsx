import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import {
  Check,
  Eraser,
  Layers,
  LocateFixed,
  Minus,
  PenTool,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import type { LandClass, LatLon, MunicipalityInfo } from '../types/domain.ts';
import { computeParcelFgc } from '../lib/spatialEngine.ts';
import {
  appendPolygonVertex,
  buildDefaultRectangleAroundCenter,
  clearAllPolygonVertices,
  removePolygonVertexAt,
  resolveNextSelectedVertexIndexAfterRemoval,
  updatePolygonVertexAt,
} from '../lib/userWorkspaceStore.ts';
import {
  buildOfflineFallbackTileSvgDataUrl,
  buildTileUrl,
  getSharedOfflineTileCacheManager,
  resolveTileTemplateUrl,
  type MapTileStyle,
  type OfflineTileCacheManager,
} from '../lib/offlineTileCache.ts';

class PolygonModalOfflineTileLayer extends L.TileLayer {
  private readonly tileStyle: MapTileStyle;
  private readonly tileCacheManager: OfflineTileCacheManager;
  private readonly parcelId: string;

  constructor(params: {
    style: MapTileStyle;
    maxZoom: number;
    tileCacheManager: OfflineTileCacheManager;
    parcelId: string;
  }) {
    const templateUrl = resolveTileTemplateUrl(params.style);

    super(templateUrl, {
      maxZoom: params.maxZoom,
      attribution:
        params.style === 'ORTHOPHOTO'
          ? 'Ortofoto Aérea / Satélite · EPSG:3763'
          : 'Cartografia Topográfica & Vetorial OSM',
    });

    this.tileStyle = params.style;
    this.tileCacheManager = params.tileCacheManager;
    this.parcelId = params.parcelId;
  }

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
      img.onload = () => done(undefined, img);
      img.onerror = () => done(undefined, img);
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
        parcelId: this.parcelId,
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

type ModalVertexToolMode = 'ADD_EDIT' | 'DELETE_VERTEX';

export interface ParcelPolygonMapModalProps {
  isOpen: boolean;
  parcelId?: string;
  parcelLabel: string;
  municipality: MunicipalityInfo;
  landClass: LandClass;
  hasEredesLine: boolean;
  initialVertices: LatLon[];
  onClose: () => void;
  onApplyVertices: (vertices: LatLon[]) => void;
}

export const ParcelPolygonMapModal: React.FC<ParcelPolygonMapModalProps> = ({
  isOpen,
  parcelId = 'draft-parcel',
  parcelLabel,
  municipality,
  landClass,
  hasEredesLine,
  initialVertices,
  onClose,
  onApplyVertices,
}) => {
  const [draftVertices, setDraftVertices] = useState<LatLon[]>(initialVertices);
  const [tileStyle, setTileStyle] = useState<MapTileStyle>('ORTHOPHOTO');
  const [toolMode, setToolMode] = useState<ModalVertexToolMode>('ADD_EDIT');
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileLayerRef = useRef<L.TileLayer | null>(null);
  const overlayGroupRef = useRef<L.LayerGroup | null>(null);
  const toolModeRef = useRef<ModalVertexToolMode>(toolMode);
  toolModeRef.current = toolMode;

  const tileCacheManager = useMemo(() => getSharedOfflineTileCacheManager(), []);

  // Re-initialize draft vertices whenever modal opens
  useEffect(() => {
    if (isOpen) {
      setDraftVertices(initialVertices);
      setToolMode('ADD_EDIT');
      setSelectedVertexIndex(null);
      setValidationError(null);
    }
  }, [isOpen, initialVertices]);

  // Auto-return to ADD_EDIT mode if all vertices are deleted
  useEffect(() => {
    if (draftVertices.length === 0 && toolMode === 'DELETE_VERTEX') {
      setToolMode('ADD_EDIT');
    }
  }, [draftVertices.length, toolMode]);

  const handleDeleteVertexAt = useCallback((indexToRemove: number) => {
    setValidationError(null);
    setDraftVertices((prev) => {
      const next = removePolygonVertexAt(prev, indexToRemove);
      setSelectedVertexIndex((prevSel) =>
        resolveNextSelectedVertexIndexAfterRemoval(prevSel, indexToRemove, next.length)
      );
      return next;
    });
  }, []);

  const handleClearAllVertices = useCallback(() => {
    setDraftVertices(clearAllPolygonVertices());
    setSelectedVertexIndex(null);
    setToolMode('ADD_EDIT');
    setValidationError(null);
  }, []);

  // Escape key to close + Delete/Backspace to remove selected vertex
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedVertexIndex !== null) {
        const target = e.target as HTMLElement | null;
        const tagName = target?.tagName?.toLowerCase();
        if (tagName === 'input' || tagName === 'textarea' || tagName === 'select') {
          return;
        }
        e.preventDefault();
        handleDeleteVertexAt(selectedVertexIndex);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose, selectedVertexIndex, handleDeleteVertexAt]);

  const liveMetrics = useMemo(() => {
    if (draftVertices.length < 3) return null;
    try {
      return computeParcelFgc({
        vertices: draftVertices,
        landClass,
        hasEredesLine,
        neighborDistanceOverrideM: 4.6,
      });
    } catch {
      return null;
    }
  }, [draftVertices, landClass, hasEredesLine]);

  const centerMapOnActiveGeometry = useCallback(
    (mapInstance: L.Map, targetVertices: LatLon[]) => {
      if (targetVertices.length >= 3) {
        let minLat = Infinity;
        let maxLat = -Infinity;
        let minLon = Infinity;
        let maxLon = -Infinity;
        for (const pt of targetVertices) {
          if (pt.lat < minLat) minLat = pt.lat;
          if (pt.lat > maxLat) maxLat = pt.lat;
          if (pt.lon < minLon) minLon = pt.lon;
          if (pt.lon > maxLon) maxLon = pt.lon;
        }
        if (maxLat - minLat < 0.00015) {
          minLat -= 0.00015;
          maxLat += 0.00015;
        }
        if (maxLon - minLon < 0.00015) {
          minLon -= 0.00015;
          maxLon += 0.00015;
        }
        mapInstance.fitBounds(
          [
            [minLat, minLon],
            [maxLat, maxLon],
          ],
          { padding: [36, 36], maxZoom: 18 }
        );
      } else if (targetVertices.length > 0) {
        mapInstance.setView([targetVertices[0].lat, targetVertices[0].lon], 17);
      } else {
        mapInstance.setView(
          [municipality.defaultCenter.lat, municipality.defaultCenter.lon],
          17
        );
      }
    },
    [municipality.defaultCenter.lat, municipality.defaultCenter.lon]
  );

  // Mount and clean up Leaflet map when modal opens
  useEffect(() => {
    if (!isOpen || !mapContainerRef.current) return;

    const initialCenter =
      initialVertices.length > 0
        ? initialVertices[0]
        : municipality.defaultCenter;

    const map = L.map(mapContainerRef.current, {
      center: [initialCenter.lat, initialCenter.lon],
      zoom: 17,
      zoomControl: false,
      attributionControl: true,
    });

    const tileLayer = new PolygonModalOfflineTileLayer({
      style: tileStyle,
      maxZoom: 19,
      tileCacheManager,
      parcelId,
    });
    tileLayer.addTo(map);
    tileLayerRef.current = tileLayer;

    const group = L.layerGroup().addTo(map);
    overlayGroupRef.current = group;

    map.on('click', (ev: L.LeafletMouseEvent) => {
      if (toolModeRef.current === 'DELETE_VERTEX') {
        return;
      }
      setValidationError(null);
      setDraftVertices((prev) => {
        const next = appendPolygonVertex(prev, {
          lat: ev.latlng.lat,
          lon: ev.latlng.lng,
        });
        setSelectedVertexIndex(next.length - 1);
        return next;
      });
    });

    mapRef.current = map;
    centerMapOnActiveGeometry(map, initialVertices);

    const rafId = window.requestAnimationFrame(() => {
      map.invalidateSize();
      centerMapOnActiveGeometry(map, initialVertices);
    });
    const timerId = window.setTimeout(() => {
      map.invalidateSize();
    }, 150);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      map.remove();
      mapRef.current = null;
      tileLayerRef.current = null;
      overlayGroupRef.current = null;
    };
    // Intentionally initialize once per open lifecycle; tileStyle updates in separate effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Swap tile style dynamically without destroying draft vertices
  useEffect(() => {
    const map = mapRef.current;
    if (!isOpen || !map) return;

    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }
    const nextLayer = new PolygonModalOfflineTileLayer({
      style: tileStyle,
      maxZoom: 19,
      tileCacheManager,
      parcelId,
    });
    nextLayer.addTo(map);
    tileLayerRef.current = nextLayer;
  }, [isOpen, tileStyle, tileCacheManager, parcelId]);

  // Render polygon + draggable/deletable vertex markers whenever draftVertices, toolMode, or selection change
  useEffect(() => {
    const group = overlayGroupRef.current;
    if (!isOpen || !group) return;

    group.clearLayers();

    if (draftVertices.length >= 3) {
      L.polygon(
        draftVertices.map((v) => [v.lat, v.lon] as [number, number]),
        {
          color: '#22C55E',
          weight: 2.5,
          fillColor: '#22C55E',
          fillOpacity: 0.22,
        }
      ).addTo(group);
    } else if (draftVertices.length === 2) {
      L.polyline(
        draftVertices.map((v) => [v.lat, v.lon] as [number, number]),
        {
          color: '#22C55E',
          weight: 2.5,
          dashArray: '6 4',
        }
      ).addTo(group);
    }

    const isDeleteMode = toolMode === 'DELETE_VERTEX';

    draftVertices.forEach((vertex, index) => {
      const isSelected = selectedVertexIndex === index;
      const badgeClasses = isDeleteMode
        ? 'w-7 h-7 rounded-full bg-[#DC2626] border-2 border-white text-white text-[10px] font-mono font-bold flex items-center justify-center shadow-md cursor-pointer'
        : isSelected
          ? 'w-7 h-7 rounded-full bg-[#FACC15] border-2 border-[#14532D] text-slate-950 text-[10px] font-mono font-bold flex items-center justify-center shadow-md cursor-grab'
          : 'w-6 h-6 rounded-full bg-[#14532D] border-2 border-white text-white text-[10px] font-mono font-bold flex items-center justify-center shadow-md cursor-grab';

      const labelText = isDeleteMode ? `V${index + 1}×` : `V${index + 1}`;
      const sizePx = isDeleteMode || isSelected ? 28 : 24;
      const anchorPx = sizePx / 2;

      const markerIcon = L.divIcon({
        className: 'fs-vertex-handle bg-transparent border-0',
        html: `<div data-testid="polygon-map-vertex-marker-${index}" class="${badgeClasses}">${labelText}</div>`,
        iconSize: [sizePx, sizePx],
        iconAnchor: [anchorPx, anchorPx],
      });

      const marker = L.marker([vertex.lat, vertex.lon], {
        draggable: !isDeleteMode,
        icon: markerIcon,
        title: isDeleteMode
          ? `Clique para apagar vértice V${index + 1} (${vertex.lat.toFixed(6)}, ${vertex.lon.toFixed(6)})`
          : `Vértice V${index + 1} (${vertex.lat.toFixed(6)}, ${vertex.lon.toFixed(6)}) · Arraste para mover ou clique para selecionar`,
      });

      marker.on('click', (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev);
        if (toolModeRef.current === 'DELETE_VERTEX') {
          handleDeleteVertexAt(index);
        } else {
          setSelectedVertexIndex(index);
        }
      });

      marker.on('contextmenu', (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev);
        handleDeleteVertexAt(index);
      });

      marker.on('dragend', () => {
        const pos = marker.getLatLng();
        setValidationError(null);
        setSelectedVertexIndex(index);
        setDraftVertices((prev) =>
          updatePolygonVertexAt(prev, index, {
            lat: pos.lat,
            lon: pos.lng,
          })
        );
      });

      marker.addTo(group);
    });
  }, [isOpen, draftVertices, toolMode, selectedVertexIndex, handleDeleteVertexAt]);

  if (!isOpen || typeof document === 'undefined') {
    return null;
  }

  const handleApply = () => {
    if (draftVertices.length < 3) {
      setValidationError(
        'Desenhe pelo menos 3 vértices no mapa para formar um polígono válido da propriedade.'
      );
      return;
    }
    onApplyVertices(draftVertices);
    onClose();
  };

  const handleUndoLastVertex = () => {
    if (draftVertices.length === 0) return;
    handleDeleteVertexAt(draftVertices.length - 1);
  };

  const handleResetDefaultPolygon = () => {
    const rect = buildDefaultRectangleAroundCenter(municipality.defaultCenter);
    setDraftVertices(rect);
    setSelectedVertexIndex(null);
    setToolMode('ADD_EDIT');
    setValidationError(null);
    if (mapRef.current) {
      centerMapOnActiveGeometry(mapRef.current, rect);
    }
  };

  const handleFocusVertex = (index: number) => {
    const target = draftVertices[index];
    if (!target) return;
    setSelectedVertexIndex(index);
    if (mapRef.current) {
      mapRef.current.panTo([target.lat, target.lon], { animate: true });
    }
  };

  const activeSelectedVertex =
    selectedVertexIndex !== null && draftVertices[selectedVertexIndex]
      ? { index: selectedVertexIndex, coord: draftVertices[selectedVertexIndex] }
      : null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="parcel-polygon-modal-title"
      data-testid="parcel-polygon-map-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
    >
      <div className="w-full max-w-5xl max-h-[95vh] rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] flex flex-col overflow-hidden">
        {/* Modal Header */}
        <div className="px-4 sm:px-5 py-3 border-b border-slate-200 dark:border-[#263248] flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums truncate">
              <span>Distrito: {municipality.district}</span>
              <span aria-hidden="true"> · </span>
              <span>
                Concelho: {municipality.name} (DICO {municipality.dico})
              </span>
              <span aria-hidden="true"> · </span>
              <span>Projeção Oficial ETRS89 / PT-TM06</span>
            </div>
            <h2
              id="parcel-polygon-modal-title"
              className="text-base sm:text-lg font-bold text-slate-900 dark:text-white truncate"
            >
              Desenhar e Editar Limites da Propriedade · {parcelLabel || 'Novo Terreno'}
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar janela de desenho no mapa"
            className="min-h-[40px] min-w-[40px] rounded-xl border border-slate-300 dark:border-[#263248] text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center justify-center shrink-0"
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {/* Drawing & Vertex Deletion Toolbar */}
        <div className="px-4 sm:px-5 py-2.5 bg-slate-50 dark:bg-[#0B0F17] border-b border-slate-200 dark:border-[#263248] flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <div
              role="group"
              aria-label="Modo de edição de vértices no mapa"
              className="inline-flex items-center gap-1 p-1 rounded-xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248]"
            >
              <button
                type="button"
                data-testid="polygon-modal-mode-add"
                onClick={() => setToolMode('ADD_EDIT')}
                className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  toolMode === 'ADD_EDIT'
                    ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                    : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
                }`}
              >
                <PenTool className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Adicionar / Mover</span>
              </button>

              <button
                type="button"
                data-testid="polygon-modal-mode-delete"
                disabled={draftVertices.length === 0}
                onClick={() =>
                  setToolMode((prev) => (prev === 'DELETE_VERTEX' ? 'ADD_EDIT' : 'DELETE_VERTEX'))
                }
                className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-45 ${
                  toolMode === 'DELETE_VERTEX'
                    ? 'bg-[#DC2626] text-white'
                    : 'text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30'
                }`}
              >
                <Eraser className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                <span>Apagar Vértice</span>
              </button>
            </div>

            <span className="text-xs text-slate-600 dark:text-slate-300 hidden xl:inline">
              {toolMode === 'DELETE_VERTEX'
                ? 'Clique sobre qualquer marcador V1..Vn no mapa para apagar esse vértice.'
                : 'Clique no mapa para adicionar pontos, arraste V1..Vn ou selecione um vértice para o apagar.'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <div
              role="group"
              aria-label="Fundo do mapa"
              className="inline-flex items-center gap-1 p-0.5 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-300 dark:border-[#263248]"
            >
              <button
                type="button"
                aria-pressed={tileStyle === 'ORTHOPHOTO'}
                onClick={() => setTileStyle('ORTHOPHOTO')}
                className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
                  tileStyle === 'ORTHOPHOTO'
                    ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                <Layers className="w-3.5 h-3.5" aria-hidden="true" />
                Ortofoto
              </button>
              <button
                type="button"
                aria-pressed={tileStyle === 'VECTOR'}
                onClick={() => setTileStyle('VECTOR')}
                className={`min-h-[34px] px-2.5 py-1 rounded-lg text-xs font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0 ${
                  tileStyle === 'VECTOR'
                    ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                    : 'text-slate-700 dark:text-slate-300'
                }`}
              >
                Topográfico
              </button>
            </div>

            <button
              type="button"
              disabled={draftVertices.length === 0}
              onClick={handleUndoLastVertex}
              className="min-h-[36px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-45 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
              Anular Último
            </button>

            <button
              type="button"
              data-testid="polygon-modal-clear-btn"
              disabled={draftVertices.length === 0}
              onClick={handleClearAllVertices}
              className="min-h-[36px] px-3 py-1.5 rounded-xl border border-rose-300 dark:border-rose-800/70 bg-white dark:bg-[#161E2E] text-xs font-semibold text-[#DC2626] dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/30 disabled:opacity-45 inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              Apagar Todos os Vértices
            </button>

            <button
              type="button"
              onClick={handleResetDefaultPolygon}
              className="min-h-[36px] px-3 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-xs font-semibold text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
            >
              Polígono no Concelho
            </button>
          </div>
        </div>

        {/* Interactive Leaflet Canvas */}
        <div className="relative flex-1 min-h-[260px] sm:min-h-[340px] bg-slate-900">
          <div
            ref={mapContainerRef}
            data-testid="parcel-polygon-leaflet-canvas"
            className="w-full h-[260px] sm:h-[340px]"
          />

          {/* Floating Selected Vertex Quick-Delete Bar on Map */}
          {activeSelectedVertex && toolMode === 'ADD_EDIT' && (
            <div
              data-testid="polygon-modal-selected-vertex-bar"
              className="absolute left-3 bottom-3 z-[500] rounded-xl bg-white/95 dark:bg-[#161E2E]/95 border border-slate-300 dark:border-[#263248] px-3 py-2 shadow-md flex flex-wrap items-center gap-2.5 text-xs"
            >
              <span className="font-mono font-bold text-slate-900 dark:text-white tabular-nums">
                V{activeSelectedVertex.index + 1} · {activeSelectedVertex.coord.lat.toFixed(6)},{' '}
                {activeSelectedVertex.coord.lon.toFixed(6)}
              </span>
              <button
                type="button"
                data-testid="polygon-modal-delete-selected-vertex"
                onClick={() => handleDeleteVertexAt(activeSelectedVertex.index)}
                className="min-h-[32px] px-2.5 py-1 rounded-lg bg-[#DC2626] hover:bg-rose-700 text-white font-semibold inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Apagar V{activeSelectedVertex.index + 1}</span>
              </button>
            </div>
          )}

          {toolMode === 'DELETE_VERTEX' && draftVertices.length > 0 && (
            <div className="absolute left-3 bottom-3 z-[500] rounded-xl bg-[#DC2626]/95 text-white px-3 py-1.5 shadow-md text-xs font-semibold">
              Modo Apagar Vértice ativo: clique num marcador V1..V{draftVertices.length} para o remover.
            </div>
          )}

          {/* Custom Accessible Zoom & Center Controls */}
          <div className="absolute right-3 top-3 z-[500] flex flex-col gap-1.5">
            <button
              type="button"
              onClick={() => mapRef.current?.zoomIn()}
              aria-label="Aproximar mapa de desenho"
              className="w-10 h-10 rounded-xl bg-white/95 dark:bg-[#161E2E]/95 border border-slate-300 dark:border-[#263248] text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center"
            >
              <Plus className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => mapRef.current?.zoomOut()}
              aria-label="Afastar mapa de desenho"
              className="w-10 h-10 rounded-xl bg-white/95 dark:bg-[#161E2E]/95 border border-slate-300 dark:border-[#263248] text-slate-900 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-center"
            >
              <Minus className="w-4 h-4" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => {
                if (mapRef.current) {
                  centerMapOnActiveGeometry(mapRef.current, draftVertices);
                }
              }}
              aria-label="Centrar vista na propriedade ou concelho"
              className="w-10 h-10 rounded-xl bg-[#14532D] dark:bg-[#22C55E] text-white dark:text-slate-950 flex items-center justify-center"
            >
              <LocateFixed className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Individual Vertex List & Per-Vertex Delete Controls */}
        <div
          data-testid="polygon-modal-vertex-list"
          className="px-4 sm:px-5 py-2.5 border-t border-slate-200 dark:border-[#263248] bg-slate-50 dark:bg-[#0B0F17] space-y-2"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="text-slate-600 dark:text-slate-300 tabular-nums">
              <strong className="text-slate-900 dark:text-white">
                Lista de Vértices ({draftVertices.length})
              </strong>
              <span aria-hidden="true"> · </span>
              <span>
                {draftVertices.length > 0
                  ? 'Clique num ponto para localizar no mapa ou no ícone de caixote para apagar individualmente'
                  : 'Sem vértices marcados — clique no mapa para desenhar os cantos da propriedade'}
              </span>
            </div>

            {draftVertices.length > 0 && (
              <button
                type="button"
                data-testid="polygon-modal-vertex-list-clear-all"
                onClick={handleClearAllVertices}
                className="text-xs font-semibold text-[#DC2626] dark:text-rose-400 hover:underline inline-flex items-center gap-1 whitespace-nowrap shrink-0"
              >
                <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                <span>Apagar todos ({draftVertices.length})</span>
              </button>
            )}
          </div>

          {draftVertices.length > 0 && (
            <div className="max-h-[96px] overflow-y-auto flex flex-wrap items-center gap-1.5 pr-1">
              {draftVertices.map((vertex, idx) => {
                const isSelected = selectedVertexIndex === idx;
                return (
                  <div
                    key={`${idx}-${vertex.lat}-${vertex.lon}`}
                    data-testid={`polygon-modal-vertex-item-${idx}`}
                    className={`inline-flex items-center rounded-xl border text-xs transition-colors ${
                      isSelected
                        ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D]/10 dark:bg-[#22C55E]/15 text-slate-900 dark:text-white'
                        : 'border-slate-300 dark:border-[#263248] bg-white dark:bg-[#161E2E] text-slate-800 dark:text-slate-200'
                    }`}
                  >
                    <button
                      type="button"
                      data-testid={`polygon-modal-select-vertex-${idx}`}
                      onClick={() => handleFocusVertex(idx)}
                      className="min-h-[34px] px-2.5 py-1 font-mono tabular-nums inline-flex items-center gap-1.5 whitespace-nowrap"
                    >
                      <span className="font-bold text-[#14532D] dark:text-[#4ADE80]">
                        V{idx + 1}
                      </span>
                      <span>
                        {vertex.lat.toFixed(5)}, {vertex.lon.toFixed(5)}
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid={`polygon-modal-delete-vertex-${idx}`}
                      aria-label={`Apagar vértice V${idx + 1}`}
                      title={`Apagar vértice V${idx + 1}`}
                      onClick={() => handleDeleteVertexAt(idx)}
                      className="min-h-[34px] min-w-[32px] px-2 border-l border-slate-200 dark:border-[#263248] text-slate-500 hover:text-[#DC2626] dark:text-slate-400 dark:hover:text-rose-400 inline-flex items-center justify-center transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Live EPSG:3763 Area Readout & Footer Actions */}
        <div className="px-4 sm:px-5 py-3 border-t border-slate-200 dark:border-[#263248] bg-white dark:bg-[#161E2E] space-y-2">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div
              data-testid="polygon-modal-live-metrics"
              className="text-xs text-slate-600 dark:text-slate-300 tabular-nums flex flex-wrap items-center gap-x-2.5 gap-y-1"
            >
              <span>
                Vértices:{' '}
                <strong className="font-mono text-slate-900 dark:text-white">
                  {draftVertices.length}
                </strong>
              </span>
              {liveMetrics ? (
                <>
                  <span aria-hidden="true">·</span>
                  <span>
                    Área Total:{' '}
                    <strong className="font-mono text-slate-900 dark:text-white">
                      {liveMetrics.totalAreaM2.toFixed(0)} m²
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Faixa Obrigatória (FGC):{' '}
                    <strong className="font-mono text-[#14532D] dark:text-[#4ADE80]">
                      {liveMetrics.mandatoryCleanAreaM2.toFixed(0)} m²
                    </strong>
                  </span>
                </>
              ) : (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-700 dark:text-amber-400 font-medium">
                    Clique em pelo menos {Math.max(1, 3 - draftVertices.length)} ponto(s) adicional(is) no mapa para fechar o polígono.
                  </span>
                </>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={onClose}
                className="min-h-[40px] px-4 py-2 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0"
              >
                Cancelar
              </button>
              <button
                type="button"
                data-testid="polygon-modal-apply-btn"
                onClick={handleApply}
                className="min-h-[40px] px-4 sm:px-5 py-2 rounded-xl bg-[#14532D] hover:bg-[#166534] dark:bg-[#22C55E] dark:hover:bg-[#16A34A] text-white dark:text-slate-950 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0"
              >
                <Check className="w-4 h-4" aria-hidden="true" />
                Aplicar Polígono aos Vértices WGS84
              </button>
            </div>
          </div>

          {validationError && (
            <p role="alert" className="text-xs font-semibold text-[#DC2626]">
              {validationError}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
