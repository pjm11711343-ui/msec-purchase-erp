// 현장 분류(투입집계 분류) 추가·수정·삭제 — 투입집계 화면과 기준정보 › 분류에서 같이 씀
//  - 삭제: 투입 기록(원장)이나 금액이 없으면 바로 삭제
//          있으면 다른 분류로 합친 뒤 삭제 (원장·계산서 줄·금액·계산서 표기를 옮김)
import { useState } from 'react';
import { audit, commitBatch, fetchWhere, newId } from '../lib/db';
import { C } from '../lib/firebase';
import type { Invoice, LedgerEntry, SiteCategory, StandardCategory } from '../types';
import { errMsg, Field, Modal, NumInput, useToast } from './ui';

const words = (s: string) => s.split(/[,\n]+/).map((x) => x.trim()).filter(Boolean);

/** 분류 추가·수정 창 */
export function SiteCatEditor({ siteId, cat, cats, std, onClose }: { siteId: string; cat?: SiteCategory; cats: SiteCategory[]; std: StandardCategory[]; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: cat?.name ?? '',
    standardCategoryId: cat?.standardCategoryId ?? '',
    aliases: (cat?.aliases ?? []).join(', '),
    contractAmount: cat?.contractAmount ?? 0,
    changeAmount: cat?.changeAmount ?? 0,
    execAmount: cat?.execAmount ?? 0,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const name = f.name.trim();
    if (!name) return toast('분류 이름을 입력하세요.', 'err');
    if (cats.some((c) => c.siteId === siteId && c.id !== cat?.id && c.name.replace(/\s/g, '') === name.replace(/\s/g, ''))) return toast('이 현장에 같은 이름의 분류가 있습니다.', 'err');
    setBusy(true);
    try {
      const siteCats = cats.filter((c) => c.siteId === siteId);
      const data = {
        siteId,
        name,
        aliases: words(f.aliases),
        standardCategoryId: f.standardCategoryId || null,
        contractAmount: f.contractAmount || 0,
        changeAmount: f.changeAmount || 0,
        execAmount: f.execAmount || 0,
        ...(cat ? {} : { order: Math.max(0, ...siteCats.map((c) => c.order)) + 1, migratedInput: 0 }),
      };
      await commitBatch([{ type: 'set', col: C.siteCategories, id: cat?.id ?? newId(C.siteCategories), data, merge: !!cat }]);
      await audit(cat ? '현장 분류 수정' : '현장 분류 추가', name, { siteId });
      toast(cat ? '수정했습니다.' : '분류를 추가했습니다.');
      onClose();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={cat ? `분류 수정 · ${cat.name}` : '분류 추가'}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn-primary" disabled={busy} onClick={save}>
            저장
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Field label="분류 이름 (투입집계 표에 나오는 이름) *">
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="표준분류 (회사 전체 비교용)">
            <select className="input" value={f.standardCategoryId} onChange={(e) => setF({ ...f, standardCategoryId: e.target.value })}>
              <option value="">미지정</option>
              {std.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="col-span-2">
          <Field label="계산서 표기 (쉼표로 여러 개)" hint="계산서 '분류' 칸에 이렇게 적혀 오면 이 분류로 넣습니다.">
            <input className="input" value={f.aliases} onChange={(e) => setF({ ...f, aliases: e.target.value })} />
          </Field>
        </div>
        <Field label="도급금액">
          <NumInput className="input" value={f.contractAmount} onChange={(n) => setF({ ...f, contractAmount: n })} />
        </Field>
        <Field label="변경예상금액">
          <NumInput className="input" value={f.changeAmount} onChange={(n) => setF({ ...f, changeAmount: n })} />
        </Field>
        <Field label="실행금액">
          <NumInput className="input" value={f.execAmount} onChange={(n) => setF({ ...f, execAmount: n })} />
        </Field>
      </div>
    </Modal>
  );
}

/** 분류 삭제 창: 투입 기록이 있으면 다른 분류로 합친 뒤 삭제 */
export function SiteCatDelete({ cat, cats, ledger, onClose }: { cat: SiteCategory; cats: SiteCategory[]; ledger: LedgerEntry[]; onClose: () => void }) {
  const toast = useToast();
  const others = cats.filter((c) => c.siteId === cat.siteId && c.id !== cat.id).sort((a, b) => a.order - b.order);
  const used = ledger.filter((e) => e.siteCategoryId === cat.id);
  const usedAmt = used.reduce((a, e) => a + e.amount, 0);
  const hasMoney = !!(cat.contractAmount || cat.changeAmount || cat.execAmount || cat.migratedInput);
  const mustMerge = used.length > 0 || !!cat.migratedInput;
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (mustMerge && !to) return toast('투입 기록이 있어 합칠 분류를 골라야 합니다.', 'err');
    const target = others.find((c) => c.id === to);
    if (!confirm(target ? `"${cat.name}"을(를) "${target.name}"에 합치고 삭제할까요?` : `"${cat.name}" 분류를 삭제할까요?`)) return;
    setBusy(true);
    try {
      const ops: Parameters<typeof commitBatch>[0] = [];
      if (target) {
        // 원장(월별 투입)·계산서 줄을 옮기고, 금액·계산서 표기를 더한다
        const allLedger = await fetchWhere<LedgerEntry>(C.ledger, 'siteId', cat.siteId);
        for (const e of allLedger) if (e.siteCategoryId === cat.id) ops.push({ type: 'set', col: C.ledger, id: e.id, data: { siteCategoryId: target.id } });
        const invs = await fetchWhere<Invoice>(C.invoices, 'siteId', cat.siteId);
        for (const inv of invs)
          if (inv.lines.some((l) => l.siteCategoryId === cat.id))
            ops.push({ type: 'set', col: C.invoices, id: inv.id, data: { lines: inv.lines.map((l) => (l.siteCategoryId === cat.id ? { ...l, siteCategoryId: target.id } : l)) } });
        ops.push({
          type: 'set',
          col: C.siteCategories,
          id: target.id,
          data: {
            contractAmount: (target.contractAmount || 0) + (cat.contractAmount || 0),
            changeAmount: (target.changeAmount || 0) + (cat.changeAmount || 0),
            execAmount: (target.execAmount || 0) + (cat.execAmount || 0),
            migratedInput: (target.migratedInput || 0) + (cat.migratedInput || 0),
            aliases: [...new Set([...(target.aliases ?? []), ...(cat.aliases ?? []), cat.name])],
          },
        });
      }
      ops.push({ type: 'delete', col: C.siteCategories, id: cat.id });
      await commitBatch(ops);
      await audit(target ? '현장 분류 합치고 삭제' : '현장 분류 삭제', cat.name, { siteId: cat.siteId, to: target?.name });
      toast(target ? `"${target.name}"에 합치고 삭제했습니다.` : '삭제했습니다.');
      onClose();
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      title={`분류 삭제 · ${cat.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            취소
          </button>
          <button className="btn-danger" disabled={busy || (mustMerge && !to)} onClick={run}>
            {to ? '합치고 삭제' : '삭제'}
          </button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        {mustMerge ? (
          <div className="rounded-md bg-amber-soft px-3 py-2 text-amber-900">
            이 분류에 투입 기록이 있습니다 (월별 {used.length}건 · {usedAmt.toLocaleString()}원{cat.migratedInput ? ` · 이관 ${cat.migratedInput.toLocaleString()}원` : ''}). 기록이 사라지지 않도록 다른 분류로 합친 뒤 삭제합니다.
          </div>
        ) : hasMoney ? (
          <div className="rounded-md bg-canvas px-3 py-2 text-muted">투입 기록은 없지만 도급·실행 금액이 있습니다. 그냥 삭제하면 금액도 사라집니다. 다른 분류로 합치면 금액이 더해집니다.</div>
        ) : (
          <div className="text-muted">투입 기록과 금액이 없는 분류입니다. 바로 삭제할 수 있습니다.</div>
        )}
        <Field label={mustMerge ? '합칠 분류 *' : '합칠 분류 (선택)'} hint="합치면 월별 투입·계산서 줄·도급·변경·실행·이관 금액·계산서 표기가 그 분류로 옮겨집니다.">
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">{mustMerge ? '분류 선택' : '합치지 않고 삭제'}</option>
            {others.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="text-[12px] text-muted">이미 작성된 구매청구서 줄의 자재분류는 바뀌지 않으니, 필요하면 청구서에서 다시 고르세요.</div>
      </div>
    </Modal>
  );
}
