import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type DefaultTheme } from 'vitepress'

const docsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

type SpecSection = {
  directory: string
  text: string
  collapsed?: boolean
}

const specSections: SpecSection[] = [
  { directory: '01-product', text: 'Product' },
  { directory: '02-architecture', text: 'Architecture' },
  { directory: '03-runtime', text: 'Runtime', collapsed: true },
  { directory: '04-ux', text: 'Experience', collapsed: true },
  { directory: '05-security', text: 'Security', collapsed: true },
  { directory: '06-delivery', text: 'Delivery', collapsed: true },
  { directory: '07-plugins', text: 'Plugins', collapsed: true },
  { directory: '08-meta', text: 'Decisions & metadata', collapsed: true },
]

const preferredRootFiles = ['README.md', '00-baseline.md', 'NAV.md']

function titleFromMarkdown(filePath: string): string {
  const source = fs.readFileSync(filePath, 'utf8')
  const frontmatterTitle = source.match(/^---[\s\S]*?^title:\s*(.+?)\s*$[\s\S]*?^---/m)?.[1]
  if (frontmatterTitle) return frontmatterTitle.replace(/^['"]|['"]$/g, '')
  return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/`/g, '') ?? path.basename(filePath, '.md')
}

/** Specification pages under `docs/spec/<directory>`, README first. */
function specItems(directory: string): DefaultTheme.SidebarItem[] {
  const sourceDirectory = path.join(docsRoot, 'spec', directory)
  if (!fs.existsSync(sourceDirectory)) return []
  const entries = fs.readdirSync(sourceDirectory, { withFileTypes: true })
  const pages = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((left, right) => {
      if (left === 'README.md') return -1
      if (right === 'README.md') return 1
      return left.localeCompare(right, 'en')
    })
    .map((file) => ({
      text: titleFromMarkdown(path.join(sourceDirectory, file)),
      link: `/spec/${directory}/${file.slice(0, -3)}`,
    }))
  // One nested level, e.g. `06-delivery/e2e/` holding the per-domain E2E catalogs.
  const groups = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((name) => ({ text: name, collapsed: true, items: specItems(`${directory}/${name}`) }))
    .filter((group) => group.items.length > 0)
  return [...pages, ...groups]
}

function adrItems(): DefaultTheme.SidebarItem[] {
  const directory = path.join(docsRoot, 'adr')
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map((file) => ({
      text: titleFromMarkdown(path.join(directory, file)),
      link: `/adr/${file.slice(0, -3)}`,
    }))
}

function projectItems(): DefaultTheme.SidebarItem[] {
  const directory = path.join(docsRoot, 'project')
  return fs.readdirSync(directory)
    .filter((file) => file.endsWith('.md'))
    .sort((left, right) => {
      if (left === 'README.md') return -1
      if (right === 'README.md') return 1
      return left.localeCompare(right, 'en')
    })
    .map((file) => ({
      text: titleFromMarkdown(path.join(directory, file)),
      link: `/project/${file.slice(0, -3)}`,
    }))
}

function specSidebar(): DefaultTheme.SidebarItem[] {
  const specRoot = path.join(docsRoot, 'spec')
  const rootFiles = fs.readdirSync(specRoot).filter((file) => file.endsWith('.md'))
  const page = (file: string) => ({
    text: titleFromMarkdown(path.join(specRoot, file)),
    link: `/spec/${file.slice(0, -3)}`,
  })
  const startItems = preferredRootFiles.filter((file) => rootFiles.includes(file)).map(page)
  const referenceItems = rootFiles
    .filter((file) => !preferredRootFiles.includes(file))
    .sort((left, right) => left.localeCompare(right, 'en'))
    .map(page)

  return [
    { text: 'Start here', items: startItems },
    ...specSections.map((section) => ({
      text: section.text,
      collapsed: section.collapsed,
      items: specItems(section.directory),
    })),
    ...(referenceItems.length ? [{
      text: 'Compatibility references',
      collapsed: true,
      items: referenceItems,
    }] : []),
  ]
}

const sidebar: DefaultTheme.Sidebar = {
  '/guide/': [{ text: 'Guide', items: [{ text: 'Start here', link: '/guide/' }, { text: 'Screens', link: '/guide/screenshots' }, { text: 'MCP market', link: '/guide/mcp-market' }] }],
  '/plugin-development': [{ text: 'Plugin authoring', items: [{ text: 'Zero to one', link: '/plugin-development' }, ...specItems('07-plugins')] }],
  '/project/': [{ text: 'Project records', items: projectItems() }],
  '/spec/': specSidebar(),
  '/adr/': [
    {
      text: 'Architecture decisions',
      items: [
        { text: 'ADR index', link: '/adr/README' },
        { text: 'Documentation site', link: '/adr/0079-vitepress-documentation-site' },
        { text: 'Latest decisions', link: '/spec/08-meta/decisions-log' },
      ],
    },
    { text: 'All decisions', collapsed: true, items: adrItems() },
  ],
}

const nav: DefaultTheme.NavItem[] = [
  { text: 'Guide', link: '/guide/' },
  { text: 'Specs', link: '/spec/README' },
  { text: 'ADRs', link: '/adr/README' },
  { text: 'Plugin guide', link: '/plugin-development' },
  { text: 'Privacy policy', link: '/privacy-policy' },
  { text: 'GitHub', link: 'https://github.com/mySlyy/slyy-desktop' },
]

export default defineConfig({
  title: 'Slyy',
  description: 'A modular desktop workspace for AI agents',
  // Product shell is dark-base; lock docs to the same charcoal system.
  appearance: 'force-dark',
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['meta', { name: 'theme-color', content: '#0d0d0d' }],
    ['meta', { name: 'color-scheme', content: 'dark light' }],
  ],
  lang: 'en',
  markdown: {
    html: false,
    lineNumbers: true,
    theme: { light: 'github-light', dark: 'github-dark' },
  },
  themeConfig: {
    logo: '/app-icon.png',
    siteTitle: 'Slyy',
    search: { provider: 'local' },
    socialLinks: [{ icon: 'github', link: 'https://github.com/mySlyy/slyy-desktop' }],
    editLink: { pattern: 'https://github.com/mySlyy/slyy-desktop/edit/main/docs/:path', text: 'Edit this page on GitHub' },
    outline: { level: 'deep', label: 'On this page' },
    docFooter: { prev: 'Previous', next: 'Next' },
    footer: { message: 'Local-first · Model-agnostic · Plugin-powered. <a href="https://slyy.ai" target="_blank" rel="noreferrer">Wapsol GmbH · slyy.ai</a> · Based on PI-Desktop (LGPL-3.0)', copyright: 'Copyright © 2026 Wapsol GmbH and PI-Desktop contributors' },
    nav,
    sidebar,
  },
})
