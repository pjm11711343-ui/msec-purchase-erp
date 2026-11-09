// 단가 관리시스템(msec-price-manager, Firebase 프로젝트 msec-price) → ERP 단가 가져오기
//  POST /api/price-sync  (Authorization: Bearer <ERP Firebase ID 토큰>, 자재부·관리자만)
//  - 단가 관리시스템 관리자 계정으로 로그인해 vendors/{업체}/prices 를 읽고, 압축한 줄 목록을 돌려준다
//  - 계정은 Vercel 환경변수에만: MSEC_PRICE_ADMIN_ID (관리자 아이디), MSEC_PRICE_ADMIN_PASSWORD
//  - 읽기만 한다 (단가 관리시스템 쪽 데이터는 바꾸지 않음)
import { fail, getDoc, HttpError, verifyUser, type Res } from './_lib/common.js';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

const P_PROJECT = process.env.MSEC_PRICE_PROJECT_ID || 'msec-price';
// 웹 앱 공개 키 (브라우저에도 들어 있는 값 — 비밀 아님)
const P_API_KEY = process.env.MSEC_PRICE_API_KEY || 'AIzaSyB4hx8WuF6amLFEnb4E4BXcLPGyxiGYJFM';
const ADMIN_DOMAIN = 'admin.msec.local';

type FsValue = Record<string, unknown>;
function val(v: FsValue | undefined): unknown {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  return undefined;
}
const n = (x: unknown) => (typeof x === 'number' ? x : Number(String(x ?? '').replace(/,/g, '')) || 0);
const s = (x: unknown) => (x == null ? '' : String(x)).trim();

async function signIn(): Promise<string> {
  const id = process.env.MSEC_PRICE_ADMIN_ID;
  const pw = process.env.MSEC_PRICE_ADMIN_PASSWORD;
  if (!id || !pw) throw new HttpError(503, '단가 관리시스템 연동 계정이 아직 설정되지 않았습니다. Vercel 환경변수 MSEC_PRICE_ADMIN_ID · MSEC_PRICE_ADMIN_PASSWORD 를 넣어 주세요.');
  const email = id.includes('@') ? id : `${id.trim().toLowerCase()}@${ADMIN_DOMAIN}`;
  const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${P_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw, returnSecureToken: true }),
  });
  if (!r.ok) throw new HttpError(502, '단가 관리시스템 로그인에 실패했습니다. Vercel 환경변수의 관리자 아이디·비밀번호를 확인하세요.');
  return ((await r.json()) as { idToken: string }).idToken;
}

async function runQuery(token: string, collectionId: string): Promise<{ name: string; fields: Record<string, FsValue> }[]> {
  const r = await fetch(`https://firestore.googleapis.com/v1/projects/${P_PROJECT}/databases/(default)/documents:runQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId, allDescendants: true }] } }),
  });
  if (r.status === 403) throw new HttpError(502, '단가 관리시스템에서 읽기 권한이 없습니다. 관리자 계정인지 확인하세요.');
  if (!r.ok) throw new HttpError(502, `단가 관리시스템 읽기 실패 (${r.status})`);
  const arr = (await r.json()) as { document?: { name: string; fields?: Record<string, FsValue> } }[];
  return arr.filter((x) => x.document).map((x) => ({ name: x.document!.name, fields: x.document!.fields ?? {} }));
}

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST만 됩니다.' });
  try {
    const me = await verifyUser(req.headers.authorization);
    const staff = await getDoc<{ role: string; active: boolean }>(me.token, `erp_users/${me.uid}`);
    if (!staff?.active || !['admin', 'material'].includes(staff.role)) throw new HttpError(403, '자재부·관리자만 단가를 가져올 수 있습니다.');

    const token = await signIn();
    const [vendors, prices] = await Promise.all([runQuery(token, 'vendors'), runQuery(token, 'prices')]);
    const vMap = new Map<string, { name: string; bizNo: string }>();
    for (const v of vendors) {
      const parts = v.name.split('/');
      if (parts[parts.length - 2] !== 'vendors' || parts.length !== 7) continue; // 최상위 vendors 만
      if (val(v.fields.deleted) === true) continue;
      const id = parts[parts.length - 1];
      vMap.set(id, { name: s(val(v.fields.name) ?? val(v.fields.companyName) ?? id), bizNo: s(val(v.fields.bizNo) ?? val(v.fields.loginId) ?? id) });
    }
    // 줄: [업체id, 업체명, 사업자번호, 품명, 규격, 단위, 협가, 네고율, 구매단가, 메이커, 분류, 적용일]
    const rows: (string | number)[][] = [];
    for (const p of prices) {
      const parts = p.name.split('/');
      const vi = parts.lastIndexOf('vendors');
      if (vi < 0 || parts[vi + 2] !== 'prices') continue;
      const vid = parts[vi + 1];
      const v = vMap.get(vid);
      if (!v) continue; // 삭제된 업체
      const f = p.fields;
      if (val(f.deleted) === true || val(f.active) === false) continue;
      const item = s(val(f.itemName) ?? val(f.name));
      const cost = n(val(f.costPrice) ?? val(f.listPrice));
      const negoRaw = n(val(f.negoRate));
      const nego = val(f.negoType) === 'amount' ? 0 : Math.abs(negoRaw) <= 1 && negoRaw !== 0 ? Math.abs(negoRaw) * 100 : Math.abs(negoRaw);
      const buy = n(val(f.unitPrice)) || Math.round(cost * (1 - nego / 100));
      if (!item || !(buy > 0)) continue;
      rows.push([vid, v.name, v.bizNo, item, s(val(f.spec)), s(val(f.unit)), cost, nego, buy, s(val(f.maker)), s(val(f.category)), s(val(f.effectiveFrom))]);
    }
    return res.status(200).json({ ok: true, vendors: vMap.size, count: rows.length, rows, at: Date.now() });
  } catch (e) {
    return fail(res, e);
  }
}
