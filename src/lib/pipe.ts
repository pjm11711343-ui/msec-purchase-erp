// 배관 본 수 계산 (구매청구 본/(비고) 칸)
/** 배관 1본 길이(m): 고강도PVC 3 · PVC 4 · SUS/STS 6 · 강관류 6 (단위가 M인 줄만) */
export function pipeLength(itemName: string): number | null {
  const t = (itemName || '').toUpperCase().replace(/\s+/g, '');
  if (/고강도|HI-?3P|HIPVC/.test(t)) return 3;
  if (/PVC|VG1|VG2|DRF/.test(t)) return 4;
  if (/SUS|STS|스텐|스테인/.test(t)) return 6;
  if (/강관|백관|흑관|SPP|STPG|SGP|아연도/.test(t)) return 6;
  return null;
}

/** 본 수 표시: 단위 M이고 배관이면 금회청구 수량 ÷ 1본 길이, 소수 1자리 (예: 1.0본) */
export function bonText(l: { itemName: string; unit: string; reqQty: number; orderQty?: number }): string {
  if (!/^M$/i.test((l.unit || '').trim())) return '';
  const len = pipeLength(l.itemName);
  const q = l.reqQty || l.orderQty || 0;
  if (!len || !q) return '';
  return `${(q / len).toFixed(1)}본`;
}

/** 본/(비고) 칸: 본 수 + (비고) */
export function bonNote(l: { itemName: string; unit: string; reqQty: number; orderQty?: number; note?: string }): string {
  const b = bonText(l);
  const n = (l.note || '').trim();
  return b && n ? `${b} (${n})` : b || n;
}
