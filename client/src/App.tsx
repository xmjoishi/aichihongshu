import { Routes, Route } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import { NoteList, NoteEditor } from "./pages/Notes";
import Publish from "./pages/Publish";
import Accounts from "./pages/Accounts";
import ProfilePage from "./pages/Profile";
import Settings from "./pages/Settings";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";

export default function App() {
  return (
    <ToastProvider>
      <ErrorBoundary>
        <div className="flex h-screen overflow-hidden bg-[#fafafa]">
          <Sidebar />
          <main className="flex-1 overflow-hidden">
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/library" element={<Library />} />
              <Route path="/notes" element={<NoteList />} />
              <Route path="/notes/:id" element={<NoteEditor />} />
              <Route path="/publish" element={<Publish />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </main>
        </div>
      </ErrorBoundary>
    </ToastProvider>
  );
}
