# FaixaSegura — Documento de Arquitetura Técnica e PRD Completo (2026)

> **Âmbito Legal e Territorial:** Decreto-Lei n.º 82/2021 (SGIFR, na sua redação atualizada) e **Despacho n.º 675/2026, de 21 de janeiro** (normas técnicas das 3 zonas de interface). Cobertura imediata da **Área Metropolitana de Lisboa (AML)**, **Área Metropolitana do Porto (AMP)** e **7 Distritos Críticos do Centro/Norte** (Leiria, Coimbra, Aveiro, Santarém, Viseu, Castelo Branco e Braga).

---

## 1. Visão Executiva e Proposta de Valor

O **FaixaSegura** converte a complexidade jurídica, cartográfica e meteorológica da gestão de combustível rural em Portugal numa **WebApp Mobile & Tablet-First (PWA)** de diagnóstico instantâneo ao centímetro, vigilância multiespectral por satélite e prova documental criptográfica (`SHA-256`).

Responde diretamente às três perguntas críticas de qualquer proprietário ou herdeiro:
1. **"Quais os metros quadrados exatos que sou obrigado a limpar — e o que pertence à E-REDES ou à Câmara?"**
2. **"Posso usar motorroçadora de lâmina metálica, motosserra ou fazer queima este sábado sem incorrer em contraordenação grave?"**
3. **"Como provo à GNR/SEPNA, à Câmara Municipal e à Seguradora Multirriscos que limpei dentro do prazo legal — e como exijo limpeza coerciva ao terreno vizinho abandonado?"**

---

## 2. Benchmark de Mercado: Comparação com Soluções Existentes

| Plataforma | Foco Principal | Pontos Fortes | Limitações face ao FaixaSegura |
| :--- | :--- | :--- | :--- |
| **App BUPi / GeoPortal eBUPi** *(Justiça / DGT)* | Georreferenciação gratuita de limites rústicos (RGG). | Dados abertos oficiais; adoção massiva em 2025–2026. | Não calcula faixas de 2m/10m/50m/100m, não alerta prazos nem liga a prestadores. *(No FaixaSegura funciona como fonte de importação em 1 toque).* |
| **Queimas e Queimadas** *(ICNF)* | Registo obrigatório e autorização autárquica de queimas. | Canal administrativo vinculativo perante GNR e Câmaras. | Interface pouco ergonómica no terreno; ignora maquinaria mecânica (motorroçadoras/discos) e crescimento do mato. |
| **Fogos.pt / Fogos Agora PT** | Monitorização em tempo real de incêndios ativos ANEPC. | Rapidez exemplar em emergência reativa. | 100% reativos: atuam quando o fogo já deflagrou; não previnem coimas nem apoiam a gestão preventiva antes de 31 de maio. |
| **Tesselo / Overstory / E-REDES** *(B2B Enterprise)* | Monitorização satélite e IA de biomassa junto a linhas elétricas. | Elevada precisão multiespectral Sentinel-2. | Exclusivos para utilities/grandes gestores florestais (contratos de dezenas de milhares de euros); inacessíveis a famílias. |
| **Fire Aside** *(EUA — Defensible Space)* | Inspeção digital de faixas defensivas para moradores e seguradoras. | Modelo validado de relatório fotográfico acionável. | Exclusivo para o mercado norte-americano e dependente de vistoria presencial prévia dos bombeiros. |

---

## 3. Product Requirements Document (PRD) — 4 Motores de Utilidade Contínua

### 3.1 Motor 1: Raio-X Geométrico da Parcela (`EPSG:3763` + Despacho n.º 675/2026)
- Seleção em 1 toque (**Snap-to-Parcel BUPi RGG**), desenho sobre ortofoto DGT (25–30 cm) ou extração automática de **Caderneta Predial**.
- Decomposição métrica exata em **ETRS89 / PT-TM06 (`EPSG:3763`)**:
  - **Zona 1 — Interface Imediata (`0–2 m` da alvenaria):** Faixa inerte (`#E11D48`), eliminação total de vegetação e manta morta.
  - **Zona 2 — Interface Próxima (`2–10 m`):** Desbaste rigoroso (`#EA580C`), desramação a 50% / mín. 4 m, zero projeção de copas a `< 5 m` de paredes/telhados.
  - **Zona 3 — Interface Alargada (`10–50 m` florestal ou `10–100 m` aglomerado):** Controlo do estrato arbustivo (`#F59E0B`) e afastamento entre copas (`4 m` geral; `10 m` pinheiro-bravo e eucalipto).
  - **Servidão de Terceiros (`#06B6D4`):** Corredores de `7–10 m` sob linhas aéreas MT/AT da **E-REDES** ou rede viária municipal — subtraídos da conta do proprietário, quantificando a poupança estimada em euros!
  - **Zona Interior Isenta (`#4ADE80`):** Área fora de qualquer buffer legal.

### 3.2 Motor 2: Semáforo Operacional Diário e Fim de Semana (IPMA `rcm` 3 Dias)
- Cruza o índice oficial de Perigo de Incêndio Rural (`rcm` 1 a 5 por código `DICO`) com vento, temperatura e humidade relativa.
- Determina sem ambiguidade se hoje, amanhã ou no fim de semana é permitido operar **Motorroçadora com Fio de Nylon**, **Lâmina Metálica / Motosserra / Grade de Discos** ou **Queima de Amontoados**.
- Quando o risco proíbe lâmina metálica (Níveis 4 e 5), sugere alternativas legais sem faísca (cabeças de fio de polímero reforçado e equipamentos a bateria).

### 3.3 Motor 3: Sentinela Satélite (Sentinel-2 NDVI/NDMI) + Radar ANEPC 15 km
- Série quinzenal das bandas `B04 (Red)`, `B08 (NIR)` e `B11 (SWIR)` do **Copernicus Sentinel-2 L2A** (10 m de resolução):
  - `NDVI > 0.55`: alerta de regeneração arbustiva densa.
  - Queda abrupta de `NDMI`: alerta de stresse hídrico / mato seco altamente inflamável.
- Cruzamento geoespacial a cada 3 minutos com ocorrências rurais ativas da **ANEPC** num raio de `15 km`.

### 3.4 Motor 4: Auto Digital `SHA-256` + Requerimento "Vizinho Incumpridor" + Marketplace `/prestadores`
- **Auto Digital de Conformidade Preventiva (PDF A4 Vetorial — 2 Páginas):** Registo fotográfico Antes/Depois georreferenciado (GPS + Azimute da bússola), verificação preventiva de quercíneas protegidas (*Sobreiro* e *Azinheira* — DL n.º 169/2001), assinatura criptográfica `SHA-256` e QR Code público `/v/[código]`.
- **Requerimento Formal "Vizinho Incumpridor" (PDF A4 + Dossiê SIG `/gtf/[código]`):** Minuta jurídica fundamentada nos Artigos 49.º, 57.º e 58.º do DL n.º 82/2021 para execução coerciva municipal, acompanhada de exportação **GeoJSON** e **KML** pronta a abrir no QGIS/ArcGIS do Gabinete Técnico Florestal (GTF).
- **Marketplace Qualificado (`/prestadores`):** Registo B2B em 3 passos com filtro de Seguro RC, equipamento homologado e matching automático por declive (`%`), área (`m²`) e código `DICO`.

---

## 4. Arquitetura Técnica e Infraestrutura Isolada

### 4.1 Contentorização Independente (`docker-compose.yml`)
- `faixasegura-db`: **PostgreSQL 16 + PostGIS 3.4** (schema dedicado `faixasegura`, geometrias indexadas com `GIST` em `EPSG:3763`).
- `faixasegura-redis`: **Redis 7** (`HSET fs:pir:{dico}` com TTL 3600s; `GEOADD fs:active_fires` com `GEOSEARCH` num raio de 15 km a cada 180s).
- `faixasegura-app`: **Node.js 22 + Express + Vite React 19 PWA** (geração vetorial nativa via `pdf-lib` sem sobrecarga de Chromium).
- **IA Privada (`https://ollama.innovaive.com`):** Ponte HTTP dedicada para `gemma3:4b` (visão multimodal e redação formal PT-PT) e `qwen3:4b` (extração textual e apoio jurídico RAG), protegida por **Circuit Breaker** com fallback determinístico imediato (< 50 ms) para garantir disponibilidade 100% no campo mesmo sem conectividade ao cluster IA.

### 4.2 Catálogo de Fontes de Dados Abertas (Zero Custo de Licenciamento)
1. **DGT (`ogcapi.dgterritorio.gov.pt`):** COS (Uso e Ocupação do Solo), CAOP (Limites Administrativos), Cadastro Predial e Ortofotos 25 cm.
2. **eBUPi / Dados.gov.pt:** Representações Gráficas Georreferenciadas (RGG) para seleção instantânea de parcelas rústicas.
3. **ICNF (`geocatalogo.icnf.pt`):** Carta de Perigosidade de Incêndio Rural 2020–2030, Freguesias Prioritárias e Rede de Pontos de Água.
4. **GEO API PT + OSM:** Pegadas de edifícios num raio de 100 m e geocodificação inversa por coordenadas/código postal.
5. **E-REDES Open Data (`e-redes.opendatasoft.com`):** Traçado de linhas aéreas de Média Tensão (MT) e Alta Tensão (AT).
6. **IPMA Open Data (`api.ipma.pt`):** Índices diários `rcm-d0.json`, `rcm-d1.json` e `rcm-d2.json` para os 308 municípios.
7. **API Aberta / ANEPC (`api.apiaberta.pt`):** Ocorrências rurais ativas e meios terrestres/aéreos mobilizados.
8. **Copernicus Data Space (`sh.dataspace.copernicus.eu`):** Bandas multiespectrais `B04`, `B08` e `B11` do Sentinel-2 L2A.

---

## 5. Ergonomia Mobile & Tablet-First ("Solar Field Mode")

- **Modo Claro Solar por Omissão:** Contraste AAA ao ar livre sob luz solar direta (`#F8FAFC` canvas, `#0F172A` texto, `#14532D` autoridade florestal, `#D97706` conversão). Inclui alternância imediata para **Modo Escuro OLED** (`#0B0F17` / `#161E2E`) para consulta noturna em casa.
- **Alvos de Toque de Campo (`>= 44x44 px`):** Pensado para utilização com uma mão ou luvas de trabalho ligeiras no terreno, barra inferior fixa de polegar em smartphones e layout dividido de duplo painel em tablets (`768px–1024px`) e desktops (`1440px`).
