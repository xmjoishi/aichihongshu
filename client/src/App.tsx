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
import RiskAckGate from "./components/RiskAckGate";
import ActiveAccountSwitcher from "./components/ActiveAccountSwitcher";

export default function App() {
  return (
    <ToastProvider>
      <ErrorBoundary>
        <RiskAckGate>
          <div className="flex h-screen overflow-hidden bg-[#fafafa]">
            <Sidebar />
            <main className="flex h-full flex-1 flex-col overflow-hidden">
              {/* 顶栏：右侧固定显示账号切换器 */}
              <div className="h-11 px-4 flex items-center justify-end bg-white border-b border-zinc-100 shrink-0">
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
        </RiskAckGate>
      </ErrorBoundary>
    </ToastProvider>
  );
}
