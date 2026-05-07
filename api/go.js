// api/go.js
// Vercel Serverless Function — Tracking clics + redirection
//
// URL format : /api/go?ref=USERNAME_OU_USER_ID&offer=OFFER_ID
//
// Flux complet :
//  1. Valide les paramètres
//  2. Résout ref en user_id (accepte username OU UUID)
//  3. Récupère l'URL de l'offre depuis Supabase
//  4. Insère un clic dans link_clicks (déclenche le realtime dashboard)
//  5. Incrémente total_clicks dans profiles (via RPC)
//  6. Redirige vers offer.url

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY  // service_role pour bypasser le RLS
)

export default async function handler(req, res) {
  const { ref: refParam, offer: offerId } = req.query

  // ── CORS ──────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')

  if (req.method === 'OPTIONS') {
    return res.status(200).end()
  }

  // ── Validation de base ────────────────────────────────────────────────────
  if (!refParam || !offerId) {
    return res.status(400).send('Paramètres manquants (ref et offer requis).')
  }

  // Validation offer (doit être UUID)
  const UUID_RE = /^[0-9a-f-]{32,36}$/i
  if (!UUID_RE.test(offerId)) {
    return res.status(400).send('Paramètre offer invalide.')
  }

  try {
    // ── 1. Résoudre ref → user_id ─────────────────────────────────────────
    // ref peut être un username (ex: "john42") ou un UUID (ancien format)
    let userId = null

    if (UUID_RE.test(refParam)) {
      // C'est un UUID → on l'utilise directement (rétrocompatibilité)
      userId = refParam
    } else {
      // C'est un username → on cherche le user_id dans profiles
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('username', refParam)
        .single()

      if (profileError || !profile) {
        console.error('[go.js] Username introuvable:', refParam, profileError?.message)
        // On redirige quand même vers l'offre sans tracker
        const { data: offerFallback } = await supabase
          .from('offers')
          .select('url')
          .eq('id', offerId)
          .single()
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
      .single()

    if (offerError || !offer || !offer.url) {
      console.error('[go.js] Offre introuvable:', offerId, offerError?.message)
      return res.status(404).send('Offre introuvable.')
    }

    if (offer.status && offer.status !== 'active') {
      // Offre désactivée → rediriger sans loguer
      return res.redirect(302, offer.url)
    }

    // ── 3. Construire l'URL finale avec ?ref=username ─────────────────────
    // On ajoute le username en paramètre ref sur le lien d'affiliation
    // → permet aux plateformes d'affiliation de tracer la source
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

    // ── 5. Incrémenter total_clicks dans profiles (non-bloquant) ─────────
    const incrPromise = supabase
      .rpc('increment_clicks', { uid: userId })
      .then(({ error }) => {
        if (error) {
          console.warn('[go.js] RPC increment_clicks indisponible, fallback manual:', error.message)
          return supabase
            .from('profiles')
            .select('total_clicks')
            .eq('user_id', userId)
            .single()
            .then(({ data: p }) => {
              if (!p) return
              return supabase
                .from('profiles')
                .update({ total_clicks: (p.total_clicks ?? 0) + 1 })
                .eq('user_id', userId)
            })
        }
      })

    // On lance les deux en parallèle sans bloquer la redirection
    Promise.all([clickPromise, incrPromise]).catch(err =>
      console.error('[go.js] tracking error (non-bloquant):', err)
    )

    // ── 6. Rediriger immédiatement ────────────────────────────────────────
    return res.redirect(302, finalUrl)

  } catch (err) {
    console.error('[go.js] Erreur serveur:', err)
    return res.status(500).send('Erreur serveur.')
  }
}
