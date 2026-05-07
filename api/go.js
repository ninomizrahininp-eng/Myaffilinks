// api/go.js
// Vercel Serverless Function — Tracking clics + redirection
//
// URL format : /api/go?ref=USERNAME_OU_USER_ID&offer=OFFER_ID

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export default async function handler(req, res) {
  const { ref: refParam, offer: offerId } = req.query

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')

  if (req.method === 'OPTIONS') return res.status(200).end()

  if (!refParam || !offerId) {
    return res.status(400).send('Paramètres manquants (ref et offer requis).')
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

  if (!UUID_RE.test(offerId)) {
    return res.status(400).send('Paramètre offer invalide.')
  }

  try {
    // ── 1. Résoudre ref → user_id ─────────────────────────────────────────
    let userId = null

    if (UUID_RE.test(refParam)) {
      userId = refParam
    } else {
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('username', refParam)
        .maybeSingle()

      if (profileError || !profile) {
        console.error('[go.js] Username introuvable:', refParam, profileError?.message)
        const { data: offerFallback } = await supabase
          .from('offers')
          .select('url')
          .eq('id', offerId)
          .maybeSingle()
        if (offerFallback?.url) return res.redirect(302, offerFallback.url)
        return res.status(404).send('Utilisateur introuvable.')
      }

      userId = profile.user_id
    }

    // ── 2. Récupérer l'URL de l'offre ─────────────────────────────────────
    const { data: offer, error: offerError } = await supabase
      .from('offers')
      .select('url, title, status')
      .eq('id', offerId)
      .maybeSingle()

    if (offerError || !offer || !offer.url) {
      console.error('[go.js] Offre introuvable:', offerId, offerError?.message)
      return res.status(404).send('Offre introuvable.')
    }

    if (offer.status && offer.status !== 'active') {
      return res.redirect(302, offer.url)
    }

    // ── 3. URL finale = URL de l'offre + ?ref=username ───────────────────
    // amazon.com?tag=toncode → amazon.com?tag=toncode&ref=sonusername
    // Même destination, mais permet de différencier les clics par utilisateur
    const separator = offer.url.includes('?') ? '&' : '?'
    const finalUrl  = `${offer.url}${separator}ref=${encodeURIComponent(refParam)}`

    // ── 4. Insérer le clic dans link_clicks (non-bloquant) ────────────────
    const clickPromise = supabase
      .from('link_clicks')
      .insert({
        user_id:    userId,
        offer_id:   offerId,
        ip:         req.headers['x-forwarded-for']?.split(',')[0].trim()
                    || req.socket?.remoteAddress
                    || null,
        user_agent: req.headers['user-agent'] || null,
      })
      .then(({ error }) => {
        if (error) console.error('[go.js] link_clicks insert error:', error.message)
      })

    // ── 5. Incrémenter total_clicks (non-bloquant) ────────────────────────
    const incrPromise = supabase
      .rpc('increment_clicks', { uid: userId })
      .then(({ error }) => {
        if (error) {
          console.warn('[go.js] RPC indisponible, fallback manual:', error.message)
          return supabase
            .from('profiles')
            .select('total_clicks')
            .eq('user_id', userId)
            .maybeSingle()
            .then(({ data: p }) => {
              if (!p) return
              return supabase
                .from('profiles')
                .update({ total_clicks: (p.total_clicks ?? 0) + 1 })
                .eq('user_id', userId)
            })
        }
      })

    Promise.all([clickPromise, incrPromise]).catch(err =>
      console.error('[go.js] tracking error:', err)
    )

    // ── 6. Rediriger ──────────────────────────────────────────────────────
    return res.redirect(302, finalUrl)

  } catch (err) {
    console.error('[go.js] Erreur serveur:', err)
    return res.status(500).send('Erreur serveur.')
  }
}
