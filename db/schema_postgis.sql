-- =============================================================================
-- FAIXASEGURA · ESQUEMA ESPACIAL POSTGRESQL 16 + POSTGIS 3.4
-- Sistema de Referência Oficial: ETRS89 / PT-TM06 (EPSG:3763 — Metros Exatos)
-- Quadro Legal: DL n.º 82/2021 (SGIFR) + Despacho n.º 675/2026 (21 de janeiro)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS faixasegura;
SET search_path TO faixasegura, public;

-- 1. Camadas Oficiais Pré-carregadas (COS Uso do Solo DGT + Perigosidade ICNF)
CREATE TABLE IF NOT EXISTS land_cover_zones (
    id BIGSERIAL PRIMARY KEY,
    cos_code VARCHAR(16) NOT NULL,
    land_class VARCHAR(24) NOT NULL CHECK (
        land_class IN ('FOREST_SCRUB', 'AGRICULTURE', 'URBAN_BUILT', 'WATER_ROCK')
    ),
    geom GEOMETRY(MultiPolygon, 3763) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cos_geom ON land_cover_zones USING GIST (geom);

CREATE TABLE IF NOT EXISTS fire_hazard_zones (
    id BIGSERIAL PRIMARY KEY,
    hazard_level SMALLINT NOT NULL CHECK (hazard_level BETWEEN 1 AND 5),
    is_priority_parish BOOLEAN DEFAULT FALSE,
    is_apps_zone BOOLEAN DEFAULT FALSE,
    geom GEOMETRY(MultiPolygon, 3763) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hazard_geom ON fire_hazard_zones USING GIST (geom);

-- 2. Edifícios, Aglomerados Populacionais e Servidões de Terceiros (E-REDES / Vias)
CREATE TABLE IF NOT EXISTS external_receptors (
    id BIGSERIAL PRIMARY KEY,
    receptor_type VARCHAR(32) NOT NULL CHECK (
        receptor_type IN (
            'ISOLATED_BUILDING',
            'POPULATION_CLUSTER',
            'ROAD_RAIL',
            'EREDES_MV_LINE',
            'EREDES_HV_LINE'
        )
    ),
    required_buffer_m SMALLINT NOT NULL,
    responsibility VARCHAR(24) NOT NULL CHECK (
        responsibility IN ('LANDOWNER', 'UTILITY_OR_MUNICIPALITY')
    ),
    geom GEOMETRY(Geometry, 3763) NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receptors_geom ON external_receptors USING GIST (geom);

-- 3. Propriedades / Terrenos Registados pelos Utilizadores
CREATE TABLE IF NOT EXISTS user_parcels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID,
    label VARCHAR(100) NOT NULL,
    dico VARCHAR(4) NOT NULL,
    dicofre VARCHAR(6) NOT NULL,
    municipality VARCHAR(80) NOT NULL,
    district VARCHAR(60) NOT NULL,
    matrix_article VARCHAR(40),
    bupi_rgg_id VARCHAR(64),
    total_area_m2 NUMERIC(10,2) NOT NULL,
    avg_slope_pct NUMERIC(5,2) DEFAULT 0,
    geom_3763 GEOMETRY(Polygon, 3763) NOT NULL,

    -- Subdivisão técnica Despacho n.º 675/2026
    zone1_immediate_m2 NUMERIC(10,2) DEFAULT 0,   -- 0 a 2 m (Faixa Inerte)
    zone2_near_m2 NUMERIC(10,2) DEFAULT 0,        -- 2 a 10 m (Interface Próxima)
    zone3_extended_m2 NUMERIC(10,2) DEFAULT 0,    -- 10 a 50 m / 100 m (Interface Alargada)
    mandatory_clean_area_m2 NUMERIC(10,2) DEFAULT 0,
    third_party_clean_area_m2 NUMERIC(10,2) DEFAULT 0,
    exempt_area_m2 NUMERIC(10,2) DEFAULT 0,

    clean_zone_geom GEOMETRY(MultiPolygon, 3763),
    third_party_zone_geom GEOMETRY(MultiPolygon, 3763),
    max_hazard_level SMALLINT DEFAULT 1,
    is_priority_parish BOOLEAN DEFAULT FALSE,

    -- Monitorização Satélite Copernicus Sentinel-2 L2A
    latest_ndvi NUMERIC(4,3),
    latest_ndmi NUMERIC(4,3),
    last_satellite_date DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_parcels_geom ON user_parcels USING GIST (geom_3763);

-- 4. Autos Digitais de Conformidade Preventiva (Prova Legal SHA-256)
CREATE TABLE IF NOT EXISTS compliance_certificates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_code VARCHAR(20) UNIQUE NOT NULL,
    parcel_id UUID REFERENCES user_parcels(id) ON DELETE CASCADE,
    owner_name VARCHAR(120) NOT NULL,
    owner_nif VARCHAR(16) NOT NULL,
    cleaned_area_m2 NUMERIC(10,2) NOT NULL,
    pir_level_at_work SMALLINT NOT NULL,
    photos_metadata JSONB NOT NULL,
    contractor_name VARCHAR(120),
    contractor_nif VARCHAR(16),
    invoice_ref VARCHAR(40),
    sha256_hash CHAR(64) NOT NULL,
    issued_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Participações Técnicas de Prédios Confinantes ("Vizinho Incumpridor")
CREATE TABLE IF NOT EXISTS neighbor_complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    req_code VARCHAR(20) UNIQUE NOT NULL,
    parcel_id UUID REFERENCES user_parcels(id) ON DELETE SET NULL,
    complainant_name VARCHAR(120) NOT NULL,
    complainant_nif VARCHAR(16) NOT NULL,
    municipality VARCHAR(80) NOT NULL,
    dicofre VARCHAR(6) NOT NULL,
    min_distance_facade_m NUMERIC(6,2) NOT NULL,
    neighbor_ndvi NUMERIC(4,3),
    neighbor_geom_3763 GEOMETRY(Polygon, 3763) NOT NULL,
    issued_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Prestadores Florestais Certificados (/prestadores) e Leads Qualificadas
CREATE TABLE IF NOT EXISTS forestry_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nif VARCHAR(16) UNIQUE NOT NULL,
    company_name VARCHAR(120) NOT NULL,
    cae_code VARCHAR(8) NOT NULL,
    phone_whatsapp VARCHAR(24) NOT NULL,
    email VARCHAR(120) NOT NULL,
    has_rc_insurance BOOLEAN NOT NULL DEFAULT TRUE,
    has_spark_arrestor BOOLEAN NOT NULL DEFAULT FALSE,
    has_icnf_oak_credential BOOLEAN NOT NULL DEFAULT FALSE,
    machinery_tags TEXT[] NOT NULL,
    covered_dicos VARCHAR(4)[] NOT NULL,
    min_area_m2 INTEGER DEFAULT 500,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Função Determinística do Motor Espacial (< 25 ms em EPSG:3763)
CREATE OR REPLACE FUNCTION faixasegura.compute_parcel_fgc(p_parcel_wgs84 GEOMETRY)
RETURNS TABLE (
    total_area_m2 NUMERIC,
    zone1_immediate_m2 NUMERIC,
    zone2_near_m2 NUMERIC,
    zone3_extended_m2 NUMERIC,
    third_party_m2 NUMERIC,
    exempt_m2 NUMERIC,
    zones_geojson JSONB
) LANGUAGE plpgsql AS $$
DECLARE
    v_parcel GEOMETRY := ST_Transform(ST_SetSRID(p_parcel_wgs84, 4326), 3763);
    v_buildings GEOMETRY;
    v_third_party GEOMETRY;
    v_z1 GEOMETRY;
    v_z2 GEOMETRY;
    v_z3 GEOMETRY;
    v_exempt GEOMETRY;
BEGIN
    SELECT COALESCE(ST_Union(geom), ST_GeomFromText('POLYGON EMPTY', 3763))
      INTO v_buildings
      FROM external_receptors
     WHERE responsibility = 'LANDOWNER'
       AND ST_DWithin(geom, v_parcel, 100.0);

    SELECT COALESCE(ST_Intersection(v_parcel, ST_Union(ST_Buffer(geom, required_buffer_m))), ST_GeomFromText('POLYGON EMPTY', 3763))
      INTO v_third_party
      FROM external_receptors
     WHERE responsibility = 'UTILITY_OR_MUNICIPALITY'
       AND ST_DWithin(geom, v_parcel, 15.0);

    v_z1 := ST_Difference(ST_Intersection(v_parcel, ST_Buffer(v_buildings, 2.0)), v_third_party);
    v_z2 := ST_Difference(ST_Intersection(v_parcel, ST_Difference(ST_Buffer(v_buildings, 10.0), ST_Buffer(v_buildings, 2.0))), v_third_party);
    v_z3 := ST_Difference(ST_Intersection(v_parcel, ST_Difference(ST_Buffer(v_buildings, 50.0), ST_Buffer(v_buildings, 10.0))), v_third_party);
    v_exempt := ST_Difference(v_parcel, ST_Union(ARRAY[v_z1, v_z2, v_z3, v_third_party]));

    RETURN QUERY SELECT
        ROUND(ST_Area(v_parcel)::NUMERIC, 2),
        ROUND(ST_Area(v_z1)::NUMERIC, 2),
        ROUND(ST_Area(v_z2)::NUMERIC, 2),
        ROUND(ST_Area(v_z3)::NUMERIC, 2),
        ROUND(ST_Area(v_third_party)::NUMERIC, 2),
        ROUND(ST_Area(v_exempt)::NUMERIC, 2),
        jsonb_build_object(
            'zone1', ST_AsGeoJSON(ST_Transform(v_z1, 4326))::JSONB,
            'zone2', ST_AsGeoJSON(ST_Transform(v_z2, 4326))::JSONB,
            'zone3', ST_AsGeoJSON(ST_Transform(v_z3, 4326))::JSONB,
            'thirdParty', ST_AsGeoJSON(ST_Transform(v_third_party, 4326))::JSONB,
            'exempt', ST_AsGeoJSON(ST_Transform(v_exempt, 4326))::JSONB
        );
END;
$$;
