import { useMemo, useState } from 'react';
import { deleteReqAliases, useReqAliases } from '../../lib/reqAlias';
import { nameKey } from '../../lib/normalize';
import { Empty, errMsg, PageHeader, useToast } from '../../components/ui';

/** 청구서 엑셀 품명·규격 다른 표기 (자재부가 고친 것을 기억해 다음 불러오기 때 자동 인식) */
export default function ReqAliases() {
  const aliases = useReqAliases();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());

  const shown = useMemo(() => {
    const k = nameKey(q);
    const l = [...aliases.list].sort((a, b) => b.at - a.at);
    return k ? l.filter((a) => nameKey([a.fromItem, a.fromSpec, a.toItem, a.toSpec, a.byName].join(' ')).includes(k)) : l;
  }, [aliases.list, q]);

  const remove = async (ids: string[]) => {
    if (!ids.length || !confirm(`${ids.length}건을 지울까요? 다음 엑셀 불러오기부터 자동으로 바뀌지 않습니다.`)) return;
    try {
      await deleteReqAliases(ids);
      setSel(new Set());
      toast(`${ids.length}건을 지웠습니다.`);
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  return (
    <div>
      <PageHeader
        title="품명 다른 표기"
        desc="청구서 엑셀의 품명·규격이 목록과 달라 자재부가 고친 내용입니다. 다음에 엑셀을 불러오면 같은 표기는 오른쪽 기준 품명·규격으로 자동으로 바뀝니다. (회사 공용)"
        actions={
          sel.size > 0 && (
            <button className="btn-danger" onClick={() => remove([...sel])}>
              선택 {sel.size}건 지우기
            </button>
          )
        }
      />
      <div className="card overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="font-semibold">{aliases.list.length}건</span>
          <input className="input ml-auto h-7 w-56" placeholder="품명·규격·고친 사람 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {!shown.length ? (
          <Empty>{aliases.loading ? '불러오는 중…' : '아직 기억한 표기가 없습니다. 청구서 엑셀 불러오기에서 "내역·규격 수정 요함" 줄을 자재부가 고쳐 저장하면 여기에 쌓입니다.'}</Empty>
        ) : (
          <div className="max-h-[calc(100vh-220px)] overflow-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-8">
                    <input type="checkbox" checked={shown.length > 0 && shown.every((a) => sel.has(a.id))} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((a) => a.id)) : new Set())} />
                  </th>
                  <th>엑셀 품명</th>
                  <th>엑셀 규격</th>
                  <th></th>
                  <th>기준 품명</th>
                  <th>기준 규격</th>
                  <th>고친 사람</th>
                  <th>날짜</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={sel.has(a.id)}
                        onChange={() =>
                          setSel((s) => {
                            const n = new Set(s);
                            if (n.has(a.id)) n.delete(a.id);
                            else n.add(a.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td className="text-muted">{a.fromItem}</td>
                    <td className="text-muted">{a.fromSpec}</td>
                    <td className="text-muted">→</td>
                    <td className="font-medium">{a.toItem}</td>
                    <td className="font-medium">{a.toSpec}</td>
                    <td className="text-muted">{a.byName}</td>
                    <td className="whitespace-nowrap text-muted">{new Date(a.at).toLocaleDateString('ko-KR')}</td>
                    <td className="text-right">
                      <button className="text-[12px] text-muted hover:text-red-600" onClick={() => remove([a.id])}>
                        지우기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
