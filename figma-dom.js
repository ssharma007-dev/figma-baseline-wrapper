// Shared logic for the Figma baseline wrapper.
// - buildBaselineLink(): reads a Figma frame (image + nodes) and returns one wrapper URL
// - decodeDom() / renderDom(): used by the wrapper page to rebuild the Figma DOM from that URL

const API = 'https://api.figma.com/v1'

export function parseFrameLink(link) {
  const fileKey = link.match(/figma\.com\/(?:design|file|proto)\/([^/?#]+)/)?.[1]
  const nodeId = link.match(/[?&]node-id=(\d+)(?:-|:|%3A)(\d+)/i)?.slice(1, 3).join(':')
  if (!fileKey) throw new Error('This is not a Figma design link.')
  if (!nodeId) throw new Error('The link has no node-id. In Figma, select the frame and copy the link again.')
  return { fileKey, nodeId }
}

const waitText = (s) => s < 120 ? `${s} seconds` : s < 7200 ? `${Math.ceil(s / 60)} minutes`
  : s < 172800 ? `${Math.ceil(s / 3600)} hours` : `${Math.ceil(s / 86400)} days`

// Turns any failed Figma call into a plain message the page can show as-is
async function figma(path, token) {
  if (!token) throw new Error('Enter your Figma personal access token.')
  let res
  try {
    res = await fetch(`${API}/${path}`, { headers: { 'X-Figma-Token': token } })
  } catch {
    throw new Error('Could not reach Figma. Check your internet connection, VPN or firewall (api.figma.com must be allowed), then try again.')
  }
  if (res.ok) {
    try { return await res.json() } catch { throw new Error('Figma sent back a response we could not read. Try again in a minute.') }
  }

  // Figma's error body is usually {"status": 404, "err": "Not found"}
  let detail = ''
  try { const body = await res.json(); detail = body.err ?? body.message ?? '' } catch {}
  const figmaSays = detail ? ` (Figma says: "${detail}")` : ''

  switch (res.status) {
    case 400:
      throw new Error(`Figma could not read this request${figmaSays}. Check the frame link is copied straight from the browser address bar with a frame selected.`)
    case 401:
    case 403:
      throw new Error(`Figma refused the token${figmaSays}. Check the token is pasted in full, has not expired or been revoked, has the file_content:read scope, and belongs to someone who can open this file.`)
    case 404:
      throw new Error(`Figma could not find this file or frame${figmaSays}. Check the link, and that the token owner has access to the file.`)
    case 429: {
      // Figma exposes these headers to browsers; low limits come from the plan of the file and the seat of the token owner
      const wait = Number(res.headers.get('Retry-After'))
      const plan = res.headers.get('X-Figma-Plan-Tier')
      const low = res.headers.get('X-Figma-Rate-Limit-Type') === 'low'
      throw new Error(`Figma's rate limit has been reached for this token. Try again in ${wait > 0 ? waitText(wait) : 'a while'}.` +
        (low ? ` This token is on Figma's low limit${plan ? ` (${plan} plan)` : ''}, which allows only a few of these calls per month for files on the Starter plan or for View/Collab seats. To avoid waiting, use a token from someone with a Full or Dev seat on a paid Figma plan, and keep the file in that team.` : ''))
    }
    default:
      if (res.status >= 500) throw new Error(`Figma is having problems right now (error ${res.status})${figmaSays}. Try again in a few minutes.`)
      throw new Error(`Figma returned an unexpected error (${res.status})${figmaSays}. Try again, and if it keeps happening, send this message to Applitools support.`)
  }
}

const hex = (c, opacity = 1) => {
  if (!c) return undefined
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0')
  const a = (c.a ?? 1) * opacity
  return '#' + h(c.r) + h(c.g) + h(c.b) + (a < 1 ? h(a) : '')
}
const solidFill = (fills) => {
  const f = (fills ?? []).find((p) => p.type === 'SOLID' && p.visible !== false)
  return f ? hex(f.color, f.opacity ?? 1) : undefined
}
const r1 = (n) => Math.round(n * 10) / 10

// Compact node: t=type, n=name, b=[x,y,w,h] relative to parent, x=text, s=text style, f=fill colour, k=children
function compact(node, parentBox) {
  if (node.visible === false || !node.absoluteBoundingBox) return null
  const box = node.absoluteBoundingBox
  const out = {
    t: node.type,
    n: node.name,
    b: [r1(box.x - parentBox.x), r1(box.y - parentBox.y), r1(box.width), r1(box.height)],
  }
  const fill = solidFill(node.fills)
  if (fill) out.f = fill
  if (node.type === 'TEXT') {
    out.x = node.characters ?? ''
    const s = node.style ?? {}
    out.s = {
      ff: s.fontFamily, fs: s.fontSize, fw: s.fontWeight,
      lh: s.lineHeightPx && r1(s.lineHeightPx), ls: s.letterSpacing || undefined,
      ta: s.textAlignHorizontal && s.textAlignHorizontal.toLowerCase(),
    }
  } else if (node.children?.length) {
    out.k = node.children.map((c) => compact(c, box)).filter(Boolean)
  }
  return out
}

const toB64Url = (bytes) => {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64Url = (str) => Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer())
}

export async function buildBaselineLink(frameLink, token, wrapperBase) {
  const { fileKey, nodeId } = parseFrameLink(frameLink)
  if (typeof CompressionStream === 'undefined') throw new Error('This browser is too old to build the link. Use a current version of Chrome, Edge, Firefox or Safari.')
  const id = encodeURIComponent(nodeId)
  const [images, nodes] = await Promise.all([
    figma(`images/${fileKey}?ids=${id}&format=png&scale=1`, token),
    figma(`files/${fileKey}/nodes?ids=${id}`, token),
  ])
  const imageUrl = images.images?.[nodeId]
  const root = nodes.nodes?.[nodeId]?.document
  if (!imageUrl || !root) throw new Error(`Figma returned nothing for node ${nodeId}. Is it a frame in this file?`)

  const tree = compact(root, root.absoluteBoundingBox)
  const packed = toB64Url(await pipe(new TextEncoder().encode(JSON.stringify(tree)), new CompressionStream('deflate-raw')))
  const link = `${wrapperBase}?img=${encodeURIComponent(imageUrl)}#dom=${packed}`
  let count = 0
  ;(function walk(n) { count++; (n.k ?? []).forEach(walk) })(tree)
  return { link, imageUrl, nodeCount: count, width: Math.round(tree.b[2]), height: Math.round(tree.b[3]) }
}

export async function decodeDom(packed) {
  const bytes = await pipe(fromB64Url(packed), new DecompressionStream('deflate-raw'))
  return JSON.parse(new TextDecoder().decode(bytes))
}

// Rebuilds the Figma tree as invisible, absolutely positioned elements inside `container`
export function renderDom(tree, container) {
  const tagFor = (n) => n.t === 'TEXT' ? ((n.s?.fs ?? 0) >= 32 ? 'h2' : 'p') : (/button/i.test(n.n) ? 'button' : 'div')
  function build(n) {
    const el = document.createElement(tagFor(n))
    el.className = 'fg'
    el.dataset.figmaType = n.t
    el.dataset.figmaName = n.n
    if (n.f) el.dataset.figmaFill = n.f
    const [x, y, w, h] = n.b
    Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' })
    if (n.t === 'TEXT') {
      el.textContent = n.x
      const s = n.s ?? {}
      if (s.ff) el.style.fontFamily = `'${s.ff}'`
      if (s.fs) el.style.fontSize = s.fs + 'px'
      if (s.fw) el.style.fontWeight = s.fw
      if (s.lh) el.style.lineHeight = s.lh + 'px'
      if (s.ls) el.style.letterSpacing = s.ls + 'px'
      if (s.ta) el.style.textAlign = s.ta === 'justified' ? 'justify' : s.ta
    } else {
      for (const c of n.k ?? []) el.appendChild(build(c))
    }
    return el
  }
  const rootEl = build(tree)
  Object.assign(rootEl.style, { left: '0px', top: '0px' })
  container.appendChild(rootEl)
}

// ---------------------------------------------------------------------------
// Text mode: the browser draws the design instead of showing Figma's PNG.
// Text becomes real, visible HTML text; boxes are drawn with CSS; only parts
// with no text inside (photos, icons, illustrations) are exported from Figma as
// images. Both the baseline and the website are then drawn by the browser, so
// a visual comparison shows real text differences, not font-rendering noise.
// ---------------------------------------------------------------------------

const S3 = 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/'
const CONTAINERS = new Set(['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'SECTION'])
const visibleFills = (n) => (n.fills ?? []).filter((p) => p.visible !== false)
const hasText = (n) => n.type === 'TEXT' || (n.children ?? []).some((c) => c.visible !== false && hasText(c))

function radius(n) {
  if (n.rectangleCornerRadii) return n.rectangleCornerRadii.map(r1)
  return n.cornerRadius ? r1(n.cornerRadius) : undefined
}

function shadows(n) {
  const list = (n.effects ?? []).filter((e) => e.visible !== false && /SHADOW/.test(e.type)).map((e) =>
    `${e.type === 'INNER_SHADOW' ? 'inset ' : ''}${r1(e.offset?.x ?? 0)}px ${r1(e.offset?.y ?? 0)}px ${r1(e.radius ?? 0)}px ${r1(e.spread ?? 0)}px ${hex(e.color)}`)
  return list.length ? list.join(', ') : undefined
}

function textStyle(s, fills) {
  return {
    ff: s.fontFamily, fw: s.fontWeight, it: s.italic || undefined, fs: s.fontSize,
    ls: s.letterSpacing ? r1(s.letterSpacing * 100) / 100 : undefined,
    lh: s.lineHeightUnit === 'INTRINSIC_%' ? undefined : s.lineHeightPx && r1(s.lineHeightPx),
    ta: s.textAlignHorizontal?.toLowerCase(), va: s.textAlignVertical?.toLowerCase(),
    tc: s.textCase, td: s.textDecoration !== 'NONE' ? s.textDecoration : undefined,
    ar: s.textAutoResize, c: solidFill(fills),
  }
}

// Same short keys as compact(), plus: v=visible mode, o=opacity, r=radius, st=stroke, sh=shadow, cl=clips,
// u=image (Figma S3 id or full URL), ru=text runs [[length, style]], warn=what could not be drawn exactly
function compactVisible(node, parentBox, ctx, parent) {
  if (node.visible === false || !node.absoluteBoundingBox) return null
  const box = node.absoluteBoundingBox
  const out = { t: node.type, n: node.name, b: [r1(box.x - parentBox.x), r1(box.y - parentBox.y), r1(box.width), r1(box.height)] }
  if (node.opacity != null && node.opacity < 1) out.o = r1(node.opacity * 100) / 100

  if (node.type === 'TEXT') {
    out.x = node.characters ?? ''
    out.s = textStyle(node.style ?? {}, node.fills)
    // Auto-width text hugs its words, so its box is as wide as Figma's text. The browser's text can be a pixel
    // wider or narrower; when an auto-layout parent centres it, centre it in the box too, as a website would.
    const centred = parent?.layoutMode === 'HORIZONTAL' ? parent.primaryAxisAlignItems === 'CENTER' : parent?.layoutMode === 'VERTICAL' && parent.counterAxisAlignItems === 'CENTER'
    if (out.s.ar === 'WIDTH_AND_HEIGHT' && centred) out.s.ta = 'center'
    ctx.fonts.add(JSON.stringify([out.s.ff, out.s.fw, !!out.s.it]))
    const o = node.characterStyleOverrides ?? []
    if (o.length && node.styleOverrideTable) {
      out.ru = []
      for (let i = 0; i < out.x.length; i++) {
        const k = o[i] ?? 0
        const last = out.ru[out.ru.length - 1]
        last && last[1] === k ? last[0]++ : out.ru.push([1, k])
      }
      out.ot = {}
      for (const [k, v] of Object.entries(node.styleOverrideTable)) {
        const st = textStyle({ ...node.style, ...v }, v.fills ?? node.fills)
        out.ot[k] = st
        ctx.fonts.add(JSON.stringify([st.ff, st.fw, !!st.it]))
      }
    }
    return out
  }

  const fills = visibleFills(node)
  const plainBox = !node.children?.length && fills.every((f) => f.type === 'SOLID') && ['RECTANGLE', 'FRAME', 'ELLIPSE'].includes(node.type)
  if (!hasText(node) && !plainBox) {
    // No text inside: Figma draws it, exported as one image
    out.img = node.id
    ctx.images.push(node.id)
    return out
  }

  out.f = solidFill(fills)
  if (fills.some((f) => f.type !== 'SOLID')) ctx.warn.add(`"${node.name}" has an image or gradient fill behind text; it is drawn without that fill.`)
  out.r = node.type === 'ELLIPSE' ? '50%' : radius(node)
  const stroke = (node.strokes ?? []).find((p) => p.visible !== false && p.type === 'SOLID')
  if (stroke && node.strokeWeight) out.st = [r1(node.strokeWeight), hex(stroke.color, stroke.opacity ?? 1), node.strokeAlign]
  out.sh = shadows(node)
  if (node.clipsContent) out.cl = 1
  if (node.children?.length) out.k = node.children.map((c) => compactVisible(c, box, ctx, node)).filter(Boolean)
  return out
}

// Finds each font on Google Fonts (through Fontsource's font list, which allows browser requests),
// including the optical-size axis when the font has one, so text looks as it does in Figma
async function googleFontsQuery(fonts, warn) {
  const byFamily = new Map()
  for (const f of fonts) {
    const [ff, fw, it] = JSON.parse(f)
    if (!ff) continue
    if (!byFamily.has(ff)) byFamily.set(ff, new Set())
    byFamily.get(ff).add(`${it ? 1 : 0},${fw ?? 400}`)
  }
  const parts = []
  for (const [family, styles] of byFamily) {
    const slug = family.toLowerCase().replace(/\s+/g, '-')
    let axes = null
    try {
      const res = await fetch(`https://api.fontsource.org/v1/variable/${slug}`)
      if (res.ok) axes = (await res.json()).axes
      else {
        const info = await fetch(`https://api.fontsource.org/v1/fonts/${slug}`)
        if (!info.ok || (await info.json()).type !== 'google') throw new Error()
      }
    } catch {
      warn.add(`The font "${family}" is not on Google Fonts, so it shows only if it is installed on the computer that runs the test. Otherwise the browser uses a similar font.`)
      continue
    }
    const opsz = axes?.opsz ? `${axes.opsz.min}..${axes.opsz.max}` : null
    const tuples = [...styles].sort().map((s) => { const [i, w] = s.split(','); return opsz ? `${i},${opsz},${w}` : `${i},${w}` })
    parts.push(`family=${encodeURIComponent(family).replace(/%20/g, '+')}:ital,${opsz ? 'opsz,' : ''}wght@${tuples.join(';')}`)
  }
  return parts.join('&')
}

export async function buildTextModeLink(frameLink, token, wrapperBase) {
  const { fileKey, nodeId } = parseFrameLink(frameLink)
  if (typeof CompressionStream === 'undefined') throw new Error('This browser is too old to build the link. Use a current version of Chrome, Edge, Firefox or Safari.')
  const nodes = await figma(`files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, token)
  const root = nodes.nodes?.[nodeId]?.document
  if (!root) throw new Error(`Figma returned nothing for node ${nodeId}. Is it a frame in this file?`)

  const ctx = { images: [], fonts: new Set(), warn: new Set() }
  const tree = compactVisible(root, root.absoluteBoundingBox, ctx)
  tree.b[0] = tree.b[1] = 0
  tree.v = 2

  // Export the parts without text at 2x, cropped exactly to each layer's box
  const urls = {}
  for (let i = 0; i < ctx.images.length; i += 50) {
    const ids = ctx.images.slice(i, i + 50).map(encodeURIComponent).join(',')
    Object.assign(urls, (await figma(`images/${fileKey}?ids=${ids}&format=png&scale=2&use_absolute_bounds=true`, token)).images)
  }
  ;(function setUrls(n) {
    if (n.img) {
      const u = urls[n.img]
      if (u) n.u = u.startsWith(S3) ? u.slice(S3.length) : u
      else ctx.warn.add(`Figma could not export "${n.n}" as an image; it is left empty.`)
      delete n.img
    }
    ;(n.k ?? []).forEach(setUrls)
  })(tree)

  tree.gf = await googleFontsQuery(ctx.fonts, ctx.warn)
  const packed = toB64Url(await pipe(new TextEncoder().encode(JSON.stringify(tree)), new CompressionStream('deflate-raw')))
  let count = 0
  ;(function walk(n) { count++; (n.k ?? []).forEach(walk) })(tree)
  return { link: `${wrapperBase}#dom=${packed}`, nodeCount: count, imageCount: ctx.images.length,
    width: Math.round(tree.b[2]), height: Math.round(tree.b[3]), warnings: [...ctx.warn] }
}

const cssCase = { UPPER: 'uppercase', LOWER: 'lowercase', TITLE: 'capitalize' }

function applyText(el, s) {
  if (s.ff) el.style.fontFamily = `'${s.ff}'`
  if (s.fw) el.style.fontWeight = s.fw
  el.style.fontStyle = s.it ? 'italic' : 'normal'
  if (s.fs) el.style.fontSize = s.fs + 'px'
  el.style.letterSpacing = (s.ls ?? 0) + 'px'
  if (s.c) el.style.color = s.c
  if (s.tc === 'SMALL_CAPS' || s.tc === 'SMALL_CAPS_FORCED') el.style.fontVariant = 'small-caps'
  else if (cssCase[s.tc]) el.style.textTransform = cssCase[s.tc]
  if (s.td) el.style.textDecoration = s.td === 'STRIKETHROUGH' ? 'line-through' : 'underline'
}

// Draws the text-mode tree as visible HTML inside `container`.
// Returns a promise that resolves when fonts and images have loaded.
export function renderVisible(tree, container) {
  const tagFor = (n) => n.t === 'TEXT' ? ((n.s?.fs ?? 0) >= 32 ? 'h2' : 'p') : (/button/i.test(n.n) ? 'button' : n.u ? 'img' : 'div')
  const waits = []

  function build(n) {
    const el = document.createElement(tagFor(n))
    el.className = 'fv'
    el.dataset.figmaType = n.t
    el.dataset.figmaName = n.n
    const [x, y, w, h] = n.b
    Object.assign(el.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px' })
    if (n.o != null) el.style.opacity = n.o

    if (n.t === 'TEXT') {
      const s = n.s ?? {}
      applyText(el, s)
      el.style.lineHeight = s.lh ? s.lh + 'px' : 'normal'
      el.style.textAlign = s.ta === 'justified' ? 'justify' : (s.ta ?? 'left')
      // Auto-width text never wraps in Figma; fixed-width text wraps inside its box
      el.style.whiteSpace = s.ar === 'WIDTH_AND_HEIGHT' ? 'pre' : 'pre-wrap'
      // Figma can centre text vertically in its box; an inner span in a flex column does the same
      let target = el
      if (s.va === 'center' || s.va === 'bottom') {
        Object.assign(el.style, { display: 'flex', flexDirection: 'column', justifyContent: s.va === 'center' ? 'center' : 'flex-end' })
        target = document.createElement('span')
        el.append(target)
      }
      if (n.ru) {
        let i = 0
        for (const [len, k] of n.ru) {
          const part = n.x.slice(i, i + len); i += len
          const st = k && n.ot?.[k]
          if (!st) { target.append(part); continue }
          const span = document.createElement(st.it && !s.it ? 'em' : st.fw >= 600 && (s.fw ?? 400) < 600 ? 'strong' : 'span')
          applyText(span, st)
          if (st.lh && st.lh !== s.lh) span.style.lineHeight = st.lh + 'px'
          span.textContent = part
          target.append(span)
        }
      } else {
        target.textContent = n.x
      }
      return el
    }

    if (n.u) {
      el.src = n.u.startsWith('http') ? n.u : S3 + n.u
      el.alt = n.n
      waits.push(el.decode().catch(() => {}))
      return el
    }

    if (n.f) el.style.background = n.f
    if (n.r != null) el.style.borderRadius = Array.isArray(n.r) ? n.r.map((v) => v + 'px').join(' ') : (typeof n.r === 'number' ? n.r + 'px' : n.r)
    if (n.st) {
      const [sw, sc, align] = n.st
      if (align === 'OUTSIDE') el.style.outline = `${sw}px solid ${sc}`
      else if (align === 'CENTER') Object.assign(el.style, { outline: `${sw}px solid ${sc}`, outlineOffset: `-${sw / 2}px` })
      else el.style.border = `${sw}px solid ${sc}`
    }
    if (n.sh) el.style.boxShadow = n.sh
    if (n.cl) el.style.overflow = 'hidden'
    for (const c of n.k ?? []) el.appendChild(build(c))
    return el
  }

  if (tree.gf) {
    const link = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?${tree.gf}&display=block` })
    const loaded = new Promise((ok) => { link.onload = link.onerror = ok })
    document.head.appendChild(link)
    // Wait for every font the design uses, so the screenshot never shows a fallback font
    const specs = new Set()
    ;(function walk(n) {
      for (const s of [n.s, ...Object.values(n.ot ?? {})]) if (s?.ff) specs.add(`${s.it ? 'italic' : 'normal'} ${s.fw ?? 400} 16px '${s.ff}'`)
      ;(n.k ?? []).forEach(walk)
    })(tree)
    waits.push(loaded.then(() => Promise.all([...specs].map((f) => document.fonts.load(f).catch(() => {})))))
  }

  const rootEl = build(tree)
  container.appendChild(rootEl)
  const timeout = new Promise((ok) => setTimeout(ok, 10000))
  return Promise.race([Promise.all(waits), timeout])
}
