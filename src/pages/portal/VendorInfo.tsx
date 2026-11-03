// 업체 포털 › 업체 정보: 담당자·연락처·주소 등을 업체가 직접 고친다 (업체명은 명신기공 자재부가 관리)
import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../../auth/AuthContext';
import { commitBatch } from '../../lib/db';
import { C, db } from '../../lib/firebase';
import { Field, errMsg, useToast } from '../../components/ui';
import { VENDOR_SELF_FIELDS, type Vendor } from '../../types';

type Form = Record<(typeof VENDOR_SELF_FIELDS)[number], string>;
const LABEL: Record<keyof Form, string> = {
  contactName: '담당자 이름',
  phone: '전화',
  mobile: '담당자 휴대폰',
  email: '이메일 (발주서·견적 의뢰가 이 주소로 갑니다)',
  fax: '팩스',
  address: '주소',
  bizNo: '사업자등록번호',
  ceoName: '대표자',
  vendorNote: '명신기공에 전할 안내 (예: 납품 가능 시간, 휴무일)',
};
const empty = (): Form => Object.fromEntries(VENDOR_SELF_FIELDS.map((k) => [k, ''])) as Form;

export default function VendorInfo() {
  const { vendor } = useAuth();
  const toast = useToast();
  const [v, setV] = useState<Vendor | null>(null);
  const [f, setF] = useState<Form>(empty());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!vendor) return;
    return onSnapshot(
      doc(db, C.vendors, vendor.vendorId),
      (d) => {
        const x = d.exists() ? ({ ...(d.data() as Omit<Vendor, 'id'>), id: d.id } as Vendor) : null;
        setV(x);
        if (x) setF(Object.fromEntries(VENDOR_SELF_FIELDS.map((k) => [k, String(x[k] ?? '')])) as Form);
      },
      () => setV(null),
    );
  }, [vendor]);
  const dirty = !!v && VENDOR_SELF_FIELDS.some((k) => (v[k] ?? '') !== f[k].trim());
  const save = async () => {
    if (!vendor || !v) return;
    if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return toast('이메일 주소 형식을 확인하세요.', 'err');
    setBusy(true);
    try {
      const data: Record<string, unknown> = { vendorUpdatedAt: Date.now() };
      for (const k of VENDOR_SELF_FIELDS) if ((v[k] ?? '') !== f[k].trim()) data[k] = f[k].trim();
      await commitBatch([{ type: 'set', col: C.vendors, id: vendor.vendorId, data, merge: true }]);
      toast('업체 정보를 저장했습니다.');
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  if (!v) return <div className="card p-6 text-muted">업체 정보를 불러오는 중…</div>;
  return (
    <div className="card max-w-3xl overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <span className="font-semibold">업체 정보</span>
        <span className="text-[12px] text-muted">업체명: {v.name} (업체명 변경은 명신기공 자재부에 요청하세요)</span>
      </div>
      <div className="grid gap-3 p-4 sm:grid-cols-2">
        {VENDOR_SELF_FIELDS.map((k) => (
          <div key={k} className={k === 'address' || k === 'vendorNote' || k === 'email' ? 'sm:col-span-2' : ''}>
            <Field label={LABEL[k]}>
              {k === 'vendorNote' ? (
                <textarea className="input h-20 w-full py-1.5" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
              ) : (
                <input className="input w-full" type={k === 'email' ? 'email' : k === 'phone' || k === 'mobile' || k === 'fax' ? 'tel' : 'text'} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
              )}
            </Field>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-line px-4 py-3">
        <span className="text-[12px] text-muted">{v.vendorUpdatedAt ? `마지막 수정 ${new Date(v.vendorUpdatedAt).toLocaleString('ko-KR')}` : ''}</span>
        <button className="btn-primary ml-auto" disabled={busy || !dirty} onClick={save}>
          저장
        </button>
      </div>
    </div>
  );
}
