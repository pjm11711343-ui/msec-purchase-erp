import { useMemo, useState } from 'react';
import { readWorkbook, parseRequisitionWorkbook, type ParsedRequisitionFile } from '../lib/parsers';
import { audit, commitBatch, newId, useSettings } from '../lib/db';
import { C } from '../lib/firebase';
import { useSiteCategories, useSites, useVendors } from '../lib/hooks';
import { looselyEqual, nameKey, won } from '../lib/normalize';
import { Empty, errMsg, PageHeader, useToast } from '../components/ui';
import type { Site, SiteCategory, Trade, Vendor } from '../types';

interface BlockTarget {
  mode: 'new' | 'existing' | 'skip';
  siteId: string;
  name: string;
  trade: Trade;
  code: string;
}

interface FileState {
  parsed: ParsedRequisitionFile;
  targets: BlockTarget[];
  vendorSel: Set<string>; // sheetName
}

function nextCodes(prefix: string, sites: Site[], count: number): string[] {
  const used = new Set(sites.map((s) => s.code));
  const out: string[] = [];
  let n = 1;
  while (out.length < count) {
    const c = `${prefix}-${String(n).padStart(2, '0')}`;
    if (!used.has(c)) {
      out.push(c);
      used.add(c);
    }
    n++;
  }
  return out;
}

function findVendor(vendors: Vendor[], name: string): Vendor | undefined {
  const k = nameKey(name);
  return vendors.find((v) => nameKey(v.name) === k || v.aliases?.some((a) => nameKey(a) === k));
}

export default function ImportRequisition() {
  const settings = useSettings();
  const sites = useSites();
  const vendors = useVendors();
  const cats = useSiteCategories();
  const toast = useToast();
  const [files, setFiles] = useState<FileState[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  const onFiles = async (list: FileList | null) => {
    if (!list) return;
    const added: FileState[] = [];
    // 새 현장 코드는 이미 화면에 올라온 파일까지 고려해서 매긴다
    const pendingCodes = files.flatMap((f) => f.targets.filter((t) => t.mode === 'new').map((t) => t.code));
    const taken = [...sites.data, ...pendingCodes.map((code) => ({ code }) as Site)];
    for (const file of Array.from(list)) {
      try {
        const parsed = parseRequisitionWorkbook(readWorkbook(await file.arrayBuffer()), file.name);
        const two = parsed.blocks.length > 1;
        const codes = nextCodes(settings.siteCodePrefix, taken, parsed.blocks.length);
        const targets: BlockTarget[] = parsed.blocks.map((b, i) => {
          const name = two ? `${parsed.shortName}(${b.guessedTrade})` : parsed.shortName;
          const existing = sites.data.find(
            (s) =>
              (looselyEqual(s.name, name) || s.aliases?.some((a) => looselyEqual(a, name))) &&
              (!two || s.trade === b.guessedTrade),
          );
          if (!existing) taken.push({ code: codes[i] } as Site);
          return existing
            ? { mode: 'existing', siteId: existing.id, name: existing.name, trade: existing.trade, code: existing.code }
            : { mode: 'new', siteId: '', name, trade: b.guessedTrade, code: codes[i] };
        });
        const vendorSel = new Set(parsed.vendors.filter((v) => !findVendor(vendors.data, v.name)).map((v) => v.sheetName));
        added.push({ parsed, targets, vendorSel });
      } catch (e) {
        toast(`${file.name}: ${errMsg(e)}`, 'err');
      }
    }
    setFiles((f) => [...f, ...added]);
  };

  const update = (fi: number, fn: (f: FileState) => FileState) => setFiles((fs) => fs.map((f, i) => (i === fi ? fn(f) : f)));

  const save = async () => {
    setBusy(true);
    try {
      type Op = Parameters<typeof commitBatch>[0][number];
      const ops: Op[] = [];
      const now = Date.now();
      const vendorNames = new Set<string>();
      let siteCount = 0;
      let catCount = 0;
      for (const f of files) {
        const p = f.parsed;
        f.targets.forEach((t, bi) => {
          if (t.mode === 'skip') return;
          const block = p.blocks[bi];
          const siteId = t.mode === 'existing' ? t.siteId : newId(C.sites);
          const prev = sites.data.find((s) => s.id === siteId);
          const aliases = new Set(prev?.aliases ?? []);
          [p.shortName, p.fullName, p.titleName].filter(Boolean).forEach((a) => aliases.add(a));
          const site: Partial<Site> = {
            code: prev?.code ?? t.code,
            name: t.mode === 'existing' ? (prev?.name ?? t.name) : t.name,
            fullName: prev?.fullName || p.fullName || p.titleName,
            aliases: [...aliases].filter((a) => a !== t.name),
            trade: t.trade,
            groupName: p.blocks.length > 1 ? p.shortName : prev?.groupName,
            address: prev?.address || p.address,
            households: prev?.households || p.households,
            managerContact: p.managerContact || prev?.managerContact,
            officeContact: p.officeContact || prev?.officeContact,
            orderDisplayName: p.orderDisplayName || prev?.orderDisplayName,
            active: prev?.active ?? true,
            createdAt: prev?.createdAt ?? now,
          };
          ops.push({ type: 'set', col: C.sites, id: siteId, data: site });
          siteCount++;
          const existingCats = cats.data.filter((c) => c.siteId === siteId);
          block.rows.forEach((r, order) => {
            const ex = existingCats.find((c) => nameKey(c.name) === nameKey(r.name));
            const data: Partial<SiteCategory> = {
              siteId,
              name: r.name,
              aliases: ex?.aliases ?? [],
              order,
              standardCategoryId: ex?.standardCategoryId,
              contractAmount: Math.round(r.contractAmount),
              changeAmount: Math.round(r.changeAmount),
              execAmount: Math.round(r.execAmount),
              migratedInput: Math.round(r.inputAmount),
              migratedMonth: settings.cutoffMonth,
            };
            ops.push({ type: 'set', col: C.siteCategories, id: ex?.id ?? newId(C.siteCategories), data });
            catCount++;
          });
        });
        for (const v of p.vendors) {
          if (!f.vendorSel.has(v.sheetName) || vendorNames.has(nameKey(v.name))) continue;
          vendorNames.add(nameKey(v.name));
          const ex = findVendor(vendors.data, v.name);
          const aliases = new Set(ex?.aliases ?? []);
          if (nameKey(v.sheetName) !== nameKey(v.name)) aliases.add(v.sheetName);
          ops.push({
            type: 'set',
            col: C.vendors,
            id: ex?.id ?? newId(C.vendors),
            data: { name: ex?.name ?? v.name, aliases: [...aliases], phone: ex?.phone || v.phone, active: ex?.active ?? true },
          });
        }
      }
      await commitBatch(ops, (d, t) => setProgress(`${d}/${t}`));
      await audit('청구서 파일 이관', files.map((f) => f.parsed.fileName).join(', '), { siteCount, catCount });
      toast(`현장 ${siteCount}곳, 분류 ${catCount}개, 업체 ${vendorNames.size}곳을 저장했습니다.`);
      setFiles([]);
    } catch (e) {
      toast(errMsg(e), 'err');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const totals = useMemo(() => {
    let blocks = 0;
    let vend = 0;
    files.forEach((f) => {
      blocks += f.targets.filter((t) => t.mode !== 'skip').length;
      vend += f.vendorSel.size;
    });
    return { blocks, vend };
  }, [files]);

  return (
    <div>
      <PageHeader
        title="청구서 파일 이관"
        desc={`현장별 청구서 엑셀에서 현장 정보, 투입집계 분류·금액, 업체를 가져옵니다. 투입금액은 ${settings.cutoffMonth}까지의 시작 잔액으로 저장됩니다.`}
        actions={
          <>
            <label className="btn-ghost cursor-pointer">
              파일 선택 (여러 개 가능)
              <input type="file" accept=".xlsx,.xls" multiple hidden onChange={(e) => (onFiles(e.target.files), (e.target.value = ''))} />
            </label>
            <button className="btn-primary" disabled={!files.length || busy} onClick={save}>
              {busy ? `저장 중 ${progress}` : `저장 (현장 ${totals.blocks}, 업체 ${totals.vend})`}
            </button>
          </>
        }
      />
      {!files.length && (
        <div className="card">
          <Empty>
            청구서 파일(예: 26.01.00 KT영통 청구서.xlsx)을 선택하세요. 같은 현장을 다시 올리면 금액만 새 값으로 바뀌고, 분류에 지정한 표준분류·별칭은
            그대로 남습니다.
          </Empty>
        </div>
      )}
      <div className="flex flex-col gap-4">
        {files.map((f, fi) => (
          <div key={fi} className="card fade-up overflow-hidden">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line bg-[#fafbfc] px-5 py-3">
              <div>
                <div className="text-[15px] font-semibold">{f.parsed.shortName}</div>
                <div className="text-muted">
                  {f.parsed.fullName} · {f.parsed.address} · {f.parsed.managerContact}
                  {f.parsed.officeContact && ` · ${f.parsed.officeContact}`}
                </div>
                <div className="mt-0.5 text-[11.5px] text-muted">{f.parsed.fileName}</div>
              </div>
              <button className="btn-ghost h-7 text-[12px]" onClick={() => setFiles((fs) => fs.filter((_, i) => i !== fi))}>
                빼기
              </button>
            </div>
            {f.parsed.warnings.length > 0 && (
              <div className="border-b border-line bg-amber-soft px-5 py-2 text-[12px]">
                {f.parsed.warnings.map((w, i) => (
                  <div key={i}>⚠ {w}</div>
                ))}
              </div>
            )}
            <div className="grid gap-4 p-5 lg:grid-cols-[1fr_300px]">
              <div className="flex flex-col gap-4">
                {f.parsed.blocks.map((b, bi) => {
                  const t = f.targets[bi];
                  const setT = (patch: Partial<BlockTarget>) =>
                    update(fi, (x) => ({ ...x, targets: x.targets.map((y, j) => (j === bi ? { ...y, ...patch } : y)) }));
                  const sum = (k: 'contractAmount' | 'execAmount' | 'inputAmount') => b.rows.reduce((a, r) => a + r[k], 0);
                  return (
                    <div key={bi} className="rounded-xl border border-line">
                      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
                        <span className="chip bg-navy-950 text-white">블록 {bi + 1}</span>
                        <select className="input h-7" value={t.mode} onChange={(e) => setT({ mode: e.target.value as BlockTarget['mode'] })}>
                          <option value="new">새 현장으로</option>
                          <option value="existing">기존 현장에 덮어쓰기</option>
                          <option value="skip">가져오지 않음</option>
                        </select>
                        {t.mode === 'new' && (
                          <>
                            <input className="input h-7 w-24" value={t.code} onChange={(e) => setT({ code: e.target.value })} title="현장코드" />
                            <input className="input h-7 w-48" value={t.name} onChange={(e) => setT({ name: e.target.value })} title="현장 이름" />
                          </>
                        )}
                        {t.mode === 'existing' && (
                          <select className="input h-7 w-56" value={t.siteId} onChange={(e) => setT({ siteId: e.target.value })}>
                            <option value="">현장 선택</option>
                            {sites.data.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.code} {s.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {t.mode !== 'skip' && (
                          <select className="input h-7" value={t.trade} onChange={(e) => setT({ trade: e.target.value as Trade })}>
                            <option>기계</option>
                            <option>소방</option>
                            <option>공통</option>
                          </select>
                        )}
                        <span className="ml-auto text-[12px] text-muted">
                          분류 {b.rows.length}개 · 실행 {won(sum('execAmount'))} · 투입 {won(sum('inputAmount'))}
                        </span>
                      </div>
                      <div className="max-h-64 overflow-y-auto">
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>분류(원래 이름)</th>
                              <th className="num">도급</th>
                              <th className="num">변경예상</th>
                              <th className="num">실행</th>
                              <th className="num">투입(시작 잔액)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {b.rows.map((r, ri) => (
                              <tr key={ri} className={r.empty ? 'text-muted' : ''}>
                                <td>{r.name}</td>
                                <td className="num">{won(r.contractAmount)}</td>
                                <td className="num">{won(r.changeAmount)}</td>
                                <td className="num">{won(r.execAmount)}</td>
                                <td className="num">{won(r.inputAmount)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="rounded-xl border border-line">
                <div className="flex items-center justify-between border-b border-line px-3 py-2">
                  <span className="font-semibold">업체 {f.parsed.vendors.length}곳</span>
                  <button
                    className="text-[12px] text-muted hover:text-ink"
                    onClick={() =>
                      update(fi, (x) => ({
                        ...x,
                        vendorSel: x.vendorSel.size ? new Set() : new Set(x.parsed.vendors.map((v) => v.sheetName)),
                      }))
                    }
                  >
                    전체 선택/해제
                  </button>
                </div>
                <div className="max-h-80 overflow-y-auto px-3 py-2">
                  {f.parsed.vendors.map((v) => {
                    const ex = findVendor(vendors.data, v.name);
                    return (
                      <label key={v.sheetName} className="flex items-center gap-2 py-0.5">
                        <input
                          type="checkbox"
                          checked={f.vendorSel.has(v.sheetName)}
                          onChange={() =>
                            update(fi, (x) => {
                              const s = new Set(x.vendorSel);
                              if (s.has(v.sheetName)) s.delete(v.sheetName);
                              else s.add(v.sheetName);
                              return { ...x, vendorSel: s };
                            })
                          }
                        />
                        <span className="flex-1 truncate">{v.name}</span>
                        <span className="text-[11px] text-muted">{ex ? '등록됨' : v.phone}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
