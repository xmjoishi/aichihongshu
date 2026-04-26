import { Routes, Route, Navigate } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import { NoteList, NoteEditor } from "./pages/Notes";
import Accounts from "./pages/Accounts";
import ProfilePage from "./pages/Profile";
import Settings from "./pages/Settings";
import Data from "./pages/Data";
import Inspire from "./pages/Inspire";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";

export default function App() {
  return (
    <ToastProvider>
      <ErrorBoundary>
        <div className="flex h-screen overflow-hidden bg-[#fafafa]">
          <Sidebar />
          <main className="flex h-full flex-1 flex-col overflow-hidden">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/library" element={<Library />} />
              <Route path="/notes" element={<NoteList />} />
              <Route path="/notes/:id" element={<NoteEditor />} />
              <Route path="/publish" element={<Navigate to="/notes" replace />} />
              <Route path="/data" element={<Data />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/inspire" element={<Inspire />} />
            </Routes>
          </main>
        </div>
      </ErrorBoundary>
    </ToastProvider>
  );
}
