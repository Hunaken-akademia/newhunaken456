export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  const cfg = {
    VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '',
    VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '',
    APP_URL: process.env.APP_URL || '',
  };
  const safe = JSON.stringify(cfg).replace(/</g, '\\u003c');
  res.status(200).send(`window.__HUNAKEN_ENV__ = ${safe};`);
}
