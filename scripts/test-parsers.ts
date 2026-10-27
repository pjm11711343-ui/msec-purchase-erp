// 실제 엑셀 파일로 파서 동작 확인: npx tsx scripts/test-parsers.ts <폴더>
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { parseInvoiceWorkbook, parseRequisitionWorkbook } from '../src/lib/parsers';

const dir = process.argv[2];
for (const f of readdirSync(dir).filter((n) => n.endsWith('.xlsx')).sort()) {
  const wb = XLSX.read(readFileSync(join(dir, f)), { type: 'buffer', cellDates: true });
  try {
    if (wb.Sheets['청구서']) {
      const p = parseRequisitionWorkbook(wb, f);
      console.log(`\n[청구서] ${f.slice(0, 12)} → ${p.shortName} | ${p.fullName} | 소장 ${p.managerContact} | 주소 ${p.address} | 업체 ${p.vendors.length}개 (예: ${p.vendors.slice(0, 2).map((v) => v.name + ' ' + v.phone).join(', ')})`);
      for (const b of p.blocks) {
        const inp = b.rows.reduce((a, r) => a + r.inputAmount, 0);
        console.log(`   블록${b.index + 1} ${b.guessedTrade} 분류 ${b.rows.length}개, 실행 ${b.rows.reduce((a, r) => a + r.execAmount, 0).toLocaleString()}, 투입 ${inp.toLocaleString()} / 합계행 ${b.totalRow?.input.toLocaleString() ?? '-'}`);
      }
      p.warnings.forEach((w) => console.log('   ⚠', w));
    } else if (wb.Sheets['계산서금액(갑지)']) {
      const p = parseInvoiceWorkbook(wb, f);
      console.log(`\n[계산서] ${f.slice(0, 12)} → ${p.vendorName} ${p.month}, 현장시트 ${p.sheets.length}개`);
      for (const s of p.sheets) console.log(`   ${s.sheetName} (${s.siteLabel}) ${s.lines.length}줄 ${s.total.toLocaleString()}원 | 분류: ${s.categories.map((c) => c.text).join(', ')}`);
      const ex = p.sheets[0]?.lines[0];
      if (ex) console.log('   예시:', JSON.stringify(ex));
      p.warnings.forEach((w) => console.log('   ⚠', w));
    } else console.log('\n[기타]', f.slice(0, 12), wb.SheetNames.slice(0, 3));
  } catch (e) {
    console.log('\n[오류]', f.slice(0, 12), (e as Error).message);
  }
}
