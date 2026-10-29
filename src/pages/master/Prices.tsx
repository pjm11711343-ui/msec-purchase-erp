import { useEffect, useMemo, useState } from 'react';
import { loadPrices, priceCacheAt, type PriceRow } from '../../lib/prices';
import { nameKey, won } from '../../lib/normalize';
import { Empty, errMsg, PageHeader, useToast } from '../../components/ui';

/** 단가 조회: ERP에 둔 단가표 사본을 보여준다 (원본은 단가관리시스템, 하루 한 번 자동 갱신) */
export default function Prices() {
  const toast = useToast();
  const [rows, setRows] = useState<PriceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(0);

  useEffect(() => {
    loadPrices({ canRebuild: true })
      .then((r) => (setRows(r), setAt(priceCacheAt())))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, []);

  const refresh = async () => {
    if (!confirm('단가관리시스템 원본에서 단가표를 다시 불러올까요? (단가 수만큼 Firebase 읽기를 씁니다)')) return;
    setBusy(true);
    try {
      const r = await loadPrices({ force: true, canRebuild: true });
      setRows(r);
      setAt(priceCacheAt());
      toast(`단가 ${r.length.toLocaleString()}건을 새로 불러왔습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };

  const shown = useMemo(() => {
    const k = nameKey(q);
    return (k ? rows.filter((r) => nameKey([r.vendorName, r.itemName, r.spec, r.maker].join(' ')).includes(k)) : rows).slice(0, 500);
  }, [rows, q]);

  return (
    <div>
      <PageHeader
        title="단가 조회"
        desc={`단가관리시스템 단가표의 ERP 사본입니다${at ? ` (${new Date(at).toLocaleString('ko-KR')} 기준, 하루 한 번 자동 갱신)` : ''}. 단가 수정은 단가관리시스템에서 하세요. 구매청구서 단가 자동 채우기에 씁니다.`}
        actions={
          <div className="flex gap-2">
            <input className="input w-64" placeholder="업체·품명·규격 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            <button className="btn-ghost" disabled={busy} onClick={refresh}>
              {busy ? '불러오는 중…' : '원본에서 새로 불러오기'}
            </button>
          </div>
        }
      />
      <div className="card overflow-hidden">
        {error ? (
          <Empty>단가를 읽지 못했습니다: {error}</Empty>
        ) : !shown.length ? (
          <Empty>{loading ? '불러오는 중…' : '단가 데이터가 없습니다.'}</Empty>
        ) : (
          <div className="max-h-[calc(100vh-200px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>업체</th>
                  <th>품명</th>
                  <th>규격</th>
                  <th>단위</th>
                  <th className="num">협가</th>
                  <th className="num">네고율</th>
                  <th className="num">구매단가</th>
                  <th>메이커</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    <td>{r.vendorName}</td>
                    <td>{r.itemName}</td>
                    <td>{r.spec}</td>
                    <td>{r.unit}</td>
                    <td className="num">{r.listPrice ? won(r.listPrice) : ''}</td>
                    <td className="num">{r.negoRate ? `${r.negoRate}%` : ''}</td>
                    <td className="num font-semibold">{won(r.buyPrice)}</td>
                    <td className="text-muted">{r.maker}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > shown.length && <div className="px-4 py-2 text-[12px] text-muted">{rows.length.toLocaleString()}건 중 {shown.length}건 표시 — 검색으로 좁히세요</div>}
          </div>
        )}
      </div>
    </div>
  );
}
