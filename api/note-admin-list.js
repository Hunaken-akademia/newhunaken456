import {
  adminError,
  requireAdmin,
  sendJson,
  serviceHeaders,
  serviceRequest,
} from "../lib/note-admin-common.js";

const FILTERS = {
  review: "in.(pending,proof_checked)",
  pending: "eq.pending",
  proof_checked: "eq.proof_checked",
  approved: "eq.approved",
  rejected: "eq.rejected",
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { ok: false, error: "GETのみ利用できます。" });
  }

  try {
    const admin = await requireAdmin(req);
    const requested = String(req.query?.status || "review");
    const statusFilter = FILTERS[requested] || null;

    const params = new URLSearchParams({
      select: "id,google_email,sale_tier,note_buyer_name,purchased_at,proof_object_path,status,proof_checked_at,proof_checked_by,approved_at,approved_by,rejected_at,rejected_by,admin_note,created_at,updated_at",
      order: "created_at.desc",
      limit: "200",
    });
    if (statusFilter) params.set("status", statusFilter);

    const rows = await serviceRequest(`/rest/v1/note_purchase_applications?${params.toString()}`, {
      headers: serviceHeaders(false),
    });

    const applications = (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      googleEmail: row.google_email,
      saleTier: row.sale_tier,
      noteBuyerName: row.note_buyer_name,
      purchasedAt: row.purchased_at,
      status: row.status,
      proofCheckedAt: row.proof_checked_at,
      proofCheckedBy: row.proof_checked_by,
      approvedAt: row.approved_at,
      approvedBy: row.approved_by,
      rejectedAt: row.rejected_at,
      rejectedBy: row.rejected_by,
      adminNote: row.admin_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      proofType: String(row.proof_object_path || "").split(".").pop()?.toLowerCase() || "",
    }));

    return sendJson(res, 200, {
      ok: true,
      adminEmail: admin.email,
      filter: requested,
      count: applications.length,
      applications,
    });
  } catch (error) {
    return adminError(res, error, "申請一覧を取得できませんでした。");
  }
}
