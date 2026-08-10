// netlify/functions/_supabase.js
const { createClient } = require("@supabase/supabase-js");

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_ANON_KEY are not set on the server. Add them in Netlify > Site configuration > Environment variables."
    );
  }
  return createClient(url, key);
}

module.exports = { getClient };
