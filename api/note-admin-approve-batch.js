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
    const rawIds = Array.isArray(req.body?.applicationIds) ? req.body.applicationIds : [];
    const ids = [...new Set(rawIds.map((value) => String(value || "").trim()))];
    if (!ids.length) return sendJson(res, 400, { ok: false, error: "承認する申請を選択してください。" });
    if (ids.length > 50) return sendJson(res, 400, { ok: false, error: "一度に承認できるのは50件までです。" });
    if (ids.some((id) => !isUuid(id))) return sendJson(res, 400, { ok: false, error: "申請IDに不正な値があります。" });

    const results = await serviceRequest("/rest/v1/rpc/approve_note_purchase_applications", {
      method: "POST",
      headers: serviceHeaders(true),
      body: JSON.stringify({
        p_application_ids: ids,
        p_admin_email: admin.email,
      }),
    });

    const rows = Array.isArray(results) ? results : [];
    const summary = {
      requested: ids.length,
      approvedCreated: rows.filter((row) => row.outcome === "approved_created").length,
      approvedExisting: rows.filter((row) => row.outcome === "approved_existing").length,
      alreadyApproved: rows.filter((row) => row.outcome === "already_approved").length,
      proofNotChecked: rows.filter((row) => row.outcome === "proof_not_checked").length,
      notFound: rows.filter((row) => row.outcome === "not_found").length,
    };

    return sendJson(res, 200, { ok: true, summary, results: rows });
  } catch (error) {
    return adminError(res, error, "まとめて承認できませんでした。");
  }
}
