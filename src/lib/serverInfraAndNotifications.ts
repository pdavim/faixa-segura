import pg from 'pg';
import { Redis } from 'ioredis';
import * as webPushNs from 'web-push';
import type { PushSubscription } from 'web-push';
import type { ComplianceCertificate, ParcelRecord, QuoteLead } from '../types/domain.ts';
import { wgs84ToPtTm06 } from './spatialEngine.ts';

const { Pool } = pg;
const webPush = (
  'default' in webPushNs && webPushNs.default ? webPushNs.default : webPushNs
) as typeof webPushNs;

export interface ExternalChannelReceipt {
  channel: 'TELEGRAM' | 'WEBPUSH' | 'EMAIL';
  delivered: boolean;
  providerLabel: string;
  detailPt: string;
}

export interface ServerIntegrationCapabilities {
  postgresConfigured: boolean;
  postgresConnected: boolean;
  redisConfigured: boolean;
  redisConnected: boolean;
  copernicusOAuthConfigured: boolean;
  eredesApiKeyConfigured: boolean;
  orthophotoCvMicroserviceConfigured: boolean;
  ollamaApiKeyConfigured: boolean;
  telegramBotConfigured: boolean;
  webPushVapidReady: boolean;
  vapidEnvConfigured: boolean;
  emailDispatchConfigured: boolean;
}

/**
 * Non-blocking PostgreSQL/PostGIS (`DATABASE_URL`) & Redis (`REDIS_URL`) persistence + cache bridge.
 * Falls back cleanly to in-memory Map storage when external daemons are absent (e.g. serverless dev preview).
 */
export class ServerInfraBridge {
  private pgPool: pg.Pool | null = null;
  private pgReady = false;
  private redisClient: Redis | null = null;
  private redisReady = false;
  private memoryCache = new Map<string, { expiresAt: number; json: string }>();

  public async initializeFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const dbUrl = env.DATABASE_URL?.trim();
    if (dbUrl) {
      try {
        const pool = new Pool({
          connectionString: dbUrl,
          max: 4,
          connectionTimeoutMillis: 1800,
          idleTimeoutMillis: 15000,
        });
        pool.on('error', () => {
          this.pgReady = false;
        });
        await pool.query(
          `CREATE TABLE IF NOT EXISTS faixasegura_kv_store (
             collection VARCHAR(48) NOT NULL,
             doc_id VARCHAR(128) NOT NULL,
             payload JSONB NOT NULL,
             updated_at TIMESTAMPTZ DEFAULT NOW(),
             PRIMARY KEY (collection, doc_id)
           );`
        );
        this.pgPool = pool;
        this.pgReady = true;
      } catch {
        this.pgReady = false;
      }
    }

    const redisUrl = env.REDIS_URL?.trim();
    if (redisUrl) {
      try {
        const client = new Redis(redisUrl, {
          lazyConnect: true,
          connectTimeout: 1500,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          retryStrategy: (times) => (times > 2 ? null : Math.min(times * 400, 1200)),
        });
        client.on('error', () => {
          this.redisReady = false;
        });
        await client.connect();
        await client.ping();
        this.redisClient = client;
        this.redisReady = true;
      } catch {
        this.redisReady = false;
      }
    }
  }

  public isPostgresConnected(): boolean {
    return this.pgReady;
  }

  public isRedisConnected(): boolean {
    return this.redisReady;
  }

  public async cacheGetJson<T>(key: string): Promise<T | null> {
    if (this.redisReady && this.redisClient) {
      try {
        const raw = await this.redisClient.get(`fs:${key}`);
        if (raw) return JSON.parse(raw) as T;
      } catch {
        // Fall through to memory cache
      }
    }
    const entry = this.memoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memoryCache.delete(key);
      return null;
    }
    try {
      return JSON.parse(entry.json) as T;
    } catch {
      return null;
    }
  }

  public async cacheSetJson<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const serialized = JSON.stringify(value);
    this.memoryCache.set(key, {
      expiresAt: Date.now() + Math.max(1, ttlSeconds) * 1000,
      json: serialized,
    });
    if (this.redisReady && this.redisClient) {
      try {
        await this.redisClient.set(`fs:${key}`, serialized, 'EX', Math.max(1, Math.round(ttlSeconds)));
      } catch {
        // Non-fatal cache write failure
      }
    }
  }

  public async persistDocument(collection: string, docId: string, payload: unknown): Promise<boolean> {
    if (!this.pgReady || !this.pgPool) return false;
    try {
      await this.pgPool.query(
        `INSERT INTO faixasegura_kv_store (collection, doc_id, payload, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (collection, doc_id)
         DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW();`,
        [collection, docId, JSON.stringify(payload)]
      );
      return true;
    } catch {
      return false;
    }
  }

  public async persistParcelPostgis(parcel: ParcelRecord): Promise<boolean> {
    const kvSaved = await this.persistDocument('parcels', parcel.id, {
      ...parcel,
      cvAnalysis: parcel.cvAnalysis
        ? { ...parcel.cvAnalysis, overlayDataUrl: undefined }
        : undefined,
    });
    if (!this.pgReady || !this.pgPool || parcel.vertices.length < 3) return kvSaved;

    // Also attempt PostGIS geometry upsert if faixasegura.user_parcels exists
    try {
      const tmPts = parcel.vertices.map(wgs84ToPtTm06);
      const closed = [...tmPts, tmPts[0]];
      const wkt3763 = `POLYGON((${closed.map((p) => `${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(', ')}))`;
      await this.pgPool.query(
        `INSERT INTO faixasegura.user_parcels (
           label, dico, dicofre, municipality, district, matrix_article, bupi_rgg_id,
           total_area_m2, avg_slope_pct, geom_3763,
           zone1_immediate_m2, zone2_near_m2, zone3_extended_m2,
           mandatory_clean_area_m2, third_party_clean_area_m2, exempt_area_m2,
           max_hazard_level, is_priority_parish
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7,
           $8, $9, ST_GeomFromText($10, 3763),
           $11, $12, $13, $14, $15, $16, $17, $18
         ) ON CONFLICT DO NOTHING;`,
        [
          parcel.label.slice(0, 100),
          parcel.dico.slice(0, 4),
          parcel.dicofre.slice(0, 6),
          parcel.municipality.slice(0, 80),
          parcel.district.slice(0, 60),
          parcel.matrixArticle.slice(0, 40),
          parcel.bupiRggId.slice(0, 64),
          parcel.spatial.totalAreaM2,
          parcel.avgSlopePct,
          wkt3763,
          parcel.spatial.zone1ImmediateM2,
          parcel.spatial.zone2NearM2,
          parcel.spatial.zone3ExtendedM2,
          parcel.spatial.mandatoryCleanAreaM2,
          parcel.spatial.thirdPartyEasementM2,
          parcel.spatial.exemptAreaM2,
          parcel.hazardLevel,
          parcel.isPriorityParish,
        ]
      );
    } catch {
      // Schema faixasegura.user_parcels optional outside full PostGIS container
    }
    return kvSaved;
  }

  public async persistCertificate(cert: ComplianceCertificate): Promise<boolean> {
    return this.persistDocument('certificates', cert.shortCode, cert);
  }

  public async persistQuoteLead(lead: QuoteLead): Promise<boolean> {
    return this.persistDocument('quotes', lead.id, lead);
  }
}

/**
 * Formats a concise Portuguese Markdown message for Telegram Bot API (`@FaixaSeguraBot`).
 */
export function formatTelegramHazardAlertPt(params: {
  parcelLabel: string;
  municipality: string;
  headline: string;
  detail: string;
  appUrl?: string;
}): string {
  const linkLine = params.appUrl ? `\nAbrir Raio-X: ${params.appUrl}` : '';
  return (
    `🔥 *FaixaSegura SGIFR — Alerta de Terreno*\n` +
    `Terreno: *${params.parcelLabel}* (${params.municipality})\n` +
    `Ocorrência: ${params.headline}\n` +
    `${params.detail}${linkLine}`
  );
}

/**
 * Dispatches a message via the official Telegram Bot HTTP API (`TELEGRAM_BOT_TOKEN` + `chatId`).
 */
export async function dispatchTelegramAlert(params: {
  botToken?: string;
  chatId?: string;
  text: string;
  fetchImpl?: typeof fetch;
}): Promise<ExternalChannelReceipt> {
  const token = params.botToken?.trim();
  const chatId = params.chatId?.trim();
  const fetchFn = params.fetchImpl ?? fetch;

  if (!token || !chatId) {
    return {
      channel: 'TELEGRAM',
      delivered: false,
      providerLabel: 'Telegram Bot API (Por configurar no servidor)',
      detailPt:
        'Defina TELEGRAM_BOT_TOKEN e TELEGRAM_DEFAULT_CHAT_ID no servidor para entrega 24/7 via Telegram.',
    };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const resp = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: params.text,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return {
        channel: 'TELEGRAM',
        delivered: false,
        providerLabel: 'Telegram Bot API',
        detailPt: `Telegram respondeu HTTP ${resp.status} ao enviar para o chat ${chatId}.`,
      };
    }
    return {
      channel: 'TELEGRAM',
      delivered: true,
      providerLabel: 'Telegram Bot API (@FaixaSeguraBot)',
      detailPt: `Alerta entregue em tempo real no Telegram (chat ${chatId}).`,
    };
  } catch {
    return {
      channel: 'TELEGRAM',
      delivered: false,
      providerLabel: 'Telegram Bot API',
      detailPt: 'Falha de rede ao contactar api.telegram.org.',
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Dispatches transactional email via Resend (`RESEND_API_KEY`) or generic JSON webhook (`SMTP_WEBHOOK_URL`).
 */
export async function dispatchTransactionalEmailOrWebhook(params: {
  resendApiKey?: string;
  fromEmail?: string;
  smtpWebhookUrl?: string;
  toEmails: string[];
  subject: string;
  textBody: string;
  htmlBody?: string;
  fetchImpl?: typeof fetch;
}): Promise<ExternalChannelReceipt> {
  const apiKey = params.resendApiKey?.trim();
  const webhookUrl = params.smtpWebhookUrl?.trim();
  const from = params.fromEmail?.trim() || 'FaixaSegura SGIFR <alertas@faixasegura.pt>';
  const recipients = params.toEmails.map((e) => e.trim()).filter(Boolean);
  const fetchFn = params.fetchImpl ?? fetch;

  if (recipients.length === 0) {
    return {
      channel: 'EMAIL',
      delivered: false,
      providerLabel: 'Despacho Email',
      detailPt: 'Sem destinatários de email válidos.',
    };
  }

  if (apiKey) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5500);
    try {
      const resp = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from,
          to: recipients,
          subject: params.subject,
          text: params.textBody,
          html: params.htmlBody ?? `<pre style="font-family:sans-serif">${params.textBody}</pre>`,
        }),
        signal: ctrl.signal,
      });
      if (resp.ok) {
        return {
          channel: 'EMAIL',
          delivered: true,
          providerLabel: 'Resend Transactional Email',
          detailPt: `Notificação enviada por email para ${recipients.length} destinatário(s).`,
        };
      }
      return {
        channel: 'EMAIL',
        delivered: false,
        providerLabel: 'Resend Transactional Email',
        detailPt: `Serviço Resend devolveu HTTP ${resp.status}.`,
      };
    } catch {
      return {
        channel: 'EMAIL',
        delivered: false,
        providerLabel: 'Resend Transactional Email',
        detailPt: 'Falha de ligação ao serviço de email Resend.',
      };
    } finally {
      clearTimeout(timer);
    }
  }

  if (webhookUrl) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from,
          to: recipients,
          subject: params.subject,
          text: params.textBody,
        }),
        signal: ctrl.signal,
      });
      if (resp.ok) {
        return {
          channel: 'EMAIL',
          delivered: true,
          providerLabel: 'SMTP Webhook',
          detailPt: `Pedido despachado via webhook SMTP para ${recipients.length} destinatário(s).`,
        };
      }
    } catch {
      // Fall through
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    channel: 'EMAIL',
    delivered: false,
    providerLabel: 'Bolsa Interna FaixaSegura',
    detailPt: `Registado na bolsa interna (${recipients.length} prestador(es) elegível(eis)); configure RESEND_API_KEY ou SMTP_WEBHOOK_URL para envio SMTP externo.`,
  };
}

/**
 * RFC 8291 Web Push VAPID Hub (`VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` + ephemeral runtime fallback).
 */
export class WebPushNotificationHub {
  private publicKey: string;
  private privateKey: string;
  private subject: string;
  private envConfigured: boolean;
  private subscriptions = new Map<string, PushSubscription>();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const envPub = env.VAPID_PUBLIC_KEY?.trim();
    const envPriv = env.VAPID_PRIVATE_KEY?.trim();
    this.subject = env.VAPID_SUBJECT?.trim() || 'mailto:alertas@faixasegura.pt';

    if (envPub && envPriv) {
      try {
        webPush.setVapidDetails(this.subject, envPub, envPriv);
        this.publicKey = envPub;
        this.privateKey = envPriv;
        this.envConfigured = true;
        return;
      } catch {
        // Malformed env VAPID key — fall back safely to runtime ephemeral keys
      }
    }

    const generated = webPush.generateVAPIDKeys();
    this.publicKey = generated.publicKey;
    this.privateKey = generated.privateKey;
    this.envConfigured = false;
    webPush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
  }

  public getPublicKey(): string {
    return this.publicKey;
  }

  public isEnvConfigured(): boolean {
    return this.envConfigured;
  }

  public getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  public registerSubscription(sub: PushSubscription): { ok: boolean; count: number } {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      return { ok: false, count: this.subscriptions.size };
    }
    this.subscriptions.set(sub.endpoint, sub);
    return { ok: true, count: this.subscriptions.size };
  }

  public async broadcastPush(payload: {
    title: string;
    body: string;
    url?: string;
    tag?: string;
  }): Promise<ExternalChannelReceipt> {
    if (this.subscriptions.size === 0) {
      return {
        channel: 'WEBPUSH',
        delivered: false,
        providerLabel: 'Web Push VAPID (RFC 8291)',
        detailPt:
          'Sem subscrições PushManager ativas neste navegador (clique em «Ativar Alertas no Dispositivo»).',
      };
    }

    const message = JSON.stringify({
      title: payload.title,
      body: payload.body,
      url: payload.url || '/?autostart=1',
      tag: payload.tag || 'faixasegura-hazard',
    });

    let deliveredCount = 0;
    for (const [endpoint, sub] of this.subscriptions.entries()) {
      try {
        await webPush.sendNotification(sub, message, { TTL: 3600 });
        deliveredCount += 1;
      } catch (err) {
        const statusCode = (err as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          this.subscriptions.delete(endpoint);
        }
      }
    }

    return {
      channel: 'WEBPUSH',
      delivered: deliveredCount > 0,
      providerLabel: 'Web Push VAPID (RFC 8291)',
      detailPt:
        deliveredCount > 0
          ? `Notificação Web Push cifrada entregue a ${deliveredCount} dispositivo(s).`
          : 'Subscrição Web Push registada, mas o endpoint push do navegador rejeitou a entrega.',
    };
  }
}
