import { useState } from 'react';
import { audit, commitBatch, newId, useCollection } from '../../lib/db';
import { createAccount, randomCode } from '../../lib/accounts';
import { useAuth } from '../../auth/AuthContext';
import { C, vendorEmail } from '../../lib/firebase';
import { useVendors } from '../../lib/hooks';
import { nameKey } from '../../lib/normalize';
import CrudTable, { toList } from '../../components/CrudTable';
import { errMsg, Modal, PageHeader, useToast } from '../../components/ui';
import type { Vendor, VendorAccount } from '../../types';

export default function Vendors() {
  const vendors = useVendors();
  const accounts = useCollection<VendorAccount>(C.vendorAccounts);
  const { profile, can } = useAuth();
  const toast = useToast();
  const [issued, setIssued] = useState<{ vendor: string; code: string; access: string } | null>(null);
  const [issuing, setIssuing] = useState(false);
  const accountOf = (vid: string) => accounts.data.find((a) => a.vendorId === vid && a.active);

  const issue = async (v: Vendor) => {
    const prev = accounts.data.filter((a) => a.vendorId === v.id && a.active);
    if (prev.length && !confirm(`${v.name}은(는) 이미 업체코드 ${prev[0].code}가 있습니다. 새 접속코드를 발급하면 기존 코드는 쓸 수 없게 됩니다. 계속할까요?`)) return;
    setIssuing(true);
    try {
      const nums = accounts.data.map((a) => Number(a.code.replace(/\D/g, '').split('-')[0]) || 0);
      // 업체코드는 발급할 때마다 새 번호 (재발급이면 기존 코드는 막힌다)
      const code = `V${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
      const access = randomCode(8);
      const uid = await createAccount(vendorEmail(code), access);
      const acc: Omit<VendorAccount, 'id'> = { vendorId: v.id, vendorName: v.name, code, accessCode: access, active: true, issuedAt: Date.now(), issuedBy: profile?.name ?? '' };
      await commitBatch([
        { type: 'set', col: C.vendorAccounts, id: uid, data: acc, merge: false },
        ...prev.map((a) => ({ type: 'set' as const, col: C.vendorAccounts, id: a.id, data: { active: false } })),
      ]);
      await audit('업체 포털 접속코드 발급', v.name, { code });
      setIssued({ vendor: v.name, code, access });
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setIssuing(false);
    }
  };
  const stopPortal = async (ids: string[]) => {
    const list = accounts.data.filter((a) => ids.includes(a.vendorId) && a.active);
    await commitBatch(list.map((a) => ({ type: 'set' as const, col: C.vendorAccounts, id: a.id, data: { active: false } })));
    toast(`${list.length}개 업체의 포털 접속을 막았습니다.`);
  };
  const toVendor = (d: Record<string, unknown>, prev?: Vendor): Partial<Vendor> => ({
    name: String(d.name ?? '').trim(),
    phone: String(d.phone ?? '').trim() || undefined,
    email: String(d.email ?? '').trim() || undefined,
    contactName: String(d.contactName ?? '').trim() || undefined,
    aliases: toList(d.aliases),
    active: prev?.active ?? true,
  });
  /** 업체에 보낼 안내 문구 복사 (PC 프로그램에서 발급해도 인터넷 주소로 안내) */
  const copyGuide = async (code: string, access: string) => {
    const origin = /localhost|127\.0\.0\.1/.test(location.hostname) ? 'https://msec-purchase-erp.vercel.app' : location.origin;
    const text = `[명신기공 협력업체 포털]\n주소: ${origin}/?vendor\n업체코드: ${code}\n접속코드: ${access}\n\n로그인 화면에서 '협력업체'를 누르고 위 코드를 넣으세요. 발주 확인과 현장 입고일 입력을 이곳에서 해주세요.`;
    try {
      await navigator.clipboard.writeText(text);
      toast('안내 문구를 복사했습니다. 업체에 보내 주세요.');
    } catch {
      toast('복사에 실패했습니다. 직접 적어 주세요.', 'err');
    }
  };

  return (
    <div>
      <PageHeader title="업체" desc="발주·계산서를 주고받는 공급업체입니다. 이메일은 3단계 발주서 발송, 접속코드는 4단계 업체 포털에서 씁니다." />
      <CrudTable<Vendor>
        rows={vendors.data}
        loading={vendors.loading}
        search={(v) => [v.name, v.phone, v.email, v.contactName, ...(v.aliases ?? [])].join(' ')}
        columns={[
          { key: 'name', label: '업체명', render: (v) => <span className="font-medium">{v.name}</span> },
          { key: 'phone', label: '전화' },
          { key: 'email', label: '이메일' },
          { key: 'contactName', label: '담당자' },
          { key: 'aliases', label: '다른 표기', render: (v) => <span className="text-[11.5px] text-muted">{(v.aliases ?? []).join(', ')}</span> },
          { key: 'active', label: '상태', render: (v) => (v.active ? '사용' : '중지') },
          {
            key: 'portal',
            label: '업체 포털',
            render: (v) => {
              const a = accountOf(v.id);
              if (!a) return <span className="text-[12px] text-muted">미발급</span>;
              return (
                <span className="inline-flex flex-wrap items-center gap-1">
                  <span className="chip bg-emerald-50 text-emerald-700">업체코드 {a.code}</span>
                  {a.accessCode ? (
                    <>
                      <span className="chip bg-navy-950/5 font-mono text-navy-900">접속코드 {a.accessCode}</span>
                      <button
                        className="text-[11px] text-amber-700 hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          copyGuide(a.code, a.accessCode!);
                        }}
                      >
                        안내 복사
                      </button>
                    </>
                  ) : (
                    <span className="text-[11px] text-muted" title="이 기능 전에 발급한 코드는 저장돼 있지 않습니다. 다시 보려면 재발급하세요.">접속코드 미보관(재발급 시 표시)</span>
                  )}
                </span>
              );
            },
          },
        ]}
        extraActions={(sel) =>
          can('admin') ? (
            <>
              <button
                className="btn-dark h-7 text-[12px]"
                disabled={issuing || sel.length !== 1}
                title={sel.length !== 1 ? '업체를 하나만 고르세요' : ''}
                onClick={() => {
                  const v = vendors.data.find((x) => x.id === sel[0]);
                  if (v) issue(v);
                }}
              >
                {issuing ? '발급 중…' : '포털 접속코드 발급'}
              </button>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => stopPortal(sel).catch((e) => toast(errMsg(e), 'err'))}>
                포털 접속 막기
              </button>
            </>
          ) : null
        }
        fields={[
          { key: 'name', label: '업체명', required: true },
          { key: 'phone', label: '전화' },
          { key: 'email', label: '이메일' },
          { key: 'contactName', label: '담당자' },
          { key: 'aliases', label: '다른 표기 (쉼표로 구분)', type: 'list', hint: '청구서 시트 이름, 계산서 표기 등' },
        ]}
        onSave={async (id, d) => {
          const prev = vendors.data.find((v) => v.id === id);
          const data = toVendor(d, prev);
          const dup = vendors.data.find((v) => v.id !== id && nameKey(v.name) === nameKey(data.name));
          if (dup) throw new Error(`같은 이름의 업체가 이미 있습니다: ${dup.name}`);
          const vid = id ?? newId(C.vendors);
          await commitBatch([{ type: 'set', col: C.vendors, id: vid, data }]);
          await audit(id ? '업체 수정' : '업체 추가', vid, { name: data.name });
        }}
        onActive={async (ids, active) => commitBatch(ids.map((id) => ({ type: 'set' as const, col: C.vendors, id, data: { active } })))}
        onDelete={async (ids) => {
          await commitBatch(ids.map((id) => ({ type: 'delete' as const, col: C.vendors, id })));
          await audit('업체 삭제', ids.join(','));
        }}
        paste={{
          keys: ['name', 'phone', 'email', 'contactName'],
          example: '업체명 ⇥ 전화 ⇥ 이메일 ⇥ 담당자',
          onAdd: async (rows) => {
            const ops = rows
              .filter((r) => r.name)
              .map((r) => {
                const ex = vendors.data.find((v) => nameKey(v.name) === nameKey(r.name) || v.aliases?.some((a) => nameKey(a) === nameKey(r.name)));
                const data = ex
                  ? Object.fromEntries(Object.entries(r).filter(([k, v]) => k !== 'name' && v && !(ex as unknown as Record<string, unknown>)[k]))
                  : toVendor(r);
                return { type: 'set' as const, col: C.vendors, id: ex?.id ?? newId(C.vendors), data };
              });
            await commitBatch(ops);
            await audit('업체 일괄 등록', `${ops.length}건`);
          },
        }}
      />
      <Modal
        open={!!issued}
        title="업체 포털 접속코드"
        onClose={() => setIssued(null)}
        footer={
          <button
            className="btn-primary"
            onClick={async () => {
              if (!issued) return;
              await copyGuide(issued.code, issued.access);
            }}
          >
            안내 문구 복사
          </button>
        }
      >
        {issued && (
          <div className="flex flex-col gap-3">
            <div className="text-[15px] font-semibold">{issued.vendor}</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl bg-canvas p-3">
                <div className="text-[12px] text-muted">업체코드</div>
                <div className="font-mono text-[22px] font-bold tracking-wider">{issued.code}</div>
              </div>
              <div className="rounded-xl bg-amber-soft p-3">
                <div className="text-[12px] text-muted">접속코드</div>
                <div className="font-mono text-[22px] font-bold tracking-wider">{issued.access}</div>
              </div>
            </div>
            <p className="text-[12.5px] text-muted">
              접속코드는 업체 목록의 "업체 포털" 칸에서 관리자(관리자·자재부)가 다시 볼 수 있습니다. 다시 발급하면 기존 코드는 막힙니다.
            </p>
          </div>
        )}
      </Modal>
    </div>
  );
}
