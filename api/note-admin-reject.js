import {
  adminError,
  isUuid,
  requireAdmin,
  sendJson,
  serviceHeaders,
  serviceRequest,
} from "../lib/note-admin-common.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, error: "POSTのみ利用できます。" });
  }

  try {
    const admin = await requireAdmin(req);
    const applicationId = String(req.body?.applicationId || "");
    const reason = String(req.body?.reason || "").trim();
    if (!isUuid(applicationId)) return sendJson(res, 400, { ok: false, error: "申請IDが不正です。" });
    if (!reason || reason.length > 300) {
      return sendJson(res, 400, { ok: false, error: "却下理由を1〜300文字で入力してください。" });
    }

    const params = new URLSearchParams({
      id: `eq.${applicationId}`,
      status: "in.(pending,proof_checked,rejected)",
    });
    const rows = await serviceRequest(`/rest/v1/note_purchase_applications?${params.toString()}`, {
      method: "PATCH",
      headers: { ...serviceHeaders(true), Prefer: "return=representation" },
      body: JSON.stringify({
        status: "rejected",
        proof_checked_at: null,
        proof_checked_by: null,
        rejected_at: new Date().toISOString(),
        rejected_by: admin.email,
        admin_note: reason,
      }),
    });
    const updated = Array.isArray(rows) ? rows[0] : null;
    if (!updated) {
      return sendJson(res, 409, { ok: false, error: "承認済みの申請は却下できません。" });
    }

    return sendJson(res, 200, { ok: true, id: updated.id, status: updated.status });
  } catch (error) {
    return adminError(res, error, "申請を却下できませんでした。");
  }
}
