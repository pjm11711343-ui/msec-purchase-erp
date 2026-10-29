// 텔레그램 봇이 들어가 있는 대화방 목록: GET /api/telegram-chats (자재부·관리자)
//  - 봇을 단톡방에 초대하거나, 개인이 봇에게 아무 말이나 보내면 여기에 나타난다 → 현장·사용자에 Chat ID 지정용
import { fail, getDoc, HttpError, telegramUpdates, verifyUser, type Res } from './_lib/common.js';

interface Req {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
}

export default async function handler(req: Req, res: Res) {
  try {
    const me = await verifyUser(req.headers.authorization);
    const staff = await getDoc<{ role: string; active: boolean }>(me.token, `erp_users/${me.uid}`);
    if (!staff?.active || !['admin', 'material'].includes(staff.role)) throw new HttpError(403, '자재부·관리자만 볼 수 있습니다.');
    res.status(200).json({ ok: true, chats: await telegramUpdates(), bot: process.env.TELEGRAM_BOT_USERNAME || '' });
  } catch (e) {
    fail(res, e);
  }
}
