module.exports = (req, res) => {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    return res.status(500).json({ error: 'SUPABASE_URL or SUPABASE_ANON_KEY not set on server' });
  }
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.json({ supabaseUrl: url, supabaseAnonKey: key });
};
