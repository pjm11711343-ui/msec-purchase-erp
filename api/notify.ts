// 알림 보내기: POST /api/notify  { event, ... }  (Authorization: Bearer <Firebase ID 토큰>)
//  po_sent       발주서 발송 → 업체 메일(PDF·포털 링크) + 현장 단톡방           (자재부·관리자)
//  po_changed    발주 수정 → 업체 메일                                      (자재부·관리자)
//  po_cancelled  발주 취소 → 업체 메일                                      (자재부·관리자)
//  po_ack        업체 발주 확인 → 자재부 텔레그램                            (업체)
//  receipt       입고 등록 → 현장 단톡방                                    (업체·사내)
//  approval_turn 청구서 결재 차례 → 결재자 개인 텔레그램                      (사내)
import { esc, fail, getDoc, HttpError, sendMail, sendTelegram, verifyUser, type Res } from './_lib/common.js';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}
type Line = { itemName: string; spec?: string; unit?: string; qty: number; price?: number; amount?: number };
type Po = { poNo: string; siteId: string; siteName: string; vendorId: string; vendorName: string; orderDate: string; deliveryTerm?: string; notice?: string; orderedByName?: string; lines: Line[]; totalAmount: number; history?: { action: string }[] };

const won = (n: number) => Math.round(n || 0).toLocaleString('ko-KR');

export default async function handler(req: Req, res: Res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST만 됩니다.' });
  try {
    const me = await verifyUser(req.headers.authorization);
    const body = (typeof req.body === 'string' ? JSON.parse(req.body) : req.body) as Record<string, unknown>;
    const event = String(body?.event ?? '');
    const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'msec-purchase-erp.vercel.app');
    const origin = `https://${host}`;

    const staff = await getDoc<{ name: string; role: string; active: boolean; position?: string }>(me.token, `erp_users/${me.uid}`);
    const vendorAcc = staff ? null : await getDoc<{ vendorId: string; vendorName: string; active: boolean }>(me.token, `erp_vendorAccounts/${me.uid}`);
    if (!(staff?.active || vendorAcc?.active)) throw new HttpError(403, 'ERP 사용자만 알림을 보낼 수 있습니다.');
    const office = !!staff && ['admin', 'material'].includes(staff.role);
    const who = staff ? [staff.name, staff.position].filter(Boolean).join(' ') : vendorAcc!.vendorName;

    const loadPo = async () => {
      const id = String(body.poId ?? '');
      const po = id && (await getDoc<Po>(me.token, `erp_purchaseOrders/${id}`));
      if (!po) throw new HttpError(404, '발주서를 찾을 수 없습니다.');
      return po;
    };
    const site = async (id: string) => getDoc<{ name: string; fullName?: string; telegramChatId?: string; address?: string }>(me.token, `erp_sites/${id}`);
    const lineText = (ls: Line[], n = 8) =>
      ls
        .slice(0, n)
        .map((l) => `· ${l.itemName} ${l.spec ?? ''} ${won(l.qty)}${l.unit ?? ''}`)
        .join('\n') + (ls.length > n ? `\n· 외 ${ls.length - n}건` : '');

    if (event === 'po_sent' || event === 'po_changed' || event === 'po_cancelled') {
      if (!office) throw new HttpError(403, '발주 메일은 자재부·관리자만 보낼 수 있습니다.');
      const po = await loadPo();
      const vendor = await getDoc<{ name: string; email?: string; contactName?: string }>(me.token, `erp_vendors/${po.vendorId}`);
      const to = String(body.to ?? vendor?.email ?? '').trim();
      const s = await site(po.siteId);
      const result: Record<string, string> = {};
      const head = event === 'po_sent' ? '발주서' : event === 'po_changed' ? '발주 변경' : '발주 취소';
      const subject = `[명신기공 ${head}] ${po.siteName} ${po.poNo} (${po.vendorName})`;
      const portal = `${origin}/?vendor`;
      const change = event === 'po_changed' ? String(body.change ?? po.history?.at(-1)?.action ?? '') : '';
      const text = [
        `${po.vendorName} ${vendor?.contactName ? `${vendor.contactName} ` : ''}담당자님 안녕하세요.`,
        `㈜명신기공 ${who}입니다.`,
        '',
        event === 'po_sent'
          ? `${po.siteName} 현장 발주서(${po.poNo})를 첨부와 같이 보내드립니다.`
          : event === 'po_changed'
            ? `${po.siteName} 현장 발주서(${po.poNo}) 내용이 변경되었습니다.${change ? `\n변경 내용: ${change}` : ''}${body.pdfBase64 ? '\n변경된 발주서를 첨부합니다.' : ''}`
            : `${po.siteName} 현장 발주서(${po.poNo})가 취소되었습니다. 이 발주 건은 납품하지 마세요.`,
        '',
        event !== 'po_cancelled' ? `■ 품목 (${po.lines.length}건${po.totalAmount ? ` · ${won(po.totalAmount)}원` : ''})\n${lineText(po.lines)}` : '',
        event !== 'po_cancelled' && po.deliveryTerm ? `■ 납품기간: ${po.deliveryTerm}` : '',
        s?.address ? `■ 현장 주소: ${s.address}` : '',
        event !== 'po_cancelled' && po.notice ? `■ 안내: ${po.notice}` : '',
        '',
        event !== 'po_cancelled' ? `업체 포털에서 발주 확인과 입고 등록을 해주세요: ${portal}\n(업체코드·접속코드로 로그인)` : '',
        '',
        '감사합니다.',
      ]
        .filter((x, i, a) => x !== '' || a[i - 1] !== '')
        .join('\n');
      if (!to) result.email = 'no-email';
      else {
        const pdf = typeof body.pdfBase64 === 'string' && body.pdfBase64 ? Buffer.from(body.pdfBase64, 'base64') : undefined;
        await sendMail({
          to,
          ...(typeof body.cc === 'string' && body.cc ? { cc: body.cc } : {}),
          subject,
          text,
          ...(pdf ? { attachments: [{ filename: `발주서_${po.siteName}_${po.vendorName}_${po.poNo}.pdf`, content: pdf }] } : {}),
        });
        result.email = 'sent';
        result.to = to;
      }
      if (event === 'po_sent') {
        result.telegram = await sendTelegram(
          s?.telegramChatId,
          `📦 <b>발주 발송</b> ${esc(po.siteName)}\n${esc(po.vendorName)} · ${esc(po.poNo)}\n${esc(lineText(po.lines, 6))}\n${po.totalAmount ? `금액 ${won(po.totalAmount)}원 · ` : ''}담당 ${esc(who)}`,
        );
      }
      return res.status(200).json({ ok: true, ...result });
    }

    if (event === 'po_ack') {
      const po = await loadPo();
      const sent = await sendTelegram(process.env.TELEGRAM_OFFICE_CHAT_ID, `✅ <b>업체 발주 확인</b>\n${esc(po.vendorName)} · ${esc(po.siteName)} ${esc(po.poNo)}`);
      return res.status(200).json({ ok: true, telegram: sent });
    }

    if (event === 'receipt') {
      const po = await loadPo();
      const s = await site(po.siteId);
      const n = Number(body.count ?? 0);
      const date = String(body.date ?? '');
      const sent = await sendTelegram(
        s?.telegramChatId,
        `🚚 <b>입고 등록</b> ${esc(po.siteName)}\n${esc(po.vendorName)} · ${esc(po.poNo)}\n${date ? `입고일 ${esc(date)} · ` : ''}${n ? `${n}줄` : ''}\n입력: ${esc(who)}\n현장에서 입고 확인 부탁드립니다: ${origin}/receipt`,
      );
      return res.status(200).json({ ok: true, telegram: sent });
    }

    if (event === 'approval_turn') {
      if (!staff) throw new HttpError(403, '사내 사용자만 보낼 수 있습니다.');
      const id = String(body.reqId ?? '');
      const r = id && (await getDoc<{ siteName: string; docNo?: string; requestDate: string; createdByName?: string; totalAmount?: number; currentApproverId?: string; status: string; steps?: { label: string }[]; currentStep?: number }>(me.token, `erp_requisitions/${id}`));
      if (!r) throw new HttpError(404, '청구서를 찾을 수 없습니다.');
      if (r.status !== 'pending' || !r.currentApproverId) return res.status(200).json({ ok: true, telegram: 'skipped' });
      const ap = await getDoc<{ name: string; telegramChatId?: string }>(me.token, `erp_users/${r.currentApproverId}`);
      const step = r.steps?.[r.currentStep ?? 0]?.label ?? '';
      const sent = await sendTelegram(
        ap?.telegramChatId,
        `📝 <b>결재 차례</b> ${esc(ap?.name ?? '')}님 (${esc(step)})\n${esc(r.siteName)} 구매청구서 ${esc(r.docNo || r.requestDate)}\n작성 ${esc(r.createdByName ?? '')}${r.totalAmount ? ` · ${won(r.totalAmount)}원` : ''}\n${origin}/req/${id}`,
      );
      return res.status(200).json({ ok: true, telegram: sent });
    }

    throw new HttpError(400, `알 수 없는 알림 종류: ${event}`);
  } catch (e) {
    fail(res, e);
  }
}
