import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import './index.css'
import App from './App.jsx'
import Login from './Login.jsx'
import { ProjectProvider } from './ProjectContext.jsx'
import { useSession } from './useSession.js'

function RequireAuth({ children }) {
  const { session, loading } = useSession()
  if (loading) return null
  if (!session) return <Navigate to="/login" replace />
  return (
    <ProjectProvider>
      {children}
    </ProjectProvider>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/*" element={
          <RequireAuth>
            <App />
          </RequireAuth>
        } />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
