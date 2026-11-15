import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import {
  FileText,
  Layers,
  MapPin,
  PenTool,
  PlusCircle,
  RotateCcw,
  ShieldAlert,
  Zap,
} from 'lucide-react';
import type {
  ActiveFireIncident,
  LandClass,
  LatLon,
  MunicipalityInfo,
  ParcelRecord,
} from '../types/domain.ts';
import { computePolygonMetrics3763 } from '../lib/spatialEngine.ts';

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
  const [newParcelLabel, setNewParcelLabel] = useState('');
  const [newParcelDico, setNewParcelDico] = useState(activeParcel.dico);
  const [newParcelLandClass, setNewParcelLandClass] = useState<LandClass>('FOREST_SCRUB');
  const [newParcelEredes, setNewParcelEredes] = useState(true);
  const [savingParcel, setSavingParcel] = useState(false);
  const [drawError, setDrawError] = useState<string | null>(null);

  // Caderneta Predial extraction state
  const [cadernetaText, setCadernetaText] = useState('');
  const [extractingCaderneta, setExtractingCaderneta] = useState(false);
  const [selectedZoneCallout, setSelectedZoneCallout] = useState<string | null>(null);

  const mapToolModeRef = useRef(mapToolMode);
  mapToolModeRef.current = mapToolMode;

  // Initialize Leaflet Map once
  useEffect(() => {
    if (!mapContainerRef.current || mapInstanceRef.current) return;

    const center = activeParcel.spatial.centroidWgs84;
    const map = L.map(mapContainerRef.current, {
      center: [center.lat, center.lon],
      zoom: 18,
      zoomControl: true,
    });

    const orthoLayer = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      {
        maxZoom: 19,
        attribution: 'Ortofoto / Satélite DGT & Esri · EPSG:3763 Motor FaixaSegura',
      }
    ).addTo(map);

    tileLayerRef.current = orthoLayer;
    overlaysGroupRef.current = L.layerGroup().addTo(map);
    mapInstanceRef.current = map;

    map.on('click', (ev: L.LeafletMouseEvent) => {
      if (mapToolModeRef.current === 'DRAW') {
        setDrawnVertices((prev) => [
          ...prev,
          { lat: Number(ev.latlng.lat.toFixed(6)), lon: Number(ev.latlng.lng.toFixed(6)) },
        ]);
      }
    });

    return () => {
      map.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  // Switch tile layer (Orthophoto vs Vector)
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    if (tileLayerRef.current) {
      map.removeLayer(tileLayerRef.current);
    }

    const url =
      baseMapStyle === 'ORTHOPHOTO'
        ? 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
        : 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png';

    tileLayerRef.current = L.tileLayer(url, {
      maxZoom: 19,
      attribution:
        baseMapStyle === 'ORTHOPHOTO'
          ? 'Ortofoto Aérea / Satélite · Motor EPSG:3763'
          : 'Cartografia Vetorial OpenStreetMap / CARTO',
    }).addTo(map);
  }, [baseMapStyle]);

  // Recenter when activeParcel changes
  useEffect(() => {
    const map = mapInstanceRef.current;
    if (!map) return;
    const c = activeParcel.spatial.centroidWgs84;
    map.setView([c.lat, c.lon], 18, { animate: false });
    setSelectedZoneCallout(null);
  }, [activeParcel.id]);

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

    // 7. Drawn vertices preview when in DRAW mode
    if (drawnVertices.length > 0) {
      drawnVertices.forEach((pt, idx) => {
        L.circleMarker([pt.lat, pt.lon], {
          radius: 6,
          color: '#FFFFFF',
          weight: 2,
          fillColor: '#FACC15',
          fillOpacity: 1,
        })
          .bindTooltip(`Vértice ${idx + 1}`, { permanent: false })
          .addTo(group);
      });
      if (drawnVertices.length >= 2) {
        L.polygon(toLatLngs(drawnVertices), {
          color: '#38BDF8',
          weight: 2.5,
          fillColor: '#38BDF8',
          fillOpacity: 0.25,
        }).addTo(group);
      }
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
  }, [activeParcel, visibleLayers, drawnVertices, fires]);

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
      } else {
        onCreateParcel(data);
        setDrawnVertices([]);
        setNewParcelLabel('');
        setMapToolMode('INSPECT');
      }
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
      const res = await fetch('/api/ai/caderneta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rawText }),
      });
      const extracted = await res.json();
      if (res.ok) {
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
          const created = await createRes.json();
          onCreateParcel(created);
          setCadernetaText('');
          setMapToolMode('INSPECT');
        }
      }
    } finally {
      setExtractingCaderneta(false);
    }
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

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Modo de interação cartográfica"
            className="flex items-center gap-1 p-1 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
          >
            <button
              type="button"
              onClick={() => setMapToolMode('INSPECT')}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                mapToolMode === 'INSPECT'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
              BUPi / Zonas
            </button>
            <button
              type="button"
              onClick={() => setMapToolMode('DRAW')}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                mapToolMode === 'DRAW'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              <PenTool className="w-3.5 h-3.5" aria-hidden="true" />
              Desenhar Lote
            </button>
            <button
              type="button"
              onClick={() => setMapToolMode('CADERNETA')}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors inline-flex items-center gap-1.5 whitespace-nowrap ${
                mapToolMode === 'CADERNETA'
                  ? 'bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                  : 'text-slate-700 dark:text-slate-300'
              }`}
            >
              <FileText className="w-3.5 h-3.5" aria-hidden="true" />
              Caderneta AT
            </button>
          </div>

          <button
            type="button"
            onClick={() =>
              setBaseMapStyle((prev) => (prev === 'ORTHOPHOTO' ? 'VECTOR' : 'ORTHOPHOTO'))
            }
            className="min-h-[42px] px-3.5 py-1.5 rounded-xl border border-slate-300 dark:border-[#263248] text-xs font-semibold text-slate-800 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
          >
            <Layers className="w-3.5 h-3.5" aria-hidden="true" />
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
              className="w-full h-[380px] sm:h-[460px] z-0"
            />
          </div>

          {/* Layer Visibility Toggles (Solar high-contrast) */}
          <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-3.5 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-slate-600 dark:text-slate-400 mr-1">
              Camadas Espaciais:
            </span>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, zones675: !v.zones675 }))}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-2 ${
                visibleLayers.zones675
                  ? 'border-[#E11D48] bg-[#E11D48]/10 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#E11D48]" aria-hidden="true" />
              Faixas 0–2–10–50m
            </button>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, eredes: !v.eredes }))}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-2 ${
                visibleLayers.eredes
                  ? 'border-[#06B6D4] bg-[#06B6D4]/10 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#06B6D4]" aria-hidden="true" />
              Servidão E-REDES
            </button>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, exempt: !v.exempt }))}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-2 ${
                visibleLayers.exempt
                  ? 'border-[#16A34A] bg-[#4ADE80]/15 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#4ADE80]" aria-hidden="true" />
              Zona Isenta
            </button>
            <button
              type="button"
              onClick={() => setVisibleLayers((v) => ({ ...v, neighborRisk: !v.neighborRisk }))}
              className={`min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors inline-flex items-center gap-2 ${
                visibleLayers.neighborRisk
                  ? 'border-[#A855F7] bg-[#A855F7]/15 text-slate-900 dark:text-white'
                  : 'border-slate-300 dark:border-slate-700 text-slate-500'
              }`}
            >
              <span className="w-2.5 h-2.5 rounded-sm bg-[#A855F7]" aria-hidden="true" />
              Vizinho em Risco
            </button>
          </div>

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
              <div className="flex items-center justify-between">
                <h2 className="text-base font-bold text-slate-900 dark:text-white">
                  Desenhar Novo Polígono no Mapa
                </h2>
                <button
                  type="button"
                  onClick={() => setDrawnVertices([])}
                  className="min-h-[40px] px-2.5 py-1 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 inline-flex items-center gap-1"
                >
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Limpar Pontos ({drawnVertices.length})
                </button>
              </div>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Toque em 3 ou mais vértices sobre a ortofoto para calcular imediatamente as coroas legais em EPSG:3763.
              </p>

              <div className="rounded-xl p-3 bg-slate-50 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248] text-xs font-mono tabular-nums flex items-center justify-between">
                <span>Vértices marcados: {drawnVertices.length}</span>
                <span>Área EPSG:3763: {drawnMetrics.areaM2.toLocaleString('pt-PT')} m²</span>
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

            <div className="pt-2 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'certificate')}
                className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#14532D] hover:bg-[#0F3F22] dark:bg-[#22C55E] dark:text-slate-950 text-white text-xs font-semibold transition-colors"
              >
                Certificar Limpeza SHA-256
              </button>
              <button
                type="button"
                onClick={() => onNavigateTab('certify', 'quotes')}
                className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#D97706] hover:bg-[#B45309] text-white text-xs font-semibold transition-colors"
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
