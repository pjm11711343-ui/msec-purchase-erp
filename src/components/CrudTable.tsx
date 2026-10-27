import { useMemo, useState, type ReactNode } from 'react';
import { Empty, errMsg, Field, Modal, useSelection, useToast } from './ui';

export interface Column<T> {
  key: string;
  label: string;
  render?: (row: T) => ReactNode;
  className?: string;
}

export interface FormField {
  key: string;
  label: string;
  type?: 'text' | 'select' | 'list' | 'textarea';
  options?: { value: string; label: string }[];
  hint?: string;
  required?: boolean;
}

/** 목록 + 검색 + 체크박스 일괄 처리 + 수정 창 + 엑셀 붙여넣기 일괄 등록 */
export default function CrudTable<T extends { id: string; active?: boolean }>({
  rows,
  columns,
  fields,
  search,
  onSave,
  onDelete,
  onActive,
  paste,
  extraActions,
  loading,
  emptyText,
}: {
  rows: T[];
  columns: Column<T>[];
  fields: FormField[];
  search: (row: T) => string;
  onSave: (id: string | null, data: Record<string, unknown>) => Promise<void>;
  onDelete?: (ids: string[]) => Promise<void>;
  onActive?: (ids: string[], active: boolean) => Promise<void>;
  paste?: { keys: string[]; example: string; onAdd: (rows: Record<string, string>[]) => Promise<void> };
  extraActions?: (selected: string[], clear: () => void) => ReactNode;
  loading?: boolean;
  emptyText?: string;
}) {
  const toast = useToast();
  const { sel, toggle, setAll, clear } = useSelection();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<{ id: string | null; data: Record<string, unknown> } | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [busy, setBusy] = useState(false);

  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return k ? rows.filter((r) => search(r).toLowerCase().includes(k)) : rows;
  }, [rows, q, search]);
  const selected = [...sel].filter((id) => rows.some((r) => r.id === id));

  const run = async (fn: () => Promise<void>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok);
      return true;
    } catch (e) {
      toast(errMsg(e), 'err');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const pasteRows = useMemo(() => {
    if (!paste) return [];
    return pasteText
      .split(/\r?\n/)
      .map((l) => l.split('\t'))
      .filter((c) => c.some((x) => x.trim()))
      .map((c) => Object.fromEntries(paste.keys.map((k, i) => [k, (c[i] ?? '').trim()])));
  }, [pasteText, paste]);

  return (
    <div className="card overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
        <input className="input w-60" placeholder="검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="text-muted">
          {shown.length}건{selected.length > 0 && ` · ${selected.length}건 선택`}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          {selected.length > 0 && (
            <>
              {extraActions?.(selected, clear)}
              {onActive && (
                <>
                  <button className="btn-ghost h-7 text-[12px]" disabled={busy} onClick={() => run(() => onActive(selected, true), '사용으로 바꿨습니다.')}>
                    사용
                  </button>
                  <button className="btn-ghost h-7 text-[12px]" disabled={busy} onClick={() => run(() => onActive(selected, false), '중지로 바꿨습니다.')}>
                    중지
                  </button>
                </>
              )}
              {onDelete && (
                <button
                  className="btn-danger h-7 text-[12px]"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`${selected.length}건을 삭제할까요? 되돌릴 수 없습니다.`)) run(() => onDelete(selected), '삭제했습니다.').then(clear);
                  }}
                >
                  삭제
                </button>
              )}
            </>
          )}
          {paste && (
            <button className="btn-ghost h-7 text-[12px]" onClick={() => setPasteOpen(true)}>
              엑셀 붙여넣기 등록
            </button>
          )}
          <button className="btn-primary h-7 text-[12px]" onClick={() => setEdit({ id: null, data: {} })}>
            + 추가
          </button>
        </div>
      </div>
      {shown.length === 0 ? (
        <Empty>{loading ? '불러오는 중…' : (emptyText ?? '데이터가 없습니다.')}</Empty>
      ) : (
        <div className="max-h-[calc(100vh-220px)] overflow-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    checked={shown.length > 0 && shown.every((r) => sel.has(r.id))}
                    onChange={(e) => setAll(shown.map((r) => r.id), e.target.checked)}
                  />
                </th>
                {columns.map((c) => (
                  <th key={c.key} className={c.className}>
                    {c.label}
                  </th>
                ))}
                <th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className={r.active === false ? 'text-muted' : ''}>
                  <td>
                    <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                  </td>
                  {columns.map((c) => (
                    <td key={c.key} className={c.className}>
                      {c.render ? c.render(r) : String((r as Record<string, unknown>)[c.key] ?? '')}
                    </td>
                  ))}
                  <td className="text-right">
                    <button className="btn-ghost h-7 text-[12px]" onClick={() => setEdit({ id: r.id, data: { ...r } })}>
                      수정
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal
        open={!!edit}
        title={edit?.id ? '수정' : '추가'}
        onClose={() => setEdit(null)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setEdit(null)}>
              취소
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                if (!edit) return;
                const miss = fields.find((f) => f.required && !String(edit.data[f.key] ?? '').trim());
                if (miss) return toast(`${miss.label}을(를) 입력하세요.`, 'err');
                if (await run(() => onSave(edit.id, edit.data), '저장했습니다.')) setEdit(null);
              }}
            >
              저장
            </button>
          </>
        }
      >
        {edit && (
          <div className="grid grid-cols-2 gap-3">
            {fields.map((f) => {
              const v = edit.data[f.key];
              const set = (val: unknown) => setEdit({ ...edit, data: { ...edit.data, [f.key]: val } });
              const wide = f.type === 'list' || f.type === 'textarea';
              return (
                <div key={f.key} className={wide ? 'col-span-2' : ''}>
                  <Field label={f.label + (f.required ? ' *' : '')} hint={f.hint}>
                    {f.type === 'select' ? (
                      <select className="input" value={String(v ?? '')} onChange={(e) => set(e.target.value)}>
                        {f.options?.map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                      </select>
                    ) : f.type === 'list' ? (
                      <input
                        className="input"
                        value={Array.isArray(v) ? (v as string[]).join(', ') : String(v ?? '')}
                        onChange={(e) => set(e.target.value)}
                      />
                    ) : f.type === 'textarea' ? (
                      <textarea className="input h-20 py-1.5" value={String(v ?? '')} onChange={(e) => set(e.target.value)} />
                    ) : (
                      <input className="input" value={String(v ?? '')} onChange={(e) => set(e.target.value)} />
                    )}
                  </Field>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {paste && (
        <Modal
          open={pasteOpen}
          title="엑셀 붙여넣기로 일괄 등록"
          onClose={() => setPasteOpen(false)}
          wide
          footer={
            <>
              <button className="btn-ghost" onClick={() => setPasteOpen(false)}>
                취소
              </button>
              <button
                className="btn-primary"
                disabled={!pasteRows.length || busy}
                onClick={async () => {
                  if (await run(() => paste.onAdd(pasteRows), `${pasteRows.length}건을 등록했습니다.`)) {
                    setPasteText('');
                    setPasteOpen(false);
                  }
                }}
              >
                {pasteRows.length}건 등록
              </button>
            </>
          }
        >
          <p className="mb-2 text-muted">
            엑셀에서 아래 순서대로 열을 골라 복사(Ctrl+C)한 뒤 붙여넣으세요. 머리글 행은 빼고 복사합니다. 이미 있는 이름은 빈칸만 채웁니다.
          </p>
          <div className="mb-2 rounded-md bg-canvas px-3 py-2 font-mono text-[12px]">{paste.example}</div>
          <textarea className="input h-40 w-full py-2 font-mono text-[12px]" value={pasteText} onChange={(e) => setPasteText(e.target.value)} />
          {pasteRows.length > 0 && (
            <div className="mt-3 max-h-60 overflow-auto rounded-md border border-line">
              <table className="tbl">
                <thead>
                  <tr>
                    {paste.keys.map((k) => (
                      <th key={k}>{fields.find((f) => f.key === k)?.label ?? k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pasteRows.slice(0, 50).map((r, i) => (
                    <tr key={i}>
                      {paste.keys.map((k) => (
                        <td key={k}>{r[k]}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

/** "a, b, c" 또는 배열 → 문자열 배열 */
export function toList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return String(v ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}
