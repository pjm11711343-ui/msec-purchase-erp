// 서버(Vercel) 공용: 로그인 확인 · 호출한 사람 권한으로 Firestore 읽기 · 텔레그램 · 네이버 메일
//  - 비밀값은 Vercel 환경변수에만: NAVER_MAIL_USER, NAVER_MAIL_PASS, TELEGRAM_BOT_TOKEN, TELEGRAM_OFFICE_CHAT_ID
//  - Firestore는 호출한 사람의 로그인 토큰으로 읽는다 → 그 사람이 볼 수 있는 문서로만 알림을 만든다
import { createRemoteJWKSet, jwtVerify } from 'jose';
import nodemailer from 'nodemailer';

export const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'gen-lang-client-0383119283';
export const DB_ID = process.env.FIRESTORE_DB || 'ai-studio-6c21e717-6da2-465a-8fc7-2181e7bbd611';

const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Authorization: Bearer <Firebase ID 토큰> 확인 → uid */
export async function verifyUser(authHeader?: string | string[]): Promise<{ uid: string; token: string; email?: string }> {
  const h = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  const token = h?.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) throw new HttpError(401, '로그인이 필요합니다.');
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${PROJECT_ID}`, audience: PROJECT_ID });
    return { uid: String(payload.sub), token, email: payload.email as string | undefined };
  } catch {
    throw new HttpError(401, '로그인 정보가 맞지 않습니다. 다시 로그인하세요.');
  }
}

/* ───────── Firestore REST (호출한 사람 권한) ───────── */
type FsValue = Record<string, unknown>;
function fromValue(v: FsValue): unknown {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return ((v.arrayValue as { values?: FsValue[] }).values ?? []).map(fromValue);
  if ('mapValue' in v) return fromFields((v.mapValue as { fields?: Record<string, FsValue> }).fields ?? {});
  return undefined;
}
function fromFields(f: Record<string, FsValue>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(f)) o[k] = fromValue(v);
  return o;
}

/** 문서 읽기 (없거나 권한이 없으면 null) */
export async function getDoc<T = Record<string, unknown>>(token: string, path: string): Promise<(T & { id: string }) | null> {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/${DB_ID}/documents/${path}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 404 || r.status === 403) return null;
  if (r.status === 429) throw new HttpError(503, 'Firebase 하루 사용량 한도를 넘어 지금은 알림을 보낼 수 없습니다.');
  if (!r.ok) throw new HttpError(502, `Firestore 읽기 실패 (${r.status})`);
  const j = (await r.json()) as { name: string; fields?: Record<string, FsValue> };
  return { ...(fromFields(j.fields ?? {}) as T), id: j.name.split('/').pop()! };
}

/* ───────── 텔레그램 ───────── */
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export { esc };

export async function sendTelegram(chatId: string | number | undefined, html: string): Promise<'sent' | 'skipped'> {
  const tokenBot = process.env.TELEGRAM_BOT_TOKEN;
  if (!tokenBot || !chatId) return 'skipped';
  const r = await fetch(`https://api.telegram.org/bot${tokenBot}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) {
    const j = (await r.json().catch(() => ({}))) as { description?: string };
    throw new HttpError(502, `텔레그램 발송 실패: ${j.description ?? r.status}`);
  }
  return 'sent';
}

export async function telegramUpdates(): Promise<{ id: number; title: string; type: string }[]> {
  const tokenBot = process.env.TELEGRAM_BOT_TOKEN;
  if (!tokenBot) throw new HttpError(400, '텔레그램 봇 토큰(TELEGRAM_BOT_TOKEN)이 Vercel 환경변수에 없습니다.');
  const r = await fetch(`https://api.telegram.org/bot${tokenBot}/getUpdates?limit=100&allowed_updates=${encodeURIComponent(JSON.stringify(['message', 'my_chat_member', 'channel_post']))}`);
  const j = (await r.json()) as { ok: boolean; description?: string; result?: Record<string, unknown>[] };
  if (!j.ok) throw new HttpError(502, `텔레그램 조회 실패: ${j.description ?? ''}`);
  const m = new Map<number, { id: number; title: string; type: string }>();
  for (const u of j.result ?? []) {
    const msg = (u.message ?? u.my_chat_member ?? u.channel_post) as { chat?: { id: number; title?: string; first_name?: string; last_name?: string; username?: string; type: string } } | undefined;
    const c = msg?.chat;
    if (!c) continue;
    m.set(c.id, { id: c.id, title: c.title ?? ([c.last_name, c.first_name].filter(Boolean).join('') || c.username || String(c.id)), type: c.type });
  }
  return [...m.values()];
}

/* ───────── 네이버 메일 ───────── */
export async function sendMail(opts: { to: string; cc?: string; subject: string; text: string; html?: string; attachments?: { filename: string; content: Buffer }[] }) {
  const user = process.env.NAVER_MAIL_USER;
  const pass = process.env.NAVER_MAIL_PASS;
  if (!user || !pass) throw new HttpError(400, '네이버 메일 계정(NAVER_MAIL_USER·NAVER_MAIL_PASS)이 Vercel 환경변수에 없습니다.');
  const from = user.includes('@') ? user : `${user}@naver.com`;
  const t = nodemailer.createTransport({ host: 'smtp.naver.com', port: 465, secure: true, auth: { user: from, pass } });
  const info = await t.sendMail({ from: `"${process.env.MAIL_FROM_NAME || '㈜명신기공 자재부'}" <${from}>`, ...opts });
  return info.messageId;
}

/* ───────── 응답 ───────── */
export interface Res {
  status: (n: number) => Res;
  json: (b: unknown) => void;
  setHeader: (k: string, v: string) => void;
}
export function fail(res: Res, e: unknown) {
  const status = e instanceof HttpError ? e.status : 500;
  res.status(status).json({ ok: false, error: e instanceof Error ? e.message : String(e) });
}
