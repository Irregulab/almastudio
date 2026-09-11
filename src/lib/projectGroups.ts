import type { Project } from './types'

/** A project's category as the sidebar groups by it: trimmed, and '' for none. */
export const categoryOf = (p: Pick<Project, 'category'>): string => p.category?.trim() ?? ''

export interface ProjectEntry {
  project: Project
  /** Position in the full list, which is what reordering takes. */
  index: number
}

export interface ProjectSection {
  /** '' for the projects without a category. */
  category: string
  projects: ProjectEntry[]
}

/**
 * The sidebar's sections: the projects without a category first, then one
 * section per category in alphabetical order. Within each, projects keep the
 * order the user put them in.
 */
export function projectSections(projects: Project[]): ProjectSection[] {
  const sections = new Map<string, ProjectSection>()
  projects.forEach((project, index) => {
    const category = categoryOf(project)
    const section = sections.get(category) ?? { category, projects: [] }
    section.projects.push({ project, index })
    sections.set(category, section)
  })
  return [...sections.values()].sort((a, b) =>
    a.category === '' ? -1 : b.category === '' ? 1 : a.category.localeCompare(b.category),
  )
}

/**
 * Where Move Up and Move Down take the project at `index`, as arguments for
 * `reorderProjects`: past the neighbouring project in its own category, which
 * in a grouped list is the row above or below it. Null at either end.
 */
export function neighbourMoves(
  projects: Project[],
  index: number,
): { up: number | null; down: number | null } {
  const own = projects[index]
  if (!own) return { up: null, down: null }
  const category = categoryOf(own)
  const peers = projects.flatMap((p, i) => (categoryOf(p) === category ? [i] : []))
  const at = peers.indexOf(index)
  return {
    up: at > 0 ? peers[at - 1] : null,
    down: at < peers.length - 1 ? peers[at + 1] + 1 : null,
  }
}
