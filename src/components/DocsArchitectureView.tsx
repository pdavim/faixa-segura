import React, { useState } from 'react';
import { Check, Copy, Database, FileSpreadsheet, Layers, Server } from 'lucide-react';

const POSTGIS_SNIPPET = `-- Motor Espacial Determinístico em ETRS89 / PT-TM06 (EPSG:3763)
SELECT
  ROUND(ST_Area(v_parcel)::NUMERIC, 2) AS total_area_m2,
  ROUND(ST_Area(ST_Difference(ST_Intersection(v_parcel, ST_Buffer(v_buildings, 2.0)), v_third_party))::NUMERIC, 2) AS z1_inerte_0_2m,
  ROUND(ST_Area(ST_Difference(ST_Intersection(v_parcel, ST_Difference(ST_Buffer(v_buildings, 10.0), ST_Buffer(v_buildings, 2.0))), v_third_party))::NUMERIC, 2) AS z2_proxima_2_10m,
  ROUND(ST_Area(ST_Difference(ST_Intersection(v_parcel, ST_Difference(ST_Buffer(v_buildings, 50.0), ST_Buffer(v_buildings, 10.0))), v_third_party))::NUMERIC, 2) AS z3_alargada_10_50m,
  ROUND(ST_Area(v_third_party)::NUMERIC, 2) AS servidao_eredes_m2
FROM faixasegura.compute_parcel_fgc(:parcel_wgs84);`;

const DOCKER_REDIS_SNIPPET = `# Chaves em Memória Redis 7 (Polling assíncrono isolado do cliente móvel)
HSET fs:pir:1111 today 4 tomorrow 3 day2 2 updated_at "2026-05-24T08:00:00Z"
EXPIRE fs:pir:1111 3600

# Radar Geoespacial ANEPC (a cada 180s)
GEOADD fs:active_fires -9.2412 38.9195 "inc_2026_88412"
GEOSEARCH fs:active_fires FROMLONLAT -9.4621 38.7984 BYRADIUS 15 km WITHDIST ASC`;

export const DocsArchitectureView: React.FC = () => {
  const [activeDocTab, setActiveDocTab] = useState<'prd' | 'apis' | 'spatial' | 'roadmap'>('prd');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const copyCode = async (id: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setCopiedId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 flex flex-col gap-4">
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-slate-900 dark:text-white">
            Documentação Técnica Detalhada & PRD — FaixaSegura (2026)
          </h2>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            Arquitetura isolada (PostgreSQL 16 + PostGIS 3.4, Redis 7, Node/TS, ollama.innovaive.com) · DL n.º 82/2021 + Despacho n.º 675/2026
          </p>
        </div>

        <div
          role="group"
          aria-label="Secções da documentação técnica"
          className="flex flex-wrap items-center gap-1.5 p-1.5 rounded-xl bg-slate-100 dark:bg-[#0B0F17] border border-slate-200 dark:border-[#263248]"
        >
          <button
            type="button"
            onClick={() => setActiveDocTab('prd')}
            className={`min-h-[40px] px-3.5 py-1.5 rounded-lg border text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              activeDocTab === 'prd'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            01. PRD & Benchmark
          </button>
          <button
            type="button"
            onClick={() => setActiveDocTab('apis')}
            className={`min-h-[40px] px-3.5 py-1.5 rounded-lg border text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              activeDocTab === 'apis'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            02. 8 APIs & IA Privada
          </button>
          <button
            type="button"
            onClick={() => setActiveDocTab('spatial')}
            className={`min-h-[40px] px-3.5 py-1.5 rounded-lg border text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              activeDocTab === 'spatial'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            03. PostGIS & Despacho 675/2026
          </button>
          <button
            type="button"
            onClick={() => setActiveDocTab('roadmap')}
            className={`min-h-[40px] px-3.5 py-1.5 rounded-lg border text-xs font-semibold whitespace-nowrap shrink-0 transition-colors ${
              activeDocTab === 'roadmap'
                ? 'border-[#14532D] dark:border-[#22C55E] bg-[#14532D] text-white dark:bg-[#22C55E] dark:text-slate-950'
                : 'border-transparent bg-transparent text-slate-700 dark:text-slate-300 hover:text-slate-950 dark:hover:text-white'
            }`}
          >
            04. Modelo Negócio & Roadmap
          </button>
        </div>
      </div>

      {/* TAB 1: PRD & BENCHMARK */}
      {activeDocTab === 'prd' && (
        <div className="space-y-6">
          <section className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 overflow-x-auto">
            <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-4">
              <FileSpreadsheet className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              01. Benchmark de Mercado: Comparação com Soluções Semelhantes
            </h2>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#263248] text-slate-500 dark:text-slate-400">
                  <th className="py-2.5 pr-4 font-semibold">Plataforma</th>
                  <th className="py-2.5 pr-4 font-semibold">Foco Principal</th>
                  <th className="py-2.5 pr-4 font-semibold">Pontos Fortes</th>
                  <th className="py-2.5 font-semibold">Vantagem Diferenciadora FaixaSegura</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-[#263248] text-slate-700 dark:text-slate-300">
                <tr>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-white">App BUPi / eBUPi (Estado)</td>
                  <td className="py-3 pr-4">Georreferenciação cadastral gratuita (RGG).</td>
                  <td className="py-3 pr-4">Dados abertos oficiais e adoção massiva.</td>
                  <td className="py-3">BUPi não calcula faixas 2m/10m/50m nem alerta prazos; no FaixaSegura serve de importação em 1 toque.</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-white">Queimas e Queimadas (ICNF)</td>
                  <td className="py-3 pr-4">Comunicação prévia / autorização de queimas.</td>
                  <td className="py-3 pr-4">Canal administrativo vinculativo junto da GNR.</td>
                  <td className="py-3">FaixaSegura abrange maquinaria mecânica (roçadoras metálicas vs nylon) num cockpit solar simples.</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-white">Fogos.pt / Google Wildfire</td>
                  <td className="py-3 pr-4"> Emergência ativa e meios ANEPC em curso.</td>
                  <td className="py-3 pr-4">Rapidez exemplar após ignição.</td>
                  <td className="py-3">100% reativos; o FaixaSegura atua preventivamente meses antes, evitando coimas e sinistros.</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-white">Tesselo / Overstory (B2B)</td>
                  <td className="py-3 pr-4">Biomassa satélite para utilities elétricas.</td>
                  <td className="py-3 pr-4">Elevado rigor multiespectral Sentinel-2.</td>
                  <td className="py-3">Democratiza o índice NDVI Sentinel-2 gratuitamente/14,90€ para famílias em Sintra, Leiria ou Valongo.</td>
                </tr>
                <tr>
                  <td className="py-3 pr-4 font-semibold text-slate-900 dark:text-white">Fire Aside (EUA — WUI)</td>
                  <td className="py-3 pr-4">Relatórios defensivos casa-a-casa e seguros.</td>
                  <td className="py-3 pr-4">Prova acionável validada por seguradoras.</td>
                  <td className="py-3">Adaptado ao DL 82/2021 português sem depender de vistoria prévia presencial dos bombeiros.</td>
                </tr>
              </tbody>
            </table>
          </section>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                02. Quatro Dores Reais Resolvidas (AML, AMP e 7 Distritos)
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                1. <strong>Incerteza Geométrica:</strong> Separa exatamente os metros obrigatórios (0–2 m, 2–10 m, 10–50 m) da zona isenta e das linhas aéreas E-REDES.<br />
                2. <strong>Risco Contraordenacional ao Sábado:</strong> Traduz o índice IPMA (RCM 1–5) em permissão clara para fio de nylon vs. disco metálico.<br />
                3. <strong>Vizinho Incumpridor:</strong> Gera requerimento técnico fundamentado com GeoJSON pronto para execução coerciva camarária.<br />
                4. <strong>Prova Auditável Tardias:</strong> Emite Auto PDF SHA-256 com fotos Antes/Depois georreferenciadas quando a fiscalização ocorre meses após rebentação.
              </p>
            </div>
            <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-2">
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                03. Princípios Mobile & Tablet-First ("Solar Field Mode")
              </h3>
              <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
                Desenhado com superfície clara anti-reflexo por omissão (<code>#F8FAFC</code> / <code>#14532D</code>), contornos cartográficos de alta visibilidade sobre ortofoto verde-escura (<code>#FACC15</code> amarelo laser, <code>#E11D48</code> carmesim, <code>#06B6D4</code> ciano elétrico), alvos táteis mínimos de 44×44 px para operação no terreno e vista dividida em tablets.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: 8 APIS & OLLAMA */}
      {activeDocTab === 'apis' && (
        <div className="space-y-6">
          <section className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 overflow-x-auto">
            <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2 mb-4">
              <Server className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
              Catálogo Exato de 8 APIs e Fontes de Dados Abertas (Zero Custo)
            </h2>
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-[#263248] text-slate-500 dark:text-slate-400">
                  <th className="py-2 pr-4">Domínio</th>
                  <th className="py-2 pr-4">Entidade Oficial</th>
                  <th className="py-2 pr-4">Serviço / Endpoint</th>
                  <th className="py-2">Estratégia de Cache / Sync</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 dark:divide-[#263248] text-slate-700 dark:text-slate-300">
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">1. COS, CAOP & Ortofotos 25cm</td>
                  <td className="py-2.5 pr-4">DGT</td>
                  <td className="py-2.5 pr-4 font-mono">ogcapi.dgterritorio.gov.pt/collections/</td>
                  <td className="py-2.5">Semestral em PostGIS + Proxy WMS Tiles</td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">2. Polígonos Rústicos RGG</td>
                  <td className="py-2.5 pr-4">eBUPi / Dados.gov.pt</td>
                  <td className="py-2.5 pr-4 font-mono">bupi.gov.pt / datasets RGG</td>
                  <td className="py-2.5">Mensal em PostGIS (Snap-to-Parcel 1 toque)</td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">3. Perigosidade Estrutural</td>
                  <td className="py-2.5 pr-4">ICNF</td>
                  <td className="py-2.5 pr-4 font-mono">geocatalogo.icnf.pt (Art. 41.º DL 82/2021)</td>
                  <td className="py-2.5">Anual (Fev/Mar antes da época crítica)</td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">4. Edificado & Altimetria</td>
                  <td className="py-2.5 pr-4">GEO API PT + OSM + DGT</td>
                  <td className="py-2.5 pr-4 font-mono">json.geoapi.pt/gps/&#123;lat&#125;,&#123;lon&#125;</td>
                  <td className="py-2.5">Redis TTL 30 dias (Buffers 50m + Declive %)</td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">5. Linhas Aéreas MT / AT</td>
                  <td className="py-2.5 pr-4">E-REDES Open Data</td>
                  <td className="py-2.5 pr-4 font-mono">e-redes.opendatasoft.com/api/explore/v2.1</td>
                  <td className="py-2.5">Trimestral em PostGIS (Isenção 7m–10m)</td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">6. Índice Diário PIR (rcm)</td>
                  <td className="py-2.5 pr-4">IPMA Open Data</td>
                  <td className="py-2.5 pr-4 font-mono">api.ipma.pt/.../rcm/rcm-d&#123;0,1,2&#125;.json</td>
                  <td className="py-2.5">Horário em Redis (TTL 3600s por DICO)</td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">7. Fogos Rurais Ativos</td>
                  <td className="py-2.5 pr-4">API Aberta / ANEPC</td>
                  <td className="py-2.5 pr-4 font-mono">api.apiaberta.pt/v1/anpc/incidents/active</td>
                  <td className="py-2.5">A cada 3 min em Redis Geospatial (15 km)</td>
                </tr>
                <tr>
                  <td className="py-2.5 pr-4 font-semibold">8. Biomassa NDVI / NDMI</td>
                  <td className="py-2.5 pr-4">Copernicus ESA</td>
                  <td className="py-2.5 pr-4 font-mono">sh.dataspace.copernicus.eu (sentinel-2-l2a)</td>
                  <td className="py-2.5">A cada 5–10 dias (cloud_cover &lt; 20%)</td>
                </tr>
              </tbody>
            </table>
          </section>

          <section className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-2">
            <h3 className="text-sm font-bold text-slate-900 dark:text-white">
              Integração Cirúrgica com https://ollama.innovaive.com (Circuit Breaker + RGPD)
            </h3>
            <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed">
              O LLM nunca intervém em cálculos geométricos (100% determinísticos em <code>EPSG:3763</code>). Os modelos <code>gemma3:4b</code> (visão multimodal e redação formal PT-PT) e <code>qwen3:4b</code> (extração e RAG jurídico sobre o DL 82/2021) processam localmente Cadernetas Prediais das Finanças, validam pares fotográficos Antes/Depois (alertando proteção de Sobreiros/Azinheiras sob DL 169/2001) e redigem requerimentos camarários, com fallback determinístico instantâneo caso o endpoint remoto exceda o timeout.
            </p>
          </section>
        </div>
      )}

      {/* TAB 3: POSTGIS & DESPACHO 675/2026 */}
      {activeDocTab === 'spatial' && (
        <div className="space-y-5">
          <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Database className="w-4 h-4 text-[#14532D] dark:text-[#22C55E]" aria-hidden="true" />
                Motor Espacial PostGIS em ETRS89 / PT-TM06 (EPSG:3763)
              </h2>
              <button
                type="button"
                onClick={() => copyCode('postgis', POSTGIS_SNIPPET)}
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold inline-flex items-center gap-1.5"
              >
                {copiedId === 'postgis' ? <Check className="w-3.5 h-3.5 text-[#16A34A]" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === 'postgis' ? 'Copiado' : 'Copiar Query SQL'}
              </button>
            </div>
            <p className="text-xs text-slate-600 dark:text-slate-400">
              O ficheiro completo <code>/db/schema_postgis.sql</code> e o <code>/docker-compose.yml</code> autónomo estão incluídos na raiz do repositório.
            </p>
            <pre className="p-4 rounded-xl bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed">
              {POSTGIS_SNIPPET}
            </pre>
          </div>

          <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                <Layers className="w-4 h-4 text-[#0284C7]" aria-hidden="true" />
                Estrutura Geoespacial em Memória no Redis 7
              </h2>
              <button
                type="button"
                onClick={() => copyCode('redis', DOCKER_REDIS_SNIPPET)}
                className="min-h-[40px] px-3 py-1.5 rounded-lg border border-slate-300 dark:border-[#263248] text-xs font-semibold inline-flex items-center gap-1.5"
              >
                {copiedId === 'redis' ? <Check className="w-3.5 h-3.5 text-[#16A34A]" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedId === 'redis' ? 'Copiado' : 'Copiar Comandos Redis'}
              </button>
            </div>
            <pre className="p-4 rounded-xl bg-slate-950 text-slate-100 text-xs font-mono overflow-x-auto leading-relaxed">
              {DOCKER_REDIS_SNIPPET}
            </pre>
          </div>
        </div>
      )}

      {/* TAB 4: BUSINESS MODEL & ROADMAP */}
      {activeDocTab === 'roadmap' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-3">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Motores de Receita (B2C Freemium + Lead Gen B2B + Afiliados)
            </h2>
            <div className="space-y-2.5 text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
              <p>
                <strong>01. Marketplace de Limpeza Florestal (Receita Principal):</strong> Leads ultra-qualificadas com área em m², declive MDT e acesso viário (valor de 8 € a 20 €/lead ou comissão sobre limpezas médias de 350 €–1.500 €).
              </p>
              <p>
                <strong>02. Plano Guardião B2C (14,90 €/ano):</strong> Até 10 terrenos (heranças familiares), alertas Telegram 24/7, histórico Sentinel-2 e emissão ilimitada de Autos SHA-256 e requerimentos GTF.
              </p>
              <p>
                <strong>03. Afiliados Contextuais & Seguros Multirriscos:</strong> Cabeças de fio de polímero e equipamentos sem faísca nos dias de risco Elevado/Muito Elevado + mediação de seguro habitação em interface florestal certificada.
              </p>
            </div>
          </div>

          <div className="rounded-2xl bg-white dark:bg-[#161E2E] border border-slate-300 dark:border-[#263248] p-5 space-y-2.5">
            <h2 className="text-base font-bold text-slate-900 dark:text-white">
              Roadmap de Execução em 5 Fases
            </h2>
            <div className="divide-y divide-slate-200 dark:divide-[#263248] text-xs text-slate-700 dark:text-slate-300">
              <div className="py-2"><strong>Fase 1:</strong> Core PostGIS isolado, ingestão CAOP/COS/ICNF e workers IPMA + ANEPC.</div>
              <div className="py-2"><strong>Fase 2:</strong> Motor <code>compute_parcel_fgc</code> (EPSG:3763), linhas MT/AT E-REDES e Snap-to-Parcel BUPi.</div>
              <div className="py-2"><strong>Fase 3:</strong> PWA Mobile/Tablet Solar-First, Semáforo Operacional e <code>@FaixaSeguraBot</code>.</div>
              <div className="py-2"><strong>Fase 4:</strong> Pipeline Copernicus Sentinel-2 (NDVI/NDMI) e ponte <code>ollama.innovaive.com</code>.</div>
              <div className="py-2"><strong>Fase 5:</strong> Autos PDF vetoriais SHA-256, dossiê SIG <code>/gtf/</code> e portal <code>/prestadores</code>.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
