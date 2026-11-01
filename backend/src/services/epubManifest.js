import { load } from 'cheerio'

// XML attribute order is not significant. Both reader endpoints must resolve
// the same manifest, including packages that write href before id.
export function parseEpubManifest(xml) {
  const $ = load(xml, { xmlMode: true })
  const manifest = Object.create(null)
  $('*').each((_, element) => {
    if (element.name?.split(':').at(-1) !== 'item' ||
        element.parent?.name?.split(':').at(-1) !== 'manifest') return
    const id = $(element).attr('id')
    const href = $(element).attr('href')
    if (id && href) manifest[id] = href
  })
  return manifest
}
