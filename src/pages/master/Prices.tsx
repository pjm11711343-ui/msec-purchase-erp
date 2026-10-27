import { useEffect, useMemo, useState } from 'react';
import { collection, collectionGroup, getDocs, limit, query, type DocumentData } from 'firebase/firestore';
import { db, PRICE_COLLECTION, PRICE_VENDOR_COLLECTION } from '../../lib/firebase';
import { Empty, PageHeader } from '../../components/ui';

// 단가관리시스템 필드 이름을 모르므로, 자주 쓰는 이름을 앞에 두고 나머지는 뒤에 붙인다
const PREFERRED = ['업체', '품번', 'code', '카테고리', 'category', '품명', 'name', 'itemName', '규격', 'spec', '단위', 'unit', '협가', 'listPrice', '네고율', 'nego', 'negoRate', '구매단가', 'price', 'purchasePrice', '메이커', 'maker', '최근변경일', 'updatedAt'];
const HIDE = new Set(['id', 'vendorId']);

type Row = Record<string, unknown> & { id: string };

function show(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'number') return v.toLocaleString('ko-KR');
  if (typeof v === 'object' && 'toDate' in (v as object)) return (v as { toDate: () => Date }).toDate().toLocaleDateString('ko-KR');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export default function Prices() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // 업체 이름표
        const vSnap = await getDocs(collection(db, PRICE_VENDOR_COLLECTION));
        const vName = new Map<string, string>();
        vSnap.docs.forEach((d) => {
          const x = d.data() as DocumentData;
          vName.set(d.id, String(x.name ?? x.companyName ?? d.id));
        });
        // vendors/{업체}/prices 전부 (컬렉션 그룹)
        const pSnap = await getDocs(query(collectionGroup(db, PRICE_COLLECTION), limit(10000)));
        setRows(
          pSnap.docs.map((d) => {
            const vendorId = d.ref.parent.parent?.id ?? '';
            return { 업체: vName.get(vendorId) ?? vendorId, ...(d.data() as DocumentData), id: d.ref.path, vendorId };
          }),
        );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const cols = useMemo(() => {
    const keys = new Set<string>();
    rows.slice(0, 200).forEach((r) => Object.keys(r).forEach((k) => !HIDE.has(k) && keys.add(k)));
    const pref = PREFERRED.filter((k) => keys.has(k));
    return [...pref, ...[...keys].filter((k) => !pref.includes(k)).sort()].slice(0, 14);
  }, [rows]);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (k ? rows.filter((r) => cols.some((c) => show(r[c]).toLowerCase().includes(k))) : rows).slice(0, 500);
  }, [rows, q, cols]);

  return (
    <div>
      <PageHeader
        title="단가 조회"
        desc={`단가관리시스템의 ${PRICE_VENDOR_COLLECTION}/{업체}/${PRICE_COLLECTION} 데이터를 읽기만 합니다. 단가 수정은 단가관리시스템에서 하세요. 2단계 구매청구서에서 이 단가를 자동으로 채웁니다.`}
        actions={<input className="input w-64" placeholder="업체·품명·규격 검색" value={q} onChange={(e) => setQ(e.target.value)} />}
      />
      <div className="card overflow-hidden">
        {error ? (
          <Empty>
            단가를 읽지 못했습니다: {error}
            <br />
            Firestore 보안 규칙에 prices 컬렉션 그룹 읽기 규칙이 있는지 확인하세요 (README 4번).
          </Empty>
        ) : !shown.length ? (
          <Empty>{loading ? '불러오는 중…' : '단가 데이터가 없습니다.'}</Empty>
        ) : (
          <div className="max-h-[calc(100vh-200px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  {cols.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    {cols.map((c) => (
                      <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}>
                        {show(r[c])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t border-line px-4 py-2 text-[12px] text-muted">
          전체 {rows.length.toLocaleString()}건 중 {shown.length.toLocaleString()}건 표시 (최대 500건)
        </div>
      </div>
    </div>
  );
}
