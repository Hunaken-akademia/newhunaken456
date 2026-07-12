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
    const checked = req.body?.checked === true;
    if (!isUuid(applicationId)) return sendJson(res, 400, { ok: false, error: "申請IDが不正です。" });

    const params = new URLSearchParams({
      id: `eq.${applicationId}`,
      status: "in.(pending,proof_checked)",
    });
    const payload = checked
      ? {
          status: "proof_checked",
          proof_checked_at: new Date().toISOString(),
          proof_checked_by: admin.email,
          rejected_at: null,
          rejected_by: null,
          admin_note: null,
        }
      : {
          status: "pending",
          proof_checked_at: null,
          proof_checked_by: null,
          admin_note: null,
        };

    const rows = await serviceRequest(`/rest/v1/note_purchase_applications?${params.toString()}`, {
      method: "PATCH",
      headers: { ...serviceHeaders(true), Prefer: "return=representation" },
      body: JSON.stringify(payload),
    });
    const updated = Array.isArray(rows) ? rows[0] : null;
    if (!updated) {
      return sendJson(res, 409, {
        ok: false,
        error: "この申請はすでに承認・却下済み、または状態が変更されています。再読み込みしてください。",
      });
    }

    return sendJson(res, 200, { ok: true, id: updated.id, status: updated.status });
  } catch (error) {
    return adminError(res, error, "確認状態を変更できませんでした。");
  }
}
