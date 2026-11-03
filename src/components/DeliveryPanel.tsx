// 납품 일정 (업체가 차량·기사·도착 예정을 알림 → 현장·자재부 텔레그램)
import { useState } from 'react';
import { commitBatch } from '../lib/db';
import { C } from '../lib/firebase';
import { notifyQuiet } from '../lib/notify';
import type { DeliveryPlan, PurchaseOrder } from '../types';
import { errMsg, Field, useToast } from './ui';

const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const empty = (): Omit<DeliveryPlan, 'id' | 'by' | 'at'> => ({ date: today(), time: '', vehicle: '', driverName: '', driverPhone: '', note: '' });

/** 발주 한 건의 납품 일정. canEdit = 업체(자기 발주) 또는 자재부 */
export default function DeliveryPanel({ po, canEdit, who }: { po: PurchaseOrder; canEdit: boolean; who: string }) {
  const toast = useToast();
  const [f, setF] = useState<ReturnType<typeof empty> | null>(null);
  const [busy, setBusy] = useState(false);
  const list = [...(po.deliveries ?? [])].sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
  const save = async (next: DeliveryPlan[], msg: string, notifyId?: string) => {
    setBusy(true);
    try {
      await commitBatch([{ type: 'set', col: C.purchaseOrders, id: po.id, data: { deliveries: next } }]);
      toast(msg);
      if (notifyId) notifyQuiet('delivery_plan', { poId: po.id, deliveryId: notifyId });
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    if (!f?.date) return toast('납품 날짜를 고르세요.', 'err');
    const id = Math.random().toString(36).slice(2, 9);
    const d: DeliveryPlan = { id, date: f.date, by: who, at: Date.now(), ...Object.fromEntries(Object.entries(f).filter(([k, v]) => k !== 'date' && String(v ?? '').trim())) };
    void save([...(po.deliveries ?? []), d], '납품 일정을 알렸습니다. 현장·자재부에 알림이 갑니다.', id).then(() => setF(null));
  };
  return (
    <div className="card mb-3 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-semibold">납품 일정</span>
        <span className="text-[12px] text-muted">업체가 차량·기사·도착 예정을 알리면 현장 단톡방과 자재부에 알림이 갑니다.</span>
        {canEdit && !f && (
          <button className="btn-primary ml-auto h-8 text-[12.5px]" onClick={() => setF(empty())}>
            + 납품 일정 알리기
          </button>
        )}
      </div>
      {f && (
        <div className="grid gap-2 border-b border-line bg-amber-soft/40 p-3 sm:grid-cols-3">
          <Field label="납품 날짜 *">
            <input type="date" className="input" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
          </Field>
          <Field label="도착 예정 시간">
            <input className="input" placeholder="예: 08:30, 오전" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
          </Field>
          <Field label="차량">
            <input className="input" placeholder="예: 5톤 카고 12가3456" value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} />
          </Field>
          <Field label="기사 이름">
            <input className="input" value={f.driverName} onChange={(e) => setF({ ...f, driverName: e.target.value })} />
          </Field>
          <Field label="기사 연락처">
            <input className="input" type="tel" value={f.driverPhone} onChange={(e) => setF({ ...f, driverPhone: e.target.value })} />
          </Field>
          <Field label="요청 사항">
            <input className="input" placeholder="예: 지게차 필요, 하차 2명" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Field>
          <div className="flex gap-2 sm:col-span-3">
            <button className="btn-ghost" onClick={() => setF(null)}>
              취소
            </button>
            <button className="btn-primary" disabled={busy} onClick={add}>
              알리기
            </button>
          </div>
        </div>
      )}
      {!list.length ? (
        <div className="px-4 py-3 text-[12.5px] text-muted">알린 납품 일정이 없습니다.</div>
      ) : (
        <div className="divide-y divide-line">
          {list.map((d) => (
            <div key={d.id} className={`flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-[12.5px] ${d.done ? 'text-muted' : ''}`}>
              <span className={`font-bold ${d.date === today() && !d.done ? 'text-amber-700' : ''}`}>
                {d.date} {d.time}
                {d.date === today() && !d.done && <span className="chip ml-1 bg-amber-brand text-navy-950">오늘</span>}
              </span>
              {d.vehicle && <span>🚚 {d.vehicle}</span>}
              {(d.driverName || d.driverPhone) && (
                <span>
                  기사 {d.driverName}{' '}
                  {d.driverPhone && (
                    <a className="text-sky-700 underline" href={`tel:${d.driverPhone}`}>
                      {d.driverPhone}
                    </a>
                  )}
                </span>
              )}
              {d.note && <span className="text-muted">요청: {d.note}</span>}
              {d.done && <span className="chip bg-emerald-50 text-emerald-700">납품 완료</span>}
              {canEdit && (
                <span className="ml-auto flex gap-2">
                  <button className="text-[12px] text-sky-700 hover:underline" onClick={() => save((po.deliveries ?? []).map((x) => (x.id === d.id ? { ...x, done: !x.done } : x)), d.done ? '되돌렸습니다.' : '납품 완료로 표시했습니다.')}>
                    {d.done ? '완료 취소' : '납품 완료'}
                  </button>
                  <button className="text-[12px] text-muted hover:text-red-600" onClick={() => confirm('이 납품 일정을 지울까요?') && save((po.deliveries ?? []).filter((x) => x.id !== d.id), '지웠습니다.')}>
                    지우기
                  </button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
