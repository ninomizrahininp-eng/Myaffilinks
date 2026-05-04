// api/go.js
// Vercel Serverless Function — Tracking clics + redirection
// Chaque fois qu'un user visite ce lien, le clic est loggué dans Supabase
// puis il est redirigé vers l'URL de l'offre.
//
// URL format : /api/go?ref=USER_ID&offer=OFFER_ID

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service_role pour bypasser le RLS
)

export default async function handler(req, res) {
  const { ref: userId, offer: offerId } = req.query

  // ── Validation basique ──────────────────────────────────────────────────
  if (!userId || !offerId) {
    return res.status(400).send('Paramètres manquants.')
  }

  try {
    // ── Récupérer l'URL de l'offre ────────────────────────────────────────
    const { data: offer, error: offerError } = await supabase
      .from('offers')
      .select('url, title')
      .eq('id', offerId)
      .single()

    if (offerError || !offer || !offer.url) {
      return res.status(404).send('Offre introuvable.')
    }

    // ── Logger le clic ────────────────────────────────────────────────────
    // On ne bloque pas la redirection si l'insert échoue
    supabase.from('link_clicks').insert({
      user_id:    userId,
      offer_id:   offerId,
      ip:         req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null,
      user_agent: req.headers['user-agent'] || null,
    }).then(({ error }) => {
      if (error) console.error('link_clicks insert error:', error.message)
    })

    // ── Construire l'URL finale avec ?ref=userId ──────────────────────────
    const separator = offer.url.includes('?') ? '&' : '?'
    const finalUrl  = `${offer.url}${separator}ref=${userId}`

    // ── Rediriger ─────────────────────────────────────────────────────────
    res.setHeader('Cache-Control', 'no-store, no-cache')
    return res.redirect(302, finalUrl)

  } catch (err) {
    console.error('go.js error:', err)
    return res.status(500).send('Erreur serveur.')
  }
}
