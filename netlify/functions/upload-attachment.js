// netlify/functions/upload-attachment.js
//
// Accepts a base64-encoded image (from the app's file attach) and stores
// it in Supabase Storage, returning a URL — this is how a photo from the
// phone becomes something the ocr_image tool can actually read, since
// tools work with URLs, not raw uploaded bytes.

const { getClient } = require("./_supabase");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON body" }) };
  }

  const { fileName, base64Data, contentType } = payload;
  if (!base64Data) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing 'base64Data'" }) };
  }

  try {
    const supabase = getClient();
    const buffer = Buffer.from(base64Data, "base64");
    const name = fileName || `attachment-${Date.now()}`;
    const storagePath = `attachments/${Date.now()}-${name}`;
    const { error } = await supabase.storage
      .from("mkdai-files")
      .upload(storagePath, buffer, { contentType: contentType || "image/png" });
    if (error) throw error;
    const { data } = supabase.storage.from("mkdai-files").getPublicUrl(storagePath);
    return { statusCode: 200, body: JSON.stringify({ url: data.publicUrl }) };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
