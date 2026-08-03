import { createContext, useContext, useEffect, useState } from 'react'
import { apiFetch } from './apiFetch.js'

const ProjectContext = createContext(null)

export function ProjectProvider({ children }) {
  const [projects, setProjects] = useState([])
  const [activeProject, setActiveProject] = useState(null)
  const [defaultProjectId, setDefaultProjectId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    apiFetch('/api/projects')
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then(data => {
        const list = data.projects ?? []
        const defaultId = data.default_project_id
        setProjects(list)
        setDefaultProjectId(defaultId)
        setActiveProject(list.find(p => p.id === defaultId) ?? list[0] ?? null)
        setLoading(false)
      })
      .catch(e => {
        console.error('[projects] load failed:', e.message)
        setLoading(false)
      })
  }, [])

  async function setDefault(projectId) {
    await apiFetch('/api/projects', {
      method: 'PUT',
      body: JSON.stringify({ default_project_id: projectId }),
    })
    setDefaultProjectId(projectId)
  }

  async function createProject(name, fields = {}) {
    const res = await apiFetch('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, ...fields }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Failed to create project')
    setProjects(prev => [...prev, data.project])
    setActiveProject(data.project)
    return data.project
  }

  async function updateSystemPrompt(projectId, systemPrompt) {
    const res = await apiFetch(`/api/projects?id=${projectId}`, {
      method: 'PATCH',
      body: JSON.stringify({ system_prompt: systemPrompt }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error ?? 'Failed to update system prompt')
    setProjects(prev =>
      prev.map(p => p.id === projectId ? { ...p, system_prompt: systemPrompt } : p)
    )
    setActiveProject(prev =>
      prev?.id === projectId ? { ...prev, system_prompt: systemPrompt } : prev
    )
  }

  return (
    <ProjectContext.Provider value={{
      projects, activeProject, setActiveProject,
      defaultProjectId, setDefault,
      createProject, updateSystemPrompt,
      loading,
    }}>
      {children}
    </ProjectContext.Provider>
  )
}

export function useProject() {
  return useContext(ProjectContext)
}
