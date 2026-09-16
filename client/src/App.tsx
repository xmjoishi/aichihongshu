import { Routes, Route, Navigate } from "react-router-dom";
import Sidebar from "./components/Sidebar";
import Dashboard from "./pages/Dashboard";
import Library from "./pages/Library";
import { NoteList, NoteEditor } from "./pages/Notes";
import Accounts from "./pages/Accounts";
import AccountPool from "./pages/AccountPool";
import ProfilePage from "./pages/Profile";
import Settings from "./pages/Settings";
import Data from "./pages/Data";
import Inspire from "./pages/Inspire";
import { ToastProvider } from "./components/Toast";
import { ErrorBoundary } from "./components/ErrorBoundary";
import ActiveAccountSwitcher from "./components/ActiveAccountSwitcher";
import LocalRuntimeStatus from "./components/LocalRuntimeStatus";

export default function App() {
  return (
    <ToastProvider>
      <ErrorBoundary>
        <div className="flex h-screen overflow-hidden bg-[var(--color-canvas)] text-[var(--color-text-primary)]">
            <Sidebar />
            <main className="flex h-full flex-1 flex-col overflow-hidden">
              <div className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6">
                <LocalRuntimeStatus />
                <ActiveAccountSwitcher />
              </div>
              <div className="flex-1 overflow-hidden flex flex-col">
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/library" element={<Library />} />
                  <Route path="/notes" element={<NoteList />} />
                  <Route path="/notes/:id" element={<NoteEditor />} />
                  <Route path="/publish" element={<Navigate to="/notes" replace />} />
                  <Route path="/data" element={<Data />} />
                  <Route path="/accounts" element={<Accounts />} />
                  <Route path="/accounts/pool" element={<AccountPool />} />
                  <Route path="/profile" element={<ProfilePage />} />
                  <Route path="/settings" element={<Settings />} />
                  <Route path="/inspire" element={<Inspire />} />
                </Routes>
              </div>
            </main>
        </div>
      </ErrorBoundary>
    </ToastProvider>
  );
}
