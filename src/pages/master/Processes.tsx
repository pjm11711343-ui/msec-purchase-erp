// 기준정보 › 구역·공종 (회사 공통)
import { useEffect, useState } from 'react';
import { audit, commitBatch } from '../../lib/db';
import { C } from '../../lib/firebase';
import { DEFAULT_MASTER, sortedTrades, sortedZones, useProcessMaster, type ProcessMaster, type Trade, type Zone } from '../../lib/process';
import { errMsg, PageHeader, useToast } from '../../components/ui';

const words = (s: string) => s.split(/[,\s·]+/).map((x) => x.trim()).filter(Boolean);
const newKey = () => Math.random().toString(36).slice(2, 7);

export default function Processes() {
  const pm = useProcessMaster();
  const toast = useToast();
  const [m, setM] = useState<ProcessMaster | null>(null);
  useEffect(() => {
    if (!pm.loading && !m) setM(structuredClone(pm.master));
  }, [pm.loading, pm.master, m]);
  if (!m) return <div className="text-muted">불러오는 중…</div>;

  const zones = sortedZones(m);
  const trades = sortedTrades(m);
  const setZone = (id: string, p: Partial<Zone>) => setM({ ...m, zones: m.zones.map((z) => (z.id === id ? { ...z, ...p } : z)) });
  const setTrade = (id: string, p: Partial<Trade>) => setM({ ...m, trades: m.trades.map((t) => (t.id === id ? { ...t, ...p } : t)) });
  const move = <T extends { id: string; order: number }>(list: T[], id: string, dir: -1 | 1): T[] => {
    const s = [...list].sort((a, b) => a.order - b.order);
    const i = s.findIndex((x) => x.id === id);
    const j = i + dir;
    if (j < 0 || j >= s.length) return list;
    [s[i], s[j]] = [s[j], s[i]];
    return s.map((x, k) => ({ ...x, order: k + 1 }));
  };
  const save = async () => {
    if (m.zones.some((z) => !z.name.trim()) || m.trades.some((t) => !t.name.trim())) return toast('이름이 빈 구역·공종이 있습니다.', 'err');
    try {
      await commitBatch([{ type: 'set', col: C.processMaster, id: 'main', data: m, merge: false }]);
      await audit('구역·공종 저장', '', { zones: m.zones.length, trades: m.trades.length });
      toast('저장했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    }
  };

  return (
    <div>
      <PageHeader
        title="구역·공종"
        desc="회사 공통 공정 구분입니다. 현장마다 쓰는 칸만 켜서 쓰고(구매 흐름 › 공정별 청구), 구매청구서는 공정 1칸마다 따로 작성합니다. 키워드는 공정분리 툴 공종 이름을 구역·공종으로 자동 맞출 때 씁니다."
        actions={
          <>
            {!pm.saved && <span className="self-center text-[12px] text-amber-700">기본값입니다. 저장하면 회사 기준이 됩니다.</span>}
            <button className="btn-ghost" onClick={() => confirm('기본값으로 되돌릴까요? (저장 전까지 반영 안 됨)') && setM(structuredClone(DEFAULT_MASTER))}>
              기본값
            </button>
            <button className="btn-primary" onClick={save}>
              저장
            </button>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[1fr_380px]">
        <div className="card overflow-hidden">
          <div className="flex items-center border-b border-line px-4 py-2.5">
            <span className="font-semibold">구역 {zones.length}</span>
            <button
              className="btn-ghost ml-auto h-7 text-[12px]"
              onClick={() => setM({ ...m, zones: [...m.zones, { id: `z${newKey()}`, name: '', order: zones.length + 1, keywords: [], defaultTrades: trades.map((t) => t.id) }] })}
            >
              + 구역 추가
            </button>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-16">순서</th>
                <th>구역</th>
                <th>기본으로 켤 공종</th>
                <th>세부 위치 (청구서에서 선택)</th>
                <th>자동 맞춤 키워드</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.id}>
                  <td className="whitespace-nowrap">
                    <button className="px-1 text-muted hover:text-ink" onClick={() => setM({ ...m, zones: move(m.zones, z.id, -1) })}>
                      ▲
                    </button>
                    <button className="px-1 text-muted hover:text-ink" onClick={() => setM({ ...m, zones: move(m.zones, z.id, 1) })}>
                      ▼
                    </button>
                  </td>
                  <td>
                    <input className="input h-7 w-32 px-1.5 font-medium" value={z.name} onChange={(e) => setZone(z.id, { name: e.target.value })} />
                  </td>
                  <td className="whitespace-nowrap">
                    {trades.map((t) => (
                      <label key={t.id} className="mr-2 inline-flex items-center gap-1 text-[12.5px]">
                        <input
                          type="checkbox"
                          checked={z.defaultTrades.includes(t.id)}
                          onChange={(e) => setZone(z.id, { defaultTrades: e.target.checked ? [...z.defaultTrades, t.id] : z.defaultTrades.filter((x) => x !== t.id) })}
                        />
                        {t.name}
                      </label>
                    ))}
                  </td>
                  <td>
                    <input className="input h-7 w-40 px-1.5" placeholder="예: 복도, 입상, 동지하" value={(z.subs ?? []).join(', ')} onChange={(e) => setZone(z.id, { subs: words(e.target.value) })} />
                  </td>
                  <td>
                    <input className="input h-7 w-52 px-1.5" value={z.keywords.join(', ')} onChange={(e) => setZone(z.id, { keywords: words(e.target.value) })} />
                  </td>
                  <td>
                    <button className="text-[12px] text-muted hover:text-red-600" onClick={() => confirm(`"${z.name}" 구역을 뺄까요? (이미 쓴 청구서의 공정 이름은 비게 됩니다)`) && setM({ ...m, zones: m.zones.filter((x) => x.id !== z.id) })}>
                      빼기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="border-t border-line px-4 py-2 text-[12px] text-muted">
            세부 위치: 내역은 한 구역으로 관리하되 청구서에서 위치만 따로 적는 경우입니다. 예) 세대외배관 내역 = 복도·입상·동지하 합계, 청구서는 "세대외배관(복도) 위생"처럼 표시. 기반입·잔여는 구역 합계로 봅니다.
          </div>
        </div>

        <div className="space-y-4">
          <div className="card overflow-hidden">
            <div className="flex items-center border-b border-line px-4 py-2.5">
              <span className="font-semibold">공종 {trades.length}</span>
              <button className="btn-ghost ml-auto h-7 text-[12px]" onClick={() => setM({ ...m, trades: [...m.trades, { id: `t${newKey()}`, name: '', order: trades.length + 1, keywords: [] }] })}>
                + 공종 추가
              </button>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-14"></th>
                  <th>공종</th>
                  <th>키워드</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id}>
                    <td className="whitespace-nowrap">
                      <button className="px-1 text-muted hover:text-ink" onClick={() => setM({ ...m, trades: move(m.trades, t.id, -1) })}>
                        ▲
                      </button>
                      <button className="px-1 text-muted hover:text-ink" onClick={() => setM({ ...m, trades: move(m.trades, t.id, 1) })}>
                        ▼
                      </button>
                    </td>
                    <td>
                      <input className="input h-7 w-20 px-1.5 font-medium" value={t.name} onChange={(e) => setTrade(t.id, { name: e.target.value })} />
                    </td>
                    <td>
                      <input className="input h-7 w-full px-1.5" value={t.keywords.join(', ')} onChange={(e) => setTrade(t.id, { keywords: words(e.target.value) })} />
                    </td>
                    <td>
                      <button className="text-[12px] text-muted hover:text-red-600" onClick={() => confirm(`"${t.name}" 공종을 뺄까요?`) && setM({ ...m, trades: m.trades.filter((x) => x.id !== t.id), zones: m.zones.map((z) => ({ ...z, defaultTrades: z.defaultTrades.filter((x) => x !== t.id) })) })}>
                        빼기
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card p-4">
            <div className="mb-1 font-semibold">공정 관리에서 빼는 말 (외주)</div>
            <input className="input" value={m.exclude.join(', ')} onChange={(e) => setM({ ...m, exclude: words(e.target.value) })} />
            <div className="mt-1 text-[12px] text-muted">공정분리 툴 공종 이름에 이 말이 있으면 가져올 때 "제외"로 추천합니다.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
