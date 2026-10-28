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

async function figma(path, token) {
  const res = await fetch(`${API}/${path}`, { headers: { 'X-Figma-Token': token } })
  if (res.status === 403) throw new Error('Figma refused the token. Check it has the file_content:read scope and can open this file.')
  if (!res.ok) throw new Error(`Figma API error ${res.status} for ${path}`)
  return res.json()
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
