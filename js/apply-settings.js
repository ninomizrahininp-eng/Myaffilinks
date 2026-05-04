/**
 * apply-settings.js - VERSION CORRIGÉE v4
 * Corrections v4 :
 * - _dup : ne duplique PAS dans l'iframe admin preview (window.__isAdminPreview)
 * - _del : masque l'élément (display:none)
 * - Filtre _del/_dup/_text du loop CSS
 * - Monospace sur chiffres via classe .num appliquée automatiquement
 */

(async function () {

  // ── 1. Attendre Supabase ──────────────────────────────────────
  async function waitForSupabase(maxMs = 8000) {
    const t0 = Date.now()
    while (!window._supabaseClient && Date.now() - t0 < maxMs) {
      await new Promise(r => setTimeout(r, 80))
    }
    return window._supabaseClient || null
  }

  const sb = await waitForSupabase()
  if (!sb) {
    console.warn('[apply-settings] Supabase indisponible')
    return
  }

  // ── 2. Profil courant ─────────────────────────────────────────
  let profile = null
  try {
    const authRes = await sb.auth.getUser()
    const user = authRes.data?.user
    if (user) {
      const profRes = await sb.from('profiles')
        .select('id,plan,role')
        .eq('user_id', user.id)
        .single()
      profile = profRes.data || null
    }
  } catch (e) {
    console.warn('[apply-settings] Erreur récupération profil:', e)
  }

  // ── 3. Page courante SPA ──────────────────────────────────────
  function getCurrentSpaPage() {
    let p = window.location.pathname
    return p.replace(/\/$/, '') || '/'
  }

  // ── 4. Le payload concerne-t-il la page courante ? ────────────
  function isForCurrentPage(payload) {
    if (!payload?.page) return false
    const payloadPage = payload.page.replace(/\/$/, '')
    const currentPage = getCurrentSpaPage()
    if (payloadPage === currentPage) return true
    if (payloadPage === '/navbarvisit.html') return true
    return false
  }

  // ── 5. Ciblage utilisateur (all / plan / profile) ────────────
  function targeted(payload) {
    if (!payload?.target) return false
    if (payload.target === 'all') return true
    if (!profile) return false
    if (payload.target === 'plan') {
      return Array.isArray(payload.plans) && payload.plans.includes(profile.plan)
    }
    if (payload.target === 'profile') {
      if (!Array.isArray(payload.profiles)) return false
      const myId = String(profile.id)
      return payload.profiles.some(pid => String(pid) === myId)
    }
    return false
  }

  // ── 6. Trouver l'élément ──────────────────────────────────────
  function findEl(change) {
    if (change.editId) {
      const el = document.querySelector(`[data-edit-id="${change.editId}"]`)
      if (el) return el
    }
    if (change.cssSelector) {
      try {
        return document.querySelector(change.cssSelector)
      } catch (e) {}
    }
    return null
  }

  // ── 7. setDirectText robuste ──────────────────────────────────
  function setDirectText(el, val) {
    for (let i = 0; i < el.childNodes.length; i++) {
      if (el.childNodes[i].nodeType === 3) {
        el.childNodes[i].textContent = val
        return
      }
    }
    if (!el.firstChild) {
      el.textContent = val
    } else {
      el.insertBefore(document.createTextNode(val), el.firstChild)
    }
  }

  // ── 8. Appliquer un changement ────────────────────────────────
  function applyChange(change) {
    const el = findEl(change)
    if (!el) return false

    const styles = change.styles || {}

    // ── Cas _del : masquer l'élément ─────────────────────────────
    if (styles._del === 'true') {
      el.style.display = 'none'
      return true
    }

    // ── Cas _dup : insérer le clone après l'élément ───────────────
    // ⚠️ On ne duplique PAS si on est dans l'iframe preview de l'admin
    if (typeof styles._dup !== 'undefined') {
      // Si c'est le preview admin, on ne duplique pas pour éviter les doublons visuels
      if (window.__isAdminPreview === true) {
        return true
      }

      const dupMarker = 'data-as-dup'
      const dupKey = (change.editId || '') + '|' + (change.cssSelector || '')
      const existingDup = el.parentNode
        ? Array.from(el.parentNode.querySelectorAll('[' + dupMarker + ']'))
            .find(d => d.getAttribute(dupMarker) === dupKey)
        : null
      if (!existingDup) {
        const temp = document.createElement('div')
        temp.innerHTML = styles._dup
        const clone = temp.firstElementChild
        if (clone) {
          clone.setAttribute(dupMarker, dupKey)
          el.parentNode.insertBefore(clone, el.nextSibling)
        }
      }
      return true
    }

    // ── Styles CSS normaux (on filtre toutes les pseudo-props) ────
    Object.keys(styles).forEach(prop => {
      if (prop === '_text' || prop === '_del' || prop === '_dup') return
      try {
        el.style[prop] = styles[prop]
      } catch (e) {}
    })

    // ── Texte direct ──────────────────────────────────────────────
    if (typeof styles._text !== 'undefined') {
      setDirectText(el, styles._text)
    }

    return true
  }

  // ── 9. Appliquer tout un payload ──────────────────────────────
  function applyPayload(payload) {
    if (!payload?.changes?.length) return true
    let allFound = true
    payload.changes.forEach(ch => {
      if (!applyChange(ch)) allFound = false
    })
    return allFound
  }

  // ── 10. Cache ─────────────────────────────────────────────────
  let cache = []

  async function fetchSettings() {
    try {
      const result = await sb.from('settings')
        .select('key,value')
        .like('key', 'visual_%')

      cache = (result.data || [])
        .map(r => {
          try {
            return { key: r.key, payload: JSON.parse(r.value) }
          } catch (e) {
            return null
          }
        })
        .filter(Boolean)
    } catch (e) {
      console.warn('[apply-settings] Erreur fetch:', e)
    }
  }

  // ── 11. Appliquer tout (avec retries SPA) ─────────────────────
  const retryDelays = [100, 300, 600, 1200, 2400]

  function applyAll(attempt = 0) {
    let pending = []

    const sorted = cache.slice().sort((a, b) => {
      const da = a.payload?.published_at ? new Date(a.payload.published_at).getTime() : 0
      const db = b.payload?.published_at ? new Date(b.payload.published_at).getTime() : 0
      return da - db
    })

    sorted.forEach(item => {
      if (!isForCurrentPage(item.payload)) return
      if (!targeted(item.payload)) return
      const ok = applyPayload(item.payload)
      if (!ok) pending.push(item.payload)
    })

    if (pending.length > 0 && attempt < retryDelays.length) {
      setTimeout(() => {
        let stillPending = []
        pending.forEach(payload => {
          if (!applyPayload(payload)) stillPending.push(payload)
        })
        if (stillPending.length > 0 && attempt + 1 < retryDelays.length) {
          applyAll(attempt + 1)
        }
      }, retryDelays[attempt])
    }
  }

  // ── 12. Observation SPA + hook manuel ─────────────────────────
  let lastAppliedPath = null

  function observeSPA() {
    const appContent = document.getElementById('app-content')
    if (!appContent) return
    const obs = new MutationObserver(() => {
      setTimeout(() => applyAll(0), 50)
    })
    obs.observe(appContent, { childList: true })
  }

  window._applySettingsReload = function () {
    setTimeout(() => applyAll(0), 50)
  }

  // ── 13. Realtime Supabase ─────────────────────────────────────
  sb.channel('as-fusion-' + Math.random().toString(36).slice(2, 8))
    .on('postgres_changes', {
      event: '*',
      schema: 'public',
      table: 'settings'
    }, function (evt) {
      const row = evt.new
      if (!row?.key?.startsWith('visual_')) return
      try {
        const payload = JSON.parse(row.value || '{}')
        const idx = cache.findIndex(c => c.key === row.key)
        if (idx >= 0) {
          cache[idx].payload = payload
        } else {
          cache.push({ key: row.key, payload })
        }
        if (isForCurrentPage(payload) && targeted(payload)) {
          const ok = applyPayload(payload)
          if (!ok) {
            setTimeout(() => applyPayload(payload), 300)
            setTimeout(() => applyPayload(payload), 800)
          }
          console.log('[apply-settings] ✅ Realtime mis à jour:', row.key)
        }
      } catch (e) {
        console.warn('[apply-settings] Erreur parsing realtime:', e)
      }
    })
    .subscribe()

  // ── 14. Démarrage ─────────────────────────────────────────────
  await fetchSettings()
  lastAppliedPath = getCurrentSpaPage()
  applyAll(0)
  observeSPA()

  console.log(
    '[apply-settings] Prêt v4',
    '| page:', getCurrentSpaPage(),
    '| profil:', profile ? String(profile.id) : 'anonyme',
    '| plan:', profile ? profile.plan : '—',
    '| settings chargés:', cache.length,
    '| preview admin:', window.__isAdminPreview === true
  )

})()