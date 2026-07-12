import {
  adminError,
  isUuid,
  requireAdmin,
  sendJson,
  serviceHeaders,
  serviceRequest,
  supabaseBase,
} from "../lib/note-admin-common.js";

function encodedPath(path) {
  return String(path || "").split("/").map(encodeURIComponent).join("/");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return sendJson(res, 405, { ok: false, error: "POSTのみ利用できます。" });
  }

  try {
    await requireAdmin(req);
    const applicationId = String(req.body?.applicationId || "");
    if (!isUuid(applicationId)) return sendJson(res, 400, { ok: false, error: "申請IDが不正です。" });

    const params = new URLSearchParams({
      select: "id,proof_object_path",
      id: `eq.${applicationId}`,
      limit: "1",
    });
    const rows = await serviceRequest(`/rest/v1/note_purchase_applications?${params.toString()}`, {
      headers: serviceHeaders(false),
    });
    const application = Array.isArray(rows) ? rows[0] : null;
    if (!application?.proof_object_path) return sendJson(res, 404, { ok: false, error: "購入証明が見つかりません。" });

    const signed = await serviceRequest(
      `/storage/v1/object/sign/note-purchase-proofs/${encodedPath(application.proof_object_path)}`,
      {
        method: "POST",
        headers: serviceHeaders(true),
        body: JSON.stringify({ expiresIn: 300 }),
      }
    );
    const relative = signed?.signedURL || signed?.signedUrl || signed?.url || "";
    if (!relative) throw new Error("購入証明の一時URLを作成できませんでした。");
    const url = /^https?:\/\//i.test(relative)
      ? relative
      : relative.startsWith("/storage/v1/")
        ? `${supabaseBase()}${relative}`
        : `${supabaseBase()}/storage/v1${relative.startsWith("/") ? relative : `/${relative}`}`;

    const extension = String(application.proof_object_path).split(".").pop()?.toLowerCase() || "";
    return sendJson(res, 200, { ok: true, url, extension, expiresIn: 300 });
  } catch (error) {
    return adminError(res, error, "購入証明を開けませんでした。");
  }
}
