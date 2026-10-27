// 기존 엑셀 파일(현장별 청구서 파일, 월 계산서정리 파일)을 읽어 ERP 데이터로 바꾸는 파서.
// 화면(React)과 검증 스크립트(Node) 양쪽에서 쓰도록 순수 함수로 작성한다.
import * as XLSX from 'xlsx';
import type { InvoiceLine, Trade } from '../types';
import { nameKey, num, parseYearMonth, toDateStr } from './normalize';

type Row = unknown[];

function rows(ws: XLSX.WorkSheet): Row[] {
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: true, defval: null, blankrows: true });
}

function cell(ws: XLSX.WorkSheet | undefined, addr: string): string {
  if (!ws) return '';
  const c = ws[addr];
  if (!c || c.v == null) return '';
  return String(c.v).trim();
}

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/* ───────────────────────── 현장별 청구서 파일 ───────────────────────── */

export interface CategoryRow {
  name: string;
  contractAmount: number;
  changeAmount: number;
  execAmount: number;
  inputAmount: number;
  empty: boolean; // 숫자 칸이 모두 비어 있던 행
}

export interface CategoryBlock {
  index: number;
  guessedTrade: Trade;
  rows: CategoryRow[];
  totalRow?: { contract: number; change: number; exec: number; input: number };
}

export interface ParsedVendor {
  sheetName: string;
  name: string;
  phone: string;
}

export interface ParsedRequisitionFile {
  fileName: string;
  shortName: string;
  fullName: string;
  households: string;
  titleName: string; // 발주서 제목의 현장명
  orderDisplayName: string; // 발주서 '현장' 칸
  managerContact: string;
  officeContact: string;
  address: string;
  vendors: ParsedVendor[];
  blocks: CategoryBlock[];
  warnings: string[];
}

const NON_VENDOR = new Set(['투입집계', '청구서', '발주서', 'Data', '현장연락처']);

function isVendorSheet(ws: XLSX.WorkSheet): boolean {
  return nameKey(cell(ws, 'D3')).includes('구입처');
}

function splitNamePhone(v: string, extraPhone: string): { name: string; phone: string } {
  const m = v.match(/^(.*?)[:：]\s*([\d\-\s)(]+)$/);
  if (m) return { name: clean(m[1]), phone: clean(m[2]) };
  return { name: clean(v), phone: clean(extraPhone) };
}

export function parseRequisitionWorkbook(wb: XLSX.WorkBook, fileName: string): ParsedRequisitionFile {
  const warnings: string[] = [];
  const req = wb.Sheets['청구서'];
  const sum = wb.Sheets['투입집계'];
  if (!req) throw new Error('청구서 파일이 아닙니다. "청구서" 시트가 있어야 합니다.');
  if (!sum) warnings.push('투입집계 시트가 없어 현장 정보와 업체만 가져옵니다. 분류는 계산서를 올릴 때 새로 만들 수 있습니다.');

  const shortName = clean(cell(req, 'U2')) || clean(cell(req, 'T11')) || fileName.replace(/\.[^.]+$/, '');
  const fullName = clean(cell(req, 'B4').replace(/^현장명\s*[:：]\s*/, ''));
  const hh = clean(cell(req, 'U4'));
  const households = hh === '0' ? '' : hh;

  // 현장 정보: 첫 번째 업체 시트 상단(또는 발주서 시트)에서 읽는다
  const vendorSheetNames = wb.SheetNames.filter((n) => !NON_VENDOR.has(n) && isVendorSheet(wb.Sheets[n]));
  const infoSheet = wb.Sheets[vendorSheetNames[0]] ?? wb.Sheets['발주서'];
  const titleName = clean(cell(infoSheet, 'A1').split('\n')[0].replace(/현장$/, '').replace(/발\s*주\s*서?$/, ''));
  const orderDisplayName = clean(cell(infoSheet, 'B3'));
  const managerContact = clean(cell(infoSheet, 'B5'));
  const office = clean(cell(infoSheet, 'B6'));
  const officeContact = office === '0' ? '' : office;
  const addr = clean(cell(infoSheet, 'E7'));
  const address = addr === '0' ? '' : addr;

  const vendors: ParsedVendor[] = vendorSheetNames.map((sn) => {
    const ws = wb.Sheets[sn];
    const { name, phone } = splitNamePhone(cell(ws, 'E3'), cell(ws, 'G3'));
    return { sheetName: sn, name: name || sn, phone };
  });

  // 투입집계: '합계' 행으로 블록을 나누고, 숫자가 하나도 없는 블록(뒤에 붙은 상세 목록)은 버린다
  const blocks: CategoryBlock[] = [];
  let cur: CategoryRow[] = [];
  let curHasNumber = false;
  const flush = (total?: CategoryBlock['totalRow']) => {
    if (cur.length && curHasNumber) {
      // 공종 꼬리표 "(소방설비)" "(기계설비)"가 붙은 행만 센다 (예: "가설소방공사"는 기계 분류)
      const fire = cur.filter((r) => /\(소방/.test(r.name)).length;
      const mech = cur.filter((r) => /\(기계/.test(r.name)).length;
      const guessed: Trade = fire > mech ? '소방' : mech > fire ? '기계' : blocks.length === 0 ? '기계' : '소방';
      blocks.push({ index: blocks.length, guessedTrade: guessed, rows: cur, totalRow: total });
    }
    cur = [];
    curHasNumber = false;
  };
  for (const r of sum ? rows(sum) : []) {
    const rawName = r[0];
    const name = clean(String(rawName ?? ''));
    const nk = nameKey(name);
    if (!nk) continue;
    if (nk === '품명') continue; // 머리글
    const vals = [r[1], r[2], r[3], r[4]];
    if (nk.includes('합계')) {
      flush({ contract: num(r[1]), change: num(r[2]), exec: num(r[3]), input: num(r[4]) });
      continue;
    }
    const empty = vals.every((v) => v == null || v === '');
    if (!empty) curHasNumber = true;
    cur.push({
      name,
      contractAmount: num(r[1]),
      changeAmount: num(r[2]),
      execAmount: num(r[3]),
      inputAmount: num(r[4]),
      empty,
    });
  }
  flush();

  // 같은 블록 안 중복 이름 제거 (첫 행 유지)
  for (const b of blocks) {
    const seen = new Set<string>();
    b.rows = b.rows.filter((r) => {
      const k = nameKey(r.name);
      if (seen.has(k)) {
        warnings.push(`블록 ${b.index + 1}: "${r.name}" 중복 행은 제외했습니다.`);
        return false;
      }
      seen.add(k);
      return true;
    });
    if (b.totalRow) {
      const s = b.rows.reduce((a, r) => a + r.inputAmount, 0);
      if (Math.abs(s - b.totalRow.input) > 1) {
        warnings.push(`블록 ${b.index + 1}: 투입금액 합(${s.toLocaleString()})이 합계 행(${b.totalRow.input.toLocaleString()})과 다릅니다.`);
      }
    }
  }
  if (!blocks.length) {
    if (sum) warnings.push('투입집계 시트에서 금액이 있는 분류를 찾지 못했습니다.');
    blocks.push({ index: 0, guessedTrade: '공통', rows: [] }); // 현장 정보만 등록
  }

  return {
    fileName,
    shortName,
    fullName,
    households,
    titleName,
    orderDisplayName,
    managerContact,
    officeContact,
    address,
    vendors,
    blocks,
    warnings,
  };
}

/* ───────────────────────── 월 계산서정리 파일 ───────────────────────── */

export interface ParsedInvoiceSheet {
  sheetName: string;
  siteLabel: string; // 시트 3행의 (현장명) 표기
  lines: InvoiceLine[];
  total: number;
  categories: { text: string; amount: number; count: number }[];
}

export interface ParsedInvoiceFile {
  fileName: string;
  vendorName: string;
  month: string; // YYYY-MM
  sheets: ParsedInvoiceSheet[];
  warnings: string[];
}

const INVOICE_SKIP = new Set(['작성방법', '계산서금액(갑지)', '..']);

const HEADER_KEYS: Record<string, string> = {
  현장입고일자: 'receivedDate',
  이월분: 'carryOver',
  제품회사명: 'maker',
  네고율: 'negoRate',
  발주서발주일자: 'orderDate',
  품명: 'itemName',
  규격: 'spec',
  단위: 'unit',
  수량: 'qty',
  단가: 'unitPrice',
  금액: 'amount',
  변경수량: 'changedQty',
  변경단가: 'changedPrice',
  변경금액: 'changedAmount',
  분류: 'categoryText',
  공정: 'process',
};

export function parseInvoiceWorkbook(wb: XLSX.WorkBook, fileName: string): ParsedInvoiceFile {
  const warnings: string[] = [];
  const cover = wb.Sheets['계산서금액(갑지)'];
  if (!cover) throw new Error('계산서정리 파일이 아닙니다. "계산서금액(갑지)" 시트가 있어야 합니다.');

  // 갑지 1행: [월, 제목, '업체명:', 업체명, 버전]
  const r1 = rows(cover)[0] ?? [];
  let vendorName = '';
  let month = '';
  r1.forEach((v, i) => {
    const s = String(v ?? '');
    if (!month) month = parseYearMonth(s) ?? '';
    if (nameKey(s).startsWith('업체명')) {
      const next = r1.slice(i + 1).find((x) => x != null && String(x).trim() !== '');
      vendorName = clean(String(next ?? ''));
    }
  });
  if (!month) {
    const m = fileName.match(/(\d{2})\.(\d{2})/);
    if (m) month = `20${m[1]}-${m[2]}`;
  }
  if (!month) warnings.push('계산서 월을 찾지 못했습니다. 화면에서 직접 지정하세요.');
  if (!vendorName) warnings.push('갑지에서 업체명을 찾지 못했습니다. 화면에서 직접 지정하세요.');
  const year = month ? Number(month.slice(0, 4)) : undefined;

  const sheets: ParsedInvoiceSheet[] = [];
  for (const sn of wb.SheetNames) {
    if (INVOICE_SKIP.has(sn) || sn.includes('거래명세서')) continue;
    const ws = wb.Sheets[sn];
    const all = rows(ws);
    const hIdx = all.slice(0, 12).findIndex((r) => r.some((v) => nameKey(v) === '품명'));
    if (hIdx < 0) continue;
    const header = all[hIdx];
    const col: Record<string, number> = {};
    header.forEach((h, i) => {
      const key = HEADER_KEYS[nameKey(h)];
      if (key && col[key] === undefined) col[key] = i;
    });
    if (col.itemName === undefined || col.qty === undefined) continue;

    const labelRow = all[2] ?? [];
    const labelCell = String(labelRow.find((v) => /^\s*\(/.test(String(v ?? ''))) ?? '');
    const siteLabel = clean(labelCell.match(/\(([^)]*)\)/)?.[1] ?? labelCell);

    const get = (r: Row, k: string) => (col[k] === undefined ? null : r[col[k]]);
    const lines: InvoiceLine[] = [];
    for (const r of all.slice(hIdx + 1)) {
      const item = clean(String(get(r, 'itemName') ?? ''));
      if (!item || item === '0') continue;
      const qty = num(get(r, 'qty'));
      const amount = num(get(r, 'amount'));
      if (!qty && !amount) continue;
      const chQ = get(r, 'changedQty');
      const chP = get(r, 'changedPrice');
      const chA = get(r, 'changedAmount');
      const hasChange = chA != null && chA !== '';
      const finalAmount = hasChange
        ? num(chA)
        : chQ != null && chP != null && chQ !== '' && chP !== ''
          ? num(chQ) * num(chP)
          : amount;
      const line: InvoiceLine = {
        receivedDate: toDateStr(get(r, 'receivedDate'), year),
        carryOver: clean(String(get(r, 'carryOver') ?? '')) || undefined,
        maker: clean(String(get(r, 'maker') ?? '')) || undefined,
        negoRate: get(r, 'negoRate') == null ? undefined : num(get(r, 'negoRate')),
        orderDate: toDateStr(get(r, 'orderDate'), year),
        itemName: item,
        spec: clean(String(get(r, 'spec') ?? '')),
        unit: clean(String(get(r, 'unit') ?? '')),
        qty,
        unitPrice: num(get(r, 'unitPrice')),
        amount,
        changedQty: chQ == null || chQ === '' ? undefined : num(chQ),
        changedPrice: chP == null || chP === '' ? undefined : num(chP),
        changedAmount: hasChange ? num(chA) : undefined,
        finalAmount,
        categoryText: clean(String(get(r, 'categoryText') ?? '').replace(/\n/g, ' ')),
        process: (() => {
          const p = clean(String(get(r, 'process') ?? ''));
          return p && p !== '0' ? p : undefined;
        })(),
        matchStatus: 'unmatched',
      };
      // undefined 필드는 Firestore 저장 시 오류가 나므로 제거
      Object.keys(line).forEach((k) => (line as unknown as Record<string, unknown>)[k] === undefined && delete (line as unknown as Record<string, unknown>)[k]);
      lines.push(line);
    }
    if (!lines.length) continue;
    const catMap = new Map<string, { amount: number; count: number }>();
    for (const l of lines) {
      const k = l.categoryText || '(분류 없음)';
      const c = catMap.get(k) ?? { amount: 0, count: 0 };
      c.amount += l.finalAmount;
      c.count += 1;
      catMap.set(k, c);
    }
    sheets.push({
      sheetName: sn,
      siteLabel,
      lines,
      total: lines.reduce((a, l) => a + l.finalAmount, 0),
      categories: [...catMap].map(([text, v]) => ({ text, ...v })),
    });
  }
  if (!sheets.length) warnings.push('입력된 거래 내역이 있는 현장 시트가 없습니다.');
  return { fileName, vendorName, month, sheets, warnings };
}

/** 파일(ArrayBuffer) → 워크북 */
export function readWorkbook(data: ArrayBuffer | Uint8Array): XLSX.WorkBook {
  return XLSX.read(data, { type: 'array', cellDates: true });
}
